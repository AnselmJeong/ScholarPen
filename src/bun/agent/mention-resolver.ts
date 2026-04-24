import { extname, relative } from "path";
import type { AgentMentionableFile, FileNode } from "../../shared/rpc-types";
import { fileSystem } from "../fs/manager";

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".qmd",
  ".txt",
  ".bib",
  ".json",
  ".tex",
  ".yaml",
  ".yml",
  ".csv",
]);

export interface MentionedFileContext {
  token: string;
  filePath: string;
  fileName: string;
  displayPath: string;
  content: string;
  truncated: boolean;
}

function flatten(nodes: FileNode[]): FileNode[] {
  const result: FileNode[] = [];
  for (const node of nodes) {
    if (node.isDirectory) result.push(...flatten(node.children ?? []));
    else result.push(node);
  }
  return result;
}

function isSupportedTextFile(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || path.endsWith(".scholarpen.json");
}

function trimContent(content: string, limit = 20_000): { content: string; truncated: boolean } {
  if (content.length <= limit) return { content, truncated: false };
  const head = content.slice(0, Math.floor(limit * 0.65));
  const tail = content.slice(-Math.floor(limit * 0.25));
  return {
    content: `${head}\n\n[...truncated...]\n\n${tail}`,
    truncated: true,
  };
}

export async function listAgentMentionableFiles(projectPath: string): Promise<AgentMentionableFile[]> {
  const nodes = await fileSystem.listProjectFiles(projectPath);
  return flatten(nodes)
    .filter((file) => isSupportedTextFile(file.path))
    .map((file) => ({
      name: file.name,
      path: file.path,
      displayPath: relative(projectPath, file.path),
      kind: file.kind,
    }))
    .sort((a, b) => a.displayPath.localeCompare(b.displayPath));
}

export async function resolveMentionedFiles(params: {
  message: string;
  explicitFilePaths: string[];
  projectPath: string;
}): Promise<MentionedFileContext[]> {
  const mentionTokens = [...params.message.matchAll(/(^|\s)@([^\s]+)/g)].map((match) => match[2]);
  const mentionable = await listAgentMentionableFiles(params.projectPath);
  const selected = new Map<string, string>();

  for (const filePath of params.explicitFilePaths) {
    selected.set(filePath, filePath);
  }

  for (const token of mentionTokens) {
    const normalized = token.toLowerCase();
    const matches = mentionable.filter(
      (file) =>
        file.name.toLowerCase() === normalized ||
        file.displayPath.toLowerCase() === normalized ||
        file.name.toLowerCase().startsWith(normalized)
    );
    if (matches.length === 1) selected.set(matches[0].path, token);
    else if (matches.length > 1) {
      throw new Error(`@${token} is ambiguous. Select the exact file from the dropdown.`);
    }
  }

  const contexts: MentionedFileContext[] = [];
  for (const [filePath, token] of selected) {
    const meta = mentionable.find((file) => file.path === filePath);
    if (!meta) throw new Error(`Selected file is not part of the current project: ${filePath}`);
    if (!isSupportedTextFile(filePath)) throw new Error(`Unsupported @file type: ${meta.displayPath}`);
    const raw = await fileSystem.readTextFile(filePath);
    const { content, truncated } = trimContent(raw);
    contexts.push({
      token,
      filePath,
      fileName: meta.name,
      displayPath: meta.displayPath,
      content,
      truncated,
    });
  }

  return contexts;
}
