import { mkdir, readdir, readFile, writeFile, stat, unlink, rename } from "fs/promises";
import { join, extname, basename, dirname, resolve, relative, isAbsolute } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import type {
  ProjectInfo,
  ProjectFile,
  FileNode,
  FileNodeKind,
  AppSettings,
  AppSettingsUpdate,
  BibliographyDeduplicationResult,
  BibliographyMergeResult,
} from "../../shared/rpc-types";
import { DEFAULT_OLLAMA_BASE_URL } from "../../shared/ollama-connection";
import {
  buildBibtexDeduplicationPlan,
  buildBibtexAppendPlan,
  collectDocumentCitationKeys,
  deduplicateBibtex,
  parseBibtexEntries,
  partitionBibtexAdditions,
  remapDocumentCitationKeys,
} from "../../shared/bibtex-utils";
import { seedAppInstructions } from "../agent/app-skills";

const SCHOLARPEN_BASE = join(homedir(), "ScholarPen");
const SETTINGS_FILE = join(SCHOLARPEN_BASE, "settings.json");
const LEGACY_PROJECTS_ROOT = join(SCHOLARPEN_BASE, "projects");
const APP_SUPPORT_DIRS = new Set(["commands", "skills"]);
export const BIBLIOGRAPHY_RELATIVE_PATH = "exports/references.bib";

const DEFAULT_SETTINGS: AppSettings = {
  projectsRootDir: SCHOLARPEN_BASE,
  sidebarAgentProvider: "ollama",
  sidebarAgentModel: "qwen3.5:397b",
  modelProviders: {
    ollama: {
      provider: "ollama",
      model: "qwen3.5:397b",
      baseUrl: DEFAULT_OLLAMA_BASE_URL,
      enabled: true,
    },
    anthropic: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      enabled: false,
    },
    deepseek: {
      provider: "deepseek",
      model: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      enabled: false,
    },
    openai: {
      provider: "openai",
      model: "gpt-5.2",
      baseUrl: "https://api.openai.com/v1",
      enabled: false,
    },
  },
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  ollamaApiKey: "",
  ollamaDefaultModel: "qwen3.5:397b",
  tinyfishApiKey: "",
  webSearchEnabled: true,
  anthropicApiKey: "",
  anthropicDefaultModel: "claude-sonnet-4-5",
  deepseekApiKey: "",
  deepseekBaseUrl: "https://api.deepseek.com",
  deepseekDefaultModel: "deepseek-chat",
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  openaiDefaultModel: "gpt-5.2",
  openAlexApiKey: "",
  theme: "system",
};

export type PersistedAppSettings = Partial<AppSettings> & {
  /** @deprecated Migrated to webSearchEnabled. */
  ollamaWebSearchEnabled?: boolean;
};

