import { useCallback, useEffect, useState } from "react";
import "./App.css";
import {
  getGraph,
  listRepos,
  refreshRepo,
  registerReposBulk,
  removeRepo,
  verifyDependency,
  type DependencyGraph as DependencyGraphData,
  type RepoSummary,
} from "./api";
import { RepoManager } from "./components/RepoManager";
import { DependencyGraph } from "./components/DependencyGraph";
import { DependencyPanel } from "./components/DependencyPanel";
import { SessionView } from "./components/SessionView";
import { ApprovalDrawer, type PendingApproval } from "./components/ApprovalDrawer";
import type { SessionEvent, ToolApprovalRequiredEvent } from "./events";

function App() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [graph, setGraph] = useState<DependencyGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDependency, setSelectedDependency] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);

  const refreshAll = useCallback(async () => {
    const [repoList, graphData] = await Promise.all([listRepos(), getGraph()]);
    setRepos(repoList);
    setGraph(graphData);
  }, []);

  useEffect(() => {
    refreshAll().catch((err) => console.error("Failed to load initial state", err));
  }, [refreshAll]);

  async function handleAddRepos(urls: string[]) {
    setLoading(true);
    try {
      const results = await registerReposBulk(urls);
      const failed = results.filter((r) => !r.success);
      await refreshAll();
      if (failed.length > 0) {
        throw new Error(failed.map((f) => `${f.url}: ${f.error}`).join("; "));
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRefreshRepo(id: string) {
    await refreshRepo(id);
    await refreshAll();
  }

  async function handleRemoveRepo(id: string) {
    await removeRepo(id);
    await refreshAll();
  }

  async function handleVerify(dependencyName: string, targetVersion: string) {
    const { sessionId } = await verifyDependency(dependencyName, targetVersion);
    setActiveSessionId(sessionId);
    setSelectedDependency(null);
  }

  function handleApprovalRequired(event: ToolApprovalRequiredEvent, contextEvents: SessionEvent[]) {
    if (!activeSessionId) return;
    setPendingApproval({ sessionId: activeSessionId, event, contextEvents });
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Upgrade Copilot</h1>
        <p>Cross-repo dependency graph + sandboxed upgrade verification, powered by TrueForge.</p>
      </header>

      <div className="app-body">
        <RepoManager repos={repos} loading={loading} onAdd={handleAddRepos} onRefresh={handleRefreshRepo} onRemove={handleRemoveRepo} />
        <DependencyGraph graph={graph} onSelectDependency={setSelectedDependency} />
        {selectedDependency && graph && (
          <DependencyPanel
            dependencyName={selectedDependency}
            graph={graph}
            repos={repos}
            onVerify={handleVerify}
            onClose={() => setSelectedDependency(null)}
          />
        )}
        {activeSessionId && <SessionView sessionId={activeSessionId} onApprovalRequired={handleApprovalRequired} />}
      </div>

      {pendingApproval && (
        <ApprovalDrawer pending={pendingApproval} onResolved={() => setPendingApproval(null)} />
      )}
    </div>
  );
}

export default App;
