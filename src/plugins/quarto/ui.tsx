import React, { useState, useCallback, useMemo } from "react";
import { BookMarked, Play } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../renderer/components/ui/tooltip";
import { QuartoBookDialog, type QuartoBookSetup } from "./ui/QuartoBookDialog";
import { QuartoRenderDialog } from "./ui/QuartoRenderDialog";
import type { QuartoExtensionDiscovery, QuartoRenderFormat, QuartoRenderResult } from "../../shared/rpc-types";
import { buildQuartoBookConfig, collectQuartoChapterFilenames, findQuartoConfigNode, getQuartoRenderFormats } from "../../shared/quarto-config";
import { toBase64 } from "lib0/buffer";
import { rpc } from "../../renderer/rpc";
import type { ExtensionUIProps } from "../../renderer/extensions/slots";
export default function QuartoUI({ workspace }: ExtensionUIProps) {
  const { project: activeProject, activeFile, files: fileTree, selectFile: handleFileSelect, setFiles: setFileTree, refreshFiles: refreshFileTree } = workspace;
  const [quartoBookDialogOpen, setQuartoBookDialogOpen] = useState(false);
  const [quartoBookYaml, setQuartoBookYaml]           = useState<string | null>(null);
  const [quartoExtensions, setQuartoExtensions] = useState<QuartoExtensionDiscovery>({ formats: [], warnings: [] });
  const [quartoBookLoading, setQuartoBookLoading]     = useState(false);
  const [quartoBookLoadError, setQuartoBookLoadError] = useState<string | null>(null);
  const [quartoRenderDialogOpen, setQuartoRenderDialogOpen] = useState(false);
  const [quartoRenderFormats, setQuartoRenderFormats] = useState<QuartoRenderFormat[]>([]);
  const [quartoRenderLoading, setQuartoRenderLoading] = useState(false);
  const [quartoRenderLoadError, setQuartoRenderLoadError] = useState<string | null>(null);
  const quartoChapterFilenames = useMemo(
    () => collectQuartoChapterFilenames(fileTree),
    [fileTree],
  );

  const handleOpenQuartoBookDialog = useCallback(async () => {
    if (!activeProject) return;
    setQuartoBookDialogOpen(true);
    setQuartoBookLoading(true);
    setQuartoBookLoadError(null);
    setQuartoBookYaml(null);
    setQuartoExtensions({ formats: [], warnings: [] });
    try {
      const [latestTree, extensions] = await Promise.all([
        rpc.listProjectFiles(activeProject.path),
        rpc.discoverQuartoExtensions(activeProject.path),
      ]);
      setQuartoExtensions(extensions);
      setFileTree(latestTree);
      const configNode = findQuartoConfigNode(latestTree);
      setQuartoBookYaml(configNode ? await rpc.readTextFile(configNode.path) : null);
    } catch (loadError) {
      setQuartoBookLoadError(
        loadError instanceof Error
          ? loadError.message
          : "Could not read the current _quarto.yml.",
      );
    } finally {
      setQuartoBookLoading(false);
    }
  }, [activeProject]);

  const handleOpenQuartoRenderDialog = useCallback(async () => {
    if (!activeProject) return;
    setQuartoRenderDialogOpen(true);
    setQuartoRenderLoading(true);
    setQuartoRenderLoadError(null);
    setQuartoRenderFormats([]);
    try {
      const latestTree = await rpc.listProjectFiles(activeProject.path);
      setFileTree(latestTree);
      const configNode = findQuartoConfigNode(latestTree);
      if (!configNode) {
        throw new Error("Create exports/_quarto.yml in the Quarto book editor before rendering.");
      }
      const configSource = await rpc.readTextFile(configNode.path);
      const formats = getQuartoRenderFormats(configSource);
      if (formats.length === 0) {
        throw new Error(
          "No output format is configured in exports/_quarto.yml. Select an output format in the Quarto book editor.",
        );
      }
      setQuartoRenderFormats(formats);
    } catch (error) {
      setQuartoRenderLoadError(
        error instanceof Error ? error.message : "Could not read the Quarto render configuration.",
      );
    } finally {
      setQuartoRenderLoading(false);
    }
  }, [activeProject]);

  const handleRenderQuartoBook = useCallback(async (
    format: QuartoRenderFormat,
  ): Promise<QuartoRenderResult> => {
    if (!activeProject) throw new Error("Open a project first.");
    const result = await rpc.renderQuartoBook(activeProject.path, format);
    if (result.status === "success") await refreshFileTree();
    return result;
  }, [activeProject, refreshFileTree]);

  const handleGenerateQuartoBook = useCallback(async ({
    title,
    authors,
    cslFilename,
    cslFile,
    qmdFilenames,
    language,
    outputDir,
    bibliographyFiles,
    formats,
    existingYaml,
    extensionFormats,
    options,
    referenceDocFile,
  }: QuartoBookSetup) => {
    if (!activeProject) throw new Error("Open a project first.");

    const latestTree = await rpc.listProjectFiles(activeProject.path);
    const currentConfigNode = findQuartoConfigNode(latestTree);
    const currentYaml = currentConfigNode
      ? await rpc.readTextFile(currentConfigNode.path)
      : null;
    if (currentYaml !== existingYaml) {
      throw new Error(
        "_quarto.yml changed outside this editor. Close and reopen the dialog to load the latest version.",
      );
    }

    const config = buildQuartoBookConfig({
      title,
      authors,
      cslFilename,
      qmdFilenames,
      language,
      outputDir,
      bibliographyFiles,
      formats,
      existingYaml,
      extensionFormats,
      options,
    });

    if (cslFile) {
      await rpc.exportFile(activeProject.path, cslFile.name, await cslFile.text());
    }
    if (referenceDocFile && formats.includes("docx")) {
      await rpc.exportBinaryFile(
        activeProject.path,
        referenceDocFile.name,
        toBase64(new Uint8Array(await referenceDocFile.arrayBuffer())),
      );
    }
    const configPath = await rpc.exportFile(
      activeProject.path,
      "_quarto.yml",
      config,
    );
    setQuartoBookYaml(config);
    setFileTree(await rpc.listProjectFiles(activeProject.path));
    handleFileSelect({
      name: "_quarto.yml",
      path: configPath,
      kind: "unknown",
      isDirectory: false,
      lastModified: Date.now(),
    });
  }, [activeProject, handleFileSelect]);

  return <>
          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenQuartoBookDialog}
                  disabled={!activeProject}
                  aria-label="Configure Quarto book"
                  className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
                    disabled:cursor-not-allowed disabled:opacity-30
                    ${activeFile?.name === "_quarto.yml"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    }`}
                >
                  <BookMarked className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Configure Quarto book</TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider delayDuration={400}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenQuartoRenderDialog}
                  disabled={!activeProject}
                  aria-label="Render Quarto book"
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Play className="h-4 w-4" strokeWidth={1.8} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Render Quarto book</TooltipContent>
            </Tooltip>
          </TooltipProvider>      <QuartoBookDialog
        key={activeProject?.path ?? "no-project"}
        open={quartoBookDialogOpen}
        onOpenChange={setQuartoBookDialogOpen}
        qmdFilenames={quartoChapterFilenames}
        initialYaml={quartoBookYaml}
        extensions={quartoExtensions}
        loading={quartoBookLoading}
        loadError={quartoBookLoadError}
        onGenerate={handleGenerateQuartoBook}
      />

      <QuartoRenderDialog
        key={`render-${activeProject?.path ?? "no-project"}`}
        open={quartoRenderDialogOpen}
        onOpenChange={setQuartoRenderDialogOpen}
        formats={quartoRenderFormats}
        loading={quartoRenderLoading}
        loadError={quartoRenderLoadError}
        onRender={handleRenderQuartoBook}
      />

  </>;
}
