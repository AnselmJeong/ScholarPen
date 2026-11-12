import { expect, test } from "bun:test";
import { ExtensionHost } from "./host";
import { validateManifest, type PluginEntry, type PluginManifest } from "./contracts";

const manifest: PluginManifest = {
  manifestVersion: 1, id: "example.counter", name: "Counter", description: "Contract fixture", version: "1.0.0", apiVersion: "0.1.0", dataSchemaVersion: 1,
  permissions: ["document.read"], contributes: { slots: ["status"], commands: [{ id: "example.counter.count", title: "Count", input: { type: "object", properties: { text: { type: "string" } } }, output: { type: "number" } }] },
};
const request = (id: string, args: unknown = { text: "abc" }) => ({ protocolVersion: 1 as const, requestId: id, operation: "example.counter.count", args });
function entry(activate: PluginEntry["load"]): PluginEntry { return { manifest, load: activate }; }

test("catalog discovery executes no plugin code; concurrent activation happens once and disposal removes handlers", async () => {
  let loaded = 0, disposed = 0;
  const host = new ExtensionHost([entry(async () => {
    loaded++; await new Promise(resolve => setTimeout(resolve, 5));
    return { activate(ctx) { ctx.register("example.counter.count", () => 3); ctx.onDispose(() => { disposed++; }); } };
  })]);
  expect(loaded).toBe(0); expect(host.list()[0]?.state).toBe("inactive");
  expect(await Promise.all([host.invoke(request("1")), host.invoke(request("2"))])).toEqual([3, 3]);
  expect(loaded).toBe(1);
  await host.setEnabled(manifest.id, false);
  expect(disposed).toBe(1);
  await expect(host.invoke(request("3"))).rejects.toThrow("disabled");
  await host.setEnabled(manifest.id, true);
  expect(await host.invoke(request("4"))).toBe(3); expect(loaded).toBe(2);
});

test("malformed inputs are rejected before activation, including extra routing identities", async () => {
  let loaded = false;
  const host = new ExtensionHost([entry(async () => { loaded = true; return { activate() {} }; })]);
  await expect(host.invoke(request("1", { text: 5 }))).rejects.toThrow("expected string");
  await expect(host.invoke(request("2", { text: "x", pluginId: "other" }))).rejects.toThrow("unexpected field");
  await expect(host.invoke({ ...request("3"), operation: "other.counter.count" })).rejects.toThrow("unavailable");
  expect(loaded).toBe(false);
});

test("activation failure releases registered resources and permits a clean retry", async () => {
  let attempts = 0, disposed = 0;
  const host = new ExtensionHost([entry(async () => ({ activate(ctx) {
    ctx.register("example.counter.count", () => 3); ctx.onDispose(() => { disposed++; });
    if (++attempts === 1) throw new Error("fixture failure");
  } }))]);
  await expect(host.invoke(request("1"))).rejects.toThrow("fixture failure");
  expect(disposed).toBe(1); expect(host.list()[0]?.state).toBe("failed");
  expect(await host.invoke(request("2"))).toBe(3);
});

test("active operations prevent unsafe disable; cancellation reaches the operation", async () => {
  let began!: () => void;
  const ready = new Promise<void>(resolve => { began = resolve; });
  const host = new ExtensionHost([entry(async () => ({ activate(ctx) {
    ctx.register("example.counter.count", (_args, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); began();
    }));
  } }))]);
  const running = host.invoke(request("1"));
  const rejected = running.catch(error => error);
  await ready;
  await expect(host.setEnabled(manifest.id, false)).rejects.toThrow("running operation");
  await expect(host.invoke(request("1"))).rejects.toThrow("Duplicate");
  host.cancel("1"); expect(await rejected).toBeInstanceOf(Error);
  await host.setEnabled(manifest.id, false); expect(host.list()[0]?.running).toBe(0);
});

test("failed persistence leaves enabled state unchanged", async () => {
  const host = new ExtensionHost([entry(async () => ({ activate(ctx) { ctx.register("example.counter.count", () => 3); } }))], [], async () => { throw new Error("disk full"); });
  await expect(host.setEnabled(manifest.id, false)).rejects.toThrow("disk full");
  expect(host.isEnabled(manifest.id)).toBe(true);
});

test("bad output is rejected and another plugin cannot register a foreign command", async () => {
  const host = new ExtensionHost([entry(async () => ({ activate(ctx) { ctx.register("example.counter.count", () => "wrong"); } }))]);
  await expect(host.invoke(request("1"))).rejects.toThrow("output");
  const foreign = new ExtensionHost([entry(async () => ({ activate(ctx) { ctx.register("other.plugin.command", () => 3); } }))]);
  await expect(foreign.invoke(request("2"))).rejects.toThrow("Undeclared");
});

test("duplicate IDs, incompatible API, unknown permissions and unknown slots are rejected", () => {
  const e = entry(async () => ({ activate() {} }));
  expect(() => new ExtensionHost([e, e])).toThrow("Duplicate");
  for (const update of [{ apiVersion: "9.0.0" }, { permissions: ["shell.unrestricted"] }, { contributes: { commands: [], slots: ["dom"] } }]) {
    expect(() => validateManifest({ ...manifest, ...update })).toThrow();
  }
});

test("host-only legacy task leases also protect disable and honor cancellation", async () => {
  const host = new ExtensionHost([entry(async () => ({ activate() {} }))]);
  let finish!: () => void;
  const work = host.runTask(manifest.id, () => new Promise<void>(resolve => { finish = resolve; }));
  await expect(host.setEnabled(manifest.id, false)).rejects.toThrow("running operation");
  finish(); await work; await host.setEnabled(manifest.id, false);
  await expect(host.runTask(manifest.id, async () => 1)).rejects.toThrow("disabled");
});
