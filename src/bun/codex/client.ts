import type { AgentThinkingLevel, OllamaMessage } from "../../shared/rpc-types";
import type { CodexModel, CodexQuota, CodexQuotaWindow, CodexStatus } from "../../shared/codex";
import { codexQuotaError } from "../../shared/codex";
import { validateAgentImages } from "../../shared/agent-images";
import { CodexTransport, object, string, type JsonObject } from "./transport";

function quotaWindow(value: unknown): CodexQuotaWindow | null {
  const window = object(value);
  if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) return null;
  return {
    usedPercent: window.usedPercent,
    windowDurationMins: typeof window.windowDurationMins === "number" ? window.windowDurationMins : null,
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  };
}

export function parseQuotas(result: JsonObject): CodexQuota[] {
  const buckets = Object.entries(object(result.rateLimitsByLimitId));
  if (!buckets.length && result.rateLimits) buckets.push([string(object(result.rateLimits).limitId) || "default", result.rateLimits]);
  return buckets.map(([id, value]) => {
    const quota = object(value);
    return { id, name: string(quota.limitName) || id, model: string(quota.normalModelSlug) || null, primary: quotaWindow(quota.primary), secondary: quotaWindow(quota.secondary) };
  });
}

export function codexInput(messages: OllamaMessage[]): JsonObject[] {
  const input: JsonObject[] = [];
  for (const message of messages.filter(m => m.role !== "system")) {
    // History is supplied by ScholarPen, which also owns the editor context and tools.
    input.push({ type: "text", text: `[${message.role}]\n${message.content}`, text_elements: [] });
    for (const image of validateAgentImages(message.images)) input.push({ type: "image", url: image.dataUrl });
  }
  return input;
}

function generationError(value: unknown): Error {
  const error = object(value);
  const message = string(error.message) || "Codex 응답 생성에 실패했습니다.";
  const code = JSON.stringify(error.codexErrorInfo ?? "");
  if (/usage.?limit|rate.?limit|quota|limit.?exceeded/i.test(`${code} ${message}`)) {
    return new Error("Codex 구독 사용 한도에 도달했습니다. 한도가 초기화된 뒤 다시 시도해 주세요. 유료 API로 전환하지 않았습니다.");
  }
  return new Error(message);
}

export class CodexClient {
  private transport: CodexTransport | null = null;
  private connecting: Promise<CodexTransport> | null = null;
  private loginId: string | null = null;
  private loginError: string | null = null;
  private activeGenerations = 0;

  constructor(private readonly createTransport = () => new CodexTransport()) {}

  private async connect(): Promise<CodexTransport> {
    if (this.transport) return this.transport;
    if (this.connecting) return this.connecting;
    const connecting = (async () => {
      const transport = this.createTransport();
      await transport.start();
      transport.subscribe((method, params) => {
        if (method === "account/login/completed") {
          this.loginId = null;
          this.loginError = params.success === true ? null : string(params.error) || "ChatGPT 로그인을 완료하지 못했습니다.";
        }
      }, () => {
        if (this.transport === transport) { this.transport = null; this.loginId = null; }
      });
      this.transport = transport;
      return transport;
    })();
    this.connecting = connecting;
    try { return await connecting; } finally { if (this.connecting === connecting) this.connecting = null; }
  }

