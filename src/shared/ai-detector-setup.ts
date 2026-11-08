export type DetectorInstallPhase = "bootstrap" | "python" | "dependencies" | "models" | "verification";
export type DetectorInstallProgress = { kind: "bytes" | "files"; completed: number; total: number | null };
export type AIDetectorStatus =
  | { state: "missing" | "ready"; detail: string }
  | { state: "installing"; phase: DetectorInstallPhase; detail: string; progress: DetectorInstallProgress | null }
  | { state: "error"; detail: string };
