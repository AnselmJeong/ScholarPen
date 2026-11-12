import type { OllamaMessage } from "../../shared/rpc-types";

/** Check the model itself as well as the endpoint: local Ollama can alias cloud models. */
export async function completeLocalStyleModel(base: string, model: string, messages: OllamaMessage[], signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<string> {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || /cloud/i.test(model)) throw new Error("문체 분석에는 로컬 모델이 필요합니다.");
  const root = base.replace(/\/+$/, "").replace(/\/(?:api|v1)$/i, "");
  const metadata = await fetcher(`${root}/api/show`, { method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model }) });
  if (!metadata.ok) throw new Error(`로컬 모델 확인 실패: HTTP ${metadata.status}`);
  const info = await metadata.json();
  if (info.remote_model || info.remote_host || !info.model_info || typeof info.model_info !== "object") throw new Error("이 모델은 로컬 실행을 확인할 수 없습니다. 샘플을 전송하지 않았습니다.");
  signal.throwIfAborted();
  const response = await fetcher(`${root}/api/chat`, { method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0, num_predict: 3000 } }) });
  if (!response.ok) throw new Error(`로컬 문체 분석 실패: HTTP ${response.status}`);
  const data = await response.json(); if (typeof data.message?.content !== "string") throw new Error("로컬 모델 응답을 읽을 수 없습니다.");
  return data.message.content;
}
