import { join } from "node:path";
import { citationClient } from "./main/client";
import { BIBLIOGRAPHY_RELATIVE_PATH } from "../../shared/bibliography-path";
import { cleanValidateAndApplyBibliography } from "./main/bibliography-maintenance";
import { proposeBibliographyRepair, validateBibliographyRepair } from "./main/bibliography-repair";
import type { ExtensionServices } from "../../bun/extensions/services";
import type { CommandHandlers } from "../../shared/extensions/commands";
import { registerCommands } from "../../shared/extensions/commands";
import type { BundledPlugin } from "../../shared/extensions/contracts";
import manifest from "./scholarpen.plugin.json";
/** Bundled entry point with module-specific host services. */
export function createPlugin(services: ExtensionServices["scholarpen.bibliography"]): BundledPlugin {
    const { fileSystem, recentlySavedFiles, internallyUpdatingProjects, sendProjectUpdated, sendBibliographyValidationProgress } = services;
    const handlers: Pick<CommandHandlers, "saveBibtex" | "saveBibtexRaw" | "saveBibtexValidated" | "loadBibtex" | "mergeBibtex" | "proposeBibliographyRepair" | "applyBibliographyRepair" | "deduplicateBibliography" | "validateAndCleanBibliography" | "resolveDOI" | "searchCitations"> = {
        saveBibtex: async ({ projectPath, bibtex }) => {
            // Suppress file watcher to avoid triggering a document reload
            recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.add("references.bib");
            setTimeout(() => {
                recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
                recentlySavedFiles.delete("references.bib");
            }, 3000);
            await fileSystem.saveBibtex(projectPath, bibtex);
            sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
            });
        },
        saveBibtexRaw: async ({ projectPath, bibtex }) => {
            recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.add("references.bib");
            setTimeout(() => {
                recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
                recentlySavedFiles.delete("references.bib");
            }, 3000);
            await fileSystem.saveBibtexRaw(projectPath, bibtex);
            sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
            });
        },
        saveBibtexValidated: async ({ projectPath, bibtex, expectedCurrentBibtex }) => {
            recentlySavedFiles.add(BIBLIOGRAPHY_RELATIVE_PATH);
            recentlySavedFiles.add("references.bib");
            setTimeout(() => {
                recentlySavedFiles.delete(BIBLIOGRAPHY_RELATIVE_PATH);
                recentlySavedFiles.delete("references.bib");
            }, 3000);
            await fileSystem.saveBibtexValidated(projectPath, bibtex, expectedCurrentBibtex);
            sendProjectUpdated?.({
                projectPath,
                filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
            });
        },
        loadBibtex: ({ projectPath }) => fileSystem.loadBibtex(projectPath),
        mergeBibtex: async ({ projectPath, importedBibtex }) => {
            internallyUpdatingProjects.add(projectPath);
            try {
                const result = await fileSystem.mergeBibtex(projectPath, importedBibtex);
                if (result.addedEntries > 0) {
                    sendProjectUpdated?.({
                        projectPath,
                        filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
                    });
                }
                return result;
            }
            finally {
                setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
            }
        },
        proposeBibliographyRepair: async ({ projectPath, bibtex, mode }) => {
            await fileSystem.loadBibtex(projectPath);
            const settings = await fileSystem.getSettings();
            return proposeBibliographyRepair(bibtex, mode, settings);
        },
        applyBibliographyRepair: async ({ projectPath, originalBibtex, repairedBibtex }) => {
            validateBibliographyRepair(originalBibtex, repairedBibtex);
            internallyUpdatingProjects.add(projectPath);
            try {
                const backupPath = await fileSystem.saveBibliographyMaintenance(projectPath, repairedBibtex, "bibliography-syntax-repair", originalBibtex);
                sendProjectUpdated?.({
                    projectPath,
                    filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
                });
                return backupPath;
            }
            finally {
                setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
            }
        },
        deduplicateBibliography: async ({ projectPath, bibtex }) => {
            internallyUpdatingProjects.add(projectPath);
            try {
                const result = await fileSystem.deduplicateBibliography(projectPath, bibtex);
                if (result.removedEntries > 0) {
                    sendProjectUpdated?.({ projectPath });
                    sendProjectUpdated?.({
                        projectPath,
                        filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
                    });
                }
                return result;
            }
            finally {
                setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
            }
        },
        validateAndCleanBibliography: async ({ projectPath, bibtex }) => {
            internallyUpdatingProjects.add(projectPath);
            try {
                const result = await cleanValidateAndApplyBibliography({
                    projectPath,
                    bibtex,
                    fileSystem,
                    onProgress: (progress) => sendBibliographyValidationProgress?.(progress),
                });
                if (result.backupPath) {
                    sendProjectUpdated?.({
                        projectPath,
                        filePath: join(projectPath, BIBLIOGRAPHY_RELATIVE_PATH),
                    });
                }
                return result;
            }
            finally {
                setTimeout(() => internallyUpdatingProjects.delete(projectPath), 3000);
            }
        },
        resolveDOI: ({ doi }) => citationClient.resolveDOI(doi),
        searchCitations: async ({ query }) => {
            const settings = await fileSystem.getSettings();
            return citationClient.searchOpenAlex(query, 10, settings.openAlexApiKey || undefined);
        }
    };
    return { activate(context) {
            registerCommands(context, manifest.id, handlers);
        } };
}
