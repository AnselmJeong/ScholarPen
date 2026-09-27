import { expect, test } from "bun:test";
import { codexQuotaError, type CodexStatus } from "./codex";

const connected: CodexStatus = {
  state: "connected", ordinaryUsageAllowed: null,
  quotas: [{ id: "codex", name: "Codex", model: null, primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1 }, secondary: null }],
};
test("accepts available included usage and does not infer allowance from a reset timestamp", () => {
  expect(codexQuotaError(connected, "model")).toBeNull();
  expect(codexQuotaError({ ...connected, ordinaryUsageAllowed: false }, "model")).toContain("한도에 도달");
  expect(codexQuotaError({ ...connected, quotas: [] }, "model")).toContain("확인할 수 없어");
});
test("checks model-specific and weekly quotas, excluding unrelated model quotas", () => {
  const exhausted = { id: "special", name: "special", model: "special-model", primary: null, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1 } };
  const status = { ...connected, quotas: [...connected.quotas, exhausted] };
  expect(codexQuotaError(status, "model")).toBeNull();
  expect(codexQuotaError(status, "special-model")).toContain("유료 API로 전환하지 않았습니다");
});
