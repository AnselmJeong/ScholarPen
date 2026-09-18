import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { linkSelectedFigure, readLinkedFigure } from "./figure-files";
import { figureExportUrl } from "../../shared/figure-files";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-figure-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "figures"), { recursive: true });
  return { root, project };
}

test("links an existing project image without copying; reads edits from disk", async () => {
  const { project } = await fixture();
  const path = join(project, "figures", "그림 (1),a.png");
  await writeFile(path, "first");
  const selected = await linkSelectedFigure(project, path);
  expect(selected).toEqual({ sourcePath: "figures/그림 (1),a.png", copied: false });
  expect(await readLinkedFigure(project, selected.sourcePath)).toBe("data:image/png;base64,Zmlyc3Q=");
  await writeFile(path, "second");
  expect(await readLinkedFigure(project, selected.sourcePath)).toBe("data:image/png;base64,c2Vjb25k");
});

test("external imports never overwrite an existing figure, even concurrently", async () => {
  const { root, project } = await fixture();
  const path = join(root, "plot.png");
  await writeFile(path, "external");
  await writeFile(join(project, "figures", "plot.png"), "original");
  const results = await Promise.all([linkSelectedFigure(project, path), linkSelectedFigure(project, path)]);
  expect(new Set(results.map((result) => result.sourcePath)).size).toBe(2);
  expect(results.every((result) => result.copied)).toBe(true);
  expect(await readFile(join(project, "figures", "plot.png"), "utf8")).toBe("original");
  for (const result of results) expect(await readFile(join(project, result.sourcePath), "utf8")).toBe("external");
  expect(await readFile(path, "utf8")).toBe("external");
});

test("relative links survive moving a project and fail/recover when the image is deleted/restored", async () => {
  const { root, project } = await fixture();
  const path = join(project, "figures", "plot.svg");
  await writeFile(path, "<svg/>");
  const selected = await linkSelectedFigure(project, path);
  const moved = join(root, "moved");
  await rename(project, moved);
  expect(await readLinkedFigure(moved, selected.sourcePath)).toContain("data:image/svg+xml;base64,");
  await rm(join(moved, selected.sourcePath));
  await expect(readLinkedFigure(moved, selected.sourcePath)).rejects.toThrow();
  await writeFile(join(moved, selected.sourcePath), "<svg>new</svg>");
  expect(await readLinkedFigure(moved, selected.sourcePath)).toEndWith(Buffer.from("<svg>new</svg>").toString("base64"));
});

test("rejects traversal, absolute paths and image symlinks escaping the project", async () => {
  const { root, project } = await fixture();
  await writeFile(join(root, "outside.png"), "private");
  await symlink(join(root, "outside.png"), join(project, "figures", "escape.png"));
  for (const path of ["../outside.png", join(root, "outside.png"), "figures/../../outside.png", "figures/escape.png"]) {
    await expect(readLinkedFigure(project, path)).rejects.toThrow();
  }
});

test("does not import through a figures folder pointing outside the project", async () => {
  const { root, project } = await fixture();
  await rm(join(project, "figures"), { recursive: true });
  await symlink(root, join(project, "figures"));
  await writeFile(join(root, "source.png"), "source");
  await expect(linkSelectedFigure(project, join(root, "source.png"))).rejects.toThrow("outside");
});

test("export paths safely encode filenames and resolve from exports to the original figure", async () => {
  const { project } = await fixture();
  const path = "figures/그림 (1)#50%.png";
  const exported = figureExportUrl(path);
  expect(exported).toStartWith("../figures/");
  expect(exported).toContain("%23");
  expect(decodeURIComponent(new URL(exported, `file://${project}/exports/chapter.qmd`).pathname)).toBe(join(project, path));
  expect(() => figureExportUrl("../outside.png")).toThrow();
});
