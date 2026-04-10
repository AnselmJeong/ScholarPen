import { mkdir, readdir, readFile, writeFile, stat, unlink, rename } from "fs/promises";
import { join, extname, basename, dirname } from "path";
import { homedir } from "os";
import type { ProjectInfo, ProjectFile, FileNode, FileNodeKind, AppSettings, AppSettingsUpdate } from "../../shared/rpc-types";

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

class FileSystemManager {
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
    const projectPath = join(rootDir, safeName);

    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, "documents"), { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "papers"), { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "notes"), { recursive: true });
    await mkdir(join(projectPath, "figures"), { recursive: true });
    await mkdir(join(projectPath, "exports"), { recursive: true });
    await mkdir(join(projectPath, ".lance"), { recursive: true });

    const emptyManuscript = { content: [], version: 1 };
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
    const projectPath = join(rootDir, name);
    await this.migrateProject(projectPath);
    const info = await stat(projectPath);
    return {
      name,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: info.mtimeMs,
    };
  }

  async openProjectByPath(projectPath: string): Promise<ProjectInfo> {
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
    const docsDir = join(projectPath, "documents");
    await mkdir(docsDir, { recursive: true });
    const filePath = join(docsDir, filename);
    await writeFile(filePath, JSON.stringify(content, null, 2));
  }

  async loadDocument(projectPath: string, filename: string): Promise<unknown> {
    const filePath = join(projectPath, "documents", filename);
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  }

  async createDocument(projectPath: string, filename: string, content?: unknown): Promise<string> {
    const docsDir = join(projectPath, "documents");
    await mkdir(docsDir, { recursive: true });
    const safeFilename = filename.endsWith(".scholarpen.json")
      ? filename
      : `${filename}.scholarpen.json`;
    const filePath = join(docsDir, safeFilename);
    const data = content ?? { content: [], version: 1 };
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
    await writeFile(join(projectPath, "references.bib"), bibtex);
  }

  async loadBibtex(projectPath: string): Promise<string> {
    try {
      return await readFile(join(projectPath, "references.bib"), "utf-8");
    } catch {
      return "";
    }
  }

  // ── Export ──────────────────────────────────────────────────

  async exportFile(projectPath: string, filename: string, content: string): Promise<string> {
    const exportDir = join(projectPath, "exports");
    await mkdir(exportDir, { recursive: true });
    const filePath = join(exportDir, filename);
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  // ── File Management ────────────────────────────────────────

  async readTextFile(filePath: string): Promise<string> {
    return readFile(filePath, "utf-8");
  }

  async renameFile(filePath: string, newName: string): Promise<string> {
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

    const newPath = join(dir, finalName);
    await rename(filePath, newPath);
    return newPath;
  }

  async deleteFile(filePath: string): Promise<void> {
    await unlink(filePath);
  }

  // ── File Tree ───────────────────────────────────────────────

  async listProjectFiles(projectPath: string, depth = 0): Promise<FileNode[]> {
    if (depth > 3) return [];
    const entries = await readdir(projectPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    // Files/folders generated by Electrobun or other internal tools
    const IGNORE = new Set(["node_modules", "snapshots", "project.json"]);

    for (const entry of entries) {
      if (entry.name.startsWith(".") || IGNORE.has(entry.name)) continue;
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

      nodes.push(node);
    }

    // Directories first, then files, both alphabetical
    return nodes.sort((a, b) => {
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