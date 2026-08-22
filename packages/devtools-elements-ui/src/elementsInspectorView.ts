import type { TreeDataSource, TreeRowSnapshot } from "./contracts.js";

const nextAriaIdSequence = new WeakMap<Document, number>();

export class ElementsInspectorView {
  public readonly element: HTMLElement;
  public readonly domRoot: HTMLElement;
  public readonly rulesRoot: HTMLElement;
  public readonly sidebarExtensionMount: HTMLElement;
  private readonly rowsRoot: HTMLElement;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;
  private renderGeneration = 0;

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    private readonly treeDataSource: TreeDataSource,
  ) {
    const ariaIds = allocateAriaIds(document);
    this.element = this.createElement("section", {
      className: "pin-op-elements-inspector",
      attributes: {
        "aria-label": "Elements inspector",
        "data-part": "inspector-workspace",
      },
    });

    this.domRoot = this.createElement("section", {
      className: "pin-op-elements-inspector__dom-pane",
      attributes: {
        "aria-labelledby": ariaIds.domTitle,
        "data-pane": "dom",
      },
    });
    const domTitle = this.createElement("h2", {
      className: "pin-op-elements-inspector__pane-title",
      text: "DOM",
      attributes: {
        "data-part": "pane-title",
        id: ariaIds.domTitle,
      },
    });
    this.rowsRoot = this.createElement("div", {
      className: "pin-op-elements-inspector__tree",
      attributes: {
        "aria-label": "DOM tree",
        "data-part": "dom-rows",
        role: "tree",
      },
    });
    this.domRoot.append(domTitle, this.rowsRoot);

    const sidebar = this.createElement("aside", {
      className: "pin-op-elements-inspector__sidebar",
      attributes: {
        "aria-label": "Element details",
        "data-pane": "sidebar",
      },
    });
    const tabList = this.createElement("div", {
      className: "pin-op-elements-inspector__tabs",
      attributes: {
        "aria-label": "Element details",
        role: "tablist",
      },
    });
    const rulesTab = this.createElement("button", {
      className: "pin-op-elements-inspector__tab",
      text: "Rules",
      attributes: {
        "aria-controls": ariaIds.rulesPanel,
        "aria-selected": "true",
        id: ariaIds.rulesTab,
        role: "tab",
        type: "button",
      },
    });
    tabList.append(rulesTab);

    this.rulesRoot = this.createElement("section", {
      className: "pin-op-elements-inspector__rules",
      attributes: {
        "aria-labelledby": ariaIds.rulesTab,
        "data-pane": "rules",
        id: ariaIds.rulesPanel,
        role: "tabpanel",
      },
    });
    this.sidebarExtensionMount = this.createElement("div", {
      className: "pin-op-elements-inspector__sidebar-extension",
      attributes: {
        "aria-hidden": "true",
        "data-part": "sidebar-extension",
      },
    });
    this.sidebarExtensionMount.hidden = true;
    sidebar.append(tabList, this.rulesRoot, this.sidebarExtensionMount);
    this.element.append(this.domRoot, sidebar);

    this.unsubscribe = this.treeDataSource.subscribe(() => this.renderRows());
    try {
      this.renderRows();
      mount.append(this.element);
    } catch (error) {
      this.unsubscribe();
      this.unsubscribe = undefined;
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderGeneration += 1;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    try {
      unsubscribe?.();
    } finally {
      this.element.remove();
    }
  }

  private renderRows(): void {
    if (this.disposed) return;
    const generation = ++this.renderGeneration;
    const rows = this.treeDataSource.snapshot().rows.map((row) => (
      this.renderRow(row)
    ));
    if (this.disposed || generation !== this.renderGeneration) return;
    this.rowsRoot.replaceChildren(...rows);
  }

  private renderRow(row: TreeRowSnapshot): HTMLElement {
    const element = this.createElement("div", {
      className: "pin-op-elements-inspector__tree-row",
      attributes: {
        "aria-level": String(row.depth + 1),
        "data-depth": String(row.depth),
        "data-node-ref": row.nodeRef,
        "data-row-type": row.type,
        role: row.type === "node" ? "treeitem" : "status",
      },
    });
    if (row.type === "load-more") {
      element.textContent = "Load more";
      return element;
    }

    element.setAttribute("aria-selected", String(row.selected));
    if (row.expandable) {
      element.setAttribute("aria-expanded", String(row.expanded));
    }
    if (row.focused) element.setAttribute("data-focused", "true");
    if (row.hovered) element.setAttribute("data-hovered", "true");
    element.textContent = row.node?.nodeValue ?? row.node?.nodeName ?? row.nodeRef;
    return element;
  }

  private createElement(
    tagName: string,
    options: {
      readonly attributes?: Readonly<Record<string, string>>;
      readonly className?: string;
      readonly text?: string;
    } = {},
  ): HTMLElement {
    const element = this.document.createElement(tagName);
    if (options.className) element.className = options.className;
    for (const [name, value] of Object.entries(options.attributes ?? {})) {
      element.setAttribute(name, value);
    }
    if (options.text !== undefined) element.textContent = options.text;
    return element;
  }
}

interface InspectorAriaIds {
  readonly domTitle: string;
  readonly rulesTab: string;
  readonly rulesPanel: string;
}

function allocateAriaIds(document: Document): InspectorAriaIds {
  let sequence = nextAriaIdSequence.get(document) ?? 1;
  while (true) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const ids = {
      domTitle: `pin-op-elements-dom-title${suffix}`,
      rulesTab: `pin-op-elements-rules-tab${suffix}`,
      rulesPanel: `pin-op-elements-rules-panel${suffix}`,
    };
    if (Object.values(ids).every((id) => document.getElementById(id) === null)) {
      nextAriaIdSequence.set(document, sequence + 1);
      return ids;
    }
    sequence += 1;
  }
}
