import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { parseDocument } from "yaml";
import type { QuartoExtensionDiscovery } from "../../shared/rpc-types";
import { isQuartoFormatName } from "../../shared/quarto-config";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read extension manifests only; never execute extension code during discovery. */
export async function discoverQuartoExtensionFormats(
  projectDirectory: string,
): Promise<QuartoExtensionDiscovery> {
  const result: QuartoExtensionDiscovery = { formats: [], warnings: [] };
  const root = join(projectDirectory, "_extensions");

  async function visit(directory: string, parts: string[]): Promise<void> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      const manifest = entries.find((entry) => (
        entry.isFile() && ["_extension.yml", "_extension.yaml"].includes(entry.name)
      ));
      if (manifest && parts.length > 0) {
        const manifestPath = [...parts, manifest.name].join("/");
        try {
          const document = parseDocument(await readFile(join(directory, manifest.name), "utf-8"));
          if (document.errors.length) throw document.errors[0];
          const metadata: unknown = document.toJS({ maxAliasCount: 100 });
          if (!isRecord(metadata)) throw new Error("The manifest must be a YAML mapping.");
          const contributes = metadata.contributes;
          if (!isRecord(contributes) || contributes.formats === undefined) return;
          if (!isRecord(contributes.formats)) throw new Error("contributes.formats must be a mapping.");
          for (const baseFormat of Object.keys(contributes.formats)) {
            if (baseFormat === "common") continue;
            // Keep the organization prefix to disambiguate namespaced installations.
            const name = `${parts.join("/")}-${baseFormat}`;
            if (!isQuartoFormatName(name) || !isQuartoFormatName(baseFormat) || baseFormat.includes("/")) {
              result.warnings.push(`${manifestPath}: Invalid format name ${baseFormat}.`);
              continue;
            }
            if (result.formats.some((format) => format.name === name)) {
              result.warnings.push(`${manifestPath}: Duplicate format ${name}.`);
              continue;
            }
            result.formats.push({
              name,
              baseFormat,
              title: typeof metadata.title === "string" ? metadata.title : parts.at(-1)!,
              manifestPath: `_extensions/${manifestPath}`,
            });
          }
        } catch (error) {
          result.warnings.push(`${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return; // Embedded extensions/resources belong to this extension, not the project.
      }
      if (parts.length >= 2) return;
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && !entry.name.startsWith("_")) {
          await visit(join(directory, entry.name), [...parts, entry.name]);
        }
      }
    } catch (error) {
      if (parts.length === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      result.warnings.push(`${directory}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await visit(root, []);
  return result;
}
