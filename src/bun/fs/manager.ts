import { mkdir, readdir, readFile, writeFile, stat, unlink, rename } from "fs/promises";
import { join, extname, basename, dirname, resolve, relative, isAbsolute } from "path";
import { homedir } from "os";
import type { ProjectInfo, ProjectFile, FileNode, FileNodeKind, AppSettings, AppSettingsUpdate } from "../../shared/rpc-types";
import { deduplicateBibtex } from "../../shared/bibtex-utils";

const SCHOLARPEN_BASE = join(homedir(), "ScholarPen");
const SETTINGS_FILE = join(SCHOLARPEN_BASE, "settings.json");

const DEFAULT_SETTINGS: AppSettings = {
  projectsRootDir: join(SCHOLARPEN_BASE, "projects"),
  ollamaBaseUrl: "http://localhost:11434",
  ollamaDefaultModel: "qwen3.5:cloud",
  ollamaEmbedModel: "nomic-embed-text",
  kbChunkSize: 512,
  kbChunkOverlap: 64,
  kbTopK: 5,
  openAlexApiKey: "",
  aiBackend: "ollama",
  claudeModel: "sonnet",
  theme: "system",
};

function extToKind(name: string, isDir: boolean): FileNodeKind {
  if (isDir) {
    if (name === "exports") return "export";
    if (name === "documents") return "folder";
    return "folder";
  }
  const ext = extname(name).toLowerCase();
  if (ext === ".json" && name.endsWith(".scholarpen.json")) return "document";
  if (ext === ".bib") return "reference";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "figure";
  if ([".md", ".qmd", ".txt"].includes(ext)) return "note";
  return "unknown";
}

// ── Knowledge Base Templates ────────────────────────────────────────────────────

const SCHEMA_TEMPLATE = `# Wiki Schema — Research Deep-Dive

## Page Types

| Type | Directory | Purpose |
|------|-----------|---------|
| entity | wiki/entities/ | Named things (people, tools, organizations, datasets) |
| concept | wiki/concepts/ | Ideas, techniques, phenomena, frameworks |
| source | wiki/sources/ | Papers, articles, talks, books, blog posts |
| query | wiki/queries/ | Open questions under active investigation |
| comparison | wiki/comparisons/ | Side-by-side analysis of related entities |
| synthesis | wiki/synthesis/ | Cross-cutting summaries and conclusions |
| overview | wiki/ | High-level project summary (one per project) |
| thesis | wiki/thesis/ | Working hypothesis and its evolution over time |
| methodology | wiki/methodology/ | Research methods, protocols, and study designs |
| finding | wiki/findings/ | Individual empirical results or observations |
| report | wiki/reports/ | Generated reports and analysis outputs |

## Naming Conventions

- Files: \`kebab-case.md\`
- Entities: match official name where possible (e.g., \`openai.md\`, \`gpt-4.md\`)
- Concepts: descriptive noun phrases (e.g., \`chain-of-thought.md\`)
- Sources: \`author-year-slug.md\` (e.g., \`wei-2022-cot.md\`)
- Queries: question as slug (e.g., \`does-scale-improve-reasoning.md\`)
- Theses: hypothesis as slug (e.g., \`scaling-improves-reasoning.md\`)
- Methodologies: method name (e.g., \`systematic-review.md\`, \`ablation-study.md\`)
- Findings: descriptive slug (e.g., \`larger-models-better-few-shot.md\`)

## Frontmatter

All pages must include YAML frontmatter:

\`\`\`yaml
---
type: entity | concept | source | query | comparison | synthesis | overview | report
title: Human-readable title
tags: []
related: []
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
\`\`\`

Source pages also include:
\`\`\`yaml
authors: []
year: YYYY
url: ""
venue: ""
\`\`\`

Thesis pages also include:
\`\`\`yaml
confidence: low | medium | high
status: speculative | supported | refuted | settled
\`\`\`

Finding pages also include:
\`\`\`yaml
source: "[[source-slug]]"
confidence: low | medium | high
replicated: true | false | null
\`\`\`

## Index Format

\`wiki/index.md\` lists all pages grouped by type. Each entry:
\`\`\`
- [[page-slug]] — one-line description
\`\`\`

## Log Format

\`wiki/log.md\` records activity in reverse chronological order:
\`\`\`
## YYYY-MM-DD

- Action taken / finding noted
\`\`\`

## Cross-referencing Rules

- Use \`[[page-slug]]\` syntax to link between wiki pages
- Every entity and concept should appear in \`wiki/index.md\`
- Queries link to the sources and concepts they draw on
- Synthesis pages cite all contributing sources via \`related:\`
- Findings link back to their source via the \`source:\` frontmatter field
- Thesis pages reference supporting and refuting findings via \`related:\`
- Methodology pages are cited by the findings that used them

## Contradiction Handling

When sources contradict each other:
1. Note the contradiction in the relevant concept or entity page
2. Create or update a query page to track the open question
3. Link both sources from the query page
4. Resolve in a synthesis page once sufficient evidence exists

## Research-Specific Conventions

- Keep the thesis pages updated as evidence accumulates — they are living documents
- Every finding should assess replication status when known
- Methodology pages explain the *why* (rationale) not just the *how*
- Distinguish between direct evidence and inference in finding pages
`;

