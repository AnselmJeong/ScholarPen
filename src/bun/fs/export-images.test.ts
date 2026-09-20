import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve } from "path";
import type { BlockNoteEditor } from "@blocknote/core";
import { blocksToScholarMarkdown } from "../../renderer/blocks/markdown-serializer";
import { externalizeExportImages } from "./export-images";
import { fileSystem } from "./manager";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT3sAAAAASUVORK5CYII=", "base64");
const data = `data:image/png;base64,${png.toString("base64")}`;
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function project() {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-export-images-"));
  roots.push(root);
  await mkdir(join(root, "documents"));
  return root;
}
function imageUrl(markdown: string) {
  return markdown.match(/(?:\.\.\/)?figures\/embedded-[\w-]+\.png/)![0];
}

test("extracts exact image bytes while preserving captions, Quarto attributes and citations", async () => {
  const root = await project();
  const source = `---\ntitle: Chapter\n---\n\n![한글 **caption** $x$ [@smith2020]](<${data}>){#fig-one width="70%" fig-alt="Description"}\n\nSee @fig-one.\n`;
  const result = await externalizeExportImages(root, source);
  const url = imageUrl(result);
  expect(result).toBe(source.replace(data, url));
  expect(await readFile(resolve(root, "exports", url))).toEqual(png);
  expect(await externalizeExportImages(root, source)).toBe(result);
  expect(await readdir(join(root, "figures"))).toHaveLength(1);
  const moved = root + "-moved";
  await rename(root, moved);
  roots.push(moved);
  expect(await readFile(resolve(moved, "exports", url))).toEqual(png);
});

test("extracts repeated and reference images, leaving code examples, remote and local links unchanged", async () => {
  const root = await project();
  const examples = `\`${data}\`\n\n\`\`\`md\n![example](${data})\n\`\`\`\n\n![remote](https://example.com/a.png)\n\n![local](../figures/plot.png)`;
  const source = `- ![one](${data})\n\n![two][plot]\n\n[plot]: <${data}> "Title"\n\n${examples}`;
  const result = await externalizeExportImages(root, source);
  const url = imageUrl(result);
  expect(result).toBe(`- ![one](${url})\n\n![two][plot]\n\n[plot]: <${url}> "Title"\n\n${examples}`);
  expect(await readdir(join(root, "figures"))).toHaveLength(1);
});

test("never overwrites an edited extracted image or follows a destination symlink", async () => {
  const root = await project();
  const source = `![image](${data})`;
  const first = await externalizeExportImages(root, source);
  const original = resolve(root, "exports", imageUrl(first));
  await writeFile(original, "user edit");
  const second = await externalizeExportImages(root, source);
  expect(second).not.toBe(first);
  expect(await readFile(original, "utf8")).toBe("user edit");
  expect(await readFile(resolve(root, "exports", imageUrl(second)))).toEqual(png);
  await rm(original);
  const outside = join(root, "private.png");
  await writeFile(outside, "private");
  await symlink(outside, original);
  expect(await externalizeExportImages(root, source)).toBe(second);
  expect(await readFile(outside, "utf8")).toBe("private");
});

test("concurrent exports share a complete image file", async () => {
  const root = await project();
  const results = await Promise.all(Array.from({ length: 5 }, () => externalizeExportImages(root, `![](${data})`)));
  expect(new Set(results).size).toBe(1);
  expect(await readFile(resolve(root, "exports", imageUrl(results[0])))).toEqual(png);
  expect(await readdir(join(root, "figures"))).toHaveLength(1);
});

test("exports both embedded and linked figures through the real file writer without changing document JSON", async () => {
  const root = await project();
  await fileSystem.openProjectByPath(root);
  await mkdir(join(root, "figures"), { recursive: true });
  await writeFile(join(root, "figures", "current.png"), png);
  const blocks = [
    { id: "embedded", type: "figure", props: { url: data, label: "fig-one", caption: "Legacy" }, content: undefined, children: [] },
    { id: "linked", type: "figure", props: { url: data, sourcePath: "figures/current.png", label: "fig-two", caption: "Linked" }, content: undefined, children: [] },
  ];
  const original = JSON.stringify(blocks);
  await writeFile(join(root, "documents", "chapter.scholarpen.json"), original);
  for (const format of ["qmd", "md"] as const) {
    const serialized = await blocksToScholarMarkdown({} as BlockNoteEditor, blocks, format);
    const file = await fileSystem.exportFile(root, `chapter.${format}`, serialized);
    const exported = await readFile(file, "utf8");
    expect(exported).not.toContain("data:image");
    expect(exported).toContain("figures/current.png");
    expect(exported).not.toContain("../figures/");
    expect(await readFile(join(root, "exports", "figures", "current.png"))).toEqual(png);
    expect(exported).toContain("Legacy");
    expect(await readFile(resolve(root, "exports", imageUrl(exported)))).toEqual(png);
    if (format === "qmd") expect(exported).toContain("{#fig-one}");
  }
  expect(JSON.stringify(blocks)).toBe(original);
  expect(await readFile(join(root, "documents", "chapter.scholarpen.json"), "utf8")).toBe(original);
});

test("invalid images and redirected folders leave the previous export intact", async () => {
  const root = await project();
  await fileSystem.openProjectByPath(root);
  await mkdir(join(root, "exports"), { recursive: true });
  const file = join(root, "exports", "chapter.qmd");
  await writeFile(file, "previous export");
  for (const invalid of ["data:image/png;base64,@@@", "data:image/png;base64,A", "data:image/unknown;base64,YQ=="]) {
    await expect(fileSystem.exportFile(root, "chapter.qmd", `![](${data})\n\n![](${invalid})`)).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("previous export");
  }
  const outside = await project();
  await symlink(outside, join(root, "figures"));
  await expect(fileSystem.exportFile(root, "chapter.qmd", `![](${data})`)).rejects.toThrow("figures folder");
  expect(await readFile(file, "utf8")).toBe("previous export");
  expect(await readdir(outside)).toEqual(["documents"]);
});

test("supports SVG base64 and does not process non-Markdown export files", async () => {
  const root = await project();
  await fileSystem.openProjectByPath(root);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  const result = await externalizeExportImages(root, `![vector](data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")})`);
  const url = result.match(/\.\.\/figures\/[^)]+/)![0];
  expect(url).toEndWith(".svg");
  expect(await readFile(resolve(root, "exports", url), "utf8")).toBe(svg);
  const config = `text: "![](${data})"`;
  expect(await readFile(await fileSystem.exportFile(root, "_quarto.yml", config), "utf8")).toBe(config);
});
