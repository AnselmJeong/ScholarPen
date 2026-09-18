import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { discoverQuartoExtensionFormats } from "./extensions";

const directories: string[] = [];
async function fixture(manifests: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "scholarpen-extensions-"));
  directories.push(directory);
  for (const [path, content] of Object.entries(manifests)) {
    const target = join(directory, "_extensions", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Quarto extension discovery", () => {
  test("missing extension directory returns no formats", async () => {
    expect(await discoverQuartoExtensionFormats(await fixture({}))).toEqual({ formats: [], warnings: [] });
  });

  test("infers names from directories and all format contributions, ignoring common and filters", async () => {
    const directory = await fixture({
      "dst-book/_extension.yml": "title: Book layout\ncontributes:\n  formats:\n    common: {toc: true}\n    typst: {}\n    html: default\n",
      "filters/_extension.yml": "contributes:\n  filters: [filter.lua]\n",
      "dst-book/_extensions/embedded/_extension.yml": "contributes:\n  formats:\n    pdf: {}\n",
    });
    const result = await discoverQuartoExtensionFormats(directory);
    expect(result.warnings).toEqual([]);
    expect(result.formats.map((format) => format.name)).toEqual(["dst-book-typst", "dst-book-html"]);
    expect(result.formats[0]).toEqual({
      name: "dst-book-typst", baseFormat: "typst", title: "Book layout",
      manifestPath: "_extensions/dst-book/_extension.yml",
    });
  });

  test("keeps organization names for colliding extension names and supports yaml manifests", async () => {
    const manifest = "contributes:\n  formats:\n    pdf: {}\n";
    const directory = await fixture({ "one/journal/_extension.yml": manifest, "two/journal/_extension.yaml": manifest });
    expect((await discoverQuartoExtensionFormats(directory)).formats.map((format) => format.name))
      .toEqual(["one/journal-pdf", "two/journal-pdf"]);
  });

  test("reports broken manifests while retaining valid extensions", async () => {
    const directory = await fixture({
      "broken/_extension.yml": "contributes: [",
      "invalid/_extension.yml": "contributes:\n  formats: [typst]\n",
      "valid/_extension.yml": "contributes:\n  formats:\n    typst: {}\n",
    });
    const result = await discoverQuartoExtensionFormats(directory);
    expect(result.formats.map((format) => format.name)).toEqual(["valid-typst"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("broken/_extension.yml");
  });

  test("does not follow symlink directories", async () => {
    const directory = await fixture({ "actual/_extension.yml": "contributes:\n  formats:\n    html: {}\n" });
    await symlink(join(directory, "_extensions", "actual"), join(directory, "_extensions", "linked"));
    expect((await discoverQuartoExtensionFormats(directory)).formats.map((format) => format.name)).toEqual(["actual-html"]);
  });
});
