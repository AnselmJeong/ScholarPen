import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, unlink, utimes, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { parseBibtexEntries } from "../../shared/bibtex-utils";
import type { ExtractedPdf } from "../project-sources/pdf-extractor";
import { CitationSourceIndex, isCitationSourcePdfPath } from "./source-index";

const projects: string[] = [];
afterEach(async () => {
  await Promise.all(projects.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const filler = (topic: string) => Array.from({ length: 30 }, (_, i) => `The ${topic} observation ${i} was recorded.`).join(" ");

/** The fake "PDF" files hold JSON pages, so tests need no PDF parser. */
async function fakeExtract(filePath: string): Promise<ExtractedPdf> {
  const pages = JSON.parse(await Bun.file(filePath).text()) as string[];
  return { pageCount: pages.length, pages: pages.map((content, index) => ({ pageNumber: index + 1, content })) };
}

async function project(files: Record<string, string[]>) {
  const root = await mkdtemp(join(tmpdir(), "scholarpen-citation-sources-"));
  projects.push(root);
  for (const [relpath, pages] of Object.entries(files)) {
    await mkdir(join(root, relpath, ".."), { recursive: true });
    await writeFile(join(root, relpath), JSON.stringify(pages));
  }
  let calls = 0;
  const index = new CitationSourceIndex(root, async (path) => { calls += 1; return fakeExtract(path); });
  return { root, index, extractions: () => calls };
}

const BIB = parseBibtexEntries(`
@article{tu2021manipulating,
  title = {Manipulating placebo analgesia and nocebo hyperalgesia by changing brain excitability},
  author = {Tu, Yiheng and Bi, Yanzhi},
  year = {2021},
  doi = {10.1073/pnas.2101273118}
}
@article{cohen2020placebo,
  title = {Placebo response mitigation with a participant-focused psychoeducational procedure},
  author = {Cohen, Elan A.},
  year = {2020},
  doi = {10.1038/s41386-020-0680-x}
}
@article{other2019,
  title = {A completely different topic about sleep spindles in adolescents},
  author = {Other, A.},
  year = {2019},
  doi = {10.1000/other.2019}
}
`).entries;

describe("CitationSourceIndex", () => {
  test("indexes PDFs under resources/ once and again only when they change", async () => {
    const { root, index, extractions } = await project({
      "resources/articles/tu.pdf": [`Manipulating placebo analgesia and nocebo hyperalgesia by changing brain excitability. doi:10.1073/pnas.2101273118 ${filler("lead")}`, `Cathodal tDCS boosted placebo analgesia in the right DLPFC. ${filler("results")}`],
      "resources/books/scan.pdf": ["", ""],
      "drafts/not-a-source.pdf": ["ignored"],
    });
    await index.scan();
    expect(await index.status()).toMatchObject({ pdfCount: 2, indexedCount: 1, noTextCount: 1, failedCount: 0, indexing: false });
    expect(extractions()).toBe(2);

    await index.scan();
    expect(extractions()).toBe(2);

    const later = new Date(Date.now() + 5_000);
    await utimes(join(root, "resources/articles/tu.pdf"), later, later);
    await index.scan();
    expect(extractions()).toBe(3);

    await unlink(join(root, "resources/books/scan.pdf"));
    await index.scan();
    expect((await index.status()).pdfCount).toBe(1);
  });

  test("links entries by DOI and title, searches body passages, and leaves contested PDFs alone", async () => {
    const { index } = await project({
      "resources/articles/2021 - Tu - Manipulating placebo analgesia.pdf": [
        `PNAS. Manipulating placebo analgesia and nocebo hyperalgesia by changing brain excitability. https://doi.org/10.1073/pnas.2101273118 ${filler("lead")}`,
        `Results from our task fMRI suggest that cathodal tDCS enhanced brain activations in the vmPFC to boost placebo analgesia. ${filler("results")}`,
      ],
      // Title only in the file name; the text has no DOI.
      "resources/articles/2020 - Cohen - Placebo response mitigation with a participant-focused psychoeducational procedure.pdf": [
        `Scanned header without a title. ${filler("cohen lead")}`, `Psychoeducation reduced placebo response. ${filler("cohen body")}`,
      ],
      // Cites other2019's DOI on its first page but is about tu2021: the DOI alone must not link it.
      "resources/articles/commentary.pdf": [`Commentary citing doi:10.1000/other.2019 about placebo analgesia and nocebo. ${filler("comment")}`],
    });
    await index.scan();
    const links = await index.linkEntries(BIB);
    expect(links.get("tu2021manipulating")).toMatchObject({ method: "doi+title", status: "indexed" });
    expect(links.get("cohen2020placebo")).toMatchObject({ method: "title" });
    expect(links.has("other2019")).toBe(false);

    const tu = links.get("tu2021manipulating")!;
    const lead = await index.lead(tu.pdfId);
    expect(lead[0].content).toContain("Manipulating placebo analgesia");
    const hits = await index.search(tu.pdfId, ["tDCS amplifies placebo analgesia", "boost enhance tdcs placebo"]);
    expect(hits[0].content).toContain("boost placebo analgesia");
    expect(hits.every(hit => hit.kind === "body")).toBe(true);
  });

  test("caches abstracts, including the absence of one", async () => {
    const { index } = await project({});
    await index.storeAbstract("doi:10.1/x", { abstract: "An abstract.", title: "X", retracted: true });
    await index.storeAbstract("doi:10.1/y", { abstract: null, title: null, retracted: false });
    expect(await index.cachedAbstract("doi:10.1/x")).toEqual({ abstract: "An abstract.", title: "X", retracted: true });
    expect(await index.cachedAbstract("doi:10.1/y")).toEqual({ abstract: null, title: null, retracted: false });
    expect(await index.cachedAbstract("doi:10.1/z")).toBeUndefined();
  });
});

test("treats PDFs anywhere under resources/ as citation sources", () => {
  expect(isCitationSourcePdfPath("resources/articles/a.PDF")).toBe(true);
  expect(isCitationSourcePdfPath("resources\\books\\b.pdf")).toBe(true);
  expect(isCitationSourcePdfPath("figures/a.pdf")).toBe(false);
});
