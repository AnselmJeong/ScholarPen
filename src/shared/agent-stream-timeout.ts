export const AGENT_FIRST_RESPONSE_TIMEOUT_MS = 120_000;
export const AGENT_STREAM_IDLE_TIMEOUT_MS = 60_000;

// The renderer is a last-resort guard for a lost Bun → webview completion
// event, so it waits slightly longer than the Bun-side deadlines.
export const AGENT_RENDERER_FIRST_RESPONSE_TIMEOUT_MS =
  AGENT_FIRST_RESPONSE_TIMEOUT_MS + 15_000;
export const AGENT_RENDERER_IDLE_TIMEOUT_MS =
  AGENT_STREAM_IDLE_TIMEOUT_MS + 15_000;

export type AgentStreamTimeoutPhase = "first-response" | "idle";

export class AgentStreamTimeoutError extends Error {
  readonly phase: AgentStreamTimeoutPhase;
  readonly timeoutMs: number;

  constructor(phase: AgentStreamTimeoutPhase, timeoutMs: number) {
    super(`Agent stream timed out during ${phase} after ${timeoutMs}ms.`);
    this.name = "AgentStreamTimeoutError";
    this.phase = phase;
    this.timeoutMs = timeoutMs;
  }
}

export async function withAgentStreamTimeout<T>(
  operation: Promise<T>,
  phase: AgentStreamTimeoutPhase,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AgentStreamTimeoutError(phase, timeoutMs);
      // Reject first so an AbortError caused by onTimeout cannot mask the
      // more useful timeout diagnosis.
      reject(error);
      onTimeout?.();
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function agentStreamTimeoutMessage(
  lang: "ko" | "en",
  phase: AgentStreamTimeoutPhase,
): string {
  if (lang === "ko") {
    return phase === "first-response"
      ? "AI가 120초 안에 응답을 시작하지 못해 요청을 종료했습니다. 인터넷 연결과 AI 제공자/API 키·모델 설정을 확인한 뒤 다시 시도해 주세요."
      : "AI 응답이 60초 동안 중단되어 연결을 종료했습니다. 일시적인 네트워크 또는 제공자 문제일 수 있으니 다시 시도해 주세요.";
  }

  return phase === "first-response"
    ? "The AI did not start responding within 120 seconds, so the request was stopped. Check your internet connection and provider, API key, and model settings, then try again."
    : "The AI response stopped for 60 seconds, so the connection was closed. This may be a temporary network or provider problem; please try again.";
}
