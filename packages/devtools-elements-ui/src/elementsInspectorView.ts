import type { TreeDataSource, TreeRowSnapshot } from "./contracts.js";

const RULES_TAB_ID = "pin-op-elements-rules-tab";
const RULES_PANEL_ID = "pin-op-elements-rules-panel";

export class ElementsInspectorView {
  public readonly element: HTMLElement;
  public readonly domRoot: HTMLElement;
  public readonly rulesRoot: HTMLElement;
  public readonly sidebarExtensionMount: HTMLElement;
  private readonly rowsRoot: HTMLElement;
  private unsubscribe: (() => void) | undefined;
  private disposed = false;

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    private readonly treeDataSource: TreeDataSource,
  ) {
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
        "aria-labelledby": "pin-op-elements-dom-title",
        "data-pane": "dom",
      },
    });
    const domTitle = this.createElement("h2", {
      className: "pin-op-elements-inspector__pane-title",
      text: "DOM",
      attributes: {
        "data-part": "pane-title",
        id: "pin-op-elements-dom-title",
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
        "aria-controls": RULES_PANEL_ID,
        "aria-selected": "true",
        id: RULES_TAB_ID,
        role: "tab",
        type: "button",
      },
    });
    tabList.append(rulesTab);

    this.rulesRoot = this.createElement("section", {
      className: "pin-op-elements-inspector__rules",
      attributes: {
        "aria-labelledby": RULES_TAB_ID,
        "data-pane": "rules",
        id: RULES_PANEL_ID,
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
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.element.remove();
  }

  private renderRows(): void {
    if (this.disposed) return;
    const rows = this.treeDataSource.snapshot().rows.map((row) => (
      this.renderRow(row)
    ));
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
