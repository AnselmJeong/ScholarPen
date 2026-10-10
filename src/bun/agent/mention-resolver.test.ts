import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentMentionableFile, FileNode } from "../../shared/rpc-types";
import {
  buildMentionableFiles,
  resolveMentionedFiles,
} from "./mention-resolver";

const projectPath = "/project";
const sourcePath = "/project/documents/03 History of Neuromodulation.scholarpen.json";
const exportPath = "/project/exports/03 History of Neuromodulation.qmd";

const mentionable: AgentMentionableFile[] = [
  {
    name: "03 History of Neuromodulation.scholarpen.json",
    path: sourcePath,
    displayPath: "documents/03 History of Neuromodulation.scholarpen.json",
    kind: "document",
  },
  {
    name: "03 History of Neuromodulation.qmd",
    path: exportPath,
    displayPath: "exports/03 History of Neuromodulation.qmd",
    kind: "note",
  },
];

const dependencies = {
  listMentionableFiles: async () => mentionable,
  readTextFile: async (filePath: string) =>
    filePath === sourcePath ? "source manuscript content" : "exported qmd content",
};

describe("agent file mention resolution", () => {
  test("includes both dropdown-selected files whose names contain spaces", async () => {
    const contexts = await resolveMentionedFiles(
      {
        projectPath,
        explicitFilePaths: [sourcePath, exportPath],
        message:
          "Compare @03 History of Neuromodulation.scholarpen.json and @03 History of Neuromodulation.qmd",
      },
      dependencies,
    );

    expect(contexts.map((file) => [file.displayPath, file.content])).toEqual([
      ["documents/03 History of Neuromodulation.scholarpen.json", "source manuscript content"],
      ["exports/03 History of Neuromodulation.qmd", "exported qmd content"],
    ]);
  });

  test("resolves a path-aware mention without separate UI state", async () => {
    const contexts = await resolveMentionedFiles(
      {
        projectPath,
        explicitFilePaths: [],
        message: "Review @[exports/03 History of Neuromodulation.qmd]",
      },
      dependencies,
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.content).toBe("exported qmd content");
  });

  test("keeps the legacy ambiguous-token error when no dropdown selection disambiguates it", async () => {
    await expect(
      resolveMentionedFiles(
        {
          projectPath,
          explicitFilePaths: [],
          message: "Review @03",
        },
        dependencies,
      ),
    ).rejects.toThrow("@03 is ambiguous");
  });

  test("includes supported files from nested export folders", () => {
    const nodes: FileNode[] = [
      {
        name: "exports",
        path: "/project/exports",
        kind: "folder",
        isDirectory: true,
        lastModified: 0,
        children: [
          {
            name: "book",
            path: "/project/exports/book",
            kind: "folder",
            isDirectory: true,
            lastModified: 0,
            children: [
              {
                name: "03 History.qmd",
                path: "/project/exports/book/03 History.qmd",
                kind: "note",
                isDirectory: false,
                lastModified: 0,
              },
            ],
          },
        ],
      },
    ];

    expect(buildMentionableFiles(projectPath, nodes)).toEqual([
      { name: "exports", path: "/project/exports", displayPath: "exports/", kind: "folder" },
      { name: "book", path: "/project/exports/book", displayPath: "exports/book/", kind: "folder" },
      {
        name: "03 History.qmd",
        path: "/project/exports/book/03 History.qmd",
        displayPath: "exports/book/03 History.qmd",
        kind: "note",
      },
    ]);
  });

  test("expands folders recursively, deduplicates files, and excludes sibling prefixes", async () => {
    const contexts = await resolveMentionedFiles({ projectPath, explicitFilePaths: [],
      message: "Compare @[exports/] with @[exports/03 History of Neuromodulation.qmd]",
    }, { ...dependencies, listMentionableFiles: async () => [
      ...mentionable,
      { name: "exports", path: "/project/exports", displayPath: "exports/", kind: "folder" },
      { name: "nested", path: "/project/exports/nested", displayPath: "exports/nested/", kind: "folder" },
      { name: "refs.bib", path: "/project/exports/nested/refs.bib", displayPath: "exports/nested/refs.bib", kind: "note" },
      { name: "private.txt", path: "/project/exports-other/private.txt", displayPath: "exports-other/private.txt", kind: "note" },
    ] });
    expect(contexts.map(file => file.displayPath)).toEqual([
      "exports/03 History of Neuromodulation.qmd", "exports/nested/refs.bib",
    ]);
  });

  test("AI handles and ordinary comments do not scan the filesystem", async () => {
    for (const message of ["Please revise", "@AI please revise", "@stats please check", "@reviewer2 thoughts?"]) {
      expect(await resolveMentionedFiles({ projectPath, message, explicitFilePaths: [] }, {
        listMentionableFiles: async () => { throw new Error("Must not scan"); },
      })).toEqual([]);
    }
  });

  test("missing, outside-project and empty folder references fail explicitly", async () => {
    for (const message of ["@[missing.bib]", "@[../secret.txt]", "@[empty/]"]) {
      await expect(resolveMentionedFiles({ projectPath, message, explicitFilePaths: [] }, {
        ...dependencies, listMentionableFiles: async () => [...mentionable,
          { name: "empty", path: "/project/empty", displayPath: "empty/", kind: "folder" }],
      })).rejects.toThrow();
    }
    await expect(resolveMentionedFiles({ projectPath, message: "", explicitFilePaths: ["/secret.txt"] }, dependencies))
      .rejects.toThrow("not part of the current project");
  });

  test("large folders fail instead of silently omitting files", async () => {
    await expect(resolveMentionedFiles({ projectPath, message: "@[exports/]", explicitFilePaths: [] }, {
      ...dependencies, listMentionableFiles: async () => [
        { name: "exports", path: "/project/exports", displayPath: "exports/", kind: "folder" },
        ...Array.from({ length: 33 }, (_, i) => ({ name: `${i}.txt`, path: `/project/exports/${i}.txt`, displayPath: `exports/${i}.txt`, kind: "note" as const })),
      ],
    })).rejects.toThrow("maximum 32");
  });

  test("marks long files as excerpts and bounds total context", async () => {
    const contexts = await resolveMentionedFiles({ projectPath, message: "", explicitFilePaths: [exportPath] }, {
      ...dependencies, readTextFile: async () => "x".repeat(30_000),
    });
    expect(contexts[0].truncated).toBe(true);
    expect(contexts[0].content.length).toBeLessThan(20_000);
    await expect(resolveMentionedFiles({ projectPath, message: "@[exports/]", explicitFilePaths: [] }, {
      readTextFile: async () => "x".repeat(20_000),
      listMentionableFiles: async () => [
        { name: "exports", path: "/project/exports", displayPath: "exports/", kind: "folder" },
        ...Array.from({ length: 5 }, (_, i) => ({ name: `${i}.txt`, path: `/project/exports/${i}.txt`, displayPath: `exports/${i}.txt`, kind: "note" as const })),
      ],
    })).rejects.toThrow("too large");
  });

  test("a project symlink cannot disclose a file outside the project", async () => {
    const root = await mkdtemp(join(tmpdir(), "scholarpen-mention-test-"));
    try {
      const project = join(root, "project");
      await mkdir(project);
      await writeFile(join(root, "private.txt"), "outside project");
      await symlink(join(root, "private.txt"), join(project, "linked.txt"));
      await expect(resolveMentionedFiles({ projectPath: project, message: "@[linked.txt]", explicitFilePaths: [] }, {
        listMentionableFiles: async () => [{ name: "linked.txt", path: join(project, "linked.txt"), displayPath: "linked.txt", kind: "note" }],
      })).rejects.toThrow("outside the current project");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
