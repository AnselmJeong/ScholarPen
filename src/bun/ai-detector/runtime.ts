import { homedir } from "node:os";
import { join } from "node:path";

export const detectorHome = join(homedir(), "Library", "Application Support", "ScholarPen", "ai-detector");
export function detectorPython(): string {
  return process.env.SCHOLARPEN_DETECTOR_PYTHON || join(detectorHome, ".venv", "bin", "python");
}