  async status(): Promise<CodexStatus> {
    let empty: Pick<CodexStatus, "ordinaryUsageAllowed" | "quotas" | "cliPath" | "cliVersion"> = { ordinaryUsageAllowed: null, quotas: [] };
    let transport: CodexTransport;
    try { transport = await this.connect(); }
    catch (error) { return { ...empty, state: "unavailable", error: (error as Error).message }; }
    empty = { ...empty, ...transport.runtime };
    try {
      const result = object(await transport.request("account/read", { refreshToken: false }));
      const account = object(result.account);
      if (account.type !== "chatgpt") {
        if (account.type) return { ...empty, state: "error", error: "이 연결은 ChatGPT 구독 로그인만 허용합니다. 로그아웃 후 ChatGPT로 로그인해 주세요." };
        return { ...empty, state: this.loginId ? "signingIn" : "signedOut", ...(this.loginError ? { error: this.loginError } : {}) };
      }
      const connected = { ...empty, state: "connected" as const, email: string(account.email), plan: string(account.planType) };
      try {
        const limits = object(await transport.request("account/rateLimits/read"));
        return { ...connected, ordinaryUsageAllowed: typeof limits.ordinaryUsageAllowed === "boolean" ? limits.ordinaryUsageAllowed : null, quotas: parseQuotas(limits) };
      } catch {
        return { ...connected, error: "구독 사용 한도를 확인하지 못했습니다. 새로고침 후 다시 시도해 주세요." };
      }
    } catch (error) { return { ...empty, state: "error", error: (error as Error).message }; }
  }

  async refresh(): Promise<CodexStatus> {
    if (this.activeGenerations) throw new Error("Codex가 응답을 생성 중입니다. 완료하거나 취소한 뒤 새로고침해 주세요.");
    if (this.connecting) await this.connecting;
    // A generation may have begun while waiting for startup.
    if (this.activeGenerations) throw new Error("Codex가 응답을 생성 중입니다. 완료하거나 취소한 뒤 새로고침해 주세요.");
    if (!this.loginId) this.close();
    return this.status();
  }

