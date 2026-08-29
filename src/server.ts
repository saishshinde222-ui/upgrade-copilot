import { randomUUID, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import semver from "semver";
import { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { buildGraph, impactOf } from "./graph.js";
import { createGitHubClient, fetchPackageJson, parseRepoUrl } from "./github.js";
import {
  appendSessionEvent,
  getRepo,
  getSessionEvents,
  isApprovalResolved,
  listRepos,
  markApprovalResolved,
  removeRepo,
  subscribeToSession,
  upsertRepo,
  type SessionEventEntry,
} from "./store.js";
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

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

/** Constant-time string compare so key-guessing can't be timed. */
function secretsMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** Every route below this line requires a caller-supplied API key, via the X-API-Key header
 *  only — never a query param, which would leak into URL logs/history/proxies. The dashboard's
 *  SSE client uses a fetch-based reader (not the native EventSource, which can't set headers)
 *  specifically so it can send this the same way as every other request. Fails closed:
 *  startServer() refuses to run without API_KEY set, so reaching the "missing" branch below
 *  means misconfiguration, not an intentionally-open server. */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_KEY;
  if (!expected) {
    res.status(500).json({ error: "Server is missing API_KEY configuration" });
    return;
  }
  const provided = req.header("x-api-key");
  if (!provided || !secretsMatch(provided, expected)) {
    res.status(401).json({ error: "Missing or invalid API key" });
    return;
  }
  next();
}

app.use(requireApiKey);

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
  let ref;
  try {
    ref = parseRepoUrl(url);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : `Invalid repository URL: "${url}"`);
  }
  const client = createGitHubClient();
  let pkg;
  try {
    pkg = await fetchPackageJson(client, ref);
  } catch (err) {
    throw new HttpError(422, err instanceof Error ? err.message : `Failed to read package.json for "${url}"`);
  }
  return upsertRepo({
    url,
    // Use GitHub's canonical casing, not whatever casing the caller happened to type — two
    // URLs differing only in case must resolve to the same registered repo.
    owner: pkg.owner,
    repo: pkg.repo,
    defaultBranch: pkg.defaultBranch,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    lastFetchedAt: new Date().toISOString(),
  });
}

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

const MAX_BULK_REPOS = 25;
const BULK_CONCURRENCY = 5;

/** Runs `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

app.post(
  "/repos/bulk",
  asyncRoute(async (req, res) => {
    const { urls } = req.body as { urls?: unknown };
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new HttpError(400, "Request body must include a non-empty array field \"urls\"");
    }
    if (urls.length > MAX_BULK_REPOS) {
      throw new HttpError(400, `"urls" must contain at most ${MAX_BULK_REPOS} entries (got ${urls.length})`);
    }
    if (!urls.every((u) => typeof u === "string")) {
      throw new HttpError(400, "Every entry in \"urls\" must be a string");
    }

    const results = await mapWithConcurrency(urls as string[], BULK_CONCURRENCY, async (url) => {
      try {
        const repo = await registerRepoByUrl(url);
        return { url, success: true as const, data: repoSummary(repo) };
      } catch (err) {
        const message = err instanceof HttpError || err instanceof Error ? err.message : "Unknown error";
        return { url, success: false as const, error: message };
      }
    });

    res.status(207).json({ data: results });
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

app.get(
  "/graph/dependency/:name/history",
  asyncRoute(async (req, res) => {
    // TODO: no version-history tracking yet. Once repos are polled/refreshed over time,
    // record each observed (repoId, version, seenAt) tuple somewhere durable (this store is
    // in-memory only and resets on restart) and return the real timeline here instead.
    res.json({ data: { name: req.params.name, history: [] } });
  }),
);

// Deliberately conservative: only accepts the npm package name grammar (with scoped-package
// support), so a value that could redirect the agent's prompt (newlines, quotes, instructions)
// is rejected outright rather than reaching src/trueforgeAgent.ts's prompt string.
const NPM_PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function assertValidDependencyName(name: string): void {
  if (!NPM_PACKAGE_NAME.test(name)) {
    throw new HttpError(400, `"${name}" is not a valid npm package name`);
  }
}

function assertValidTargetVersion(version: string): void {
  if (!semver.validRange(version)) {
    throw new HttpError(400, `"${version}" is not a valid semver range`);
  }
}

app.post(
  "/impact/:dependency/verify",
  asyncRoute(async (req, res) => {
    const dependencyName = req.params.dependency!;
    assertValidDependencyName(dependencyName);

    const { targetVersion } = req.body as { targetVersion?: unknown };
    if (typeof targetVersion !== "string" || targetVersion.trim().length === 0) {
      throw new HttpError(400, "Request body must include a non-empty string field \"targetVersion\"");
    }
    assertValidTargetVersion(targetVersion);

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

/** A pending approval must correspond to a `tool.approval_required` event we actually saw for
 *  this session, and must not have been resolved already — otherwise any caller who can guess
 *  or reuse a threadId/toolCallId could submit a decision for a call that was never actually
 *  paused there, or replay/contradict a decision that was already acted on. */
function findPendingApproval(sessionId: string, threadId: string, toolCallId: string): boolean {
  if (isApprovalResolved(sessionId, threadId, toolCallId)) return false;
  return getSessionEvents(sessionId).some(
    (event) =>
      event.type === "tool.approval_required" &&
      event.threadId === threadId &&
      event.toolCalls.some((tc) => tc.id === toolCallId),
  );
}

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
    if (!findPendingApproval(sessionId, threadId, toolCallId)) {
      throw new HttpError(404, "No pending approval matches this session, threadId, and toolCallId");
    }
    // Marked resolved before the SDK call so a rapid duplicate request can't race past the
    // check above — worst case a legitimate retry after a network error must be treated as a
    // fresh (and, from TrueForge's side, harmless no-op) approval, not silently accepted twice.
    markApprovalResolved(sessionId, threadId, toolCallId);
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
 *  the whole turn — verification can run for minutes across sandboxed subagents). If the
 *  stream itself breaks after that point, appends a synthetic `session.error` event so SSE
 *  clients see a terminal state instead of waiting forever. */
function relayStream(sessionId: string, stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>): Promise<string | undefined> {
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
        const message = err instanceof Error ? err.message : String(err);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(message));
        } else {
          console.error(`Session ${sessionId} stream error after turn started:`, err);
          const errorEvent: SessionEventEntry = {
            type: "session.error",
            id: randomUUID(),
            threadId: null,
            createdAt: new Date().toISOString(),
            message,
          };
          appendSessionEvent(sessionId, errorEvent);
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
  if (!process.env.API_KEY) {
    throw new Error(
      "API_KEY environment variable is not set. Generate one (e.g. `openssl rand -hex 32`) and set it before starting the server — every route except /health requires it.",
    );
  }
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
