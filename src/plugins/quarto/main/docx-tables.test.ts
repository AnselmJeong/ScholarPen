import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { mkdtemp, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { renderQuartoBookProject } from "./render";

const quarto = [Bun.which("quarto"), "/usr/local/bin/quarto", "/opt/homebrew/bin/quarto", "/Applications/quarto/bin/quarto"]
  .find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function zipEntry(archive: string, entry: string): string {
  const result = Bun.spawnSync(["unzip", "-p", archive, entry]);
  if (result.exitCode !== 0) throw new Error(`unzip ${entry}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

const RESULTS = `# Results

Participants are summarized in @tbl-demo.

| Characteristic | Female | Male | Total |
|:---------------|-------:|-----:|------:|
| Age            | 34.1   | 35.2 | 34.6  |
| BMI            | 22.3   | 24.1 | 23.2  |

: Demographics {#tbl-demo}

| A | B |
|---|---|
| 1 | 2 |
`;

describe.skipIf(!quarto)("Word tables rendered by Quarto", () => {
  test("rules the manuscript's tables but not Quarto's caption layout table", async () => {
    const projectDirectory = await mkdtemp(join(tmpdir(), "scholarpen-docx-tables-"));
    temporaryDirectories.push(projectDirectory);
    await writeFile(join(projectDirectory, "_quarto.yml"),
      "project:\n  type: book\n  output-dir: _book\nbook:\n  title: Tables\n  chapters: [index.qmd, results.qmd]\nformat:\n  docx: {}\n");
    await writeFile(join(projectDirectory, "index.qmd"), "");
    await writeFile(join(projectDirectory, "results.qmd"), RESULTS);

    const result = await renderQuartoBookProject({ projectDirectory, format: "docx", executable: quarto });
    expect(result.status).toBe("success");
    const docx = join(projectDirectory, "_book", (await readdir(join(projectDirectory, "_book"))).find((name) => name.endsWith(".docx"))!);

    // pandoc reorders attributes, so each rule is checked attribute by attribute.
    const style = zipEntry(docx, "word/styles.xml").match(/<w:style [^>]*w:styleId="ScholarPenTable"[^>]*>.*?<\/w:style>/s)?.[0] ?? "";
    const rule = (part: RegExp, edge: "top" | "bottom") => {
      const element = style.match(part)?.[1].match(new RegExp(`<w:${edge} [^>]*>`))?.[0] ?? "";
      return element.includes('w:val="single"') && element.includes('w:sz="8"');
    };
    expect(style).toContain('<w:basedOn w:val="Table"');
    expect(rule(/<w:tblBorders>(.*?)<\/w:tblBorders>/s, "top")).toBe(true);
    expect(rule(/<w:tblBorders>(.*?)<\/w:tblBorders>/s, "bottom")).toBe(true);
    expect(rule(/<w:tblStylePr w:type="firstRow">(.*?)<\/w:tblStylePr>/s, "bottom")).toBe(true);

    // Quarto's one-cell table around the caption, the captioned table, the table without a caption.
    const tableStyles = [...zipEntry(docx, "word/document.xml").matchAll(/<w:tblStyle w:val="([^"]+)"/g)].map((match) => match[1]);
    expect(tableStyles).toEqual(["Table", "ScholarPenTable", "ScholarPenTable"]);
  }, 180_000);
});
