import type {
  BibliographyMaintenanceResult,
  BibliographyValidationProgress,
} from "../../shared/rpc-types";
import {
  parseBibtexEntries,
  removeUnusedBibtexEntries,
} from "../../shared/bibtex-utils";
import { validateBibliography } from "./bibliography-validator";

interface BibliographyMaintenanceFileSystem {
  scanBibliographyUsage(projectPath: string): Promise<{
    usedCitekeys: string[];
    scannedDocuments: number;
  }>;
  saveBibliographyMaintenance(
    projectPath: string,
    bibtex: string,
    backupPrefix: string,
  ): Promise<string | null>;
}

type ValidateBibliography = (
  bibtex: string,
  onProgress?: (progress: BibliographyValidationProgress) => void,
) => ReturnType<typeof validateBibliography>;

export async function cleanValidateAndApplyBibliography({
  projectPath,
  bibtex,
  fileSystem,
  onProgress,
  validate = validateBibliography,
}: {
  projectPath: string;
  bibtex: string;
  fileSystem: BibliographyMaintenanceFileSystem;
  onProgress?: (progress: BibliographyValidationProgress) => void;
  validate?: ValidateBibliography;
}): Promise<BibliographyMaintenanceResult> {
  onProgress?.({
    stage: "scan",
    processed: 0,
    total: 0,
    message: "프로젝트 문서의 인용을 스캔하는 중",
  });

  const usage = await fileSystem.scanBibliographyUsage(projectPath);
  const cleanup = removeUnusedBibtexEntries(bibtex, usage.usedCitekeys);
  const availableCitekeys = new Set(
    parseBibtexEntries(cleanup.bibtex).entries.map(
      (entry) => entry.citekey.toLocaleLowerCase(),
    ),
  );
  const missingCitekeys = usage.usedCitekeys.filter(
    (citekey) => !availableCitekeys.has(citekey.toLocaleLowerCase()),
  );
  const validation = await validate(cleanup.bibtex, onProgress);
  const finalBibtex = validation.suggestedBibtex;

  onProgress?.({
    stage: "save",
    processed: 0,
    total: 0,
    message: "정리 및 확인된 서지정보 보정을 백업하고 저장하는 중",
  });
  const backupPath = await fileSystem.saveBibliographyMaintenance(
    projectPath,
    finalBibtex,
    "bibliography-validation",
  );

  return {
    bibtex: finalBibtex,
    removedUnused: cleanup.removedEntries.length,
    scannedDocuments: usage.scannedDocuments,
    usedEntries: validation.validations.length,
    missingCitekeys,
    backupPath,
    validations: validation.validations,
  };
}
