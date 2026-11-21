import { mkdtemp, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import referenceDocScript from "./docx/reference-doc.lua" with { type: "text" };
import ruledTablesFilter from "./docx/ruled-tables.lua" with { type: "text" };

const BUILD_TIMEOUT_MS = 60_000;

export interface DocxTableStyling {
  /** Extra `quarto render` arguments: the reference document and the table filter. */
  args: string[];
  cleanup(): Promise<void>;
}

/**
 * Word output without a template of the author's own gets ruled tables: a 1 pt
 * rule above each table, under its header row and under its last row. Quarto's
 * pandoc builds the reference document (its default one plus that table style),
 * and a Lua filter gives the manuscript's tables the style.
 *
 * Returns null when the reference document cannot be built; the book then
 * renders with pandoc's plain tables rather than failing.
 */
export async function prepareDocxTableStyling(
  executable: string,
  environment?: Record<string, string>,
): Promise<DocxTableStyling | null> {
  const directory = await mkdtemp(join(tmpdir(), "scholarpen-docx-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  const script = join(directory, "reference-doc.lua");
  const referenceDoc = join(directory, "scholarpen-reference.docx");
  const filter = join(directory, "ruled-tables.lua");
  try {
    await Promise.all([writeFile(script, referenceDocScript), writeFile(filter, ruledTablesFilter)]);
    const build = Bun.spawn({
      cmd: [executable, "pandoc", "lua", script, referenceDoc],
      cwd: directory,
      env: environment,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => build.kill("SIGTERM"), BUILD_TIMEOUT_MS);
    const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited])
      .finally(() => clearTimeout(timeout));
    if (exitCode !== 0 || !(await stat(referenceDoc).catch(() => null))?.size) {
      throw new Error(stderr.trim() || `exit ${exitCode}`);
    }
    return { args: ["--reference-doc", referenceDoc, "--lua-filter", filter], cleanup };
  } catch (error) {
    console.warn("[Quarto] Word tables keep pandoc's plain style: could not build the reference document.", error);
    await cleanup();
    return null;
  }
}
