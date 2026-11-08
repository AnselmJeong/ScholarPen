/** Editable revision folders belong to the open project, but have independent assets and state. */
export function revisionWorkspacePath(projectPath: string, filePath: string): string | null {
  const root = projectPath.replace(/\/$/, '');
  const prefix = `${root}/revisions/`;
  if (!filePath.startsWith(prefix)) return null;
  const parts = filePath.slice(prefix.length).split('/');
  if (parts.length < 2 || parts.some(p => !p || p === '.' || p === '..' || /[\\\0]/.test(p))) return null;
  return `${prefix}${parts[0]}`;
}
