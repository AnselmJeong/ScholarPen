/**
 * PoC: LanceDB in Bun environment
 * Run with: bun src/bun/lancedb/poc.ts
 */
import { connect } from "@lancedb/lancedb";
import { ollamaClient } from "../ollama/client";

async function main() {
  console.log("=== ScholarPen Phase 0 PoC ===\n");

  // ── 1. Ollama status ─────────────────────────────────
  console.log("1. Checking Ollama status...");
  const status = await ollamaClient.getStatus();
  console.log(`   Connected: ${status.connected}`);
  console.log(`   Models: ${status.models.slice(0, 3).join(", ") || "(none)"}`);

  // ── 2. LanceDB create & insert ───────────────────────
  console.log("\n2. Testing LanceDB...");
  const tmpDir = `/tmp/scholarpen-poc-${Date.now()}`;
  const db = await connect(tmpDir);

  const table = await db.createTable("test_chunks", [
    {
      id: "chunk-001",
      text: "Free energy principle minimizes surprise over time",
      vector: new Array(4).fill(0).map(() => Math.random()),
      metadata: { title: "Test Paper", year: 2024 },
    },
    {
      id: "chunk-002",
      text: "Active inference implements the free energy principle",
      vector: new Array(4).fill(0).map(() => Math.random()),
      metadata: { title: "Test Paper", year: 2024 },
    },
  ]);

  console.log(`   Table created: ${table.name}`);
  console.log(`   Row count: ${await table.countRows()}`);

  // ── 3. LanceDB vector search ─────────────────────────
  console.log("\n3. Testing LanceDB vector search...");
  const queryVec = new Array(4).fill(0).map(() => Math.random());
  const results = await table.vectorSearch(queryVec).limit(2).toArray();
  console.log(`   Search returned ${results.length} results`);
  results.forEach((r, i) => console.log(`   [${i + 1}] ${r.text}`));

  // ── 4. Ollama streaming (if connected) ───────────────
  if (status.connected) {
    console.log("\n4. Testing Ollama streaming...");
    const chunks: string[] = [];
    await ollamaClient.streamChat(
      {
        model: status.activeModel ?? "llama3.1",
        messages: [{ role: "user", content: "Say hello in one sentence." }],
      },
      (chunk) => chunks.push(chunk)
    );
    const response = chunks.join("").trim();
    console.log(`   Response: "${response.slice(0, 80)}..."`);
  } else {
    console.log("\n4. Skipping Ollama streaming (not connected)");
    console.log("   Start Ollama with: ollama serve");
  }

  console.log("\n=== PoC Complete ✓ ===");
}

main().catch((err) => {
  console.error("PoC failed:", err);
  process.exit(1);
});