const PURPOSE_TEMPLATE = `# Project Purpose — Research Deep-Dive

## Research Question

<!-- State the central question this research aims to answer. Be specific and falsifiable. -->

>

## Hypothesis / Working Thesis

<!-- Your current best guess. This will evolve - update it as evidence accumulates. -->

>

## Background

<!-- What prior work or context motivates this research? What gap does it fill? -->

## Sub-questions

<!-- Break down the main question into tractable sub-questions. -->

1.
2.
3.
4.

## Scope

**In scope:**
-

**Out of scope:**
-

## Methodology

<!-- How will you investigate this? What types of sources or experiments are relevant? -->

-

## Success Criteria

<!-- How will you know when you have a satisfying answer? -->

-

## Current Status

> Not started - update this section as research progresses.
`;

const INDEX_TEMPLATE = `# Wiki Index

## Entities

- (None yet)

## Concepts

- (None yet)

## Sources

- (None yet)

## Queries

- (None yet)

## Comparisons

- (None yet)

## Findings

- (None yet)

## Methodology

- (None yet)

## Synthesis

- (None yet)

## Thesis

- (None yet)

## Reports

- (None yet)
`;

const OVERVIEW_TEMPLATE = `---
type: overview
title: Project Overview
tags: []
related: []
created: ${new Date().toISOString().split("T")[0]}
updated: ${new Date().toISOString().split("T")[0]}
---

# Project Overview

<!-- Provide a high-level summary of the research project, its goals, and current state. -->
`;

const LOG_TEMPLATE = `# Research Log

## ${new Date().toISOString().split("T")[0]}

- Project created.
`;

const SCHOLARWIKI_TEMPLATE = `raw_dir: ./raw/sources
summaries_dir: ./wiki/sources
wiki_dir: ./wiki
llm:
  provider: ollama
  model: nemotron-3-super:cloud
concept_threshold: 3
`;

class FileSystemManager {
  private allowedProjectPaths = new Set<string>();

  private markProjectPath(projectPath: string): string {
    const resolved = resolve(projectPath);
    this.allowedProjectPaths.add(resolved);
    return resolved;
  }

  private async assertKnownProjectPath(projectPath: string): Promise<string> {
    const resolvedProject = resolve(projectPath);
    if (this.allowedProjectPaths.has(resolvedProject)) return resolvedProject;

    const rootDir = resolve(await this.getProjectsRootDir());
    const rel = relative(rootDir, resolvedProject);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      this.allowedProjectPaths.add(resolvedProject);
      return resolvedProject;
    }

