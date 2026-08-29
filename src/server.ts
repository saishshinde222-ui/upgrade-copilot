import { pathToFileURL } from "node:url";
import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { buildGraph, impactOf } from "./graph.js";
import { createGitHubClient, fetchPackageJson, parseRepoUrl } from "./github.js";
import { appendSessionEvent, getRepo, getSessionEvents, listRepos, removeRepo, subscribeToSession, upsertRepo } from "./store.js";
import { ensureAgent, startVerificationSession, respondToApproval } from "./trueforgeAgent.js";
import type { RepoRecord } from "./types.js";

const app = express();
app.use(cors());
app.use(express.json());

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function repoSummary(repo: RepoRecord) {
  return {
    id: repo.id,
    url: repo.url,
    owner: repo.owner,
    repo: repo.repo,
    defaultBranch: repo.defaultBranch,
    dependencyCount: Object.keys(repo.dependencies).length + Object.keys(repo.devDependencies).length,
    registeredAt: repo.registeredAt,
    lastFetchedAt: repo.lastFetchedAt,
  };
}

async function registerRepoByUrl(url: string): Promise<RepoRecord> {
  const ref = parseRepoUrl(url);
  const client = createGitHubClient();
  const pkg = await fetchPackageJson(client, ref);
  return upsertRepo({
    url,
    owner: ref.owner,
    repo: ref.repo,
    defaultBranch: pkg.defaultBranch,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    lastFetchedAt: new Date().toISOString(),
  });
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.get(
  "/repos",
  asyncRoute(async (_req, res) => {
    res.json({ data: listRepos().map(repoSummary) });
  }),
);

app.post(
  "/repos",
  asyncRoute(async (req, res) => {
    const { url } = req.body as { url?: unknown };
    if (typeof url !== "string" || url.trim().length === 0) {
      throw new HttpError(400, "Request body must include a non-empty string field \"url\"");
    }
    const repo = await registerRepoByUrl(url);
    res.status(201).json({ data: repoSummary(repo) });
  }),
);

app.post(
  "/repos/:id/refresh",
  asyncRoute(async (req, res) => {
    const existing = getRepo(req.params.id!);
    if (!existing) {
      throw new HttpError(404, `No registered repo with id "${req.params.id}"`);
    }
    const repo = await registerRepoByUrl(existing.url);
    res.json({ data: repoSummary(repo) });
  }),
);

app.delete(
  "/repos/:id",
  asyncRoute(async (req, res) => {
    const removed = removeRepo(req.params.id!);
    if (!removed) {
      throw new HttpError(404, `No registered repo with id "${req.params.id}"`);
    }
    res.status(204).end();
  }),
);

app.get(
  "/graph",
  asyncRoute(async (_req, res) => {
    res.json({ data: buildGraph(listRepos()) });
  }),
);

app.post(
  "/impact/:dependency/verify",
  asyncRoute(async (req, res) => {
    const dependencyName = req.params.dependency!;
    const { targetVersion } = req.body as { targetVersion?: unknown };
    if (typeof targetVersion !== "string" || targetVersion.trim().length === 0) {
      throw new HttpError(400, "Request body must include a non-empty string field \"targetVersion\"");
    }

    const impact = impactOf(listRepos(), dependencyName);
    if (!impact) {
      throw new HttpError(404, `No registered repo depends on "${dependencyName}"`);
    }

    const repos = listRepos().filter((repo) => impact.usedBy.some((usage) => usage.repoId === repo.id));
    const { sessionId, stream } = await startVerificationSession({ dependencyName, targetVersion, repos });
    const turnId = await relayStream(sessionId, stream);
    res.status(202).json({ data: { sessionId, turnId } });
  }),
);

app.get("/sessions/:sessionId/events", (req, res) => {
  res.json({ data: getSessionEvents(req.params.sessionId!) });
});

app.get("/sessions/:sessionId/stream", (req, res) => {
  const { sessionId } = req.params as { sessionId: string };
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  for (const event of getSessionEvents(sessionId)) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  const unsubscribe = subscribeToSession(sessionId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on("close", () => {
    unsubscribe();
  });
});

app.post(
  "/sessions/:sessionId/approval",
  asyncRoute(async (req, res) => {
    const { sessionId } = req.params as { sessionId: string };
    const { threadId, toolCallId, approval } = req.body as {
      threadId?: unknown;
      toolCallId?: unknown;
      approval?: { status?: unknown; reason?: unknown };
    };
    if (typeof threadId !== "string" || typeof toolCallId !== "string") {
      throw new HttpError(400, "Request body must include string fields \"threadId\" and \"toolCallId\"");
    }
    if (approval?.status !== "allow" && approval?.status !== "deny") {
      throw new HttpError(400, "Request body field \"approval.status\" must be \"allow\" or \"deny\"");
    }
    const decision: TrueForgeApi.ApprovalDecision =
      approval.status === "allow"
        ? { status: "allow" }
        : { status: "deny", reason: typeof approval.reason === "string" ? approval.reason : undefined };

    const stream = await respondToApproval({ sessionId, threadId, toolCallId, approval: decision });
    const turnId = await relayStream(sessionId, stream);
    res.status(202).json({ data: { sessionId, turnId } });
  }),
);

/** Consumes `stream` in the background, appending every event to the session's event log,
 *  and resolves with the turn id as soon as `turn.created` is observed (without waiting for
 *  the whole turn — verification can run for minutes across sandboxed subagents). */
function relayStream(
  sessionId: string,
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
): Promise<string | undefined> {
  const iterator = stream[Symbol.asyncIterator]();
  return new Promise((resolve, reject) => {
    let settled = false;
    (async () => {
      try {
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) break;
          appendSessionEvent(sessionId, value);
          if (!settled && value.type === "turn.created") {
            settled = true;
            resolve(value.turnId);
          }
        }
        if (!settled) resolve(undefined);
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        } else {
          console.error(`Session ${sessionId} stream error after turn started:`, err);
        }
      }
    })();
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof TrueForgeApi.ConflictError || err instanceof Error) {
    console.error(err);
    res.status(502).json({ error: "Upstream request failed", message: err.message });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = Number(process.env.PORT ?? 4000);

export async function startServer(): Promise<void> {
  await ensureAgent();
  app.listen(PORT, () => {
    console.log(`Upgrade Copilot API listening on http://localhost:${PORT}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}

export { app };
