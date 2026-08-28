import { describe, expect, test } from "bun:test";
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
      {
        name: "03 History.qmd",
        path: "/project/exports/book/03 History.qmd",
        displayPath: "exports/book/03 History.qmd",
        kind: "note",
      },
    ]);
  });
});