    throw new Error("Project path is outside the configured projects root and has not been opened.");
  }

  private async assertProjectFilePath(filePath: string): Promise<string> {
    const resolvedFile = resolve(filePath);
    for (const projectPath of this.allowedProjectPaths) {
      const rel = relative(projectPath, resolvedFile);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        return resolvedFile;
      }
    }

    const rootDir = resolve(await this.getProjectsRootDir());
    const rel = relative(rootDir, resolvedFile);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      return resolvedFile;
    }

    throw new Error("File path is outside the active ScholarPen project roots.");
  }

  private safeFilename(filename: string, expectedSuffix?: string): string {
    if (
      !filename ||
      filename.includes("\0") ||
      filename.includes("/") ||
      filename.includes("\\") ||
      filename.includes("..") ||
      basename(filename) !== filename
    ) {
      throw new Error("Invalid filename.");
    }
    if (expectedSuffix && !filename.endsWith(expectedSuffix)) {
      throw new Error(`Filename must end with ${expectedSuffix}.`);
    }
    return filename;
  }

  private async getProjectsRootDir(): Promise<string> {
    try {
      const settings = await this.getSettings();
      return settings.projectsRootDir;
    } catch {
      return DEFAULT_SETTINGS.projectsRootDir;
    }
  }

  async ensureBaseDir(): Promise<void> {
    const rootDir = await this.getProjectsRootDir();
    await mkdir(rootDir, { recursive: true });
  }

  // ── Project Management ──────────────────────────────────────

  async listProjects(): Promise<ProjectInfo[]> {
    await this.ensureBaseDir();
    const rootDir = await this.getProjectsRootDir();
    const entries = await readdir(rootDir, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(rootDir, entry.name);

      // Migrate legacy projects (manuscript at root → documents/)
      await this.migrateProject(projectPath);

      // Check for documents/ directory as indicator of a valid project
      try {
        const docsDir = join(projectPath, "documents");
        const info = await stat(docsDir);
        this.markProjectPath(projectPath);
        projects.push({
          name: entry.name,
          path: projectPath,
          files: [],
          lastModified: info.mtimeMs,
        });
      } catch {
        // Also accept projects with legacy manuscript at root
        try {
          const info = await stat(join(projectPath, "manuscript.scholarpen.json"));
          this.markProjectPath(projectPath);
          projects.push({
            name: entry.name,
            path: projectPath,
            files: [],
            lastModified: info.mtimeMs,
          });
        } catch {
          // skip directories without any document
        }
      }
    }

    return projects.sort((a, b) => b.lastModified - a.lastModified);
  }

  async createProject(name: string): Promise<ProjectInfo> {
    const rootDir = await this.getProjectsRootDir();
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    const projectPath = this.markProjectPath(join(rootDir, safeName));

    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, "documents"), { recursive: true });
    // Knowledge Base structure (matches Knowledge_Base schema)
    const kbDir = join(projectPath, "Knowledge_Base");
    const wikiDir = join(kbDir, "wiki");
    const wikiSubdirs = [
      "sources", "concepts", "entities", "synthesis",
      "findings", "thesis", "queries", "methodology", "comparisons", "reports", "index",
    ];
    for (const sub of wikiSubdirs) {
      await mkdir(join(wikiDir, sub), { recursive: true });
    }
    await mkdir(join(kbDir, "raw", "sources"), { recursive: true });
    await writeFile(join(kbDir, "schema.md"), SCHEMA_TEMPLATE);
    await writeFile(join(kbDir, "purpose.md"), PURPOSE_TEMPLATE);
    await writeFile(join(kbDir, "scholarwiki.yaml"), SCHOLARWIKI_TEMPLATE);
    await writeFile(join(wikiDir, "index.md"), INDEX_TEMPLATE);
    await writeFile(join(wikiDir, "overview.md"), OVERVIEW_TEMPLATE);
    await writeFile(join(wikiDir, "log.md"), LOG_TEMPLATE);
    await mkdir(join(projectPath, "figures"), { recursive: true });
    await mkdir(join(projectPath, "exports"), { recursive: true });
    await mkdir(join(projectPath, ".lance"), { recursive: true });

    const emptyManuscript: unknown[] = [];
    await writeFile(
      join(projectPath, "documents", `${safeName}.scholarpen.json`),
      JSON.stringify(emptyManuscript, null, 2)
    );
    await writeFile(join(projectPath, "references.bib"), "");

    return {
      name: safeName,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: Date.now(),
    };
  }

  async openProject(name: string): Promise<ProjectInfo> {
    const rootDir = await this.getProjectsRootDir();
    const safeName = this.safeFilename(name);
    const projectPath = this.markProjectPath(join(rootDir, safeName));
    await this.migrateProject(projectPath);
    const info = await stat(projectPath);
    return {
      name: safeName,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: info.mtimeMs,
    };
  }

  async openProjectByPath(projectPath: string): Promise<ProjectInfo> {
    projectPath = this.markProjectPath(projectPath);
    await this.migrateProject(projectPath);
    const info = await stat(projectPath);
    const name = basename(projectPath);
    return {
      name,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: info.mtimeMs,
    };
  }

  // ── Document CRUD ───────────────────────────────────────────

  async saveDocument(projectPath: string, filename: string, content: unknown): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    filename = this.safeFilename(filename, ".scholarpen.json");
    const docsDir = join(projectPath, "documents");
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, filename);
    await writeFile(filePath, JSON.stringify(content, null, 2));
  }

  async loadDocument(projectPath: string, filename: string): Promise<unknown> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    filename = this.safeFilename(filename, ".scholarpen.json");
    const filePath = join(projectPath, "documents", filename);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  }

  async createDocument(projectPath: string, filename: string, content?: unknown): Promise<string> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    const docsDir = join(projectPath, "documents");
    await mkdir(docsDir, { recursive: true });
    const safeFilename = filename.endsWith(".scholarpen.json")
      ? this.safeFilename(filename, ".scholarpen.json")
      : this.safeFilename(`${filename}.scholarpen.json`, ".scholarpen.json");
    const filePath = join(docsDir, safeFilename);
    const data = content ?? [];
    await writeFile(filePath, JSON.stringify(data, null, 2));
    return safeFilename;
  }

  // ── Legacy (backward compat) ────────────────────────────────

  async saveManuscript(projectPath: string, content: unknown): Promise<void> {
    await this.migrateProject(projectPath);
    await this.saveDocument(projectPath, "manuscript.scholarpen.json", content);
  }

  async loadManuscript(projectPath: string): Promise<unknown> {
    await this.migrateProject(projectPath);
    return this.loadDocument(projectPath, "manuscript.scholarpen.json");
  }

  // ── BibTeX ──────────────────────────────────────────────────

  async saveBibtex(projectPath: string, bibtex: string): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    await writeFile(join(projectPath, "references.bib"), deduplicateBibtex(bibtex));
  }

  async saveBibtexRaw(projectPath: string, bibtex: string): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    await writeFile(join(projectPath, "references.bib"), bibtex);
  }

  async loadBibtex(projectPath: string): Promise<string> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    try {
      return await readFile(join(projectPath, "references.bib"), "utf-8");
    } catch {
      return "";
    }
  }

  // ── Export ──────────────────────────────────────────────────

  async exportFile(projectPath: string, filename: string, content: string): Promise<string> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    filename = this.safeFilename(filename);
    const exportDir = join(projectPath, "exports");
    await mkdir(exportDir, { recursive: true });
    const filePath = join(exportDir, filename);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  // ── File Management ────────────────────────────────────────

  async readTextFile(filePath: string): Promise<string> {
    filePath = await this.assertProjectFilePath(filePath);
    return readFile(filePath, "utf-8");
  }

  async readBinaryFile(filePath: string): Promise<string> {
    filePath = await this.assertProjectFilePath(filePath);
    const buf = await readFile(filePath);
    return buf.toString("base64");
  }

  async renameFile(filePath: string, newName: string): Promise<string> {
    filePath = await this.assertProjectFilePath(filePath);
    const dir = dirname(filePath);
    const oldBasename = basename(filePath);

    // Preserve extension if newName doesn't already include it
    let finalName = newName;
    if (oldBasename.endsWith(".scholarpen.json")) {
      if (!newName.endsWith(".scholarpen.json")) {
        finalName = `${newName}.scholarpen.json`;
      }
    } else {
      const oldExt = extname(oldBasename);
      if (oldExt && !newName.endsWith(oldExt)) {
        finalName = `${newName}${oldExt}`;
      }
    }

    finalName = this.safeFilename(finalName);
    const newPath = await this.assertProjectFilePath(join(dir, finalName));
    await rename(filePath, newPath);
    return newPath;
  }

  async deleteFile(filePath: string): Promise<void> {
    filePath = await this.assertProjectFilePath(filePath);
    await unlink(filePath);
  }

  // ── File Tree ───────────────────────────────────────────────

  async listProjectFiles(projectPath: string, depth = 0): Promise<FileNode[]> {
    if (depth === 0) projectPath = await this.assertKnownProjectPath(projectPath);
    if (depth > 5) return [];
    const entries = await readdir(projectPath, { withFileTypes: true });

    // Files/folders generated by Electrobun or other internal tools
    const IGNORE = new Set(["node_modules", "snapshots", "project.json"]);

    const nodes = await Promise.all(entries.map(async (entry): Promise<FileNode | null> => {
      if (entry.name.startsWith(".") || IGNORE.has(entry.name)) return null;
      const fullPath = join(projectPath, entry.name);
      const isDir = entry.isDirectory();
      const kind = extToKind(entry.name, isDir);

      let fileInfo = { mtimeMs: 0, size: 0 };
      try {
        const s = await stat(fullPath);
        fileInfo = { mtimeMs: s.mtimeMs, size: s.size };
      } catch {}

      const node: FileNode = {
        name: entry.name,
        path: fullPath,
        kind,
        isDirectory: isDir,
        lastModified: fileInfo.mtimeMs,
        size: isDir ? undefined : fileInfo.size,
      };

      if (isDir) {
        node.children = await this.listProjectFiles(fullPath, depth + 1);
      }

      return node;
    }));

    // Directories first, then files, both alphabetical
    return nodes.filter((node): node is FileNode => node !== null).sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async openFolderDialog(): Promise<string | null> {
    const proc = Bun.spawn([
      "osascript",
      "-e",
      'POSIX path of (choose folder with prompt "Choose a projects folder:")',
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const raw = (await new Response(proc.stdout).text()).trim().replace(/\/$/, "");
    return raw.length > 0 ? raw : null;
  }

  // ── Settings ────────────────────────────────────────────────

  async getSettings(): Promise<AppSettings> {
    await mkdir(SCHOLARPEN_BASE, { recursive: true });
    try {
      const raw = await readFile(SETTINGS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async saveSettings(update: AppSettingsUpdate): Promise<void> {
    const current = await this.getSettings();
    const merged = { ...current, ...update };
    await writeFile(SETTINGS_FILE, JSON.stringify(merged, null, 2));
    if (update.projectsRootDir) {
      await mkdir(update.projectsRootDir, { recursive: true });
    }
  }

  // ── Migration ───────────────────────────────────────────────

  /** Migrate legacy projects: move root manuscript.scholarpen.json → documents/ */
  private async migrateProject(projectPath: string): Promise<void> {
    const oldPath = join(projectPath, "manuscript.scholarpen.json");
    const docsDir = join(projectPath, "documents");
    const newPath = join(docsDir, "manuscript.scholarpen.json");

    try {
      await stat(oldPath);
      // Legacy file exists at root — migrate it
      await mkdir(docsDir, { recursive: true });
      const content = await readFile(oldPath, "utf-8");
      await writeFile(newPath, content);
      await unlink(oldPath);
      console.log(`[Migration] Moved ${oldPath} → ${newPath}`);
    } catch {
      // No legacy file — already migrated or never existed
    }
  }

  private buildFileList(projectPath: string): ProjectFile[] {
    return [
      { name: "documents", path: join(projectPath, "documents"), type: "manuscript" as const },
      { name: "references.bib", path: join(projectPath, "references.bib"), type: "reference" as const },
    ];
  }
}

export const fileSystem = new FileSystemManager();
