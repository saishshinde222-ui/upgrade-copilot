import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSessionEvents, subscribeToSessionStream } from "../api";
import {
  messageText,
  type ModelMessageEvent,
  type SessionEvent,
  type ThreadCreatedEvent,
  type ToolApprovalRequiredEvent,
} from "../events";
import { ApprovalDrawer } from "./ApprovalDrawer";

interface Props {
  sessionId: string;
}

interface Lane {
  threadId: string;
  title: string;
  isMain: boolean;
  events: SessionEvent[];
}

export function SessionView({ sessionId }: Props) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  // Queue of tool.approval_required event ids awaiting a human decision, oldest first —
  // a singleton would drop concurrent approvals from different subagent threads.
  const [pendingApprovalIds, setPendingApprovalIds] = useState<string[]>([]);
  const seenIds = useRef<Set<string>>(new Set());
  const notifiedApprovals = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    setPendingApprovalIds([]);
    seenIds.current = new Set();
    notifiedApprovals.current = new Set();

    function append(next: SessionEvent) {
      if (cancelled) return;
      const id = next.id;
      if (id) {
        if (seenIds.current.has(id)) return;
        seenIds.current.add(id);
      }
      setEvents((prev) => [...prev, next]);
    }

    fetchSessionEvents(sessionId)
      .then((initial) => {
        if (cancelled) return;
        for (const e of initial) append(e);
      })
      .catch(() => {
        // stream below will still populate the view
      });

    const controller = new AbortController();
    // Reconnects internally on any disconnect until aborted, so this promise only ever
    // resolves (once aborted) and never needs a rejection handler here.
    void subscribeToSessionStream(
      sessionId,
      (raw) => {
        try {
          append(JSON.parse(raw) as SessionEvent);
        } catch {
          // ignore malformed frames
        }
      },
      controller.signal,
    );

    return () => {
      // Guards the fetchSessionEvents().then() above: without this, a response that resolves
      // after sessionId changes could append stale events into the new session's state.
      cancelled = true;
      controller.abort();
    };
  }, [sessionId]);

  useEffect(() => {
    for (const event of events) {
      if (event.type === "tool.approval_required" && event.id && !notifiedApprovals.current.has(event.id)) {
        notifiedApprovals.current.add(event.id);
        setPendingApprovalIds((prev) => [...prev, event.id!]);
      }
    }
  }, [events]);

  const lanes = useMemo<Lane[]>(() => {
    const laneMap = new Map<string, Lane>();
    laneMap.set("main", { threadId: "main", title: "Main agent", isMain: true, events: [] });

    for (const event of events) {
      if (event.type === "thread.created") {
        const created = event as ThreadCreatedEvent;
        laneMap.set(created.threadId, {
          threadId: created.threadId,
          title: created.title || created.agentInfo?.name || created.threadId,
          isMain: false,
          events: [],
        });
      }
    }

    for (const event of events) {
      const threadId = event.threadId ?? "main";
      const lane = laneMap.get(threadId) ?? { threadId, title: threadId, isMain: false, events: [] };
      lane.events.push(event);
      laneMap.set(threadId, lane);
    }

    return Array.from(laneMap.values()).filter((lane) => lane.events.length > 0);
  }, [events]);

  const prLinks = useMemo(() => {
    const found = new Set<string>();
    const re = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
    for (const event of events) {
      if (event.type === "tool.response") {
        const content = String((event as { content?: unknown }).content ?? "");
        for (const match of content.matchAll(re)) found.add(match[0]);
      }
    }
    return Array.from(found);
  }, [events]);

  // Always re-derived from the current `events` state (not a snapshot frozen at notification
  // time), so if the drawer opens before the tool call's originating model.message has been
  // replayed, it picks up the tool name/arguments as soon as that event arrives.
  const currentApprovalId = pendingApprovalIds[0];
  const currentApprovalEvent = currentApprovalId
    ? (events.find((e) => e.id === currentApprovalId) as ToolApprovalRequiredEvent | undefined)
    : undefined;

  return (
    <section className="panel session-view">
      <h2>Live verification — session {sessionId.slice(0, 12)}…</h2>
      {prLinks.length > 0 && (
        <div className="pr-links">
          {prLinks.map((url) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              Pull request opened: {url}
            </a>
          ))}
        </div>
      )}
      <div className="lanes">
        {lanes.map((lane) => (
          <LaneCard key={lane.threadId} lane={lane} />
        ))}
      </div>
      {currentApprovalEvent && (
        <ApprovalDrawer
          key={currentApprovalEvent.id}
          sessionId={sessionId}
          event={currentApprovalEvent}
          contextEvents={events}
          onResolved={() => setPendingApprovalIds((prev) => prev.slice(1))}
        />
      )}
    </section>
  );
}

function LaneCard({ lane }: { lane: Lane }) {
  return (
    <div className={`lane ${lane.isMain ? "lane-main" : "lane-sub"}`}>
      <div className="lane-title">{lane.title}</div>
      <div className="lane-body">
        {lane.events.map((event, i) => (
          <EventLine key={event.id ?? i} event={event} />
        ))}
      </div>
    </div>
  );
}

function EventLine({ event }: { event: SessionEvent }) {
  switch (event.type) {
    case "model.message": {
      const text = messageText((event as ModelMessageEvent).content);
      const toolCalls = (event as ModelMessageEvent).toolCalls ?? [];
      return (
        <div className="event event-message">
          {text && <p>{text}</p>}
          {toolCalls.map((tc) => (
            <div key={tc.id} className="event-tool-call">
              → calling <code>{tc.function?.name ?? tc.toolInfo?.name ?? "tool"}</code>
            </div>
          ))}
        </div>
      );
    }
    case "tool.response": {
      const content = String(event.content ?? "");
      return (
        <div className="event event-tool-response">
          <code>{content.slice(0, 200)}</code>
        </div>
      );
    }
    case "tool.approval_required":
      return <div className="event event-approval">⏸ Approval required — see the drawer</div>;
    case "sandbox.created":
      return <div className="event event-info">🧪 Sandbox created</div>;
    case "thread.created":
      return <div className="event event-info">🧵 Subagent spawned</div>;
    case "thread.done":
      return <div className="event event-info">✅ Subagent finished</div>;
    case "turn.done":
      return <div className="event event-info">■ Turn done ({(event as { state?: { status?: string } }).state?.status})</div>;
    case "session.error":
      return <div className="event event-error">⚠ Verification stream failed: {String(event.message ?? "unknown error")}</div>;
    default:
      return null;
  }
}
