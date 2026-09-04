import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { join } from "path";
import type { QuartoRenderFormat, QuartoRenderResult } from "../../shared/rpc-types";
import { getQuartoRenderFormats, parseQuartoBookConfig } from "../../shared/quarto-config";

const DEFAULT_RENDER_TIMEOUT_MS = 9 * 60 * 1000;
const MAX_LOG_CHARACTERS = 24_000;
const KNOWN_QUARTO_PATHS = [
  "/usr/local/bin/quarto",
  "/opt/homebrew/bin/quarto",
  "/Applications/quarto/bin/quarto",
] as const;

export interface QuartoRenderOptions {
  projectDirectory: string;
  format: QuartoRenderFormat;
  environment?: Record<string, string>;
  executable?: string;
  timeoutMs?: number;
}

function cleanLog(value: string): string {
  const withoutAnsi = value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return withoutAnsi.length <= MAX_LOG_CHARACTERS
    ? withoutAnsi
    : `…${withoutAnsi.slice(-MAX_LOG_CHARACTERS)}`;
}

function errorResult(
  format: QuartoRenderFormat,
  startedAt: number,
  message: string,
  options: {
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
  } = {},
): QuartoRenderResult {
  return {
    status: "error",
    format,
    message,
    exitCode: options.exitCode ?? null,
    stdout: cleanLog(options.stdout ?? ""),
    stderr: cleanLog(options.stderr ?? ""),
    durationMs: Date.now() - startedAt,
  };
}

function summarizeRenderFailure(stderr: string, stdout: string, exitCode: number): string {
  const lines = `${stderr}\n${stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = [...lines].reverse().find((line) => /error|failed|not found|cannot|could not/i.test(line))
    ?? lines.at(-1);
  return diagnostic
    ? `Quarto render failed (exit ${exitCode}): ${diagnostic}`
    : `Quarto render failed with exit code ${exitCode}.`;
}

async function findQuartoExecutable(explicitExecutable?: string): Promise<string | null> {
  const candidates = [explicitExecutable, Bun.which("quarto"), ...KNOWN_QUARTO_PATHS]
    .filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of new Set(candidates)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep checking the known macOS installation locations.
    }
  }
  return null;
}

export async function renderQuartoBookProject(
  options: QuartoRenderOptions,
): Promise<QuartoRenderResult> {
  const startedAt = Date.now();
  const configPath = join(options.projectDirectory, "_quarto.yml");
  let configSource: string;
  try {
    configSource = await readFile(configPath, "utf-8");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return errorResult(
      options.format,
      startedAt,
      `Could not read ${configPath}. ${detail}`,
    );
  }

  let outputDirectory: string;
  try {
    const configuredFormats = getQuartoRenderFormats(configSource);
    if (!configuredFormats.includes(options.format)) {
      return errorResult(
        options.format,
        startedAt,
        `The ${options.format} format is not configured in _quarto.yml.`,
      );
    }
    const outputDir = parseQuartoBookConfig(configSource, []).outputDir;
    outputDirectory = join(options.projectDirectory, outputDir);
  } catch (error) {
    return errorResult(
      options.format,
      startedAt,
      error instanceof Error ? error.message : "Could not parse _quarto.yml.",
    );
  }

  const executable = await findQuartoExecutable(options.executable);
  if (!executable) {
    return errorResult(
      options.format,
      startedAt,
      "Quarto CLI was not found. Install Quarto, relaunch ScholarPen, and try again.",
    );
  }

  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    const process = Bun.spawn({
      cmd: [executable, "render", "--to", options.format],
      cwd: options.projectDirectory,
      env: options.environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      process.kill("SIGTERM");
    }, timeoutMs);
    let stdoutRaw: string;
    let stderrRaw: string;
    let exitCode: number;
    try {
      [stdoutRaw, stderrRaw, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const stdout = cleanLog(stdoutRaw);
    const stderr = cleanLog(stderrRaw);

    if (timedOut) {
      return errorResult(
        options.format,
        startedAt,
        `Quarto rendering timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
        { exitCode, stdout, stderr },
      );
    }

    if (exitCode !== 0) {
      return errorResult(
        options.format,
        startedAt,
        summarizeRenderFailure(stderr, stdout, exitCode),
        { exitCode, stdout, stderr },
      );
    }

    return {
      status: "success",
      format: options.format,
      outputDirectory,
      stdout,
      stderr,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return errorResult(
      options.format,
      startedAt,
      error instanceof Error ? error.message : "Could not start Quarto rendering.",
    );
  }
}
