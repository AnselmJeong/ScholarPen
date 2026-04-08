import { mkdir, readdir, readFile, writeFile, stat } from "fs/promises";
import { join, extname, basename } from "path";
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
  if (isDir) return "folder";
  const ext = extname(name).toLowerCase();
  if (ext === ".json" && name.endsWith(".scholarpen.json")) return "manuscript";
  if (ext === ".bib") return "reference";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "figure";
  if ([".md", ".txt"].includes(ext)) return "note";
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

  async listProjects(): Promise<ProjectInfo[]> {
    await this.ensureBaseDir();
    const rootDir = await this.getProjectsRootDir();
    const entries = await readdir(rootDir, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(rootDir, entry.name);
      try {
        const info = await stat(join(projectPath, "manuscript.scholarpen.json"));
        projects.push({
          name: entry.name,
          path: projectPath,
          files: [],
          lastModified: info.mtimeMs,
        });
      } catch {
        // skip directories without a manuscript
      }
    }

    return projects.sort((a, b) => b.lastModified - a.lastModified);
  }

  async createProject(name: string): Promise<ProjectInfo> {
    const rootDir = await this.getProjectsRootDir();
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    const projectPath = join(rootDir, safeName);

    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "papers"), { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "notes"), { recursive: true });
    await mkdir(join(projectPath, "figures"), { recursive: true });
    await mkdir(join(projectPath, "exports"), { recursive: true });
    await mkdir(join(projectPath, ".lance"), { recursive: true });

    const emptyManuscript = { content: [], version: 1 };
    await writeFile(
      join(projectPath, "manuscript.scholarpen.json"),
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
    const info = await stat(projectPath);
    return {
      name,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: info.mtimeMs,
    };
  }

  async openProjectByPath(projectPath: string): Promise<ProjectInfo> {
    const info = await stat(projectPath);
    const name = basename(projectPath);
    return {
      name,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: info.mtimeMs,
    };
  }

  async saveManuscript(projectPath: string, content: unknown): Promise<void> {
    const filePath = join(projectPath, "manuscript.scholarpen.json");
    await writeFile(filePath, JSON.stringify(content, null, 2));
  }

  async loadManuscript(projectPath: string): Promise<unknown> {
    const filePath = join(projectPath, "manuscript.scholarpen.json");
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw);
  }

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

  async listProjectFiles(projectPath: string, depth = 0): Promise<FileNode[]> {
    if (depth > 3) return [];
    const entries = await readdir(projectPath, { withFileTypes: true });
    const nodes: FileNode[] = [];

    // Files/folders generated by Electrobun or other internal tools
    const IGNORE = new Set(["node_modules", "snapshots", "project.json", "exports"]);

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
    const proc = Bun.spawnSync([
      "osascript",
      "-e",
      'tell application "System Events" to set folderPath to POSIX path of (choose folder with prompt "Choose a projects folder:")',
    ]);
    if (proc.exitCode !== 0) return null;
    const raw = proc.stdout.toString().trim().replace(/\/$/, "");
    return raw.length > 0 ? raw : null;
  }

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

  private buildFileList(projectPath: string): ProjectFile[] {
    return [
      { name: "manuscript.scholarpen.json", path: join(projectPath, "manuscript.scholarpen.json"), type: "manuscript" },
      { name: "references.bib", path: join(projectPath, "references.bib"), type: "reference" },
    ];
  }
}

export const fileSystem = new FileSystemManager();