export function normalizeSettings(parsed: PersistedAppSettings): AppSettings {
  const migrated = { ...parsed };
  delete migrated.ollamaWebSearchEnabled;
  const legacyProvider = parsed.aiBackend === "claude" ? "anthropic" : "ollama";
  const sidebarAgentProvider = parsed.sidebarAgentProvider ?? legacyProvider;
  const legacyClaudeModel =
    parsed.claudeModel && parsed.claudeModel !== "sonnet"
      ? parsed.claudeModel
      : DEFAULT_SETTINGS.anthropicDefaultModel;
  const sidebarAgentModel =
    parsed.sidebarAgentModel ??
    (sidebarAgentProvider === "anthropic"
      ? legacyClaudeModel
      : parsed.ollamaDefaultModel ?? DEFAULT_SETTINGS.ollamaDefaultModel);

  const modelProviders = {
    ...DEFAULT_SETTINGS.modelProviders,
    ...(parsed.modelProviders ?? {}),
  };

  modelProviders.ollama = {
    ...modelProviders.ollama,
    model: parsed.ollamaDefaultModel ?? modelProviders.ollama.model,
    baseUrl: parsed.ollamaBaseUrl ?? modelProviders.ollama.baseUrl,
    enabled: true,
  };
  modelProviders.anthropic = {
    ...modelProviders.anthropic,
    model: parsed.anthropicDefaultModel ?? legacyClaudeModel,
    enabled: Boolean(parsed.anthropicApiKey) || modelProviders.anthropic.enabled,
  };
  modelProviders.deepseek = {
    ...modelProviders.deepseek,
    model: parsed.deepseekDefaultModel ?? modelProviders.deepseek.model,
    baseUrl: parsed.deepseekBaseUrl ?? modelProviders.deepseek.baseUrl,
    enabled: Boolean(parsed.deepseekApiKey) || modelProviders.deepseek.enabled,
  };
  modelProviders.openai = {
    ...modelProviders.openai,
    model: parsed.openaiDefaultModel ?? modelProviders.openai.model,
    baseUrl: parsed.openaiBaseUrl ?? modelProviders.openai.baseUrl,
    enabled: Boolean(parsed.openaiApiKey) || modelProviders.openai.enabled,
  };

  return {
    ...DEFAULT_SETTINGS,
    ...migrated,
    webSearchEnabled:
      typeof parsed.webSearchEnabled === "boolean"
        ? parsed.webSearchEnabled
        : typeof parsed.ollamaWebSearchEnabled === "boolean"
          ? parsed.ollamaWebSearchEnabled
          : DEFAULT_SETTINGS.webSearchEnabled,
    sidebarAgentProvider,
    sidebarAgentModel,
    modelProviders,
    ollamaApiKey: parsed.ollamaApiKey ?? DEFAULT_SETTINGS.ollamaApiKey,
    tinyfishApiKey:
      typeof parsed.tinyfishApiKey === "string"
        ? parsed.tinyfishApiKey
        : DEFAULT_SETTINGS.tinyfishApiKey,
    anthropicDefaultModel: parsed.anthropicDefaultModel ?? legacyClaudeModel,
    deepseekBaseUrl: parsed.deepseekBaseUrl ?? DEFAULT_SETTINGS.deepseekBaseUrl,
    deepseekDefaultModel: parsed.deepseekDefaultModel ?? DEFAULT_SETTINGS.deepseekDefaultModel,
    openaiBaseUrl: parsed.openaiBaseUrl ?? DEFAULT_SETTINGS.openaiBaseUrl,
    openaiDefaultModel: parsed.openaiDefaultModel ?? DEFAULT_SETTINGS.openaiDefaultModel,
  };
}

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

function isProjectDirectoryCandidate(name: string): boolean {
  if (!name || name.startsWith(".")) return false;
  if (APP_SUPPORT_DIRS.has(name)) return false;
  return true;
}

const PROJECT_SKELETON_DIRECTORIES = [
  "documents",
  "drafts",
  "resources/articles",
  "resources/books",
  "figures",
  "exports",
] as const;

