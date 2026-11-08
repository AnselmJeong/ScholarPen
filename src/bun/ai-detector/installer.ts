import { access, chmod, mkdir, rename, rm, statfs } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { AIDetectorStatus, DetectorInstallPhase, DetectorInstallProgress } from "../../shared/ai-detector-setup";
import { detectorActivity, detectorHome, detectorPython } from "./runtime";
import { detectorOfflineEnv, materializeDetectorSources } from "./sources";
import { parseDetectorOutput } from "./service";

const UV_VERSION = "0.11.7";
const UV_ARCHIVE = "uv-aarch64-apple-darwin.tar.gz";
const UV_SHA256 = "66e37d91f839e12481d7b932a1eccbfe732560f42c1cfb89faddfa2454534ba8";
const SAMPLE = "This is a local installation test. We measured samples on three different days. The first measurement was higher than the second, but the difference was small. Further experiments are needed to establish whether the pattern is reproducible across laboratories. ".repeat(2);

export function parseInstallProgress(line: string): DetectorInstallProgress | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object") return null;
    if (!("kind" in value) || (value.kind !== "bytes" && value.kind !== "files") ||
      !("completed" in value) || typeof value.completed !== "number" || !Number.isFinite(value.completed) || value.completed < 0 ||
      !("total" in value) || (value.total !== null && (typeof value.total !== "number" || !Number.isFinite(value.total) || value.total <= 0 || value.completed > value.total))) return null;
    return { kind: value.kind, completed: value.completed, total: value.total };
  } catch { return null; }
}

export class DetectorInstaller {
  private status: AIDetectorStatus = { state: "missing", detail: "DetectorScope 설치가 필요합니다." };
  private controller: AbortController | null = null;
  private checkedAt = 0;
  private checkTask: Promise<AIDetectorStatus> | null = null;

  private phase(phase: DetectorInstallPhase, detail: string, progress: DetectorInstallProgress | null = null) {
    this.status = { state: "installing", phase, detail, progress };
  }

  async getStatus(): Promise<AIDetectorStatus> {
    if (this.controller || this.status.state === "error" || Date.now() - this.checkedAt < 30_000) return this.status;
    if (this.checkTask) return this.checkTask;
    this.checkTask = (async () => {
      let ready = false;
      try {
        await access(detectorPython());
        const root = await materializeDetectorSources();
        const output = await this.run([detectorPython(), join(root, "setup_worker.py"), "--check"], AbortSignal.timeout(20_000), detectorOfflineEnv());
        ready = JSON.parse(output).ready === true;
      } catch { /* Missing runtime/cache is a normal first-run state. */ }
      // A concurrent install must not be overwritten by this older probe.
      if (!this.controller) {
        this.status = ready ? { state: "ready", detail: "로컬 분석 준비 완료" }
          : { state: "missing", detail: "실행 환경 또는 모델 파일이 없습니다." };
        this.checkedAt = Date.now();
      }
      return this.status;
    })().finally(() => { this.checkTask = null; });
    return this.checkTask;
  }

  start(): AIDetectorStatus {
    if (this.controller) return this.status;
    if (process.env.SCHOLARPEN_DETECTOR_PYTHON && process.env.SCHOLARPEN_DETECTOR_PYTHON !== join(detectorHome, "detectorscope", ".venv", "bin", "python")) {
      return { state: "error", detail: "개발용 Python 경로가 지정되어 있습니다. SCHOLARPEN_DETECTOR_PYTHON 설정을 해제한 뒤 앱의 관리형 설치를 사용해 주세요." };
    }
    if (detectorActivity.analyzing) return { state: "error", detail: "분석이 진행 중입니다. 완료 후 설치·복구를 실행해 주세요." };
    detectorActivity.installing = true;
    const controller = new AbortController();
    this.controller = controller;
    this.phase("bootstrap", "설치를 준비하고 있습니다…");
    const timer = setTimeout(() => controller.abort(new Error("설치 제한 시간(60분)을 초과했습니다. 네트워크를 확인하고 다시 시도해 주세요.")), 60 * 60_000);
    void this.install(controller.signal).then(() => {
      this.status = { state: "ready", detail: "설치와 오프라인 분석 검증이 완료됐습니다. /ai-score를 실행할 수 있습니다." };
    }).catch((error: unknown) => {
      this.status = controller.signal.aborted && controller.signal.reason?.name === "AbortError"
        ? { state: "missing", detail: "설치를 취소했습니다. 다시 시작하면 내려받은 모델 파일을 재사용합니다." }
        : { state: "error", detail: error instanceof Error ? error.message : "설치에 실패했습니다. 다시 시도해 주세요." };
    }).finally(() => {
      clearTimeout(timer);
      this.controller = null;
      detectorActivity.installing = false;
      this.checkedAt = Date.now();
    });
    return this.status;
  }

  cancel(): AIDetectorStatus {
    this.controller?.abort();
    if (this.status.state === "installing") this.status = { ...this.status, detail: "설치를 취소하고 있습니다…" };
    return this.status;
  }

