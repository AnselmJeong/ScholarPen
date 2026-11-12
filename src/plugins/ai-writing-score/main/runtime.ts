import { homedir } from "node:os";
import { join } from "node:path";

export const detectorHome = process.env.SCHOLARPEN_DETECTOR_HOME || join(homedir(), "Library", "Application Support", "ScholarPen", "ai-detector");
export const detectorActivity = { analyzing: false, installing: false };
export function detectorPython(): string {
  return process.env.SCHOLARPEN_DETECTOR_PYTHON || join(detectorHome, "detectorscope", ".venv", "bin", "python");
}
