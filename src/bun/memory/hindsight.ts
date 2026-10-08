import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { basename, join, resolve } from "path";
import { DEFAULT_HINDSIGHT_URL, MEMORY_CONTENT_LIMIT, type ProjectMemoryHit, type ProjectMemoryStatus, type ProjectMemoryReceipt, type ProjectMemoryOperation } from "../../shared/project-memory";

interface Binding { version: 1; bankId: string }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Hindsight 연결에 실패했습니다.";

/** Uses the Control Plane API exposed at the configured public URL. All traffic stays in Bun. */
export class ProjectMemoryService {
  private bindings = new Map<string, Promise<Binding>>();
  private provisioning = new Map<string, Promise<void>>();
  private ready = new Set<string>();
  readonly url: string;

  constructor(
    url = process.env.SCHOLARPEN_HINDSIGHT_URL || DEFAULT_HINDSIGHT_URL,
    private fetcher: typeof fetch = fetch,
    private apiKey = process.env.SCHOLARPEN_HINDSIGHT_API_KEY || "",
  ) {
    this.url = url.replace(/\/+$/, "");
  }

  private async request(path: string, body?: unknown, method = "POST", signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(8_000);
    const response = await this.fetcher(`${this.url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Hindsight 요청 실패 (HTTP ${response.status}). 연결을 확인하고 다시 시도해 주세요.`);
    const data: unknown = await response.json();
    if (!record(data)) throw new Error("Hindsight 응답 형식이 올바르지 않습니다.");
    return data;
  }

  private async readBinding(projectPath: string): Promise<Binding | null> {
    let source: string;
    try { source = await readFile(join(projectPath, ".scholarpen", "hindsight.json"), "utf8"); }
    catch (error) {
      if (record(error) && error.code === "ENOENT") return null;
      throw error;
    }
    const data: unknown = JSON.parse(source);
    if (!record(data) || data.version !== 1 || typeof data.bankId !== "string" || !/^scholarpen-[a-z0-9-]+$/.test(data.bankId)) {
      throw new Error("프로젝트의 Hindsight 연결 파일을 읽을 수 없습니다. 기존 bank 보호를 위해 새 bank를 만들지 않았습니다.");
    }
    return { version: 1, bankId: data.bankId };
  }