  private async run(cmd: string[], signal: AbortSignal, env: Record<string, string | undefined>, input?: string, progress?: (line: string) => void): Promise<string> {
    signal.throwIfAborted();
    const proc = Bun.spawn(cmd, { cwd: detectorHome, env, stdin: input === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
    const abort = () => { proc.kill(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let output = "";
    const drain = async (stream: ReadableStream<Uint8Array>, isOutput: boolean) => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          if (isOutput) {
            output = (output + text).slice(-2_000_000);
            pending += text;
            const lines = pending.split(/\r?\n/);
            pending = lines.pop()?.slice(-8_000) ?? "";
            for (const line of lines) progress?.(line);
          }
        }
      } finally { reader.releaseLock(); }
    };
    const streams = Promise.all([drain(proc.stdout, true), drain(proc.stderr, false)]);
    try {
      if (input !== undefined && typeof proc.stdin !== "number" && proc.stdin) {
        await proc.stdin.write(input);
        await proc.stdin.end();
      }
      const [code] = await Promise.all([proc.exited, streams]);
      signal.throwIfAborted();
      if (code !== 0) throw new Error(`설치 단계가 실패했습니다 (종료 코드 ${code}). 네트워크·저장 공간을 확인하고 설치·복구를 다시 눌러 주세요.`);
      return output;
    } finally {
      signal.removeEventListener("abort", abort);
      if (proc.exitCode === null) { proc.kill(); await proc.exited; }
      await streams;
    }
  }

  private async install(signal: AbortSignal) {
    if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("현재 로컬 DetectorScope 설치는 Apple Silicon Mac에서 지원합니다.");
    await mkdir(detectorHome, { recursive: true });
    const disk = await statfs(detectorHome);
    if (disk.bavail * disk.bsize < 20 * 1024 ** 3) throw new Error("초기 설치에는 최소 20GB의 여유 공간이 필요합니다.");
    const root = await materializeDetectorSources();
    const tools = join(detectorHome, "tools", `uv-${UV_VERSION}`);
    const uv = join(tools, "uv");
    await mkdir(tools, { recursive: true });
    const env = { ...process.env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PYTHONUNBUFFERED: "1", TOKENIZERS_PARALLELISM: "false",
      UV_PYTHON_INSTALL_DIR: join(detectorHome, "python"), UV_CACHE_DIR: join(detectorHome, "uv-cache"),
      HF_HUB_DISABLE_XET: "1", HF_HUB_DISABLE_TELEMETRY: "1", HF_HUB_OFFLINE: "0", TRANSFORMERS_OFFLINE: "0" };
    if (!(await Bun.file(uv).exists())) {
      this.phase("bootstrap", "설치 도구를 다운로드하고 있습니다…");
      const response = await fetch(`https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${UV_ARCHIVE}`, { signal });
      if (!response.ok || !response.body) throw new Error("설치 도구를 다운로드할 수 없습니다. 네트워크를 확인해 주세요.");
      const archive = join(tools, "uv.tar.gz");
      const partial = `${archive}.part`;
      const writer = Bun.file(partial).writer();
      const hash = createHash("sha256");
      const total = Number(response.headers.get("content-length")) || null;
      let completed = 0;
      try {
        for await (const chunk of response.body) {
          signal.throwIfAborted();
          completed += chunk.length;
          if (completed > 100 * 1024 ** 2) throw new Error("설치 도구 파일 크기가 예상 범위를 초과했습니다.");
          hash.update(chunk);
          await writer.write(chunk);
          this.phase("bootstrap", "설치 도구를 다운로드하고 있습니다…", { kind: "bytes", completed, total });
        }
      } finally { await writer.end(); }
      if (hash.digest("hex") !== UV_SHA256) { await rm(partial, { force: true }); throw new Error("설치 도구 무결성 검증에 실패했습니다. 다시 시도해 주세요."); }
      await rename(partial, archive);
      await this.run(["/usr/bin/tar", "-xzf", archive, "-C", tools, "--strip-components", "1", "uv-aarch64-apple-darwin/uv"], signal, env);
      await chmod(uv, 0o755);
      await rm(archive, { force: true });
    }
    const venv = join(detectorHome, "detectorscope", ".venv");
    const python = join(venv, "bin", "python");
    this.phase("python", "전용 Python 실행 환경을 준비하고 있습니다…");
    if (!(await Bun.file(python).exists())) await this.run([uv, "venv", "--managed-python", "--python", "3.12", "--allow-existing", venv], signal, env);
    this.phase("dependencies", "분석 라이브러리를 설치하고 있습니다…");
    await this.run([uv, "pip", "sync", "--require-hashes", "--python", python, join(root, "requirements.lock")], signal, env);
    this.phase("models", "DetectorScope 모델을 다운로드하고 있습니다 (약 12GB)…");
    await this.run([python, join(root, "setup_worker.py")], signal, env, undefined, line => {
      const progress = parseInstallProgress(line);
      if (progress) this.phase("models", "DetectorScope 모델을 다운로드하고 있습니다…", progress);
    });
    this.phase("verification", "설치된 모델로 오프라인 분석을 검증하고 있습니다…");
    const output = await this.run([python, join(root, "worker.py")], signal, { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" }, JSON.stringify({ text: SAMPLE }));
    parseDetectorOutput(output);
    signal.throwIfAborted();
  }
}

export const detectorInstaller = new DetectorInstaller();
