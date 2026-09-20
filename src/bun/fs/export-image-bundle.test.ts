import { afterEach, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { bundleExportImages } from "./export-image-bundle";
import { prepareQuartoBookImages } from "../quarto/prepare-images";
import { renderQuartoBookProject } from "../quarto/render";

const roots: string[] = [];
const config = 'project:\n  type: book\nbook:\n  chapters:\n    - index.qmd\n    - part: Results\n      chapters: [chapters/results.qmd]\nformat:\n  typst: {}\n';
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-bundle-"));
  roots.push(root);
  await mkdir(join(root, "figures"));
  await mkdir(join(root, "exports", "chapters"), { recursive: true });
  await writeFile(join(root, "figures", "plot.png"), "original");
  await writeFile(join(root, "exports", "_quarto.yml"), config);
  return root;
}
async function prepare(root: string, content: string) {
  return (await bundleExportImages(root, [{ path: join(root, "exports", "index.qmd"), content }]))[0].content;
}

test("bundles only image destinations, including reference images, without changing manuscript syntax", async () => {
  const root = await fixture();
  const name = "그림 (2)#.png";
  await writeFile(join(root, "figures", name), "unicode");
  const url = encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
  const unchanged = '\n\n`![example](../figures/plot.png)`\n\n```md\n![example](../figures/plot.png)\n```\n\n[ordinary](../figures/plot.png)\n\n![web](https://example.com/image.png)';
  const content = `---\ntitle: "![example](../figures/plot.png)"\n---\n\n![**Caption** $x$ [@ref]](<../figures/${url}>){#fig-one width="60%"}\n\n![two][image]\n\n[image]: ../figures/plot.png "Title"${unchanged}`;
  const result = await prepare(root, content);
  expect(result).toBe(content.replace(`(<../figures/${url}>)`, `(<figures/${url}>)`).replace('[image]: ../figures/', '[image]: figures/'));
  expect(await readFile(join(root, "exports", "figures", name), "utf8")).toBe("unicode");
  expect(await readFile(join(root, "figures", name), "utf8")).toBe("unicode");
});

test("migrates configured nested chapters with backups and refreshes originals on repeated renders", async () => {
  const root = await fixture();
  const exports = join(root, "exports");
  const first = '# First\n\n![Plot](../figures/plot.png){#fig-first}\n';
  const nested = '# Results\n\n![Plot](../../figures/plot.png){#fig-second}\n';
  await writeFile(join(exports, "index.qmd"), first);
  await writeFile(join(exports, "chapters/results.qmd"), nested);
  await prepareQuartoBookImages(exports, config);
  expect(await readFile(join(exports, "index.qmd"), "utf8")).toBe(first.replace("../figures", "figures"));
  expect(await readFile(join(exports, "chapters/results.qmd"), "utf8")).toBe(nested.replace("../../figures", "../figures"));
  const backups = await readdir(join(root, ".scholarpen/backups"));
  expect(backups).toHaveLength(1);
  expect(await readFile(join(root, ".scholarpen/backups", backups[0], "exports/index.qmd"), "utf8")).toBe(first);
  expect(await readFile(join(root, ".scholarpen/backups", backups[0], "exports/chapters/results.qmd"), "utf8")).toBe(nested);
  await writeFile(join(root, "figures/plot.png"), "updated original");
  await prepareQuartoBookImages(exports, config);
  expect(await readFile(join(exports, "figures/plot.png"), "utf8")).toBe("updated original");
  expect(await readdir(join(root, ".scholarpen/backups"))).toEqual(backups);
  expect((await lstat(join(exports, "figures"))).isSymbolicLink()).toBe(false);
});

test("preserves unrelated local images and copies different source folders without basename collisions", async () => {
  const root = await fixture();
  await mkdir(join(root, "exports/figures"));
  await writeFile(join(root, "exports/figures/plot.png"), "independent");
  await mkdir(join(root, "resources"));
  await writeFile(join(root, "resources/plot.png"), "resource");
  const result = await prepare(root, '![](../figures/plot.png)\n\n![](../resources/plot.png)\n\n![](figures/plot.png)');
  expect(result).toContain("figures/_project/resources/plot.png");
  expect(result).toMatch(/figures\/plot-[a-f0-9]{12}\.png/);
  expect(result).toEndWith("![](figures/plot.png)");
  expect(await readFile(join(root, "exports/figures/plot.png"), "utf8")).toBe("independent");
});

test("missing originals and independently edited generated copies preserve existing QMD", async () => {
  const root = await fixture();
  const exports = join(root, "exports");
  const first = '![](../figures/plot.png)\n\n![](../figures/missing.png)';
  await writeFile(join(exports, "index.qmd"), first);
  await expect(prepareQuartoBookImages(exports, config)).rejects.toThrow("missing.png");
  expect(await readFile(join(exports, "index.qmd"), "utf8")).toBe(first);
  expect(await readdir(join(exports, "figures"))).toHaveLength(0);
  await writeFile(join(exports, "index.qmd"), '![](../figures/plot.png)');
  await prepareQuartoBookImages(exports, config);
  const migrated = await readFile(join(exports, "index.qmd"), "utf8");
  await writeFile(join(exports, "figures/plot.png"), "user's exported edit");
  await expect(prepareQuartoBookImages(exports, config)).rejects.toThrow("exported copy was edited");
  expect(await readFile(join(exports, "index.qmd"), "utf8")).toBe(migrated);
  expect(await readFile(join(root, "figures/plot.png"), "utf8")).toBe("original");
  await rm(join(root, "figures/plot.png"));
  await expect(prepareQuartoBookImages(exports, config)).rejects.toThrow("original image");
});

test("rejects source escapes and redirected output directories without touching targets", async () => {
  const root = await fixture();
  const outside = await fixture();
  await symlink(join(outside, "figures/plot.png"), join(root, "figures/escape.png"));
  await expect(prepare(root, '![](../figures/escape.png)')).rejects.toThrow("inside this project");
  await symlink(join(root, "figures"), join(root, "exports/figures"));
  await expect(prepare(root, '![](../figures/plot.png)')).rejects.toThrow("real directory");
  expect(await readFile(join(root, "figures/plot.png"), "utf8")).toBe("original");
  expect(await readdir(join(outside, "figures"))).toEqual(["plot.png"]);
});

test("concurrent chapter exports preserve all source mappings", async () => {
  const root = await fixture();
  await Promise.all(Array.from({ length: 4 }, async (_, i) => {
    await writeFile(join(root, `figures/image-${i}.png`), `image ${i}`);
    return prepare(root, `![](../figures/image-${i}.png)`);
  }));
  const manifest = JSON.parse(await readFile(join(root, "exports/.scholarpen-image-manifest.json"), "utf8"));
  expect(manifest.images).toHaveLength(4);
});

test("the actual render entrypoint prepares image bytes before launching Quarto", async () => {
  const root = await fixture();
  const exports = join(root, "exports");
  await writeFile(join(exports, "index.qmd"), '# First\n\n![Plot](../figures/plot.png){#fig-one}');
  const executable = join(root, "fake-quarto");
  await writeFile(executable, '#!/bin/sh\ntest -f figures/plot.png || exit 5\ncat figures/plot.png\n');
  await chmod(executable, 0o755);
  const result = await renderQuartoBookProject({ projectDirectory: exports, executable, format: "typst" });
  expect(result.status).toBe("success");
  expect(result.stdout).toBe("original");
  await writeFile(join(root, "figures/plot.png"), "new bytes");
  const second = await renderQuartoBookProject({ projectDirectory: exports, executable, format: "typst" });
  expect(second.stdout).toBe("new bytes");
});
