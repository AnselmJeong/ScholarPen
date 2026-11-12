import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledManifests } from "./catalog.generated";

test("composition roots have no feature implementation imports and generated catalog owns all bundled modules", async () => {
  const root = join(import.meta.dir, "../../..");
  for (const path of ["src/bun/index.ts", "src/renderer/App.tsx", "src/bun/fs/manager.ts"]) {
    const code = await readFile(join(root, path), "utf8");
    expect(code.match(/(?:from\s*|import\s*\()['"][^'"]*\/plugins\//g)).toBeNull();
  }
  const catalog = await readFile(join(root, "src/bun/extensions/catalog.generated.ts"), "utf8");
  expect(bundledManifests.length).toBeGreaterThanOrEqual(6);
  for (const manifest of bundledManifests) expect(catalog).toContain(`/plugins/${manifest.id.split(".")[1]}/main`);
});
