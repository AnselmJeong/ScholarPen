import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("packaged PDF text extraction", () => {
  test("loads from a standalone Bun bundle without resolving native canvas packages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "scholarpen-pdf-bundle-"));
    temporaryDirectories.push(directory);
    const malformedPdf = join(directory, "malformed.pdf");
    const entry = join(directory, "entry.ts");
    await writeFile(malformedPdf, "%PDF-1.4\nintentionally malformed\n%%EOF");
    await writeFile(entry, `
      import { extractPdfPages } from ${JSON.stringify(join(import.meta.dir, "pdf-extractor.ts"))};
      try {
        await extractPdfPages(process.argv[2], [1]);
      } catch {
        console.log("PDF_MODULE_LOADED");
      }
    `);

    const build = await Bun.build({
      entrypoints: [entry],
      outdir: directory,
      target: "bun",
      minify: true,
    });
    expect(build.success).toBeTrue();
    const output = build.outputs[0];
    expect(output).toBeDefined();

    const process = Bun.spawn([Bun.which("bun") ?? "bun", output.path, malformedPdf], {
      cwd: directory,
      env: { ...globalThis.process.env, BUN_INSTALL_CACHE_DIR: join(directory, "empty-cache") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("PDF_MODULE_LOADED");
    expect(stderr).not.toContain("@napi-rs/canvas");
    expect(stderr).not.toContain("Resolving [");
  });
});
