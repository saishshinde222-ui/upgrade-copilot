import { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { RepoRecord } from "./types.js";

export const AGENT_NAME = "upgrade-copilot-verifier";
export const SKILL_NAME = "upgrade-evaluation";
const DEFAULT_MODEL = process.env.TRUEFORGE_MODEL ?? "openai/gpt-5-5";

let cachedClient: TrueForge | null = null;

export function getTrueForgeClient(): TrueForge {
  if (!cachedClient) {
    cachedClient = new TrueForge({
      baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://localhost:8790",
    });
  }
  return cachedClient;
}

const AGENT_INSTRUCTIONS = `You are Upgrade Copilot's verification agent. You are given a shared
dependency, a candidate target version, and the set of registered repositories that declare it.

For each repo, spawn one dynamic subagent to check that repo independently and in parallel — do not
check repos sequentially in the main thread. Each subagent must:
1. Read the repo's current manifest and the dependency's changelog / migration guide (github, bright-data tools).
2. Actually install the candidate version and run the repo's build/tests inside its sandbox — never
   conclude "safe" from documentation alone, per the upgrade-evaluation skill.
3. Classify the result as exactly one of: safe, needs-manual-migration, or broken, citing the specific
   file/line or command output that justifies the classification.

After all subagents report back, summarize per-repo results. For every repo classified "safe" (and only
those), actually call the tool to open a pull request bumping the dependency on that repo — do not just
describe that a PR "could" be opened and stop, and do not ask the user for permission in a chat message
first. Calling the write tool is itself always safe to attempt: it will automatically pause and wait for
explicit human approval before anything is written, because pull-request tools require approval by
configuration. If the human denies it, stop for that repo and report the denial reason instead of
retrying silently. Never attempt to open a PR for a repo classified "needs-manual-migration" or "broken".`;

function agentManifest(): TrueForgeApi.AgentSpec {
  return {
    model: { name: DEFAULT_MODEL },
    instructions: AGENT_INSTRUCTIONS,
    mcpServers: [
      { name: "github", requireApprovalForTools: ["@write", "@destructive"] },
      { name: "bright-data" },
    ],
    skills: [{ name: SKILL_NAME }],
    config: {
      sandbox: { enabled: true },
      dynamicSubAgents: { enabled: true },
    },
  };
}

/** Creates the named agent if missing, or syncs its manifest if it already exists. Safe to call on every server start. */
export async function ensureAgent(): Promise<void> {
  const client = getTrueForgeClient();
  const manifest = agentManifest();
  try {
    await client.agents.create({ name: AGENT_NAME, manifest });
    return;
  } catch (err) {
    if (!(err instanceof TrueForgeApi.ConflictError)) {
      throw err;
    }
  }
  const { data: agents } = await client.agents.list();
  const existing = agents.find((agent) => agent.name === AGENT_NAME);
  if (!existing) {
    throw new Error(`Agent "${AGENT_NAME}" reported a conflict on create but was not found on list`);
  }
  await client.agents.update(existing.id, { manifest });
}

function formatRepoUsage(repo: RepoRecord, dependencyName: string): string {
  const version = repo.dependencies[dependencyName] ?? repo.devDependencies[dependencyName];
  return `- ${repo.owner}/${repo.repo} (currently ${version ?? "unknown"})`;
}

export interface StartVerificationInput {
  dependencyName: string;
  targetVersion: string;
  repos: RepoRecord[];
}

/** Creates a session bound to the verifier agent and kicks off the first turn. Caller owns consuming/relaying the returned stream. */
export async function startVerificationSession(
  input: StartVerificationInput,
): Promise<{ sessionId: string; stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent> }> {
  const client = getTrueForgeClient();
  const session = await client.sessions.create({ agent: { name: AGENT_NAME } });
  const sessionId = session.data.id;

  const prompt = [
    `Dependency "${input.dependencyName}" could be upgraded to ${input.targetVersion}.`,
    `Repos currently declaring it:`,
    ...input.repos.map((repo) => formatRepoUsage(repo, input.dependencyName)),
    `Verify the upgrade to ${input.targetVersion} independently for each repo above.`,
  ].join("\n");

  const stream = await client.sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: prompt }],
  });

  return { sessionId, stream };
}

export interface RespondToApprovalInput {
  sessionId: string;
  threadId: string;
  toolCallId: string;
  approval: TrueForgeApi.ApprovalDecision;
}

/** Resumes a paused turn by submitting the human's approval decision as the next turn's input. */
export async function respondToApproval(
  input: RespondToApprovalInput,
): Promise<AsyncIterable<TrueForgeApi.TurnStreamingEvent>> {
  const client = getTrueForgeClient();
  return client.sessions.createTurnStream(input.sessionId, {
    input: [
      {
        type: "user.tool_approval",
        threadId: input.threadId,
        toolCallId: input.toolCallId,
        approval: input.approval,
      },
    ],
  });
}

export async function listPersistedSessionEvents(
  sessionId: string,
): Promise<TrueForgeApi.SessionEventItem[]> {
  const client = getTrueForgeClient();
  const page = await client.sessions.listEvents(sessionId);
  const items: TrueForgeApi.SessionEventItem[] = [];
  for await (const item of page) {
    items.push(item);
  }
  return items;
}
