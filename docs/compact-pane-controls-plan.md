# Compact pane controls

- Replace the large Files rail button with a small left-panel icon at the left edge of the editor tab bar.
- Replace the breadcrumb's Outline text button with a matching right-panel icon at the right edge of the document pane's tab bar.
- Keep both controls outside the horizontally scrolling tabs, with tooltips, accessible names, expanded states, and keyboard focus indicators.
- Remove the now-unnecessary icon rail and move Settings to the app header. Its Help button had no action.
- Preserve file explorer state, editor mounting, outline visibility persistence, split-pane behavior, and focus restoration when closing the outline.
- Check TypeScript, frontend build, and compact control interactions with in-memory UI fixtures; do not modify manuscript data.

## Verified

- TypeScript, Vite production frontend build, and 5 existing outline tests passed.
- Browser fixture rendered the actual App and editor with in-memory RPC responses and disabled writes.
- File and outline panels both hide and restore with their compact controls; manuscript content and expanded file folders remain intact.
- Closing the outline returns focus to its tab-bar toggle; Enter reopens it. Settings opens from the new app-header button even while files are hidden.
- Installed macOS app was not replaced or tested.
