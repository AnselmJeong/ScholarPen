import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
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