  /** Persist identity before networking so retries and folder moves keep the same bank. */
  private binding(projectPath: string): Promise<Binding> {
    const path = resolve(projectPath);
    const existing = this.bindings.get(path);
    if (existing) return existing;
    const pending = (async () => {
      const saved = await this.readBinding(path);
      if (saved) return saved;
      const slug = basename(path).toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) || "project";
      const binding: Binding = { version: 1, bankId: `scholarpen-${slug}-${randomUUID()}` };
      const dir = join(path, ".scholarpen");
      await mkdir(dir, { recursive: true });
      try {
        // Exclusive creation also works in cloud-synced folders that lack hard-link support.
        // Never replace another process's identity; a partial/corrupt file fails closed.
        await writeFile(join(dir, "hindsight.json"), JSON.stringify(binding, null, 2), { flag: "wx", mode: 0o600 });
        return binding;
      } catch (error) {
        if (record(error) && error.code === "EEXIST") {
          const winner = await this.readBinding(path);
          if (winner) return winner;
        }
        throw error;
      }
    })().finally(() => { this.bindings.delete(path); });
    this.bindings.set(path, pending);
    return pending;
  }

  private ensureBank(binding: Binding, projectPath: string): Promise<void> {
    if (this.ready.has(binding.bankId)) return Promise.resolve();
    const pending = this.provisioning.get(binding.bankId);
    if (pending) return pending;
    const work = (async () => {
      const data = await this.request(`/api/banks/${encodeURIComponent(binding.bankId)}`, {
        name: `ScholarPen · ${basename(projectPath)}`,
      }, "PUT");
      if (!record(data) || data.bank_id !== binding.bankId) throw new Error("Hindsight bank 생성 응답을 확인할 수 없습니다.");
      this.ready.add(binding.bankId);
    })().finally(() => { this.provisioning.delete(binding.bankId); });
    this.provisioning.set(binding.bankId, work);
    return work;
  }

  /** Local identity is durable before returning; remote availability never blocks project opening. */
  async initialize(projectPath: string): Promise<void> {
    const binding = await this.binding(projectPath);
    void this.ensureBank(binding, projectPath).catch(error => console.warn("[Hindsight] Bank provisioning:", errorMessage(error)));
  }

  async status(projectPath: string): Promise<ProjectMemoryStatus> {
    let bankId: string | null = null;
    try {
      const binding = await this.binding(projectPath);
      bankId = binding.bankId;
      await this.ensureBank(binding, projectPath);
      const health = await this.request("/api/health", undefined, "GET");
      if (!record(health) || !record(health.dataplane) || health.dataplane.status !== "connected") throw new Error("Hindsight 메모리 서버에 연결할 수 없습니다.");
      return { state: "ready", bankId, url: this.url };
    } catch (error) { return { state: "unavailable", bankId, url: this.url, error: errorMessage(error) }; }
  }

  async retain(projectPath: string, content: string, source: string): Promise<ProjectMemoryReceipt> {
    content = content.trim();
    source = source.trim().slice(0, 500);
    if (!content || content.length > MEMORY_CONTENT_LIMIT) throw new Error(`기억할 내용을 1–${MEMORY_CONTENT_LIMIT.toLocaleString()}자 이내로 입력해 주세요.`);
    const binding = await this.binding(projectPath);
    await this.ensureBank(binding, projectPath);
    // A deterministic source document prevents duplicate memories after a lost acknowledgement/retry.
    const documentId = `scholarpen-note-${createHash("sha256").update(JSON.stringify([content, source])).digest("hex")}`;
    const data = await this.request("/api/memories/retain_async", {
      bank_id: binding.bankId,
      items: [{ content, document_id: documentId, context: source || `User-saved project note: ${basename(projectPath)}`, metadata: { app: "ScholarPen", source: source || "project-note" }, tags: ["scholarpen", "user-saved"] }],
    });
    if (!record(data) || data.success !== true || data.bank_id !== binding.bankId || typeof data.operation_id !== "string") {
      throw new Error("Hindsight 저장 접수를 확인하지 못했습니다. 내용을 유지하고 다시 시도해 주세요.");
    }
    return { state: "processing", operationId: data.operation_id };
  }

  async operation(projectPath: string, operationId: string): Promise<ProjectMemoryOperation> {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(operationId)) throw new Error("잘못된 저장 작업 ID입니다.");
    const binding = await this.binding(projectPath);
    const data = await this.request(`/api/banks/${binding.bankId}/operations/${operationId}`, undefined, "GET");
    if (!record(data) || typeof data.status !== "string") throw new Error("저장 상태를 확인할 수 없습니다.");
    if (data.status === "completed") return { state: "completed" };
    if (data.status === "failed" || data.status === "cancelled") return { state: "failed" };
    if (["pending", "processing", "running", "queued"].includes(data.status)) return { state: "processing" };
    throw new Error("알 수 없는 Hindsight 저장 상태입니다.");
  }

  async recall(projectPath: string, query: string, signal?: AbortSignal): Promise<ProjectMemoryHit[]> {
    if (!query.trim()) return [];
    // Context retrieval must not create banks for arbitrary/unopened projects.
    const binding = await this.readBinding(projectPath);
    if (!binding) return [];
    signal?.throwIfAborted();
    const data = await this.request("/api/recall", {
      bank_id: binding.bankId, query: query.slice(0, 1_500), budget: "low", max_tokens: 2_000,
    }, "POST", signal);
    if (!record(data) || !Array.isArray(data.results)) throw new Error("Hindsight 검색 응답을 읽을 수 없습니다.");
    const hits: ProjectMemoryHit[] = [];
    for (const hit of data.results.slice(0, 8)) {
      if (!record(hit) || typeof hit.id !== "string" || typeof hit.text !== "string") throw new Error("Hindsight 기억 형식이 올바르지 않습니다.");
      hits.push({ id: hit.id, text: hit.text.slice(0, 1_500), context: typeof hit.context === "string" ? hit.context.slice(0, 300) : "" });
    }
    return hits;
  }
}

export const projectMemory = new ProjectMemoryService();
