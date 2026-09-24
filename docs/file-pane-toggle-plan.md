# File pane visibility

- Use the existing Files button in the persistent icon rail to hide/show the left file pane.
- Reflect visibility in the button's active styling, accessible name, and expanded state.
- Hide the pane and its resize handle together, preserving the mounted file explorer and its width so folder and selection state survive toggling.
- Keep editor panes mounted in place and leave AI sidebar behavior independent.
- Validate with TypeScript, a frontend build, and a browser interaction check where available.

## Validation

- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/vite/bin/vite.js build`: passed.
- Browser interaction blocked before rendering by the existing Electrobun initialization error: invalid `ws://localhost:undefined/socket?webviewId=undefined` URL.
- Installed desktop app was not replaced or interaction-tested.
