import { addNodeAndExtensionsToSpec, defaultBlockSpecs } from "@blocknote/core";

// Keep BlockNote's native table node, resizing, keyboard shortcuts, and heading
// implementation. Extend both the JSON schema and the underlying node attributes.
function withQuartoProps<T extends typeof defaultBlockSpecs.heading | typeof defaultBlockSpecs.table>(base: T) {
  const properties = { label: { default: "" }, caption: { default: "" },
    ...(base.config.type === "heading" ? { quartoClasses: { default: "" } } : {}) };
  const config = { ...base.config, propSchema: { ...base.config.propSchema, ...properties } };
  // Heading's stock renderer closes over its original prop schema. Passing new
  // props into that wrapper crashes only when a real NodeView is mounted.
  const implementation = base.config.type === "heading" ? {
    ...base.implementation,
    render(this: any, block: any, editor: any) {
      const { label, caption, quartoClasses, ...props } = block.props;
      const result = base.implementation.render.call(this, { ...block, props }, editor);
      if (label && result.dom instanceof HTMLElement) result.dom.setAttribute("data-label", label);
      return result;
    },
    toExternalHTML(this: any, block: any, editor: any, context: any) {
      const { label, caption, quartoClasses, ...props } = block.props;
      const result = base.implementation.toExternalHTML!.call(this, { ...block, props }, editor, context);
      if (result && label && result.dom instanceof HTMLElement) result.dom.setAttribute("data-label", label);
      return result;
    },
  } : base.implementation;
  const node = addNodeAndExtensionsToSpec(config as any, implementation as any, base.extensions).implementation.node;
  return {
    ...base,
    config,
    implementation: {
      ...implementation,
      ...(node ? { node: node.extend({
        ...(base.config.type === "table" ? {
          addNodeView(this: any) {
            const parent = this.parent();
            return (props: any) => {
              const view = parent(props);
              const caption = document.createElement("div");
              caption.className = "px-2 py-2 text-sm text-muted-foreground";
              caption.contentEditable = "false";
              (view.dom.querySelector(".tableWrapper") ?? view.dom).appendChild(caption);
              const sync = (attrs: Record<string, string>) => {
                caption.textContent = [attrs.label ? `#${attrs.label}` : "", attrs.caption].filter(Boolean).join(" · ");
                caption.hidden = !caption.textContent;
              };
              sync(props.node.attrs);
              const update = view.update?.bind(view);
              view.update = (next: any, ...rest: any[]) => {
                const updated = update?.(next, ...rest) ?? false;
                if (updated) sync(next.attrs);
                return updated;
              };
              return view;
            };
          },
        } : {}),
        addAttributes() {
          return {
            ...this.parent?.(),
            ...Object.fromEntries(Object.keys(properties).map((key) => [key, {
              default: "", keepOnSplit: false,
              parseHTML: (element: HTMLElement) => element.getAttribute(`data-${key}`) ?? "",
              renderHTML: (attrs: Record<string, unknown>) => attrs[key] ? { [`data-${key}`]: attrs[key] } : {},
            }])),
          };
        },
      }) } : {}),
    },
  };
}

export const quartoHeading = withQuartoProps(defaultBlockSpecs.heading);
export const quartoTable = withQuartoProps(defaultBlockSpecs.table);
