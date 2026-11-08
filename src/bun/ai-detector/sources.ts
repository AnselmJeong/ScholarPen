import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import worker from "./python/worker.py" with { type: "text" };
import setupWorker from "./python/setup_worker.py" with { type: "text" };
import requirements from "./python/requirements.lock" with { type: "text" };
import config from "./python/detector_config.json";
import { detectorHome } from "./runtime";

let sources: Promise<string> | null = null;
export function materializeDetectorSources(): Promise<string> {
  return sources ??= writeSources().catch(error => { sources = null; throw error; });
}

async function writeSources(): Promise<string> {
  const hash = createHash("sha256").update(worker + setupWorker + requirements + JSON.stringify(config)).digest("hex").slice(0, 16);
  const root = join(detectorHome, "workers", hash);
  await mkdir(root, { recursive: true });
  await Promise.all([
    writeFile(join(root, "worker.py"), worker),
    writeFile(join(root, "setup_worker.py"), setupWorker),
    writeFile(join(root, "requirements.lock"), requirements),
    writeFile(join(root, "detector_config.json"), JSON.stringify(config)),
  ]);
  return root;
}

export const detectorOfflineEnv = () => ({ ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
  HF_HUB_DISABLE_TELEMETRY: "1", TOKENIZERS_PARALLELISM: "false", PYTHONUNBUFFERED: "1" });
