import { mkdir } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";
import type { AgentThread, AgentThreadMessage, AgentThreadWithMessages, LLMProvider } from "../../shared/rpc-types";

type ThreadRow = {
  id: string;
  project_path: string;
  title: string;
  provider: LLMProvider;
  model: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  metadata_json: string | null;
};

type MessageRow = {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: number;
  status: AgentThreadMessage["status"];
  metadata_json: string | null;
};

const stores = new Map<string, AgentThreadStore>();

function parseMetadata(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringifyMetadata(value?: Record<string, unknown>): string | null {
  return value ? JSON.stringify(value) : null;
}

function rowToThread(row: ThreadRow): AgentThread {
  return {
    id: row.id,
    projectPath: row.project_path,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

function rowToMessage(row: MessageRow): AgentThreadMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    status: row.status,
    metadata: parseMetadata(row.metadata_json),
  };
}

function defaultTitle(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "New thread";
  return normalized.length > 52 ? `${normalized.slice(0, 52)}...` : normalized;
}

export class AgentThreadStore {
  private db: Database | null = null;

  constructor(private readonly projectPath: string) {}

  async ready(): Promise<this> {
    if (this.db) return this;
    const dbDir = join(this.projectPath, "db");
    await mkdir(dbDir, { recursive: true });
    this.db = new Database(join(dbDir, "scholarpen.sqlite"));
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.initSchema();
    return this;
  }

  private get database(): Database {
    if (!this.db) throw new Error("Agent thread store is not initialized.");
    return this.db;
  }

  private initSchema(): void {
    const db = this.database;
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_threads (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        title TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        metadata_json TEXT
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS ai_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        metadata_json TEXT
      )
    `);
    db.run("CREATE INDEX IF NOT EXISTS idx_ai_threads_project_updated ON ai_threads(project_path, deleted_at, updated_at DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_ai_messages_thread_created ON ai_messages(thread_id, created_at ASC)");
  }

  listThreads(): AgentThread[] {
    const rows = this.database
      .query("SELECT * FROM ai_threads WHERE project_path = ? AND deleted_at IS NULL ORDER BY updated_at DESC")
      .all(this.projectPath) as ThreadRow[];
    return rows.map(rowToThread);
  }

  createThread(params: {
    provider: LLMProvider;
    model: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }): AgentThread {
    const now = Date.now();
    const thread: ThreadRow = {
      id: crypto.randomUUID(),
      project_path: this.projectPath,
      title: params.title?.trim() || "New thread",
      provider: params.provider,
      model: params.model,
      created_at: now,
      updated_at: now,
      deleted_at: null,
      metadata_json: stringifyMetadata(params.metadata),
    };
    this.database
      .query(
        `INSERT INTO ai_threads (id, project_path, title, provider, model, created_at, updated_at, deleted_at, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.project_path,
        thread.title,
        thread.provider,
        thread.model,
        thread.created_at,
        thread.updated_at,
        thread.deleted_at,
        thread.metadata_json,
      );
    return rowToThread(thread);
  }

  getThread(threadId: string): AgentThreadWithMessages {
    const threadRow = this.database
      .query("SELECT * FROM ai_threads WHERE id = ? AND project_path = ? AND deleted_at IS NULL")
      .get(threadId, this.projectPath) as ThreadRow | null;
    if (!threadRow) throw new Error("Thread not found.");
    const messageRows = this.database
      .query("SELECT * FROM ai_messages WHERE thread_id = ? ORDER BY created_at ASC")
      .all(threadId) as MessageRow[];
    return {
      thread: rowToThread(threadRow),
      messages: messageRows.map(rowToMessage),
    };
  }

  deleteThread(threadId: string): void {
    const now = Date.now();
    this.database
      .query("UPDATE ai_threads SET deleted_at = ?, updated_at = ? WHERE id = ? AND project_path = ? AND deleted_at IS NULL")
      .run(now, now, threadId, this.projectPath);
  }

  saveMessage(params: {
    threadId: string;
    role: "user" | "assistant";
    content: string;
    status?: AgentThreadMessage["status"];
    metadata?: Record<string, unknown>;
  }): AgentThreadMessage {
    const thread = this.getThread(params.threadId).thread;
    const now = Date.now();
    const message: MessageRow = {
      id: crypto.randomUUID(),
      thread_id: params.threadId,
      role: params.role,
      content: params.content,
      created_at: now,
      status: params.status ?? "complete",
      metadata_json: stringifyMetadata(params.metadata),
    };
    this.database
      .query(
        `INSERT INTO ai_messages (id, thread_id, role, content, created_at, status, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(message.id, message.thread_id, message.role, message.content, message.created_at, message.status, message.metadata_json);

    const updateTitle = thread.title === "New thread" && params.role === "user";
    this.database
      .query("UPDATE ai_threads SET title = ?, updated_at = ? WHERE id = ? AND project_path = ?")
      .run(updateTitle ? defaultTitle(params.content) : thread.title, now, params.threadId, this.projectPath);

    return rowToMessage(message);
  }
}

export async function getAgentThreadStore(projectPath: string): Promise<AgentThreadStore> {
  let store = stores.get(projectPath);
  if (!store) {
    store = new AgentThreadStore(projectPath);
    stores.set(projectPath, store);
  }
  return store.ready();
}
