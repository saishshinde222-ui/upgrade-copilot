import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSessionEvents, streamSessionUrl } from "../api";
import { messageText, type ModelMessageEvent, type SessionEvent, type ThreadCreatedEvent, type ToolApprovalRequiredEvent } from "../events";

interface Props {
  sessionId: string;
  onApprovalRequired: (event: ToolApprovalRequiredEvent, allEvents: SessionEvent[]) => void;
}

interface Lane {
  threadId: string;
  title: string;
  isMain: boolean;
  events: SessionEvent[];
}

export function SessionView({ sessionId, onApprovalRequired }: Props) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const seenIds = useRef<Set<string>>(new Set());
  const notifiedApprovals = useRef<Set<string>>(new Set());

  useEffect(() => {
    setEvents([]);
    seenIds.current = new Set();
    notifiedApprovals.current = new Set();

    function append(next: SessionEvent) {
      const id = next.id;
      if (id) {
        if (seenIds.current.has(id)) return;
        seenIds.current.add(id);
      }
      setEvents((prev) => [...prev, next]);
    }

    fetchSessionEvents(sessionId)
      .then((initial) => {
        for (const e of initial) append(e);
      })
      .catch(() => {
        // stream below will still populate the view
      });

    const source = new EventSource(streamSessionUrl(sessionId));
    source.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as SessionEvent;
        append(parsed);
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [sessionId]);

  useEffect(() => {
    for (const event of events) {
      if (event.type === "tool.approval_required" && event.id && !notifiedApprovals.current.has(event.id)) {
        notifiedApprovals.current.add(event.id);
        onApprovalRequired(event as ToolApprovalRequiredEvent, events);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    default:
      return null;
  }
}