export async function initializeProjectSkeleton(
  projectPath: string,
  projectName: string,
): Promise<void> {
  await mkdir(projectPath, { recursive: true });
  for (const relativePath of PROJECT_SKELETON_DIRECTORIES) {
    await mkdir(join(projectPath, relativePath), { recursive: true });
  }

  const emptyManuscript: unknown[] = [];
  await writeFile(
    join(projectPath, "documents", `${projectName}.scholarpen.json`),
    JSON.stringify(emptyManuscript, null, 2),
  );
  await writeFile(join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH), "");
}

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

  private assertValidBibtex(bibtex: string): void {
    const issue = parseBibtexEntries(bibtex).issues[0];
    if (issue) {
      throw new Error(
        `BibTeX parse error at line ${issue.line}, column ${issue.column}: ${issue.message}`,
      );
    }
  }

  private async writeFileAtomically(filePath: string, content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const temporaryPath = join(
      dirname(filePath),
      `.${basename(filePath)}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, content, "utf-8");
      await rename(temporaryPath, filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch {}
      throw error;
    }
  }

  private async getProjectsRootDir(): Promise<string> {
    try {
      const settings = await this.getSettings();
      return settings.projectsRootDir;
    } catch {
      return DEFAULT_SETTINGS.projectsRootDir;
    }
  }

  private async hasProjectDirectories(rootDir: string): Promise<boolean> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const projectPath = join(rootDir, entry.name);
        try {
          await stat(join(projectPath, "documents"));
          return true;
        } catch {}
        try {
          await stat(join(projectPath, "manuscript.scholarpen.json"));
          return true;
        } catch {}
      }
    } catch {}
    return false;
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
      if (!isProjectDirectoryCandidate(entry.name)) continue;

      const projectPath = join(rootDir, entry.name);
      const info = await stat(projectPath);

      // Any top-level research folder in the projects root can become a project.
      await this.migrateProject(projectPath);
      this.markProjectPath(projectPath);
      projects.push({
        name: entry.name,
        path: projectPath,
        files: [],
        lastModified: info.mtimeMs,
      });
    }

    return projects.sort((a, b) => b.lastModified - a.lastModified);
  }

  async createProject(name: string): Promise<ProjectInfo> {
    const rootDir = await this.getProjectsRootDir();
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, "-").toLowerCase();
    const projectPath = this.markProjectPath(join(rootDir, safeName));

    await initializeProjectSkeleton(projectPath, safeName);

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

  async saveDocuments(
    projectPath: string,
    documents: Array<{ filename: string; content: unknown }>,
  ): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    if (documents.length === 0) return;

    const docsDir = join(projectPath, "documents");
    await mkdir(docsDir, { recursive: true });
    const prepared = documents.map(({ filename, content }) => {
      const safeFilename = this.safeFilename(filename, ".scholarpen.json");
      return {
        filename: safeFilename,
        filePath: join(docsDir, safeFilename),
        serialized: JSON.stringify(content, null, 2),
      };
    });
    if (new Set(prepared.map((item) => item.filename)).size !== prepared.length) {
      throw new Error("Batch document save contains duplicate filenames.");
    }

    const originals = new Map<string, string>();
    for (const item of prepared) {
      originals.set(item.filePath, await readFile(item.filePath, "utf-8"));
    }

    const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(projectPath, ".scholarpen", "backups", `documents-${backupStamp}`);
    await mkdir(backupDir, { recursive: true });
    for (const item of prepared) {
      await writeFile(
        join(backupDir, item.filename),
        originals.get(item.filePath)!,
        "utf-8",
      );
    }

    try {
      for (const item of prepared) {
        await writeFile(item.filePath, item.serialized, "utf-8");
      }
    } catch (error) {
      await Promise.allSettled(
        [...originals.entries()].map(([filePath, original]) =>
          writeFile(filePath, original, "utf-8")
        ),
      );
      throw error;
    }
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
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    this.assertValidBibtex(bibtex);
    await this.writeFileAtomically(referencesPath, deduplicateBibtex(bibtex));
  }

  async saveBibtexRaw(projectPath: string, bibtex: string): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await this.writeFileAtomically(referencesPath, bibtex);
  }

  async saveBibtexValidated(
    projectPath: string,
    bibtex: string,
    expectedCurrentBibtex: string,
  ): Promise<void> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    let current = "";
    try {
      current = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current !== expectedCurrentBibtex) {
      throw new Error(
        "references.bib changed outside this editor. Reload it before saving to avoid overwriting newer changes.",
      );
    }
    await this.writeFileAtomically(referencesPath, bibtex);
  }

  async loadBibtex(projectPath: string): Promise<string> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    try {
      return await readFile(join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH), "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    }
  }

  async mergeBibtex(
    projectPath: string,
    importedBibtex: string,
  ): Promise<BibliographyMergeResult> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    const currentBibtex = await this.loadBibtex(projectPath);
    const appendPlan = buildBibtexAppendPlan(currentBibtex, importedBibtex);
    const currentEntries = parseBibtexEntries(currentBibtex).entries;
    const { accepted, skipped } = partitionBibtexAdditions(
      currentEntries,
      appendPlan.addedEntries,
    );

    if (accepted.length === 0) {
      return {
        bibtex: currentBibtex,
        addedEntries: 0,
        skippedDuplicates: skipped.map(({ entry, duplicateOf }) => ({
          citekey: entry.citekey,
          duplicateOfCitekey: duplicateOf.citekey,
        })),
        backupPath: null,
      };
    }

    const merged = buildBibtexAppendPlan(
      currentBibtex,
      accepted.map((entry) => entry.raw).join("\n\n"),
    ).bibtex;
    const backupPath = await this.saveBibliographyMaintenance(
      projectPath,
      merged,
      "bibliography-import",
      currentBibtex,
    );

    return {
      bibtex: merged,
      addedEntries: accepted.length,
      skippedDuplicates: skipped.map(({ entry, duplicateOf }) => ({
        citekey: entry.citekey,
        duplicateOfCitekey: duplicateOf.citekey,
      })),
      backupPath,
    };
  }

  async scanBibliographyUsage(projectPath: string): Promise<{
    usedCitekeys: string[];
    scannedDocuments: number;
  }> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    const documentsDir = join(projectPath, "documents");
    const documentPaths: string[] = [];
    const collect = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) await collect(entryPath);
        else if (entry.name.endsWith(".scholarpen.json")) documentPaths.push(entryPath);
      }
    };
    try {
      await collect(documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const usedCitekeys = new Set<string>();
    for (const filePath of documentPaths) {
      try {
        const content = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
        collectDocumentCitationKeys(content, usedCitekeys);
      } catch (error) {
        throw new Error(
          `인용 스캔 실패: ${relative(projectPath, filePath)} (${error instanceof Error ? error.message : "invalid document"})`,
        );
      }
    }
    return { usedCitekeys: Array.from(usedCitekeys), scannedDocuments: documentPaths.length };
  }

  async saveBibliographyMaintenance(
    projectPath: string,
    bibtex: string,
    backupPrefix: string,
    expectedOriginal?: string,
  ): Promise<string | null> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    let original = "";
    try {
      original = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (expectedOriginal !== undefined && original !== expectedOriginal) {
      throw new Error(
        "references.bib changed outside ScholarPen. Reload it before applying this operation to avoid overwriting newer changes.",
      );
    }
    if (original === bibtex) return null;

    const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      projectPath,
      ".scholarpen",
      "backups",
      `${backupPrefix}-${backupStamp}`,
    );
    const bibliographyBackupPath = join(backupPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await mkdir(dirname(bibliographyBackupPath), { recursive: true });
    await writeFile(bibliographyBackupPath, original, "utf-8");
    try {
      await this.writeFileAtomically(referencesPath, bibtex);
    } catch (error) {
      await writeFile(referencesPath, original, "utf-8");
      throw error;
    }
    return backupPath;
  }

  async deduplicateBibliography(
    projectPath: string,
    bibtex: string,
  ): Promise<BibliographyDeduplicationResult> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    this.assertValidBibtex(bibtex);
    const plan = buildBibtexDeduplicationPlan(bibtex);
    if (plan.removedEntries === 0) {
      return {
        bibtex,
        removedEntries: 0,
        remappedCitations: 0,
        updatedDocuments: 0,
        citekeyRemap: {},
        backupPath: null,
      };
    }

    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    const documentsDir = join(projectPath, "documents");
    const documentPaths: string[] = [];
    const collectDocumentPaths = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          await collectDocumentPaths(entryPath);
        } else if (entry.name.endsWith(".scholarpen.json")) {
          documentPaths.push(entryPath);
        }
      }
    };
    try {
      await collectDocumentPaths(documentsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const updatedDocuments: Array<{
      filePath: string;
      original: string;
      updated: string;
      replacementCount: number;
    }> = [];
    for (const filePath of documentPaths) {
      const original = await readFile(filePath, "utf-8");
      const content = JSON.parse(original) as unknown;
      const remapped = remapDocumentCitationKeys(content, plan.citekeyRemap);
      if (remapped.replacementCount === 0) continue;
      updatedDocuments.push({
        filePath,
        original,
        updated: JSON.stringify(remapped.content, null, 2),
        replacementCount: remapped.replacementCount,
      });
    }

    let originalBibtex = "";
    try {
      originalBibtex = await readFile(referencesPath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (originalBibtex !== bibtex) {
      throw new Error(
        "references.bib changed outside this editor. Reload it before deduplicating to avoid overwriting newer changes.",
      );
    }

    const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = join(
      projectPath,
      ".scholarpen",
      "backups",
      `bibliography-dedup-${backupStamp}`,
    );
    const bibliographyBackupPath = join(backupPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await mkdir(dirname(bibliographyBackupPath), { recursive: true });
    await writeFile(bibliographyBackupPath, originalBibtex, "utf-8");
    for (const document of updatedDocuments) {
      const documentBackupPath = join(backupPath, relative(projectPath, document.filePath));
      await mkdir(dirname(documentBackupPath), { recursive: true });
      await writeFile(documentBackupPath, document.original, "utf-8");
    }

    try {
      for (const document of updatedDocuments) {
        await writeFile(document.filePath, document.updated, "utf-8");
      }
      await writeFile(referencesPath, plan.bibtex, "utf-8");
    } catch (error) {
      await Promise.allSettled([
        writeFile(referencesPath, originalBibtex, "utf-8"),
        ...updatedDocuments.map((document) =>
          writeFile(document.filePath, document.original, "utf-8")
        ),
      ]);
      throw error;
    }

    return {
      bibtex: plan.bibtex,
      removedEntries: plan.removedEntries,
      remappedCitations: updatedDocuments.reduce(
        (count, document) => count + document.replacementCount,
        0,
      ),
      updatedDocuments: updatedDocuments.length,
      citekeyRemap: plan.citekeyRemap,
      backupPath,
    };
  }

  // ── Export ──────────────────────────────────────────────────

  async getQuartoProjectDirectory(projectPath: string): Promise<string> {
    projectPath = await this.assertKnownProjectPath(projectPath);
    return join(projectPath, "exports");
  }

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

  async listProjectFiles(
    projectPath: string,
    depth = 0,
    maxDepth = 5,
  ): Promise<FileNode[]> {
    if (depth === 0) projectPath = await this.assertKnownProjectPath(projectPath);
    if (depth > maxDepth) return [];
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
        node.children = await this.listProjectFiles(fullPath, depth + 1, maxDepth);
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
    await seedAppInstructions();
    try {
      const raw = await readFile(SETTINGS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const settings = normalizeSettings(parsed);
      if (
        settings.projectsRootDir === LEGACY_PROJECTS_ROOT &&
        !(await this.hasProjectDirectories(LEGACY_PROJECTS_ROOT))
      ) {
        return { ...settings, projectsRootDir: SCHOLARPEN_BASE };
      }
      return settings;
    } catch {
      return normalizeSettings({});
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

  /** Initialize loose research folders and migrate legacy project files. */
  private async migrateProject(projectPath: string): Promise<void> {
    const oldPath = join(projectPath, "manuscript.scholarpen.json");
    const docsDir = join(projectPath, "documents");
    const newPath = join(docsDir, "manuscript.scholarpen.json");

    await mkdir(docsDir, { recursive: true });

    try {
      await stat(oldPath);
      // Legacy file exists at root — migrate it
      const content = await readFile(oldPath, "utf-8");
      await writeFile(newPath, content);
      await unlink(oldPath);
      console.log(`[Migration] Moved ${oldPath} → ${newPath}`);
    } catch {
      // No legacy file — already migrated or never existed
    }

    await this.migrateBibliography(projectPath);
  }

  private async migrateBibliography(projectPath: string): Promise<void> {
    const legacyPath = join(projectPath, "references.bib");
    const referencesPath = join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH);
    await mkdir(dirname(referencesPath), { recursive: true });

    const readIfPresent = async (filePath: string): Promise<string | null> => {
      try {
        return await readFile(filePath, "utf-8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    };

    const [legacyBibtex, currentBibtex] = await Promise.all([
      readIfPresent(legacyPath),
      readIfPresent(referencesPath),
    ]);

    if (legacyBibtex === null) {
      if (currentBibtex === null) await writeFile(referencesPath, "");
      return;
    }

    if (currentBibtex === null) {
      await rename(legacyPath, referencesPath);
      console.log(`[Migration] Moved ${legacyPath} → ${referencesPath}`);
      return;
    }

    if (legacyBibtex !== currentBibtex) {
      const backupStamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = join(
        projectPath,
        ".scholarpen",
        "backups",
        `references-root-${backupStamp}.bib`,
      );
      await mkdir(dirname(backupPath), { recursive: true });
      await writeFile(backupPath, legacyBibtex, "utf-8");

      const merged = deduplicateBibtex(
        [currentBibtex.trim(), legacyBibtex.trim()].filter(Boolean).join("\n\n"),
      );
      await writeFile(referencesPath, merged, "utf-8");
    }

    await unlink(legacyPath);
    console.log(`[Migration] Consolidated ${legacyPath} into ${referencesPath}`);
  }

  private buildFileList(projectPath: string): ProjectFile[] {
    return [
      { name: "documents", path: join(projectPath, "documents"), type: "manuscript" as const },
      {
        name: "references.bib",
        path: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
        type: "reference" as const,
      },
    ];
  }
}

export const fileSystem = new FileSystemManager();
