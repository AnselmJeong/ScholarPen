import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { detectorHome } from "../src/bun/ai-detector/runtime";

const uv = Bun.which("uv");
if (!uv) throw new Error("Install uv first: https://docs.astral.sh/uv/getting-started/installation/");
await mkdir(detectorHome, { recursive: true });
const venv = join(detectorHome, ".venv");
const python = join(venv, "bin", "python");
async function run(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  if (await proc.exited !== 0) throw new Error(`Setup failed: ${cmd[0]}`);
}
if (!(await Bun.file(python).exists())) await run([uv, "venv", "--python", "3.12", venv]);
await run([uv, "pip", "install", "--python", python, "torch==2.14.1", "transformers==5.19.0"]);
console.log("Downloading the two Qwen 0.5B detector models. Manuscript text is never uploaded.");
await run([python, "-c", `from transformers import AutoTokenizer, AutoModelForCausalLM
for name in ("Qwen/Qwen2.5-0.5B", "Qwen/Qwen2.5-0.5B-Instruct"):
    AutoTokenizer.from_pretrained(name)
    AutoModelForCausalLM.from_pretrained(name)
print("ScholarPen AI detector is ready for offline analysis.")
`]);
