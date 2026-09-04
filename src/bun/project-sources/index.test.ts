import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ProjectSourceIndex, isProjectSourceDigestPath } from "./index";

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryProjects.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function projectWithDigest(): Promise<{ project: string; digest: string }> {
  const project = await mkdtemp(join(tmpdir(), "scholarpen-project-sources-"));
  temporaryProjects.push(project);
  const article = join(project, "resources", "articles", "placebo");
  const summary = join(article, "summary");
  await mkdir(summary, { recursive: true });
  const digest = join(summary, "2026 - Kim - Placebo effects.md");
  await writeFile(join(article, "2026 - Kim - Placebo effects.pdf"), "not needed for indexing");
  await writeFile(digest, `---
title: Placebo Effects in Clinical Care
authors: [Kim]
year: 2026
source_relpath: placebo/2026 - Kim - Placebo effects.pdf
source_page_count: 8
---
# Mechanisms

Expectancy and predictive processing contribute to placebo analgesia. [Source: Mechanisms, p.3]

## Clinical implications

Therapeutic context changes treatment outcomes. [Source: Discussion, pp.6-7]
`);
  return { project, digest };
}

describe("ProjectSourceIndex", () => {
  test("indexes only summary digests and links their original PDF", async () => {
    const { project, digest } = await projectWithDigest();
    const index = new ProjectSourceIndex(project);
    const status = await index.status();
    expect(status.digestCount).toBe(1);
    expect(status.chunkCount).toBe(2);
    expect(status.linkedPdfCount).toBe(1);
    expect(isProjectSourceDigestPath(project, digest)).toBeTrue();

    const hits = await index.search("predictive processing placebo");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toBe("Placebo Effects in Clinical Care");
    expect(hits[0].pageStart).toBe(3);
    expect(hits[0].sourcePdfRelpath).toBe("resources/articles/placebo/2026 - Kim - Placebo effects.pdf");
  });

  test("removes documents whose digest was deleted", async () => {
    const { project, digest } = await projectWithDigest();
    const index = new ProjectSourceIndex(project);
    expect((await index.status()).digestCount).toBe(1);
    await rm(digest);
    index.markDirty();
    expect((await index.status(true)).digestCount).toBe(0);
  });

  test("consults a linked PDF only when the question asks for original verification", async () => {
    const { project } = await projectWithDigest();
    const index = new ProjectSourceIndex(project);
    const ordinary = await index.retrieve("placebo predictive processing", []);
    expect(ordinary.pdfAttempted).toBeFalse();

    const verification = await index.retrieve("placebo 원문 PDF 페이지를 검증해줘", []);
    expect(verification.pdfAttempted).toBeTrue();
    expect(verification.pdfPages).toHaveLength(0);
    expect(verification.pdfErrors).toHaveLength(1);
  });
});
