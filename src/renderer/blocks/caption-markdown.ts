import { prepareMarkdownMath } from "./markdown-math";

/** Older captions sometimes contain a second escaping layer on every TeX command.
 * Decode that layer only within formulas with no singly escaped commands. Keep
 * normal TeX (including matrix row separators) and surrounding prose untouched.
 */
export function normalizeFigureCaption(source: string): string {
  const prepared = prepareMarkdownMath(source);
  return prepared.markdown.replace(prepared.pattern, (token) => {
    const math = prepared.formulas.get(token)!;
    let formula = math.formula;
    if (!/(?<!\\)\\[A-Za-z]/.test(formula) && /(?<!\\)\\\\[A-Za-z]/.test(formula)) {
      formula = formula.replace(/(?<!\\)\\\\(?=[A-Za-z])/g, "\\");
    }
    const delimiter = math.display ? "$$" : "$";
    return `${delimiter}${formula}${delimiter}${math.label ? ` {#${math.label}}` : ""}`;
  });
}
