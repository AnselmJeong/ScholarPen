import { describe, expect, test } from "bun:test";
import {
  explicitlyRequestsWebSearch,
  parseWebSearchDecision,
} from "./web-search-decision";

describe("automatic web-search decisions", () => {
  test("recognizes explicit Korean and English requests", () => {
    expect(explicitlyRequestsWebSearch("인터넷에서 최신 논문을 찾아줘")).toBe(true);
    expect(explicitlyRequestsWebSearch("Search the web for current guidance")).toBe(true);
    expect(explicitlyRequestsWebSearch("이 문단을 자연스럽게 다듬어줘")).toBe(false);
  });

  test("accepts only SEARCH as the positive model decision", () => {
    expect(parseWebSearchDecision("SEARCH")).toBe(true);
    expect(parseWebSearchDecision("NO_SEARCH")).toBe(false);
  });
});
