import {defineTheme} from '@astryxdesign/core/theme';
import {neutralTheme} from '@astryxdesign/theme-neutral';

const systemSans =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Apple SD Gothic Neo", "Pretendard", Helvetica, Arial, sans-serif';

/**
 * ScholarPen "technical workbench" theme.
 *
 * Neutral's quiet grays carry the chrome; one indigo accent marks focus,
 * selection and the primary action. Type uses the platform UI font (no
 * webfont download in a desktop app) and corners are tightened for a
 * denser, tool-like rhythm.
 */
export const workbenchTheme = defineTheme({
  name: 'workbench',
  extends: neutralTheme,
  tokens: {
    '--color-accent': ['#4f46e5', '#a5a8ff'],
    '--font-family-body': systemSans,
    '--font-family-heading': systemSans,
    '--font-family-code':
      'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace',
    '--radius-page': '0.75rem',
    '--radius-container': '0.5rem',
    '--radius-element': '0.375rem',
    '--radius-inner': '0.25rem',
  },
});

export default workbenchTheme;
