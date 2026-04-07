import { mkdir, readdir, readFile, writeFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ProjectInfo, ProjectFile } from "../../shared/rpc-types";

const SCHOLARPEN_DIR = join(homedir(), "ScholarPen", "projects");

class FileSystemManager {
  async ensureBaseDir(): Promise<void> {
    await mkdir(SCHOLARPEN_DIR, { recursive: true });
  }

  async listProjects(): Promise<ProjectInfo[]> {
    await this.ensureBaseDir();
    const entries = await readdir(SCHOLARPEN_DIR, { withFileTypes: true });
    const projects: ProjectInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = join(SCHOLARPEN_DIR, entry.name);
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
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    const projectPath = join(SCHOLARPEN_DIR, safeName);

    await mkdir(projectPath, { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "papers"), { recursive: true });
    await mkdir(join(projectPath, "knowledge-base", "notes"), { recursive: true });
    await mkdir(join(projectPath, "figures"), { recursive: true });
    await mkdir(join(projectPath, "exports"), { recursive: true });
    await mkdir(join(projectPath, ".lance"), { recursive: true });

    // Create empty manuscript
    const emptyManuscript = { content: [], version: 1 };
    await writeFile(
      join(projectPath, "manuscript.scholarpen.json"),
      JSON.stringify(emptyManuscript, null, 2)
    );

    // Create empty references.bib
    await writeFile(join(projectPath, "references.bib"), "");

    return {
      name: safeName,
      path: projectPath,
      files: this.buildFileList(projectPath),
      lastModified: Date.now(),
    };
  }

  async openProject(name: string): Promise<ProjectInfo> {
    const projectPath = join(SCHOLARPEN_DIR, name);
    const info = await stat(projectPath);
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

  private buildFileList(projectPath: string): ProjectFile[] {
    return [
      { name: "manuscript.scholarpen.json", path: join(projectPath, "manuscript.scholarpen.json"), type: "manuscript" },
      { name: "references.bib", path: join(projectPath, "references.bib"), type: "reference" },
    ];
  }
}

export const fileSystem = new FileSystemManager();
