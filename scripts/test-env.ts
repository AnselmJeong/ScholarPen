// Tests must never provision banks on the user's real Hindsight instance.
// Integration tests construct their own ProjectMemoryService with a loopback test server.
process.env.SCHOLARPEN_HINDSIGHT_DISABLED = "1";
// Tests that exercise the common context composer must not touch personal style profiles.
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const profiles = mkdtempSync(join(tmpdir(), "scholarpen-test-profiles-"));
process.env.SCHOLARPEN_PROFILE_HOME = profiles;
process.on("exit", () => rmSync(profiles, { recursive: true, force: true }));
// Astryx modules schedule an animation frame when they are first imported in a
// window-like environment; give the test process one so import order between
// component tests never matters.
if (typeof globalThis.requestAnimationFrame !== "function") {
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0) as unknown as number);
  globalThis.cancelAnimationFrame = ((id: number) => clearTimeout(id));
}
