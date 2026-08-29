const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";
const API_KEY_STORAGE_KEY = "upgrade-copilot.apiKey";

/** The backend API key, entered once by the operator and kept only in this browser's
 *  localStorage — never baked into the build (a VITE_* env var ships in the JS bundle,
 *  which would defeat the point of a secret). Falls back to "" when storage is unavailable
 *  (private browsing, blocked site data), same as any other empty-key request. */
export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setApiKey(key: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, key);
  } catch {
    // best-effort; the key just won't persist across reloads in this environment
  }
}

export interface RepoSummary {
  id: string;
  url: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  dependencyCount: number;
  registeredAt: string;
  lastFetchedAt: string;
}

export interface GraphRepoNode {
  type: "repo";
  id: string;
  label: string;
  url: string;
}

export interface GraphDependencyNode {
  type: "dependency";
  id: string;
  name: string;
  shared: boolean;
  versionMismatch: boolean;
  usedBy: Array<{ repoId: string; version: string; dev: boolean }>;
}

export interface GraphEdge {
  source: string;
  target: string;
  version: string;
  dev: boolean;
}

export interface DependencyGraph {
  repoNodes: GraphRepoNode[];
  dependencyNodes: GraphDependencyNode[];
  edges: GraphEdge[];
}

export interface BulkRepoResult {
  url: string;
  success: boolean;
  data?: RepoSummary;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "X-API-Key": getApiKey(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new Error(body.error ?? `Request failed with status ${res.status}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export function listRepos(): Promise<RepoSummary[]> {
  return request<{ data: RepoSummary[] }>("/repos").then((r) => r.data);
}

export function registerRepo(url: string): Promise<RepoSummary> {
  return request<{ data: RepoSummary }>("/repos", {
    method: "POST",
    body: JSON.stringify({ url }),
  }).then((r) => r.data);
}

export function registerReposBulk(urls: string[]): Promise<BulkRepoResult[]> {
  return request<{ data: BulkRepoResult[] }>("/repos/bulk", {
    method: "POST",
    body: JSON.stringify({ urls }),
  }).then((r) => r.data);
}

export function refreshRepo(id: string): Promise<RepoSummary> {
  return request<{ data: RepoSummary }>(`/repos/${id}/refresh`, { method: "POST" }).then((r) => r.data);
}

export function removeRepo(id: string): Promise<void> {
  return request<void>(`/repos/${id}`, { method: "DELETE" });
}

export function getGraph(): Promise<DependencyGraph> {
  return request<{ data: DependencyGraph }>("/graph").then((r) => r.data);
}

export function verifyDependency(
  name: string,
  targetVersion: string,
): Promise<{ sessionId: string; turnId?: string }> {
  return request<{ data: { sessionId: string; turnId?: string } }>(
    `/impact/${encodeURIComponent(name)}/verify`,
    { method: "POST", body: JSON.stringify({ targetVersion }) },
  ).then((r) => r.data);
}

export type ApprovalDecision = { status: "allow" } | { status: "deny"; reason?: string };

export function respondApproval(
  sessionId: string,
  input: { threadId: string; toolCallId: string; approval: ApprovalDecision },
): Promise<{ sessionId: string; turnId?: string }> {
  return request<{ data: { sessionId: string; turnId?: string } }>(`/sessions/${sessionId}/approval`, {
    method: "POST",
    body: JSON.stringify(input),
  }).then((r) => r.data);
}

export function streamSessionUrl(sessionId: string): string {
  // EventSource can't set request headers, so the stream route also accepts the key as a
  // query param.
  return `${API_BASE}/sessions/${sessionId}/stream?apiKey=${encodeURIComponent(getApiKey())}`;
}

export function fetchSessionEvents(sessionId: string) {
  return request<{ data: import("./events").SessionEvent[] }>(`/sessions/${sessionId}/events`).then(
    (r) => r.data,
  );
}
