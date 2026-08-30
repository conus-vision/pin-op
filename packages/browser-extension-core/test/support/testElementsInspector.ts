import {
  ElementsInspectorShell,
  type CreateElementsRulesRenderer,
  type CreateElementsTreeRenderer,
  type MatchedStylesSnapshot,
  type PseudoStateDataSource,
  type RulesDataSource,
  type SourceLinkDelegate,
  type TreeDataSource,
} from "@pin-op/devtools-elements-ui";
import { PseudoStateController } from "../../../devtools-elements-ui/src/pseudoStateController.js";

/**
 * The packaged panel always receives Chromium's renderers through the native
 * runtime. Tests mount the same shell with inert stand-ins so panel wiring is
 * observable without a browser.
 */
export class TestElementsInspector extends ElementsInspectorShell {
  public constructor(
    document: Document,
    mount: HTMLElement,
    treeDataSource: TreeDataSource,
    rulesDataSource?: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
    pseudoStateDataSource?: PseudoStateDataSource,
  ) {
    super(
      document,
      mount,
      treeDataSource,
      rulesDataSource,
      sourceLinkDelegate,
      pseudoStateDataSource,
      createTestTreeRenderer,
      createTestRulesRenderer,
    );
  }
}

/**
 * Renders exactly the row identity and pointer contract the panel runtime
 * observes, without reimplementing Chromium's tree presentation.
 */
const createTestTreeRenderer: CreateElementsTreeRenderer = (
  document,
  mount,
  treeDataSource,
) => {
  const host = document.createElement("div");
  host.className = "elements-tree-outline";
  host.setAttribute("data-part", "test-tree-renderer");
  mount.append(host);
  const nodeRefOf = (event: Event): string | undefined => {
    const target = event.target as { getAttribute?: (name: string) => string | null };
    return target?.getAttribute?.("data-node-ref") ?? undefined;
  };
  const hover = (event: Event): void => {
    hoveredNodeRef = nodeRefOf(event);
    treeDataSource.hover(hoveredNodeRef);
  };
  const clearHover = (): void => {
    hoveredNodeRef = undefined;
    treeDataSource.hover(undefined);
  };
  const select = (event: Event): void => {
    const nodeRef = nodeRefOf(event);
    if (nodeRef) void treeDataSource.select(nodeRef);
  };
  let hoveredNodeRef: string | undefined;
  host.addEventListener("pointermove", hover);
  host.addEventListener("pointerleave", clearHover);
  host.addEventListener("click", select);
  const render = (): void => {
    host.replaceChildren();
    for (const row of treeDataSource.snapshot().rows) {
      const element = document.createElement("div");
      element.setAttribute("data-node-ref", row.nodeRef);
      element.setAttribute("data-selected", String(row.selected));
      element.setAttribute("data-hovered", String(row.hovered));
      element.setAttribute("aria-selected", String(row.selected));
      host.append(element);
    }
  };
  const unsubscribe = treeDataSource.subscribe(render);
  render();
  return {
    dispose(): void {
      // Chromium's adapter releases its hover before it unsubscribes.
      if (hoveredNodeRef !== undefined) clearHover();
      unsubscribe();
      host.removeEventListener("pointermove", hover);
      host.removeEventListener("pointerleave", clearHover);
      host.removeEventListener("click", select);
      host.replaceChildren();
      host.remove();
    },
  };
};

/**
 * Renders exactly the rule-origin contract the panel runtime owns: a plain
 * generated label until an exact IDE authority arrives, then one clickable
 * origin that reports the open intent back through the delegate.
 */
const createTestRulesRenderer: CreateElementsRulesRenderer = (
  document,
  mount,
  _dataSource,
  sourceLinkDelegate,
  pseudoStateDataSource,
) => {
  const host = document.createElement("div");
  host.setAttribute("data-part", "test-rules-renderer");
  mount.append(host);
  const preview = pseudoStateDataSource
    ? new PseudoStateController(document, pseudoStateDataSource)
    : undefined;
  if (preview) host.append(preview.element);
  let rendered: MatchedStylesSnapshot | undefined;
  const renderOrigins = (): void => {
    host.replaceChildren(...(preview ? [preview.element] : []));
    for (const rule of rulesOf(rendered)) {
      const section = document.createElement("div");
      section.setAttribute("data-rule-ref", rule.ruleRef);
      section.textContent = `${rule.selectorText} { ${rule.declarations.map(
        (declaration) => `${declaration.name}: ${declaration.value}${
          declaration.important ? " !important" : ""
        };`,
      ).join(" ")} }`;
      const origin = sourceLinkDelegate?.originFor(rule.ruleRef);
      const generated = generatedLabelOf(rule);
      if (origin || generated) {
        const clickable = Boolean(origin?.clickable && origin.state === undefined);
        const element = document.createElement(clickable ? "button" : "span");
        element.setAttribute("data-rule-origin", rule.ruleRef);
        element.setAttribute(
          "data-source-link-status",
          origin ? origin.state ?? "exact" : "unresolved",
        );
        element.textContent = origin
          ? `${origin.label}:${origin.startLine}`
          : generated ?? "";
        if (clickable) {
          element.addEventListener("click", () => {
            sourceLinkDelegate?.openRuleOrigin(rule.ruleRef);
          });
        }
        section.append(element);
      }
      host.append(section);
    }
  };
  return {
    render(snapshot: MatchedStylesSnapshot): void {
      rendered = snapshot;
      renderOrigins();
    },
    refreshOrigins(): void {
      renderOrigins();
    },
    clear(): void {
      rendered = undefined;
      renderOrigins();
    },
    dispose(): void {
      preview?.dispose();
      host.remove();
    },
  };
};

type RenderedRule = MatchedStylesSnapshot["matchedRules"][number];

function rulesOf(snapshot: MatchedStylesSnapshot | undefined): RenderedRule[] {
  if (!snapshot) return [];
  return [
    ...(snapshot.inlineStyle ? [snapshot.inlineStyle] : []),
    ...snapshot.matchedRules,
    ...snapshot.inherited.flatMap((inherited) => [
      ...(inherited.inlineStyle ? [inherited.inlineStyle] : []),
      ...inherited.matchedRules,
    ]),
  ];
}

function generatedLabelOf(rule: RenderedRule): string | undefined {
  const source = rule.generatedSource;
  if (!source) return undefined;
  return source.lineNumber === undefined
    ? source.label
    : source.columnNumber === undefined
      ? `${source.label}:${source.lineNumber}`
      : `${source.label}:${source.lineNumber}:${source.columnNumber}`;
}