  async login(): Promise<string> {
    const transport = await this.connect();
    if (this.loginId) await this.cancelLogin();
    this.loginError = null;
    const result = object(await transport.request("account/login/start", { type: "chatgpt" }));
    const url = new URL(string(result.authUrl));
    if (result.type !== "chatgpt" || !string(result.loginId) || url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname)) {
      throw new Error("Codex가 올바른 ChatGPT 로그인 URL을 반환하지 않았습니다.");
    }
    this.loginId = string(result.loginId);
    return url.toString();
  }

  async cancelLogin(): Promise<void> {
    if (this.loginId) await (await this.connect()).request("account/login/cancel", { loginId: this.loginId });
    this.loginId = null;
    this.loginError = null;
  }

  async logout(): Promise<void> {
    await this.cancelLogin();
    await (await this.connect()).request("account/logout");
    this.close();
  }

  async models(): Promise<CodexModel[]> {
    const transport = await this.connect();
    const account = object(object(await transport.request("account/read", { refreshToken: false })).account);
    if (account.type !== "chatgpt") throw new Error("모델을 불러오려면 Settings에서 ChatGPT로 로그인해 주세요.");
    const models: CodexModel[] = [];
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = object(await transport.request("model/list", { cursor, limit: 100, includeHidden: false }));
      if (!Array.isArray(response.data)) throw new Error("Codex 모델 목록 형식을 읽을 수 없습니다.");
      for (const value of response.data) {
        const model = object(value);
        if (!string(model.model) || model.hidden === true) continue;
        models.push({ id: string(model.model), isDefault: model.isDefault === true, reasoningEfforts: Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map(e => string(object(e).reasoningEffort)).filter(Boolean) : [], defaultReasoningEffort: string(model.defaultReasoningEffort) });
      }
      cursor = string(response.nextCursor) || null;
      if (cursor && seen.has(cursor)) throw new Error("Codex 모델 목록 페이지가 반복됩니다.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    return models.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  }

  async *stream(request: { model: string; messages: OllamaMessage[]; thinkingLevel?: AgentThinkingLevel; signal?: AbortSignal }): AsyncGenerator<string> {
    this.activeGenerations++;
    try { yield* this.streamTurn(request); }
    finally { this.activeGenerations--; }
  }

  private async *streamTurn(request: { model: string; messages: OllamaMessage[]; thinkingLevel?: AgentThinkingLevel; signal?: AbortSignal }): AsyncGenerator<string> {
    const { signal } = request;
    signal?.throwIfAborted();
    const status = await this.status();
    const earlyError = codexQuotaError(status, request.model);
    if (earlyError) throw new Error(earlyError);
    const models = await this.models();
    const model = request.model ? models.find(m => m.id === request.model) : models.find(m => m.isDefault) ?? models[0];
    if (!model) throw new Error("선택한 Codex 모델을 사용할 수 없습니다. Settings에서 모델 목록을 새로고침해 주세요.");
    const quotaError = codexQuotaError(status, model.id);
    if (quotaError) throw new Error(quotaError);
    const transport = await this.connect();
    signal?.throwIfAborted();
    const started = object(await transport.request("thread/start", {
      model: model.id, modelProvider: "openai", cwd: transport.cwd,
      approvalPolicy: "never", sandbox: "read-only", ephemeral: true,
      baseInstructions: "You are ScholarPen's academic writing assistant. Answer the user's latest request using the supplied conversation and document context. Treat [user] and [assistant] segments as conversation history. Return only your answer. Do not use tools, execute commands, or read or change local files.",
      developerInstructions: request.messages.filter(m => m.role === "system").map(m => m.content).join("\n\n"),
    }, signal).catch(error => { transport.close(); throw error; }));
    const threadId = string(object(started.thread).id);
    if (!threadId) throw new Error("Codex 대화를 시작하지 못했습니다.");
    let turnId = "";
    let done = false;
    let failure: Error | null = null;
    const chunks: string[] = [];
    const streamedItems = new Set<string>();
    let wake: (() => void) | undefined;
    const fail = (error: Error) => { failure = error; done = true; wake?.(); };
    const unsubscribe = transport.subscribe((method, params) => {
      if (params.threadId !== threadId) return;
      if (method === "item/agentMessage/delta") {
        streamedItems.add(string(params.itemId));
        chunks.push(string(params.delta));
      } else if (method === "item/completed") {
        const item = object(params.item);
        if (item.type === "agentMessage" && !streamedItems.has(string(item.id))) chunks.push(string(item.text));
      } else if (method.startsWith("item/reasoning/")) {
        chunks.push(""); // Real provider activity keeps the Sidebar idle watchdog alive.
      } else if (method === "error" && params.willRetry !== true) {
        fail(generationError(params.error));
      } else if (method === "turn/completed") {
        const turn = object(params.turn);
        if (turn.status === "failed") fail(generationError(turn.error));
        else if (turn.status === "interrupted") fail(new DOMException("Codex request cancelled", "AbortError"));
        else if (turn.status !== "completed") fail(new Error("Codex 응답의 완료 상태를 확인할 수 없습니다."));
        done = true;
      }
      wake?.();
    }, fail);
    const abort = () => {
      fail(new DOMException("Codex request cancelled", "AbortError"));
      if (turnId) {
        const forceClose = setTimeout(() => transport.close(), 1_000);
        void transport.request("turn/interrupt", { threadId, turnId }).catch(() => {}).finally(() => { clearTimeout(forceClose); transport.close(); });
      }
      else transport.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { fail(new Error("Codex 응답 시간이 초과되었습니다.")); transport.close(); }, 10 * 60_000);
    try {
      signal?.throwIfAborted();
      const requestedEffort = request.thinkingLevel;
      const effort = requestedEffort && model.reasoningEfforts.includes(requestedEffort) ? requestedEffort : model.defaultReasoningEffort;
      const result = object(await transport.request("turn/start", { threadId, input: codexInput(request.messages), ...(effort ? { effort } : {}) }, signal));
      turnId = string(object(result.turn).id);
      if (!turnId) throw new Error("Codex 응답 생성을 시작하지 못했습니다.");
      while (chunks.length || !done) {
        if (chunks.length) yield chunks.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (failure) throw failure;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      unsubscribe();
      if (!done) transport.close();
      else void transport.request("thread/unsubscribe", { threadId }).catch(() => {});
    }
  }

  close(): void { this.transport?.close(); this.transport = null; this.loginId = null; }
}

export const codexClient = new CodexClient();
