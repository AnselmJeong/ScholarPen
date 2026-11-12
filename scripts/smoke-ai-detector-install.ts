/** Run with SCHOLARPEN_DETECTOR_HOME set to an empty directory and PATH restricted. */
import { detectorInstaller } from "../src/plugins/ai-writing-score/main/installer";
import { detectorActivity, detectorHome } from "../src/plugins/ai-writing-score/main/runtime";
const cancel = process.argv.includes("--cancel");
const initial = await detectorInstaller.getStatus();
console.log(JSON.stringify({ initial, home: detectorHome }));
if (initial.state !== "missing") throw new Error("Expected a fresh detector installation directory");
console.log(JSON.stringify(detectorInstaller.start()));
if (cancel) {
  await new Promise(resolve => setTimeout(resolve, 100));
  detectorInstaller.cancel();
}
let previous = "";
while (true) {
  await new Promise(resolve => setTimeout(resolve, 1000));
  const state = await detectorInstaller.getStatus();
  const serialized = JSON.stringify(state);
  if (serialized !== previous) { console.log(serialized); previous = serialized; }
  if (cancel && state.state === "missing") {
    if (detectorActivity.installing) throw new Error("Installer lock was not released");
    break;
  }
  if (state.state === "ready") break;
  if (state.state === "error" || state.state === "missing") throw new Error(state.detail);
}
