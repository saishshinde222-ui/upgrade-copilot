export interface RepoRef {
  owner: string;
  repo: string;
}

export interface DependencyMap {
  [name: string]: string;
}

export interface RepoRecord {
  id: string;
  url: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  dependencies: DependencyMap;
  devDependencies: DependencyMap;
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

/** Synthetic terminal event we inject into a session's event log when the background
 *  relay of a TrueForge turn stream fails after the turn already started — the SDK's own
 *  event union has no "this stream broke" event, so SSE clients would otherwise wait forever. */
export interface SessionErrorEvent {
  type: "session.error";
  id: string;
  threadId: null;
  createdAt: string;
  message: string;
}
