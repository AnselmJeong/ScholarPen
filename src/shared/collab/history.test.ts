import { expect, test } from "bun:test";
import { commonIds, diffBlocks, groupHistory, historyStats, type HistoryBlock, type HistoryEntry } from "./history";
import { planThinning, type StoredEntry } from "../../bun/collab/history/thinning";

const block = (id: string, text: string): HistoryBlock => ({ id, type: "paragraph", text, fingerprint: text });

test("commonIds keeps the longest run of blocks that did not move", () => {
  const kept = commonIds(["a", "b", "c", "d"], ["a", "c", "b", "d"]);
  expect(kept.size).toBe(3);
  expect(kept.has("a") && kept.has("d")).toBe(true);
  expect([...commonIds(["a", "b", "c"], ["c", "a", "b"])].sort()).toEqual(["a", "b"]);
  expect(commonIds(["a"], ["b"]).size).toBe(0);
});

test("diffBlocks lists removed, added and changed blocks in reading order", () => {
  const older = [block("a", "Alpha one."), block("b", "Beta."), block("c", "Gamma.")];
  const newer = [block("a", "Alpha two."), block("c", "Gamma."), block("d", "Delta.")];
  const rows = diffBlocks(older, newer);
  expect(rows.map((row) => `${row.kind}:${row.id}`)).toEqual(["changed:a", "removed:b", "same:c", "added:d"]);
  const changed = rows[0];
  expect(changed.kind === "changed" && changed.parts).toEqual([
    { text: "Alpha ", op: "same" }, { text: "one", op: "remove" }, { text: "two", op: "add" }, { text: ".", op: "same" },
  ]);
});

test("historyStats counts words in changed, new and deleted blocks", () => {
  const stats = historyStats([block("a", "one two"), block("b", "gone words here")], [block("a", "one three four"), block("c", "new")]);
  expect(stats).toEqual({ added: 3, removed: 4, blocks: 3 });
});

const entry = (id: string, kind: HistoryEntry["kind"], startedAt: number, extra: Partial<StoredEntry> = {}): StoredEntry =>
  ({ id, seq: Number(id), kind, startedAt, endedAt: startedAt + 1_000, stats: { added: 1, removed: 0, blocks: 1 }, ...extra });

test("groupHistory folds a session of plain author checkpoints, newest first", () => {
  const groups = groupHistory([
    entry("0", "start", 0),
    entry("1", "author", 60_000),
    entry("2", "author", 120_000),
    entry("3", "ai", 180_000),
    entry("4", "author", 240_000, { name: "Submitted" }),
  ]);
  expect(groups.map((group) => group.entries.map((item) => item.id))).toEqual([["4"], ["3"], ["1", "2"], ["0"]]);
});

test("planThinning folds hidden entries forward and old plain ones per hour", () => {
  const hour = 60 * 60_000;
  const now = new Date(2026, 5, 20, 12).getTime();
  const old = new Date(2026, 5, 10, 9).getTime();
  const entries = [
    entry("0", "start", old - hour),
    entry("1", "author", old),
    entry("2", "system", old + 60_000, { hidden: true }),
    entry("3", "author", old + 120_000),
    entry("4", "author", old + 180_000, { label: "Accepted AI suggestions" }),
    entry("5", "author", old + 2 * hour),
    entry("6", "author", now - hour),
    entry("7", "system", now - 60_000, { hidden: true }),
  ];
  expect(planThinning(entries, now)).toEqual([{ from: 1, to: 3 }]);
});
