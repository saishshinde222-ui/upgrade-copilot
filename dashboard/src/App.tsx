import { useCallback, useEffect, useState } from "react";
import "./App.css";
import {
  getApiKey,
  getGraph,
  listRepos,
  refreshRepo,
  registerReposBulk,
  removeRepo,
  setApiKey,
  verifyDependency,
  type DependencyGraph as DependencyGraphData,
  type RepoSummary,
} from "./api";
import { RepoManager } from "./components/RepoManager";
import { DependencyGraph } from "./components/DependencyGraph";
import { DependencyPanel } from "./components/DependencyPanel";
import { SessionView } from "./components/SessionView";

function App() {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [graph, setGraph] = useState<DependencyGraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDependency, setSelectedDependency] = useState<string | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState(() => getApiKey());

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

  function handleSaveApiKey() {
    setApiKey(apiKeyInput.trim());
    refreshAll().catch((err) => console.error("Failed to reload after saving API key", err));
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Upgrade Copilot</h1>
        <p>Cross-repo dependency graph + sandboxed upgrade verification, powered by TrueForge.</p>
        <div className="api-key-row">
          <label htmlFor="api-key">API key</label>
          <input
            id="api-key"
            type="password"
            placeholder="Backend API_KEY"
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <button onClick={handleSaveApiKey}>Save</button>
        </div>
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
        {activeSessionId && <SessionView sessionId={activeSessionId} />}
      </div>
    </div>
  );
}

export default App;
