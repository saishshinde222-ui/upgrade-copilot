import { randomUUID } from "node:crypto";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { RepoRecord } from "./types.js";

const repos = new Map<string, RepoRecord>();

export function listRepos(): RepoRecord[] {
  return Array.from(repos.values());
}

export function getRepo(id: string): RepoRecord | undefined {
  return repos.get(id);
}

export function findRepoByOwnerRepo(owner: string, repo: string): RepoRecord | undefined {
  return listRepos().find((r) => r.owner === owner && r.repo === repo);
}

export type RepoUpsertInput = Omit<RepoRecord, "id" | "registeredAt">;

/** Registers a repo, or refreshes it in place (same id) if owner/repo was already registered. */
export function upsertRepo(input: RepoUpsertInput): RepoRecord {
  const existing = findRepoByOwnerRepo(input.owner, input.repo);
  const record: RepoRecord = {
    ...input,
    id: existing?.id ?? randomUUID(),
    registeredAt: existing?.registeredAt ?? new Date().toISOString(),
  };
  repos.set(record.id, record);
  return record;
}

export function removeRepo(id: string): boolean {
  return repos.delete(id);
}

// --- per-session event log (last N events), so a dashboard client that connects after a
// verification session already started can still catch up via a plain GET. ---

const MAX_EVENTS_PER_SESSION = 500;
const sessionEvents = new Map<string, TrueForgeApi.TurnStreamingEvent[]>();
const sessionListeners = new Map<string, Set<(event: TrueForgeApi.TurnStreamingEvent) => void>>();

export function appendSessionEvent(sessionId: string, event: TrueForgeApi.TurnStreamingEvent): void {
  const events = sessionEvents.get(sessionId) ?? [];
  events.push(event);
  if (events.length > MAX_EVENTS_PER_SESSION) {
    events.splice(0, events.length - MAX_EVENTS_PER_SESSION);
  }
  sessionEvents.set(sessionId, events);

  const listeners = sessionListeners.get(sessionId);
  if (listeners) {
    for (const listener of listeners) listener(event);
  }
}

export function getSessionEvents(sessionId: string): TrueForgeApi.TurnStreamingEvent[] {
  return sessionEvents.get(sessionId) ?? [];
}

/** Returns an unsubscribe function. */
export function subscribeToSession(
  sessionId: string,
  listener: (event: TrueForgeApi.TurnStreamingEvent) => void,
): () => void {
  const listeners = sessionListeners.get(sessionId) ?? new Set();
  listeners.add(listener);
  sessionListeners.set(sessionId, listeners);
  return () => {
    listeners.delete(listener);
  };
}
