import { describe, expect, test } from "bun:test";
import {
  buildCitationSearchQueries,
  reconstructOpenAlexAbstract,
} from "./client";

describe("citation candidate utilities", () => {
  test("reconstructs an OpenAlex inverted abstract in reading order", () => {
    expect(reconstructOpenAlexAbstract({
      evidence: [2],
      Direct: [0],
      supporting: [1],
    })).toBe("Direct supporting evidence");
  });

  test("prioritizes Latin scholarly terms for a Korean passage", () => {
    const queries = buildCitationSearchQueries(
      "ASD 아동은 Ebbinghaus 착각과 Müller-Lyer 착각에서 contextual integration 차이를 보인다.",
    );

    expect(queries[0]).toContain("ASD");
    expect(queries[0]).toContain("Ebbinghaus");
    expect(queries[0]).toContain("Müller-Lyer");
    expect(queries[1]).toContain("아동");
  });

  test("keeps the full passage first for an English claim", () => {
    const passage = "Children with autism may be less susceptible to the Ebbinghaus illusion.";
    expect(buildCitationSearchQueries(passage)[0]).toBe(passage);
  });
});
