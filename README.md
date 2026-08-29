# Upgrade Copilot

Agent-powered dashboard that tracks dependencies across multiple GitHub
repos, builds a live cross-repo dependency graph, flags shared dependencies
with version mismatches, and verifies upgrades safely in an isolated sandbox
(via [TrueForge](https://github.com/truefoundry/trueforge) + Daytona) —
against every repo that uses them — before anything is written back to any
repo. Every write action (opening a pull request) requires an explicit human
approval; there is no path that bypasses this.

Built for the TrueForge Agent Harness Hackathon. No AWS or other cloud infra
— Daytona (sandbox), Bright Data (web access), GitHub, and a model provider
are all reached by API key only; TrueForge runs locally.

## Architecture

- `src/github.ts` — parses repo URLs, reads `package.json` from any GitHub
  repo, opens pull requests (branch + file commit + PR creation).
- `src/graph.ts` — pure cross-repo dependency graph logic: shared-dependency
  detection, version-mismatch flagging (by comparing resolved major versions
  across repos), and `impactOf()` lookups.
- `src/trueforgeAgent.ts` — wraps the real `@truefoundry/trueforge-sdk`:
  registers the verifier agent (model, MCP connectors, skill, sandbox +
  dynamic-subagents config), starts verification sessions, and resumes
  paused turns with a human's approval decision.
- `src/store.ts` — in-memory repo registry and a per-session event log (last
  N events) so a dashboard client that connects mid-session can catch up.
- `src/server.ts` — Express API tying it together, including SSE streaming
  of live verification sessions.
- `skills/upgrade-evaluation/SKILL.md` — the rubric the agent follows to
  classify an upgrade as safe / needs-manual-migration / broken, and the
  hard rule that "safe" must always be verified in a sandbox, never
  concluded from documentation alone.
- `dashboard/` — the React + Vite frontend: repo manager, dependency graph
  (React Flow), live per-subagent session view, and the approval drawer.

## Prerequisites

- Node.js >= 22.14
- A running local TrueForge instance (`npx @truefoundry/trueforge@latest`,
  defaults to `http://localhost:8790`)
- In TrueForge's Settings UI (or via its REST API):
  - **Models**: at least one model provider configured (this project
    defaults to `openai/gpt-5-5`; override with `TRUEFORGE_MODEL`)
  - **Connectors**: an MCP connector named exactly `github` and one named
    exactly `bright-data` — these names are referenced literally in
    `src/trueforgeAgent.ts`
  - **Sandbox providers**: Daytona, with a real API key
- A GitHub Personal Access Token with `Contents: read/write` and
  `Pull requests: read/write` on the repos you plan to register (this is a
  separate credential from whatever token TrueForge's own `github` connector
  uses — this one is for the dashboard's direct GitHub API calls)

## Setup

```sh
npm install
cp .env.example .env
# fill in GITHUB_TOKEN, and set API_KEY to a generated secret (openssl rand -hex 32) —
# every backend route except /health requires it
npm run typecheck
npm test
npm run dev             # starts the API on :4000
```

In a second terminal:

```sh
cd dashboard
npm install
npm run dev              # starts the dashboard on :5173
```

Open the dashboard, paste the same `API_KEY` value into the "API key" field in the
header, and click Save — it's kept in this browser's `localStorage`, never in the
dashboard's build output.

The upgrade-evaluation skill must be registered in TrueForge before the
agent can be created (TrueForge validates skill references at agent-create
time). Register it once, pointing at this repo:

```sh
curl -X PUT http://localhost:8790/api/v1/settings/skills \
  -H "Content-Type: application/json" \
  -d '{
    "manifest": {
      "type": "git",
      "name": "upgrade-evaluation",
      "url": "https://github.com/<your-org>/upgrade-copilot",
      "path": "skills/upgrade-evaluation",
      "ref": "main",
      "description": "How to evaluate whether a dependency or API upgrade is safe."
    }
  }'
```

## API reference

Every route except `/health` requires the `X-API-Key` header (set to your `API_KEY`).

| Method | Path | Description |
|---|---|---|
| GET | `/repos` | List registered repos |
| POST | `/repos` | Register one repo (`{ "url": "..." }`) |
| POST | `/repos/bulk` | Register many repos (`{ "urls": ["...", ...] }`), per-URL success/failure |
| POST | `/repos/:id/refresh` | Re-fetch a repo's `package.json` |
| DELETE | `/repos/:id` | Remove a registered repo |
| GET | `/graph` | Full dependency graph (repo nodes, dependency nodes, edges, shared/mismatch flags) |
| GET | `/graph/dependency/:name/history` | **TODO** — placeholder only, see below |
| POST | `/impact/:dependency/verify` | Start a verification session (`{ "targetVersion": "..." }`) for every registered repo using that dependency |
| GET | `/sessions/:sessionId/events` | Snapshot of the session's buffered events (last 500) |
| GET | `/sessions/:sessionId/stream` | SSE stream: buffered events, then live |
| POST | `/sessions/:sessionId/approval` | Resume a paused turn with a human decision (`{ "threadId", "toolCallId", "approval": { "status": "allow" | "deny", "reason"? } }`) |

## Known limitations / TODOs

- **Repo registry and session event log are in-memory only.** Restarting the
  server loses all registered repos and any in-flight session's event
  buffer (the underlying TrueForge session/turn itself keeps running
  server-side — only our own relay/buffer is lost). A real deployment would
  persist both.
- **Dependency version history is not tracked yet.** `GET
  /graph/dependency/:name/history` is a stub that always returns an empty
  array — see the `TODO` comment at its route in `src/server.ts`.
- **No reconnect-on-restart for in-flight turns.** If the server restarts
  mid-verification, the dashboard stops receiving live updates for that
  session (TrueForge's `subscribeToTurn` API could be used to recover this;
  not yet wired up).
- **The Qodo custom-rules-check agent (`.github/workflows/qodo.yml`) reads
  untrusted PR diff text with an LLM while holding write-capable secrets.**
  It never checks out or executes the PR's own code, and its instructions
  explicitly treat diff/PR text as inert data rather than commands — but
  prompt injection via diff content is a residual, structural risk shared by
  any LLM-based PR reviewer, not one this setup fully eliminates.

## Qodo Code Review Evidence

This project ships every feature as its own pull request, reviewed by Qodo
before merge (per the hackathon's mandatory workflow). Two custom rules are
enforced two ways:

1. **`.pr_agent.toml`** (`[best_practices]` / `[pr_reviewer].extra_instructions`)
   — read by the installed Qodo Merge GitHub App on every PR review.
2. **`.github/workflows/qodo.yml`** — runs `qodo-ai/command` on every PR,
   using the custom agent at
   `.github/qodo/agents/pr-custom-rules-check/agent.toml`, which posts a
   dedicated review comment checking only these two rules.

The two rules:
- Every TrueForge SDK call that can reject must be handled by checking the
  SDK's own error types (`TrueForgeError` / `TrueForgeApi.ConflictError`),
  not a generic catch.
- No hardcoded API keys or tokens anywhere in source — all secrets come from
  `process.env`.

<!--
  Update this section as real PRs land — link at least one representative
  merged PR, and note what Qodo found and what was changed or dismissed.
  Do not leave this as a template once PRs start merging.
-->

_No PRs merged yet — this section will be updated with a real merged PR
link and a summary of Qodo's findings as soon as the first PR is reviewed
and merged._
