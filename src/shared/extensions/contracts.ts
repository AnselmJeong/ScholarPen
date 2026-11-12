/** Experimental bundled-plugin API. Not an external-code security boundary. */
export const EXTENSION_API_VERSION = "0.1.0";
export const CAPABILITIES = ["document.read", "document.propose", "workspace.read", "workspace.write", "process.tool", "ai.request", "preferences.read", "preferences.write"] as const;
export type Capability = typeof CAPABILITIES[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ValueSchema = { type: "string" | "number" | "boolean" | "object" | "array" | "null"; optional?: boolean; properties?: Record<string, ValueSchema>; items?: ValueSchema; enum?: string[] };
export interface CommandContribution {
  id: string;
  title: string;
  input: ValueSchema;
  output?: ValueSchema;
  /** Temporary bridge for 1.x callers; new plugins must use command IDs. */
  legacyMethod?: string;
}
export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  description: string;
  version: string;
  apiVersion: "0.1.0";
  dataSchemaVersion: number;
  permissions: Capability[];
  contributes: { commands: CommandContribution[]; slots: string[] };
}
export interface ExtensionInfo {
  manifest: PluginManifest;
  enabled: boolean;
  state: "inactive" | "activating" | "active" | "disabled" | "failed";
  running: number;
  error?: string;
}
export interface ExtensionRequest { protocolVersion: 1; requestId: string; operation: string; args: unknown }
export type CommandHandler = (args: unknown, signal: AbortSignal) => unknown | Promise<unknown>;
export interface PluginContext {
  register(command: string, handler: CommandHandler): void;
  onDispose(dispose: () => void | Promise<void>): void;
}
export interface BundledPlugin { activate(context: PluginContext): void | Promise<void> }
export interface PluginEntry { manifest: PluginManifest; load(): Promise<BundledPlugin> }

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function validateSchema(value: unknown, depth = 0): void {
  if (depth > 8 || !isRecord(value) || !["string", "number", "boolean", "object", "array", "null"].includes(String(value.type)) ||
      Object.keys(value).some(key => !["type", "optional", "properties", "items", "enum"].includes(key)) ||
      (value.optional !== undefined && typeof value.optional !== "boolean")) throw new Error("Invalid command value schema.");
  if (value.properties !== undefined) {
    if (value.type !== "object" || !isRecord(value.properties)) throw new Error("Invalid object schema.");
    for (const child of Object.values(value.properties)) validateSchema(child, depth + 1);
  }
  if (value.items !== undefined) {
    if (value.type !== "array") throw new Error("Invalid array schema.");
    validateSchema(value.items, depth + 1);
  }
  if (value.enum !== undefined && (value.type !== "string" || !Array.isArray(value.enum) || !value.enum.every(item => typeof item === "string"))) throw new Error("Invalid enum schema.");
}

export function validateValue(schema: ValueSchema, value: unknown, label = "input"): void {
  if (value === undefined && schema.optional) return;
  const matches = schema.type === "null" ? value === null || value === undefined
    : schema.type === "array" ? Array.isArray(value)
    : schema.type === "object" ? isRecord(value)
    : typeof value === schema.type;
  if (!matches || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`Invalid ${label}: expected ${schema.type}.`);
  if (schema.enum && !schema.enum.includes(String(value))) throw new Error(`Invalid ${label}: unsupported value.`);
  if (schema.properties && isRecord(value)) {
    for (const key of Object.keys(value)) if (!(key in schema.properties)) throw new Error(`Invalid ${label}: unexpected field ${key}.`);
    for (const [key, field] of Object.entries(schema.properties)) validateValue(field, value[key], `${label}.${key}`);
  }
  if (schema.items && Array.isArray(value)) value.forEach(item => validateValue(schema.items!, item, label));
}

export function validateManifest(value: unknown): asserts value is PluginManifest {
  if (!isRecord(value) || value.manifestVersion !== 1 || value.apiVersion !== EXTENSION_API_VERSION ||
      typeof value.id !== "string" || !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(value.id) ||
      typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version) ||
      typeof value.name !== "string" || !value.name || typeof value.description !== "string" ||
      !Number.isInteger(value.dataSchemaVersion) || Number(value.dataSchemaVersion) < 1 ||
      !Array.isArray(value.permissions) || !value.permissions.every(p => CAPABILITIES.includes(p)) ||
      !isRecord(value.contributes) || !Array.isArray(value.contributes.commands) || !Array.isArray(value.contributes.slots)) {
    throw new Error("Invalid or incompatible bundled plugin manifest.");
  }
  if (Object.keys(value).some(key => !["manifestVersion", "id", "name", "description", "version", "apiVersion", "dataSchemaVersion", "permissions", "contributes"].includes(key)) ||
      Object.keys(value.contributes).some(key => !["commands", "slots"].includes(key))) throw new Error("Unsupported manifest field or contribution.");
  const ids = new Set<string>();
  for (const command of value.contributes.commands) {
    if (!isRecord(command) || typeof command.id !== "string" || !command.id.startsWith(`${value.id}.`) ||
        !/^[a-zA-Z0-9.-]+$/.test(command.id) || ids.has(command.id) || typeof command.title !== "string" ||
        !isRecord(command.input) || !["string", "number", "boolean", "object", "array", "null"].includes(String(command.input.type))) {
      throw new Error("Invalid or duplicate plugin command.");
    }
    ids.add(command.id);
    validateSchema(command.input);
    if (command.output !== undefined) validateSchema(command.output);
  }
  if (!value.contributes.slots.every(s => typeof s === "string" && ["status", "toolbar", "dialogs", "settings", "project"].includes(s))) throw new Error("Unknown extension slot.");
}
