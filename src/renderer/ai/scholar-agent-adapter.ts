import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import type { AgentStreamParams } from "@shared/rpc-types";
import { onAgentChunk, rpc } from "../rpc";

const HISTORY_MESSAGE_LIMIT = 4_000;
const HISTORY_TOTAL_LIMIT = 16_000;
const STREAM_FLUSH_INTERVAL_MS = 24;
const STREAM_CHARS_PER_FLUSH = 18;

type ScholarAgentRunConfig = Omit<AgentStreamParams, "message" | "history"> & {
  onComplete?: (assistantMessage: string, status: "complete" | "error" | "aborted") => Promise<void> | void;
  ignoreHistory?: boolean;
};

function textFromMessage(message: ThreadMessage): string {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");
}

function trimHistoryText(text: string): string {
  const normalized = text.trim();
  if (normalized.length <= HISTORY_MESSAGE_LIMIT) return normalized;
  const head = normalized.slice(0, Math.floor(HISTORY_MESSAGE_LIMIT * 0.7));
  const tail = normalized.slice(-Math.floor(HISTORY_MESSAGE_LIMIT * 0.2));
  return `${head}\n\n[...previous message truncated...]\n\n${tail}`;
}

function compactHistory(messages: readonly ThreadMessage[]): AgentStreamParams["history"] {
  let total = 0;
  const history: AgentStreamParams["history"] = [];

  for (const message of messages.slice(0, -1).reverse()) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const content = trimHistoryText(textFromMessage(message));
    if (!content) continue;
    if (message.role === "assistant" && content.startsWith("❌")) continue;
    if (total + content.length > HISTORY_TOTAL_LIMIT) break;
    history.unshift({ role: message.role, content });
    total += content.length;
    if (history.length >= 8) break;
  }

  return history;
}

export function createScholarAgentAdapter(
  buildParams: (
    messages: readonly ThreadMessage[],
    message: string,
  ) => ScholarAgentRunConfig | Promise<ScholarAgentRunConfig>,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }) {
      const last = messages.at(-1);
      const message = last ? textFromMessage(last) : "";
      const { onComplete, ignoreHistory, ...base } = await buildParams(messages, message);
      let received = "";
      let visible = "";
      let done = false;
      let wasAborted = false;
      let notify: (() => void) | null = null;

      const off = onAgentChunk((content, isDone) => {
        if (content) received += content;
        done = isDone;
        notify?.();
      });

      abortSignal.addEventListener("abort", () => {
        wasAborted = true;
        rpc.abortAgentStream().catch(console.error);
      });

      try {
        await rpc.agentStream({
          ...base,
          message,
          history: ignoreHistory ? [] : compactHistory(messages),
        });

        while (!done || visible.length < received.length) {
          if (visible.length < received.length) {
            const remaining = received.length - visible.length;
            const step = Math.min(
              remaining,
              remaining > 800 ? STREAM_CHARS_PER_FLUSH * 4 : STREAM_CHARS_PER_FLUSH,
            );
            visible = received.slice(0, visible.length + step);
            yield { content: [{ type: "text", text: visible }] };
            await new Promise((resolve) => setTimeout(resolve, STREAM_FLUSH_INTERVAL_MS));
            continue;
          }

          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }

        yield { content: [{ type: "text", text: received }] };
      } finally {
        off();
        const status = wasAborted ? "aborted" : received.trim().startsWith("❌") ? "error" : "complete";
        await onComplete?.(received, status);
      }
    },
  };
}
