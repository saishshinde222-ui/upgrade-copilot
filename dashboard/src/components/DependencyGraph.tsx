import { useMemo } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DependencyGraph as DependencyGraphData } from "../api";

interface Props {
  graph: DependencyGraphData | null;
  onSelectDependency: (name: string) => void;
}

const REPO_SPACING = 220;
const DEP_SPACING = 200;

export function DependencyGraph({ graph, onSelectDependency }: Props) {
  const { nodes, edges } = useMemo<{ nodes: Node[]; edges: Edge[] }>(() => {
    if (!graph) return { nodes: [], edges: [] };

    const repoWidth = graph.repoNodes.length * REPO_SPACING;
    const depWidth = graph.dependencyNodes.length * DEP_SPACING;
    const width = Math.max(repoWidth, depWidth, REPO_SPACING);

    const repoNodes: Node[] = graph.repoNodes.map((repo, i) => ({
      id: repo.id,
      position: { x: (i + 0.5) * (width / graph.repoNodes.length) - 90, y: 0 },
      data: { label: repo.label },
      style: {
        background: "#1d4ed8",
        color: "white",
        borderRadius: 8,
        border: "1px solid #1e3a8a",
        padding: 8,
        width: 180,
        fontSize: 12,
        textAlign: "center" as const,
      },
    }));

    const depNodes: Node[] = graph.dependencyNodes.map((dep, i) => {
      const isFlagged = dep.versionMismatch;
      const isShared = dep.shared;
      return {
        id: dep.id,
        position: { x: (i + 0.5) * (width / graph.dependencyNodes.length) - 80, y: 220 },
        data: { label: `${dep.name}${isShared ? ` (${dep.usedBy.length} repos)` : ""}`, kind: "dependency", name: dep.name },
        style: {
          background: isFlagged ? "#7f1d1d" : isShared ? "#78350f" : "#374151",
          color: "white",
          borderRadius: 999,
          border: isFlagged ? "3px solid #ef4444" : isShared ? "2px solid #f59e0b" : "1px solid #4b5563",
          padding: 8,
          width: isShared ? 200 : 150,
          fontSize: 12,
          textAlign: "center" as const,
          fontWeight: isFlagged ? 700 : 400,
          cursor: "pointer",
        },
      };
    });

    const edgeList: Edge[] = graph.edges.map((edge, i) => {
      const depNode = graph.dependencyNodes.find((d) => d.id === edge.target);
      const flagged = depNode?.versionMismatch ?? false;
      return {
        id: `e${i}`,
        source: edge.source,
        target: edge.target,
        label: edge.version,
        animated: flagged,
        style: { stroke: flagged ? "#ef4444" : "#94a3b8" },
        labelStyle: { fill: "#e2e8f0", fontSize: 10 },
      };
    });

    return { nodes: [...repoNodes, ...depNodes], edges: edgeList };
  }, [graph]);

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.data?.kind === "dependency" && typeof node.data.name === "string") {
      onSelectDependency(node.data.name);
    }
  };

  if (!graph || graph.repoNodes.length === 0) {
    return (
      <section className="panel graph-panel">
        <h2>Dependency graph</h2>
        <p className="empty">Register at least one repo to see the graph.</p>
      </section>
    );
  }

  return (
    <section className="panel graph-panel">
      <h2>Dependency graph</h2>
      <div className="graph-legend">
        <span>
          <i className="dot dot-repo" /> repo
        </span>
        <span>
          <i className="dot dot-shared" /> shared dependency
        </span>
        <span>
          <i className="dot dot-mismatch" /> version mismatch
        </span>
      </div>
      <div style={{ height: 420 }}>
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={handleNodeClick} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
    </section>
  );
}
