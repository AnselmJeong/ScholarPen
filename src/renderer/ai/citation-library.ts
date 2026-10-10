import { parseBibtexEntries } from "../../shared/bibtex-utils";
import { rpc } from "../rpc";

function normalizeDOI(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").toLowerCase();
}

/** Resolve full authors/metadata before saving; Paperclip authors may be truncated. */
export async function addEvidenceCitation(projectPath: string, doi: string): Promise<string> {
  const metadata = await rpc.resolveDOI(doi);
  if (!metadata?.bibtex || normalizeDOI(metadata.doi) !== normalizeDOI(doi)) {
    throw new Error("DOI 서지정보를 확인하지 못했습니다. 논문 링크에서 확인해 주세요.");
  }
  await rpc.mergeBibtex(projectPath, metadata.bibtex);
  const saved = await rpc.loadBibtex(projectPath);
  const entry = parseBibtexEntries(saved).entries.find(item => normalizeDOI(item.fields.doi ?? "") === normalizeDOI(doi));
  if (!entry) throw new Error("참고문헌 저장을 확인하지 못했습니다. 다시 시도해 주세요.");
  return entry.citekey;
}
