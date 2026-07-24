import type { ChatModelAdapter, ThreadMessage } from "@assistant-ui/react";
import type { AgentStreamParams } from "@shared/rpc-types";
import {
  AGENT_RENDERER_FIRST_RESPONSE_TIMEOUT_MS,
  AGENT_RENDERER_IDLE_TIMEOUT_MS,
  agentStreamTimeoutMessage,
} from "@shared/agent-stream-timeout";
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
      let streamFailed = false;
      let receivedEvent = false;
      let lastEventAt = Date.now();
      let notify: (() => void) | null = null;

      const off = onAgentChunk((content, isDone) => {
        if (content) received += content;
        if (content.includes("❌")) streamFailed = true;
        done = isDone;
        receivedEvent = true;
        lastEventAt = Date.now();
        notify?.();
      });

      abortSignal.addEventListener("abort", () => {
        wasAborted = true;
        done = true;
        notify?.();
        rpc.abortAgentStream().catch(console.error);
      }, { once: true });

      try {
        try {
          await rpc.agentStream({
            ...base,
            message,
            history: ignoreHistory ? [] : compactHistory(messages),
          });
        } catch (error) {
          if (abortSignal.aborted) {
            wasAborted = true;
            done = true;
          } else {
            streamFailed = true;
            done = true;
            const detail = error instanceof Error && error.message.trim()
              ? ` (${error.message.trim().slice(0, 300)})`
              : "";
            received = base.lang === "ko"
              ? `❌ AI 요청을 시작하지 못했습니다. 연결과 제공자 설정을 확인한 뒤 다시 시도해 주세요.${detail}`
              : `❌ The AI request could not be started. Check the connection and provider settings, then try again.${detail}`;
          }
        }

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

          const timeoutMs = receivedEvent
            ? AGENT_RENDERER_IDLE_TIMEOUT_MS
            : AGENT_RENDERER_FIRST_RESPONSE_TIMEOUT_MS;
          const remainingMs = Math.max(0, timeoutMs - (Date.now() - lastEventAt));
          const waitResult = await new Promise<"activity" | "timeout">((resolve) => {
            const timer = setTimeout(() => resolve("timeout"), remainingMs);
            notify = () => {
              clearTimeout(timer);
              resolve("activity");
            };
          });
          notify = null;

          if (waitResult === "timeout" && !done && !wasAborted) {
            streamFailed = true;
            const phase = receivedEvent ? "idle" : "first-response";
            const messageText = agentStreamTimeoutMessage(base.lang, phase);
            received += `${received.trim() ? "\n\n" : ""}❌ ${messageText}`;
            done = true;
            rpc.abortAgentStream().catch(console.error);
          }
        }

        yield { content: [{ type: "text", text: received }] };
      } finally {
        off();
        const status = wasAborted ? "aborted" : streamFailed ? "error" : "complete";
        await onComplete?.(received, status);
      }
    },
  };
}
