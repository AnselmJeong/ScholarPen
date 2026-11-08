import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseBibtexEntries } from '../../shared/bibtex-utils';
import { figureMimeType } from '../../shared/figure-files';
import { markdownImageDestinations } from './markdown-images';
import { externalizeExportImages } from './export-images';
import { bundleExportImages, isInsideDirectory, writeExportAtomically } from './export-image-bundle';
import { scopedPath } from '../review/workspace';

const pending = new Map<string, Promise<unknown>>();
async function optionalText(root: string, path: string) {
  try { return await readFile(await scopedPath(root, path), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
async function backup(root: string, content: string, extension: string) {
  if (content) await writeExportAtomically(root, join(root, '.scholarpen/export-backups', `${createHash('sha256').update(content).digest('hex')}.${extension}`), content);
}

/** Keep source assets in the revision while publishing chapters to the parent Quarto project. */
export async function exportRevisionFile(project: string, revision: string, filename: string, content: string): Promise<string> {
  const previous = pending.get(project) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const path = await scopedPath(project, `exports/${filename}`);
    const oldContent = await optionalText(project, `exports/${filename}`);
    const oldBib = await optionalText(project, 'exports/references.bib');
    const revisionBib = await optionalText(revision, 'exports/references.bib');
    const original = parseBibtexEntries(oldBib); const revised = parseBibtexEntries(revisionBib);
    if (original.issues.length || revised.issues.length) throw new Error('참고문헌 형식을 확인해 주세요. 수정 원고를 내보내지 않았습니다.');
    // Replace matching entries with the revision's version, retaining parent-only entries and comments.
    let bibliography = oldBib;
    const revisedByKey = new Map(revised.entries.map(entry => [entry.citekey, entry]));
    for (const entry of [...original.entries].reverse()) {
      const replacement = revisedByKey.get(entry.citekey);
      if (replacement) bibliography = bibliography.slice(0, entry.start) + replacement.raw + bibliography.slice(entry.end);
    }
    const originalKeys = new Set(original.entries.map(entry => entry.citekey));
    const additions = revised.entries.filter(entry => !originalKeys.has(entry.citekey));
    if (additions.length) bibliography = [bibliography.trimEnd(), ...additions.map(entry => entry.raw)].filter(Boolean).join('\n\n') + '\n';
    content = await externalizeExportImages(revision, content);
    const sourceDocument = join(revision, 'exports', filename);
    for (const image of markdownImageDestinations(content).sort((a, b) => b.start - a.start)) {
      if (!image.url || /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(image.url)) continue;
      const match = /^([^?#]*)([?#].*)?$/.exec(image.url)!;
      const decoded = decodeURIComponent(match[1]);
      if (!figureMimeType(decoded)) continue;
      const source = resolve(dirname(sourceDocument), decoded);
      if (!isInsideDirectory(revision, source)) throw new Error(`수정본 밖의 그림 경로입니다: ${image.url}`);
      await scopedPath(revision, relative(revision, source));
      const url = relative(dirname(path), source).split('/').map(part => encodeURIComponent(part).replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16)}`)).join('/') + (match[2] ?? '');
      content = content.slice(0, image.start) + url + content.slice(image.end);
    }
    const [prepared] = await bundleExportImages(project, [{ path, content }]);
    if (oldContent !== prepared.content) await backup(project, oldContent, filename.endsWith('.qmd') ? 'qmd' : 'md');
    if (bibliography !== oldBib) {
      await backup(project, oldBib, 'bib');
      // Do not overwrite bibliography edits made while the images were being read.
      if (await optionalText(project, 'exports/references.bib') !== oldBib) throw new Error('내보내는 동안 참고문헌이 변경되었습니다. 다시 내보내 주세요.');
      await writeExportAtomically(project, join(project, 'exports/references.bib'), bibliography);
    }
    if (await optionalText(project, `exports/${filename}`) !== oldContent) throw new Error('내보내는 동안 대상 원고가 변경되었습니다. 다시 내보내 주세요.');
    await writeExportAtomically(project, path, prepared.content);
    return path;
  });
  pending.set(project, operation);
  try { return await operation; }
  finally { if (pending.get(project) === operation) pending.delete(project); }
}
