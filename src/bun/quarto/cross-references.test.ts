import { describe, expect, test } from "bun:test";
import { crossReferenceRenderDiagnostic } from "./render";
import { staticQuartoLabels } from "./reference-validation";

describe("Quarto cross-reference diagnostics", () => {
  test("scans static target definitions without treating examples as targets", () => {
    const source = '# State {#sec-state}\n\n![Figure](figure.png){#fig-one width=50%}\n\n: Caption {#tbl-one}\n\n$$x=1$$ {#eq-steady}\n\n`{#sec-code}`\n\n~~~qmd\n# Demo {#sec-example}\n~~~\n\nMention {#sec-text} in prose.';
    expect(staticQuartoLabels(source)).toEqual(["sec-state", "fig-one", "tbl-one", "eq-steady"]);
  });
  test("separates missing document references from bibliography warnings", () => {
    const diagnostic = crossReferenceRenderDiagnostic("WARNING Unable to resolve crossref @sec-state\nWARNING Unable to resolve crossref @fig-one\nWARNING Unable to resolve crossref @sec-state");
    expect(diagnostic).toContain("@sec-state, @fig-one");
    expect(diagnostic).toContain("not bibliography citations");
    expect(crossReferenceRenderDiagnostic("[WARNING] Citeproc: citation smith2020 not found")).toBeNull();
    expect(crossReferenceRenderDiagnostic("[WARNING] Citeproc: citation sec-state not found")).toContain("@sec-state");
  });
  test("reports duplicate targets independently of missing targets", () => {
    expect(crossReferenceRenderDiagnostic("WARNING: Duplicate identifier 'fig-one'")).toContain("Duplicate document identifiers");
  });
});
