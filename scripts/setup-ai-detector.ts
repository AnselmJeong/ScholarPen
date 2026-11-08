import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { detectorHome } from "../src/bun/ai-detector/runtime";
import config from "../src/bun/ai-detector/python/detector_config.json";

const uv = Bun.which("uv");
if (!uv) throw new Error("Install uv first: https://docs.astral.sh/uv/getting-started/installation/");
await mkdir(detectorHome, { recursive: true });
const venv = join(detectorHome, "detectorscope", ".venv");
const python = join(venv, "bin", "python");
async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, {
    stdout: "inherit", stderr: "inherit",
    // Standard HTTP avoids Xet transfers stalling on desktop networks.
    env: { ...process.env, HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET ?? "1", HF_HUB_DISABLE_TELEMETRY: "1" },
  });
  if (await proc.exited !== 0) throw new Error(`Setup failed: ${cmd[0]}`);
}
if (!(await Bun.file(python).exists())) await run([uv, "venv", "--python", "3.12", venv]);
await run([uv, "pip", "sync", "--require-hashes", "--python", python, join(import.meta.dir, "../src/bun/ai-detector/python/requirements.lock")]);
console.log("Downloading DetectorScope (Gemma 2 2B + SAE features; several GB). Manuscript text is never uploaded.");
await run([python, "-c", `import json, sys
from huggingface_hub import snapshot_download
config = json.loads(sys.argv[1])
snapshot_download(config["model"], revision=config["revision"])
print("ScholarPen DetectorScope models downloaded.")
`, JSON.stringify(config)]);
// Verify the actual offline adapter, including model loading and highlights.
const worker = join(import.meta.dir, "../src/bun/ai-detector/python/worker.py");
const proc = Bun.spawn([python, worker], {
  stdin: "pipe", stdout: "inherit", stderr: "inherit",
  env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
});
await proc.stdin.write(JSON.stringify({ text: "This is a local installation test. We measured the same samples on three different days and found that the results varied between runs. The first measurement was higher than the second, but the difference was small. Further experiments will be needed to establish whether this pattern is reproducible across laboratories. ".repeat(2) }));
await proc.stdin.end();
if (await proc.exited !== 0) throw new Error("DetectorScope offline validation failed.");
console.log("ScholarPen DetectorScope is ready for offline analysis.");
