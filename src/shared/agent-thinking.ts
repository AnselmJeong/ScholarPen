import type { AgentThinkingLevel, LLMProvider } from "./rpc-types";

export const AGENT_THINKING_LEVELS = ["none", "low", "medium", "high"] as const;

// Keep provider payloads and the composer's capability explanation together.
export function agentThinkingConfig(provider: LLMProvider, model: string, level: AgentThinkingLevel = "none"): {
  fields: Record<string, unknown>;
  notice?: string;
  supported?: boolean;
} {
  if (provider === "codex") return {
    fields: {},
    notice: "선택한 Codex 모델이 지원하는 thinking 단계를 적용합니다. 지원하지 않는 단계는 해당 모델의 기본값을 사용합니다.",
  };
  const id = model.toLowerCase();
  const enabled = level !== "none";
  if (provider === "ollama") {
    if (id.includes("gpt-oss")) {
      return {
        fields: { reasoning_effort: enabled ? level : "low" },
        notice: "이 모델은 thinking을 끌 수 없어 None 선택 시 Low로 실행합니다.",
      };
    }
    return {
      // /v1/chat/completions uses reasoning_effort, not the native API's think.
      fields: { reasoning_effort: level },
      notice: "Thinking 단계 지원은 모델에 따라 다릅니다. 켜기/끄기만 지원하는 모델에서는 Low·Medium·High가 동일하게 적용됩니다.",
    };
  }
  if (provider === "deepseek") {
    const legacy = /^deepseek-(chat|reasoner)$/.test(id);
    return {
      fields: {
        // Legacy aliases select the thinking mode through the model name.
        ...(legacy ? { model: enabled ? "deepseek-reasoner" : "deepseek-chat" } : {}),
        thinking: { type: enabled ? "enabled" : "disabled" },
        ...(!legacy && enabled ? { reasoning_effort: level === "medium" ? "high" : level } : {}),
      },
      notice: legacy
        ? "None은 deepseek-chat, 나머지 단계는 deepseek-reasoner로 실행합니다. 이 모델은 세부 단계 조절을 지원하지 않습니다."
        : "이 모델에서는 Medium이 High로 적용됩니다.",
    };
  }
  if (provider === "anthropic") return {
    fields: {},
    notice: "Claude 구독 연결에서는 CLI의 effort를 사용합니다. None은 Low로 실행하며, 지원 범위는 선택한 모델에 따라 다릅니다.",
  };
  if (/^gpt-5(?:[.-]|$)|^o[134](?:-|$)/.test(id) && !id.includes("chat") && !/^o1-(?:mini|preview)/.test(id)) {
    const supportsNone = /^gpt-5\.[1-9]/.test(id) && !id.includes("pro") && !id.includes("codex");
    const onlyHigh = id === "gpt-5-pro" || id.startsWith("gpt-5-pro-");
    return {
      fields: { reasoning_effort: onlyHigh ? "high" : !enabled && !supportsNone ? "low" : level },
      notice: onlyHigh
        ? "이 모델은 High thinking만 지원합니다."
        : !supportsNone ? "이 모델은 thinking을 끌 수 없어 None 선택 시 Low로 실행합니다." : undefined,
    };
  }
  return { fields: {}, supported: false, notice: "이 모델의 thinking 조절은 지원되지 않습니다." };
}
