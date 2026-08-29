import { describe, expect, it } from "vitest";
import { buildGraph, impactOf, sharedDependencies, versionMismatches } from "./graph.js";
import type { RepoRecord } from "./types.js";

function makeRepo(overrides: Partial<RepoRecord> & Pick<RepoRecord, "owner" | "repo">): RepoRecord {
  return {
    id: `${overrides.owner}/${overrides.repo}`,
    url: `https://github.com/${overrides.owner}/${overrides.repo}`,
    defaultBranch: "main",
    dependencies: {},
    devDependencies: {},
    registeredAt: "2026-01-01T00:00:00.000Z",
    lastFetchedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildGraph", () => {
  it("flags a dependency used by 2+ repos as shared", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { chalk: "^4.1.2" } }),
    ];
    const graph = buildGraph(repos);
    const chalk = graph.dependencyNodes.find((d) => d.name === "chalk");
    expect(chalk?.shared).toBe(true);
  });

  it("does not flag a dependency used by only one repo as shared", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { lodash: "^4.17.0" } }),
    ];
    const graph = buildGraph(repos);
    const chalk = graph.dependencyNodes.find((d) => d.name === "chalk");
    const lodash = graph.dependencyNodes.find((d) => d.name === "lodash");
    expect(chalk?.shared).toBe(false);
    expect(lodash?.shared).toBe(false);
    expect(sharedDependencies(graph)).toHaveLength(0);
  });

  it("flags a version mismatch when declared ranges resolve to different majors", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { chalk: "^5.3.0" } }),
    ];
    const graph = buildGraph(repos);
    const chalk = graph.dependencyNodes.find((d) => d.name === "chalk");
    expect(chalk?.versionMismatch).toBe(true);
    expect(versionMismatches(graph).map((d) => d.name)).toEqual(["chalk"]);
  });

  it("does not flag a version mismatch when shared repos agree on major version", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^5.0.0" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { chalk: "^5.3.0" } }),
    ];
    const graph = buildGraph(repos);
    const chalk = graph.dependencyNodes.find((d) => d.name === "chalk");
    expect(chalk?.versionMismatch).toBe(false);
  });

  it("does not flag a mismatch when all repos declare the identical unparseable spec", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { internal: "workspace:*" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { internal: "workspace:*" } }),
    ];
    const graph = buildGraph(repos);
    const internal = graph.dependencyNodes.find((d) => d.name === "internal");
    expect(internal?.versionMismatch).toBe(false);
  });

  it("conservatively flags a mismatch when specs differ and at least one is unparseable", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { pkg: "^5.0.0" } }),
      makeRepo({ owner: "b", repo: "demo-b", dependencies: { pkg: "latest" } }),
    ];
    const graph = buildGraph(repos);
    const pkg = graph.dependencyNodes.find((d) => d.name === "pkg");
    expect(pkg?.versionMismatch).toBe(true);
  });

  it("never flags a mismatch for a non-shared dependency, even with an unusual range", () => {
    const repos = [makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2" } })];
    const graph = buildGraph(repos);
    const chalk = graph.dependencyNodes.find((d) => d.name === "chalk");
    expect(chalk?.shared).toBe(false);
    expect(chalk?.versionMismatch).toBe(false);
  });

  it("tracks devDependencies separately with a dev flag, and includes them in shared/mismatch checks", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", devDependencies: { vitest: "^2.0.0" } }),
      makeRepo({ owner: "b", repo: "demo-b", devDependencies: { vitest: "^3.0.0" } }),
    ];
    const graph = buildGraph(repos);
    const vitest = graph.dependencyNodes.find((d) => d.name === "vitest");
    expect(vitest?.shared).toBe(true);
    expect(vitest?.versionMismatch).toBe(true);
    expect(vitest?.usedBy.every((u) => u.dev)).toBe(true);
  });

  it("builds one edge per repo-dependency declaration", () => {
    const repos = [
      makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2", lodash: "^4.17.0" } }),
    ];
    const graph = buildGraph(repos);
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges.map((e) => e.source)).toEqual(["a/demo-a", "a/demo-a"]);
  });

  it("returns empty graph for no repos", () => {
    const graph = buildGraph([]);
    expect(graph.repoNodes).toEqual([]);
    expect(graph.dependencyNodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});

describe("impactOf", () => {
  const repos = [
    makeRepo({ owner: "a", repo: "demo-a", dependencies: { chalk: "^4.1.2" } }),
    makeRepo({ owner: "b", repo: "demo-b", dependencies: { chalk: "^5.3.0" } }),
    makeRepo({ owner: "c", repo: "demo-c", dependencies: { lodash: "^4.17.0" } }),
  ];

  it("returns null when no registered repo depends on the given name", () => {
    expect(impactOf(repos, "left-pad")).toBeNull();
  });

  it("returns every repo using the dependency, with owner/repo/version", () => {
    const impact = impactOf(repos, "chalk");
    expect(impact?.usedBy).toHaveLength(2);
    expect(impact?.usedBy.map((u) => `${u.owner}/${u.repo}`).sort()).toEqual(["a/demo-a", "b/demo-b"]);
  });

  it("does not include unrelated repos", () => {
    const impact = impactOf(repos, "lodash");
    expect(impact?.usedBy).toHaveLength(1);
    expect(impact?.usedBy[0]?.owner).toBe("c");
  });
});
