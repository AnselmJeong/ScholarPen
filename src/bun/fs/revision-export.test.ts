import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSystem } from './manager';
import { prepareQuartoBookImages } from '../../plugins/quarto/main/prepare-images';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'scholar-revision-export-'))); roots.push(root);
  await mkdir(join(root, 'documents')); await fileSystem.openProjectByPath(root);
  const revision = join(root, 'revisions/session-1');
  for (const folder of ['documents', 'figures', 'exports', '.scholarpen']) await mkdir(join(revision, folder), { recursive: true });
  await writeFile(join(revision, '.scholarpen/review-origin.json'), JSON.stringify({ sessionId: 'session-1', baselineHash: 'test' }));
  await writeFile(join(revision, 'figures/plot.png'), 'revised figure');
  await writeFile(join(revision, 'exports/references.bib'), '@article{shared,title={Author corrected reference}}\n@article{new,title={New revision source}}');
  await writeFile(join(root, 'exports/references.bib'), '@article{shared,title={Old reference}}\n@article{rootonly,title={Unrelated root source}}');
  return { root, revision };
}

test('revision QMD exports to parent exports with revision figures and bibliography, preserving old files in backups', async () => {
  const { root, revision } = await fixture();
  await writeFile(join(root, 'exports/chapter.qmd'), 'Previous chapter');
  const sourceBib = await readFile(join(revision, 'exports/references.bib'), 'utf8');
  const result = await fileSystem.exportFile(revision, 'chapter.qmd', '---\nbibliography: references.bib\n---\n\n# Author revised chapter\n\n![Plot](../figures/plot.png)');
  expect(result).toBe(join(root, 'exports/chapter.qmd'));
  expect(await fileSystem.getQuartoProjectDirectory(revision)).toBe(join(root, 'exports'));
  const content = await readFile(result, 'utf8'); expect(content).toContain('Author revised chapter'); expect(content).toContain('figures/_project/revisions/session-1/figures/plot.png');
  expect(await readFile(join(root, 'exports/figures/_project/revisions/session-1/figures/plot.png'), 'utf8')).toBe('revised figure');
  const bib = await readFile(join(root, 'exports/references.bib'), 'utf8'); expect(bib).toContain('Author corrected reference'); expect(bib).toContain('rootonly'); expect(bib).toContain('@article{new'); expect(bib).not.toContain('Old reference');
  const backups = await readdir(join(root, '.scholarpen/export-backups')); expect(backups.some(n => n.endsWith('.bib'))).toBe(true); expect(backups.some(n => n.endsWith('.qmd'))).toBe(true);
  expect(await readdir(join(revision, 'exports'))).toEqual(['references.bib']); expect(await readFile(join(revision, 'exports/references.bib'), 'utf8')).toBe(sourceBib);
  await writeFile(join(revision, 'figures/plot.png'), 'updated revision figure');
  await prepareQuartoBookImages(join(root, 'exports'), 'project:\n  type: book\nbook:\n  chapters: [chapter.qmd]\n');
  expect(await readFile(join(root, 'exports/figures/_project/revisions/session-1/figures/plot.png'), 'utf8')).toBe('updated revision figure');
});

test('revision export fails on missing/escaping images without replacing root chapters or bibliography', async () => {
  const { root, revision } = await fixture();
  await writeFile(join(root, 'exports/chapter.md'), 'Keep existing chapter');
  const before = await readFile(join(root, 'exports/references.bib'), 'utf8');
  await expect(fileSystem.exportFile(revision, 'chapter.md', '![](../figures/missing.png)')).rejects.toThrow();
  await expect(fileSystem.exportFile(revision, 'chapter.md', '![](../../../figures/missing.png)')).rejects.toThrow('수정본 밖');
  await symlink(join(root, 'exports/references.bib'), join(revision, 'figures/escape.png'));
  await expect(fileSystem.exportFile(revision, 'chapter.md', '![](../figures/escape.png)')).rejects.toThrow('Symlink');
  expect(await readFile(join(root, 'exports/chapter.md'), 'utf8')).toBe('Keep existing chapter');
  expect(await readFile(join(root, 'exports/references.bib'), 'utf8')).toBe(before);
});

test('ordinary exports keep their location and concurrent revision chapters share a complete image manifest', async () => {
  const { root, revision } = await fixture();
  expect(await fileSystem.exportFile(root, 'ordinary.md', '# Ordinary')).toBe(join(root, 'exports/ordinary.md'));
  await Promise.all(['one.md', 'two.qmd'].map(name => fileSystem.exportFile(revision, name, '![](../figures/plot.png)')));
  for (const name of ['one.md', 'two.qmd']) expect(await readFile(join(root, 'exports', name), 'utf8')).toContain('revisions/session-1/figures/plot.png');
  expect(JSON.parse(await readFile(join(root, 'exports/.scholarpen-image-manifest.json'), 'utf8')).images).toHaveLength(1);
});
