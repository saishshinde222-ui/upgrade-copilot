import semver from "semver";
import type {
  DependencyGraph,
  GraphDependencyNode,
  GraphEdge,
  GraphRepoNode,
  RepoRecord,
} from "./types.js";

interface Usage {
  repoId: string;
  version: string;
  dev: boolean;
}

function dependencyNodeId(name: string): string {
  return `dep:${name}`;
}

function repoNodeId(repo: RepoRecord): string {
  return repo.id;
}

/**
 * True when the shared usages of a dependency can't be trusted to agree. Two rules, in order:
 * 1. If every repo declares the exact same spec string, they trivially agree — no mismatch,
 *    regardless of whether semver can parse that spec (covers tags, git/workspace refs, etc.).
 * 2. Otherwise, if any spec is unparseable, we can't rule out a real difference — flag it
 *    conservatively rather than silently ignoring the unparseable one (this is a safety tool;
 *    "unsure" should read as "needs a human look", not "fine"). If every spec parses, compare
 *    resolved major versions.
 */
function hasVersionMismatch(usages: Usage[]): boolean {
  const specs = new Set(usages.map((u) => u.version));
  if (specs.size <= 1) return false;

  const majors = new Set<number>();
  for (const spec of specs) {
    // semver.minVersion throws on some invalid ranges (e.g. "latest") rather than returning
    // null, so both outcomes mean "unparseable" here.
    let min: ReturnType<typeof semver.minVersion>;
    try {
      min = semver.minVersion(spec);
    } catch {
      min = null;
    }
    if (!min) return true;
    majors.add(min.major);
  }
  return majors.size >= 2;
}

export function buildGraph(repos: RepoRecord[]): DependencyGraph {
  const repoNodes: GraphRepoNode[] = repos.map((repo) => ({
    type: "repo",
    id: repoNodeId(repo),
    label: `${repo.owner}/${repo.repo}`,
    url: repo.url,
  }));

  const usagesByDependency = new Map<string, Usage[]>();
  for (const repo of repos) {
    for (const [name, version] of Object.entries(repo.dependencies)) {
      const usages = usagesByDependency.get(name) ?? [];
      usages.push({ repoId: repoNodeId(repo), version, dev: false });
      usagesByDependency.set(name, usages);
    }
    for (const [name, version] of Object.entries(repo.devDependencies)) {
      const usages = usagesByDependency.get(name) ?? [];
      usages.push({ repoId: repoNodeId(repo), version, dev: true });
      usagesByDependency.set(name, usages);
    }
  }

  const dependencyNodes: GraphDependencyNode[] = [];
  const edges: GraphEdge[] = [];

  for (const [name, usages] of usagesByDependency) {
    const shared = new Set(usages.map((u) => u.repoId)).size >= 2;
    const versionMismatch = shared && hasVersionMismatch(usages);

    dependencyNodes.push({
      type: "dependency",
      id: dependencyNodeId(name),
      name,
      shared,
      versionMismatch,
      usedBy: usages.map((u) => ({ repoId: u.repoId, version: u.version, dev: u.dev })),
    });

    for (const usage of usages) {
      edges.push({
        source: usage.repoId,
        target: dependencyNodeId(name),
        version: usage.version,
        dev: usage.dev,
      });
    }
  }

  return { repoNodes, dependencyNodes, edges };
}

export function sharedDependencies(graph: DependencyGraph): GraphDependencyNode[] {
  return graph.dependencyNodes.filter((node) => node.shared);
}

export function versionMismatches(graph: DependencyGraph): GraphDependencyNode[] {
  return graph.dependencyNodes.filter((node) => node.versionMismatch);
}

export interface DependencyImpact {
  name: string;
  usedBy: Array<{ repoId: string; owner: string; repo: string; version: string; dev: boolean }>;
}

/** Which registered repos use `dependencyName`, and at what declared version range. */
export function impactOf(repos: RepoRecord[], dependencyName: string): DependencyImpact | null {
  const usedBy: DependencyImpact["usedBy"] = [];
  for (const repo of repos) {
    if (dependencyName in repo.dependencies) {
      usedBy.push({
        repoId: repoNodeId(repo),
        owner: repo.owner,
        repo: repo.repo,
        version: repo.dependencies[dependencyName]!,
        dev: false,
      });
    } else if (dependencyName in repo.devDependencies) {
      usedBy.push({
        repoId: repoNodeId(repo),
        owner: repo.owner,
        repo: repo.repo,
        version: repo.devDependencies[dependencyName]!,
        dev: true,
      });
    }
  }
  if (usedBy.length === 0) {
    return null;
  }
  return { name: dependencyName, usedBy };
}
