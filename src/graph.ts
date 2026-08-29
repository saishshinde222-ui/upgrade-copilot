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

/** Distinct major versions among parseable ranges; unparseable ranges are ignored. */
function distinctMajors(usages: Usage[]): Set<number> {
  const majors = new Set<number>();
  for (const usage of usages) {
    const min = semver.minVersion(usage.version);
    if (min) {
      majors.add(min.major);
    }
  }
  return majors;
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
    const versionMismatch = shared && distinctMajors(usages).size >= 2;

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
