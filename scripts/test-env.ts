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
