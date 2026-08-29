export interface ToolCallInfo {
  id: string;
  function?: { name?: string; arguments?: string };
  toolInfo?: { type?: string; name?: string };
}

export interface ThreadCreatedEvent {
  type: "thread.created";
  id: string;
  threadId: string;
  title: string;
  agentInfo: { type: string; name: string; input: string; model?: string };
  parent: { threadId: string; toolCallId: string };
  createdAt: string;
}

export interface ModelMessageEvent {
  type: "model.message";
  id: string;
  threadId: string;
  content?: string | Array<{ type: string; text?: string }> | null;
  toolCalls?: ToolCallInfo[];
  createdAt: string;
}

export interface ToolCallRef {
  id: string;
  sourceEventId: string;
}

export interface ToolApprovalRequiredEvent {
  type: "tool.approval_required";
  id: string;
  threadId: string;
  toolCalls: ToolCallRef[];
  createdAt: string;
}

export interface ToolResponseEvent {
  type: "tool.response";
  id: string;
  threadId: string;
  toolCallId: string;
  content: string;
  createdAt: string;
}

export interface SandboxCreatedEvent {
  type: "sandbox.created";
  id: string;
  sandboxId: string;
  /** Always null — sandbox is session-scoped, not thread-scoped. */
  threadId: string | null;
  createdAt: string;
}

export interface TurnDoneEvent {
  type: "turn.done";
  id: string;
  threadId: string | null;
  state: { status: string; output?: ModelMessageEvent | null };
  createdAt: string;
}

export interface ThreadDoneEvent {
  type: "thread.done";
  id: string;
  threadId: string;
  createdAt: string;
}

/** Synthetic terminal event the backend injects when a turn stream breaks after it started —
 *  the SDK's own event union has nothing for "this stream broke". */
export interface SessionErrorEvent {
  type: "session.error";
  id: string;
  threadId: null;
  createdAt: string;
  message: string;
}

export interface GenericSessionEvent {
  type: string;
  id?: string;
  threadId?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export type SessionEvent =
  | ThreadCreatedEvent
  | ModelMessageEvent
  | ToolApprovalRequiredEvent
  | ToolResponseEvent
  | SandboxCreatedEvent
  | TurnDoneEvent
  | ThreadDoneEvent
  | SessionErrorEvent
  | GenericSessionEvent;

export function messageText(content: ModelMessageEvent["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

/** Finds the ToolCallInfo (name + arguments) for a pending tool call id, by scanning
 *  model.message events for the toolCalls entry that originally requested it. */
export function findToolCall(events: SessionEvent[], toolCallId: string): ToolCallInfo | undefined {
  for (const event of events) {
    if (event.type === "model.message") {
      const match = (event as ModelMessageEvent).toolCalls?.find((tc) => tc.id === toolCallId);
      if (match) return match;
    }
  }
  return undefined;
}
