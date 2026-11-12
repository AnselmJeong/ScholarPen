import { Window } from "happy-dom";

/**
 * Installs a happy-dom window as the global browser environment for a
 * component test and returns a restore function for `afterAll`.
 *
 * Astryx components use more of the browser than plain React markup
 * (animation frames, media queries, observers, computed styles), so tests
 * that render them install the whole set here instead of a hand-picked few.
 */
const GLOBAL_KEYS = [
  "window", "document", "navigator", "location",
  "Node", "Element", "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "HTMLSelectElement", "HTMLTextAreaElement", "HTMLAnchorElement",
  "HTMLDivElement", "HTMLSpanElement", "HTMLLabelElement", "HTMLFormElement", "SVGElement", "SVGSVGElement", "Text", "DocumentFragment", "ShadowRoot",
  "Range", "Selection", "NodeFilter", "TreeWalker", "AbortController",
  "Event", "CustomEvent", "KeyboardEvent", "MouseEvent", "PointerEvent", "FocusEvent", "InputEvent",
  "getComputedStyle", "matchMedia", "requestAnimationFrame", "cancelAnimationFrame",
  "ResizeObserver", "MutationObserver", "IntersectionObserver",
  "DOMRect", "DOMParser", "CSS", "CSSStyleSheet",
] as const;

export function installDom(options?: ConstructorParameters<typeof Window>[0]) {
  const dom = new Window({ url: "http://localhost", ...options });
  const keys = [...GLOBAL_KEYS, "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const value = (key: (typeof keys)[number]) => {
    if (key === "IS_REACT_ACT_ENVIRONMENT") return true;
    if (key === "window") return dom;
    if (key === "requestAnimationFrame") return (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number;
    if (key === "cancelAnimationFrame") return (id: number) => clearTimeout(id);
    if (key === "matchMedia") return (query: string) => dom.matchMedia(query);
    if (key === "getComputedStyle") return (element: Element) => dom.getComputedStyle(element as never);
    if (key === "ResizeObserver" && !Reflect.get(dom, key)) {
      return class { observe() {} unobserve() {} disconnect() {} };
    }
    return Reflect.get(dom, key);
  };
  for (const key of keys) {
    const next = value(key);
    if (next !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: next });
  }
  if (!Reflect.get(dom, "requestAnimationFrame")) Object.defineProperty(dom, "requestAnimationFrame", { configurable: true, value: value("requestAnimationFrame") });
  if (!Reflect.get(dom, "cancelAnimationFrame")) Object.defineProperty(dom, "cancelAnimationFrame", { configurable: true, value: value("cancelAnimationFrame") });
  return {
    dom,
    restore() {
      for (const [key, descriptor] of previous) descriptor ? Object.defineProperty(globalThis, key, descriptor) : Reflect.deleteProperty(globalThis, key);
      void dom.happyDOM.abort();
    },
  };
}

/** Finds an element by its exact accessible text among buttons in `root`. */
export function buttonByText(root: ParentNode, label: string) {
  return Array.from(root.querySelectorAll("button")).find(button => button.textContent?.trim() === label || button.getAttribute("aria-label") === label);
}

/**
 * Chooses an option in an Astryx Selector: opens the combobox named `label`
 * and clicks the option whose text is `option`. Options render in a portal,
 * so they are looked up in the whole document.
 */
export async function chooseOption(root: ParentNode, label: string, option: string, act: (fn: () => Promise<void>) => Promise<void>) {
  const trigger = Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"]')).find(element =>
    element.getAttribute("aria-label") === label || labelledText(element) === label);
  if (!trigger) throw new Error(`No selector labelled ${label}`);
  await act(async () => { trigger.click(); });
  const choice = optionsOf(trigger).find(element => element.textContent?.trim() === option);
  if (!choice) throw new Error(`No option ${option} in ${label}`);
  await act(async () => { choice.click(); });
}

function labelledText(element: HTMLElement) {
  if (element.id) {
    const label = document.querySelector(`label[for="${element.id}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
  return ids.map(id => document.getElementById(id)?.textContent?.trim() ?? "").join(" ").trim();
}

/** Lists the option texts of an Astryx Selector after opening it. */
export async function optionTexts(root: ParentNode, label: string, act: (fn: () => Promise<void>) => Promise<void>) {
  const trigger = Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"]')).find(element =>
    element.getAttribute("aria-label") === label || labelledText(element) === label);
  if (!trigger) throw new Error(`No selector labelled ${label}`);
  await act(async () => { trigger.click(); });
  const texts = optionsOf(trigger).map(element => element.textContent?.trim() ?? "");
  await act(async () => { trigger.click(); });
  return texts;
}

/** The combobox element of the Astryx Selector labelled `label`. */
export function selectorTrigger(root: ParentNode, label: string) {
  const trigger = Array.from(root.querySelectorAll<HTMLElement>('[role="combobox"]')).find(element =>
    element.getAttribute("aria-label") === label || labelledText(element) === label);
  if (!trigger) throw new Error(`No selector labelled ${label}`);
  return trigger;
}

/** Options of the listbox a combobox controls (a closing popover may linger). */
function optionsOf(trigger: HTMLElement) {
  const listbox = trigger.getAttribute("aria-controls");
  const scope = listbox ? document.getElementById(listbox) : null;
  const options = Array.from((scope ?? document).querySelectorAll<HTMLElement>('[role="option"]'));
  return listbox && !scope ? options.filter(option => option.id.startsWith(`${listbox}-`)) : options;
}
