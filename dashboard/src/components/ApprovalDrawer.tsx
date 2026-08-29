import { useEffect, useState } from "react";
import { respondApproval } from "../api";
import { findToolCall, type SessionEvent, type ToolApprovalRequiredEvent } from "../events";

interface Props {
  sessionId: string;
  event: ToolApprovalRequiredEvent;
  /** The session's live event list — read fresh on every render (not a snapshot), so if this
   *  drawer opens before the tool call's originating model.message has replayed, it still
   *  picks up the real tool name/arguments once that event arrives. */
  contextEvents: SessionEvent[];
  onResolved: () => void;
}

export function ApprovalDrawer({ sessionId, event, contextEvents, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<{ status: "allow" | "deny" } | null>(null);

  // A parent component gives every pending approval its own component instance (keyed by
  // event.id), so this timer only ever belongs to the approval it was set for — but it's
  // still cleared on unmount so a fast-resolving-then-remounting parent can't leak it.
  useEffect(() => {
    if (!resolution) return;
    const timer = setTimeout(onResolved, 1500);
    return () => clearTimeout(timer);
  }, [resolution, onResolved]);

  const toolCall = event.toolCalls[0];
  const info = toolCall ? findToolCall(contextEvents, toolCall.id) : undefined;
  const toolName = info?.function?.name ?? info?.toolInfo?.name ?? "unknown tool";
  let args: unknown = info?.function?.arguments;
  try {
    if (typeof args === "string") args = JSON.parse(args);
  } catch {
    // leave as raw string if not JSON
  }

  async function decide(status: "allow" | "deny") {
    if (!toolCall) return;
    setBusy(true);
    setError(null);
    try {
      await respondApproval(sessionId, {
        threadId: event.threadId,
        toolCallId: toolCall.id,
        approval: status === "allow" ? { status: "allow" } : { status: "deny", reason: "Denied from dashboard" },
      });
      setResolution({ status });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to submit approval");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-overlay">
      <div className="approval-drawer">
        <h2>Approval required</h2>
        <p>
          The agent wants to call <code>{toolName}</code>. This is a write action that will affect a real
          repository. Review the arguments before approving.
        </p>
        <pre className="approval-args">{JSON.stringify(args ?? {}, null, 2)}</pre>

        {resolution ? (
          <p className={resolution.status === "allow" ? "success-text" : "warning-banner"}>
            {resolution.status === "allow" ? "Approved — agent will proceed." : "Denied — no changes were made."}
          </p>
        ) : (
          <div className="approval-actions">
            <button className="approve" onClick={() => decide("allow")} disabled={busy}>
              Approve
            </button>
            <button className="danger" onClick={() => decide("deny")} disabled={busy}>
              Discard
            </button>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
