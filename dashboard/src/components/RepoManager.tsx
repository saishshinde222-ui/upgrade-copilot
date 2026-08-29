import { useState } from "react";
import type { RepoSummary } from "../api";

interface Props {
  repos: RepoSummary[];
  loading: boolean;
  onAdd: (urls: string[]) => Promise<void>;
  onRefresh: (id: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}

export function RepoManager({ repos, loading, onAdd, onRefresh, onRemove }: Props) {
  const [input, setInput] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleAdd() {
    const urls = input
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (urls.length === 0) return;
    setError(null);
    try {
      await onAdd(urls);
      setInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add repos");
    }
  }

  async function handleRefresh(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onRefresh(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to refresh repo");
    } finally {
      setBusyId(null);
    }
  }

  async function handleRemove(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await onRemove(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove repo");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="panel repo-manager">
      <h2>Repositories</h2>
      <textarea
        placeholder="https://github.com/owner/repo (one per line for bulk add)"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        rows={3}
      />
      <button onClick={handleAdd} disabled={loading || input.trim().length === 0}>
        {loading ? "Adding…" : "Add repo(s)"}
      </button>
      {error && <p className="error-text">{error}</p>}

      <ul className="repo-list">
        {repos.map((repo) => (
          <li key={repo.id} className="repo-item">
            <div>
              <strong>
                {repo.owner}/{repo.repo}
              </strong>
              <div className="repo-meta">
                {repo.dependencyCount} dependencies · last fetched{" "}
                {new Date(repo.lastFetchedAt).toLocaleTimeString()}
              </div>
            </div>
            <div className="repo-actions">
              <button onClick={() => handleRefresh(repo.id)} disabled={busyId === repo.id}>
                Refresh
              </button>
              <button className="danger" onClick={() => handleRemove(repo.id)} disabled={busyId === repo.id}>
                Remove
              </button>
            </div>
          </li>
        ))}
        {repos.length === 0 && <li className="empty">No repos registered yet.</li>}
      </ul>
    </section>
  );
}
