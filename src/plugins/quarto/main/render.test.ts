import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { renderQuartoBookProject } from "./render";

const temporaryDirectories: string[] = [];

async function createFixture(
  formatYaml: string,
  executableBody: string,
): Promise<{ projectDirectory: string; executable: string }> {
  const projectDirectory = await mkdtemp(join(tmpdir(), "scholarpen-quarto-render-"));
  temporaryDirectories.push(projectDirectory);
  await writeFile(
    join(projectDirectory, "_quarto.yml"),
    `project:\n  type: book\n  output-dir: rendered-book\nbook:\n  title: Test\n  author: [Tester]\n  chapters: [index.qmd]\nformat:\n${formatYaml}\n`,
  );
  await writeFile(join(projectDirectory, "index.qmd"), "# Test\n");
  const executable = join(projectDirectory, "fake-quarto");
  await writeFile(executable, `#!/bin/sh\n${executableBody}\n`);
  await chmod(executable, 0o755);
  return { projectDirectory, executable };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Quarto book rendering", () => {
  test("blocks duplicate labels across book chapters before starting Quarto", async () => {
    const fixture = await createFixture("  html: {}", 'echo SHOULD_NOT_RUN');
    await writeFile(join(fixture.projectDirectory, "_quarto.yml"), 'project:\n  type: book\nbook:\n  chapters:\n    - index.qmd\n    - part: Results\n      chapters: [results.qmd]\nformat:\n  html: {}\n');
    await writeFile(join(fixture.projectDirectory, "index.qmd"), '# Introduction {#sec-same}\n');
    await writeFile(join(fixture.projectDirectory, "results.qmd"), '# Results {#sec-same}\n');
    const result = await renderQuartoBookProject({ ...fixture, format: "html" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.message).toContain("sec-same (index.qmd, results.qmd)");
      expect(result.stdout).not.toContain("SHOULD_NOT_RUN");
    }
  });
  test("does not report success when Quarto exits zero with an unresolved internal reference", async () => {
    const fixture = await createFixture("  html: {}", 'printf "WARNING Unable to resolve crossref @eq-missing\\n" >&2\nexit 0');
    const result = await renderQuartoBookProject({ ...fixture, format: "html" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain("@eq-missing");
      expect(result.message).toContain("not bibliography citations");
    }
  });
  test.each(["dst-book-typst", "org/journal-pdf"])("passes the exact custom format %s to Quarto", async (format) => {
    const fixture = await createFixture(`  ${format}: default`, 'printf "arguments:%s %s %s\\n" "$1" "$2" "$3"');
    const result = await renderQuartoBookProject({ ...fixture, format });
    expect(result.status).toBe("success");
    expect(result.stdout).toContain(`arguments:render --to ${format}`);
  });

  test("renders the explicitly selected configured format", async () => {
    const fixture = await createFixture(
      "  html: {}",
      'printf "arguments:%s %s %s\\n" "$1" "$2" "$3"',
    );

    const result = await renderQuartoBookProject({
      ...fixture,
      format: "html",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.stdout).toContain("arguments:render --to html");
    expect(result.outputDirectory).toBe(join(fixture.projectDirectory, "rendered-book"));
  });

  describe("Word tables", () => {
    // The fake Quarto writes the reference document when asked to build it and logs every call.
    const fakeQuarto = (buildExit = 0) => [
      'echo "$*" >> "$(dirname "$0")/calls.log"',
      `if [ "$1" = pandoc ]; then [ ${buildExit} = 0 ] && printf PK > "$4"; exit ${buildExit}; fi`,
      'printf "arguments:%s\\n" "$*"',
    ].join("\n");
    const calls = async (projectDirectory: string) =>
      (await readFile(join(projectDirectory, "calls.log"), "utf8")).trim().split("\n");

    test("adds ScholarPen's reference document and table filter without a Word template", async () => {
      const fixture = await createFixture("  docx: {}", fakeQuarto());
      const result = await renderQuartoBookProject({ ...fixture, format: "docx" });
      expect(result.status).toBe("success");
      const [build, render] = await calls(fixture.projectDirectory);
      expect(build).toMatch(/^pandoc lua \S+\/reference-doc\.lua \S+\/scholarpen-reference\.docx$/);
      const match = render.match(/^render --to docx --reference-doc (\S+\/scholarpen-reference\.docx) --lua-filter (\S+\/ruled-tables\.lua)$/);
      expect(match).not.toBeNull();
      // The generated files are removed once Quarto has finished.
      expect(await stat(match![1]).catch(() => null)).toBeNull();
      expect(await stat(match![2]).catch(() => null)).toBeNull();
    });

    test("leaves tables to the author's own Word template", async () => {
      const fixture = await createFixture("  docx:\n    reference-doc: journal.docx", fakeQuarto());
      const result = await renderQuartoBookProject({ ...fixture, format: "docx" });
      expect(result.status).toBe("success");
      expect(await calls(fixture.projectDirectory)).toEqual(["render --to docx"]);
    });

    test("still renders when the reference document cannot be built", async () => {
      const fixture = await createFixture("  docx: {}", fakeQuarto(3));
      const result = await renderQuartoBookProject({ ...fixture, format: "docx" });
      expect(result.status).toBe("success");
      expect((await calls(fixture.projectDirectory)).at(-1)).toBe("render --to docx");
    });

    test("does not change other formats", async () => {
      const fixture = await createFixture("  html: {}", fakeQuarto());
      await renderQuartoBookProject({ ...fixture, format: "html" });
      expect(await calls(fixture.projectDirectory)).toEqual(["render --to html"]);
    });
  });

  test("returns a useful diagnostic and logs when Quarto exits unsuccessfully", async () => {
    const fixture = await createFixture(
      "  typst: {}",
      'printf "ERROR: chapter 2 could not be compiled\\n" >&2\nexit 2',
    );

    const result = await renderQuartoBookProject({
      ...fixture,
      format: "typst",
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.exitCode).toBe(2);
    expect(result.message).toContain("chapter 2 could not be compiled");
    expect(result.stderr).toContain("ERROR: chapter 2 could not be compiled");
  });

  test("does not launch a format absent from _quarto.yml", async () => {
    const fixture = await createFixture("  docx: {}", "exit 99");

    const result = await renderQuartoBookProject({
      ...fixture,
      format: "html",
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.exitCode).toBeNull();
    expect(result.message).toContain("not configured");
  });

  test("reports a timeout distinctly from a normal Quarto failure", async () => {
    const fixture = await createFixture("  html: {}", "sleep 2");

    const result = await renderQuartoBookProject({
      ...fixture,
      format: "html",
      timeoutMs: 20,
    });

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.message).toContain("timed out");
  });
});
