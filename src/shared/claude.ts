export interface ClaudeStatus {
  state: "unavailable" | "signedOut" | "signingIn" | "connected" | "error";
  cliPath?: string;
  cliVersion?: string;
  email?: string;
  plan?: string;
  error?: string;
  quota?: { status: string; resetsAt?: number; utilization?: number; checkedAt: number };
}

// Official CLI aliases, not a claim that every account can access every model.
export const CLAUDE_MODELS = ["sonnet", "opus", "haiku"];
export const CLAUDE_LIMIT_ERROR = "Claude 구독 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 시도해 주세요. 유료 API로 전환하지 않았습니다.";
