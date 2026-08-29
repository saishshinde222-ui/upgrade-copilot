import { useState } from "react";
import type { DependencyGraph, RepoSummary } from "../api";

interface Props {
  dependencyName: string;
  graph: DependencyGraph;
  repos: RepoSummary[];
  onVerify: (dependencyName: string, targetVersion: string) => Promise<void>;
  onClose: () => void;
}

export function DependencyPanel({ dependencyName, graph, repos, onVerify, onClose }: Props) {
  const [targetVersion, setTargetVersion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dep = graph.dependencyNodes.find((d) => d.name === dependencyName);
  if (!dep) return null;

  async function handleVerify() {
    if (!targetVersion.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await onVerify(dependencyName, targetVersion.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start verification");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="panel dependency-panel">
      <div className="panel-header">
        <h2>{dependencyName}</h2>
        <button className="ghost" onClick={onClose}>
          ×
        </button>
      </div>
      {dep.versionMismatch && <p className="warning-banner">Version mismatch across repos using this dependency.</p>}
      <table className="usage-table">
        <thead>
          <tr>
            <th>Repo</th>
            <th>Declared version</th>
          </tr>
        </thead>
        <tbody>
          {dep.usedBy.map((usage) => {
            const repo = repos.find((r) => r.id === usage.repoId);
            return (
              <tr key={usage.repoId}>
                <td>{repo ? `${repo.owner}/${repo.repo}` : usage.repoId}</td>
                <td>
                  {usage.version}
                  {usage.dev && <span className="dev-tag">dev</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="verify-form">
        <label htmlFor="target-version">Candidate target version</label>
        <input
          id="target-version"
          placeholder="e.g. ^5.3.0"
          value={targetVersion}
          onChange={(e) => setTargetVersion(e.target.value)}
        />
        <button onClick={handleVerify} disabled={submitting || !targetVersion.trim()}>
          {submitting ? "Starting…" : "Check for upgrade"}
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>
    </aside>
  );
}
