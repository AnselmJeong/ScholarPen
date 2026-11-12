import { projectMemory } from "./hindsight";
import { ProjectMemorySync } from "./sync";
// Author Style has its own private storage and scheduler. Hindsight owns only its opt-in sync.
export const projectMemorySync = new ProjectMemorySync(projectMemory, async () => []);
// Existing remote author observations are retired through the durable deletion ledger.
