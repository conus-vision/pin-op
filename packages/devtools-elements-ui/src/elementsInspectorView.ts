import { ElementsTreeOutline } from "./chromium/dom/ElementsTreeOutline.js";
import { StylesSidebarPane } from "./chromium/rules/StylesSidebarPane.js";
import type {
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
  TreeDataSource,
} from "./contracts.js";

const nextAriaIdSequence = new WeakMap<Document, number>();

export class ElementsInspectorView {
  public readonly element: HTMLElement;
  public readonly domRoot: HTMLElement;
  public readonly rulesRoot: HTMLElement;
  public readonly sidebarExtensionMount: HTMLElement;
  private readonly treeOutline: ElementsTreeOutline;
  private rulesDataSource: RulesDataSource | undefined;
  private rulesPane: StylesSidebarPane | undefined;
  private unsubscribeRules: (() => void) | undefined;
  private rulesRenderRevision = 0;
  private disposed = false;

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    treeDataSource: TreeDataSource,
    rulesDataSource?: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
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
    this.domRoot.append(domTitle);

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
        "aria-readonly": "true",
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

    this.treeOutline = new ElementsTreeOutline(
      document,
      this.domRoot,
      treeDataSource,
    );
    try {
      if (rulesDataSource) {
        this.bindRulesDataSource(rulesDataSource, sourceLinkDelegate);
      } else {
        this.renderRules();
      }
      mount.append(this.element);
    } catch (error) {
      try {
        this.dispose();
      } catch {
        // Preserve the constructor failure that prevented the view from mounting.
      }
      throw error;
    }
  }

  public bindRulesDataSource(
    dataSource: RulesDataSource,
    sourceLinkDelegate?: SourceLinkDelegate,
  ): void {
    if (this.disposed) throw new Error("Elements Inspector is disposed");
    if (this.rulesDataSource || this.rulesPane || this.unsubscribeRules) {
      throw new Error("Rules data source is already bound");
    }
    const rulesPane = new StylesSidebarPane(
      this.document,
      dataSource,
      sourceLinkDelegate,
    );
    let unsubscribe: (() => void) | undefined;
    try {
      let notificationsEnabled = false;
      unsubscribe = dataSource.subscribe(() => {
        if (notificationsEnabled) this.renderRules();
      });
      this.rulesDataSource = dataSource;
      this.rulesPane = rulesPane;
      this.unsubscribeRules = unsubscribe;
      notificationsEnabled = true;
      this.renderRules();
    } catch (error) {
      try {
        unsubscribe?.();
      } catch {
        // Preserve the binding failure.
      }
      rulesPane.dispose();
      this.rulesDataSource = undefined;
      this.rulesPane = undefined;
      this.unsubscribeRules = undefined;
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    let disposeError: unknown;
    const unsubscribeRules = this.unsubscribeRules;
    this.unsubscribeRules = undefined;
    this.rulesDataSource = undefined;
    try {
      unsubscribeRules?.();
    } catch (error) {
      disposeError = error;
    }
    try {
      this.treeOutline.dispose();
    } catch (error) {
      disposeError ??= error;
    }
    const rulesPane = this.rulesPane;
    this.rulesPane = undefined;
    try {
      rulesPane?.dispose();
    } catch (error) {
      disposeError ??= error;
    } finally {
      this.element.remove();
    }
    if (disposeError !== undefined) throw disposeError;
  }

  private renderRules(): void {
    if (this.disposed) return;
    const revision = ++this.rulesRenderRevision;
    const snapshot = this.rulesDataSource?.snapshot() ?? EMPTY_RULES_SNAPSHOT;
    if (this.disposed || revision !== this.rulesRenderRevision) return;

    this.rulesRoot.setAttribute("data-state", snapshot.state);
    this.rulesRoot.setAttribute(
      "aria-busy",
      snapshot.state === "loading" ? "true" : "false",
    );
    this.renderRulesProbe(snapshot);
    this.rulesRoot.replaceChildren();

    if (snapshot.state === "loading") {
      this.rulesRoot.append(this.createRulesMessage("Loading styles", "status"));
    } else if (snapshot.state === "partial") {
      this.rulesRoot.append(this.createRulesMessage(
        "Some styles could not be inspected",
        "status",
      ));
      this.renderMatchedStyles(snapshot.matchedStyles);
    } else if (snapshot.state === "ready") {
      this.renderMatchedStyles(snapshot.matchedStyles);
    } else if (snapshot.state === "error") {
      this.rulesRoot.append(this.createRulesMessage(snapshot.message, "alert"));
    }
  }

  private renderRulesProbe(snapshot: RulesPresentationSnapshot): void {
    for (const attribute of RULES_PROBE_ATTRIBUTES) {
      this.rulesRoot.removeAttribute(attribute);
    }
    if (snapshot.state !== "ready" && snapshot.state !== "partial") return;
    const styles = snapshot.matchedStyles;
    this.rulesRoot.setAttribute(
      "data-document-epoch",
      String(styles.documentEpoch),
    );
    this.rulesRoot.setAttribute(
      "data-selection-revision",
      String(styles.selectionRevision),
    );
    this.rulesRoot.setAttribute(
      "data-styles-revision",
      String(styles.stylesRevision),
    );
    this.rulesRoot.setAttribute(
      "data-stylesheet-revision",
      String(styles.stylesheetRevision),
    );
    const ruleRef = primaryRuleRef(styles);
    if (ruleRef) this.rulesRoot.setAttribute("data-probe-rule-ref", ruleRef);
  }

  private renderMatchedStyles(
    snapshot: Extract<
      RulesPresentationSnapshot,
      { readonly state: "ready" | "partial" }
    >["matchedStyles"],
  ): void {
    const rulesPane = this.rulesPane;
    if (!rulesPane || this.disposed) return;
    rulesPane.render(snapshot);
    if (!this.disposed) this.rulesRoot.append(rulesPane.element);
  }

  private createRulesMessage(
    text: string,
    role: "alert" | "status",
  ): HTMLElement {
    return this.createElement("p", {
      className: "pin-op-elements-inspector__rules-message",
      text,
      attributes: {
        "data-part": "rules-message",
        role,
      },
    });
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

const EMPTY_RULES_SNAPSHOT: RulesPresentationSnapshot = Object.freeze({
  state: "empty",
});

const RULES_PROBE_ATTRIBUTES = Object.freeze([
  "data-document-epoch",
  "data-selection-revision",
  "data-styles-revision",
  "data-stylesheet-revision",
  "data-probe-rule-ref",
]);

function primaryRuleRef(
  styles: Extract<
    RulesPresentationSnapshot,
    { readonly state: "ready" | "partial" }
  >["matchedStyles"],
): string | undefined {
  const matched = styles.matchedRules[0]?.ruleRef;
  if (matched) return matched;
  if (styles.inlineStyle) return styles.inlineStyle.ruleRef;
  for (const inherited of styles.inherited) {
    if (inherited.matchedRules[0]) return inherited.matchedRules[0].ruleRef;
    if (inherited.inlineStyle) return inherited.inlineStyle.ruleRef;
  }
  return undefined;
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
