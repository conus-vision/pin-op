import type {
  CreateElementsRulesRenderer,
  CreateElementsTreeRenderer,
  ElementsRulesRendererHost,
  ElementsTreeRendererHost,
  PseudoStateDataSource,
  RulesDataSource,
  RulesPresentationSnapshot,
  SourceLinkDelegate,
  TreeDataSource,
} from "./contracts.js";

const nextAriaIdSequence = new WeakMap<Document, number>();

export class ElementsInspectorShell {
  public readonly element: HTMLElement;
  public readonly domRoot: HTMLElement;
  public readonly rulesRoot: HTMLElement;
  public readonly sidebarExtensionMount: HTMLElement;
  private readonly rulesTab: HTMLElement;
  private readonly sourceTab: HTMLElement;
  private treeRendererHost: ElementsTreeRendererHost | undefined;
  private rulesDataSource: RulesDataSource | undefined;
  private rulesPane: ElementsRulesRendererHost | undefined;
  private rulesMessage: HTMLElement | undefined;
  private unsubscribeRules: (() => void) | undefined;
  private rulesRenderRevision = 0;
  private disposed = false;

  private readonly showRules = (): void => {
    this.selectSidebarTab("rules");
  };

  private readonly showSource = (): void => {
    this.selectSidebarTab("source");
  };

  public constructor(
    private readonly document: Document,
    mount: HTMLElement,
    treeDataSource: TreeDataSource,
    rulesDataSource: RulesDataSource | undefined,
    sourceLinkDelegate: SourceLinkDelegate | undefined,
    pseudoStateDataSource: PseudoStateDataSource | undefined,
    createTreeRenderer: CreateElementsTreeRenderer,
    private readonly createRulesRenderer: CreateElementsRulesRenderer,
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
    this.rulesTab = this.createElement("button", {
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
    this.sourceTab = this.createElement("button", {
      className: "pin-op-elements-inspector__tab",
      text: "Source",
      attributes: {
        "aria-controls": ariaIds.sourcePanel,
        "aria-selected": "false",
        id: ariaIds.sourceTab,
        role: "tab",
        tabindex: "-1",
        type: "button",
      },
    });
    this.rulesTab.addEventListener("click", this.showRules);
    this.sourceTab.addEventListener("click", this.showSource);
    tabList.append(this.rulesTab, this.sourceTab);

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
        "aria-labelledby": ariaIds.sourceTab,
        "data-part": "sidebar-extension",
        id: ariaIds.sourcePanel,
        role: "tabpanel",
      },
    });
    this.sidebarExtensionMount.hidden = true;
    sidebar.append(tabList, this.rulesRoot, this.sidebarExtensionMount);
    this.element.append(this.domRoot, sidebar);

    try {
      this.treeRendererHost = createTreeRenderer(
        document,
        this.domRoot,
        treeDataSource,
      );
      if (rulesDataSource) {
        this.bindRulesDataSource(
          rulesDataSource,
          sourceLinkDelegate,
          pseudoStateDataSource,
        );
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
    pseudoStateDataSource?: PseudoStateDataSource,
  ): void {
    if (this.disposed) throw new Error("Elements Inspector is disposed");
    if (this.rulesDataSource || this.rulesPane || this.unsubscribeRules) {
      throw new Error("Rules data source is already bound");
    }
    const rulesMessage = this.createRulesMessage();
    this.rulesRoot.append(rulesMessage);
    let rulesPane: ElementsRulesRendererHost;
    try {
      rulesPane = this.createRulesRenderer(
        this.document,
        this.rulesRoot,
        dataSource,
        sourceLinkDelegate,
        pseudoStateDataSource,
      );
    } catch (error) {
      this.rulesRoot.replaceChildren();
      throw error;
    }
    let unsubscribe: (() => void) | undefined;
    try {
      let notificationsEnabled = false;
      unsubscribe = dataSource.subscribe(() => {
        if (notificationsEnabled) this.renderRules();
      });
      this.rulesDataSource = dataSource;
      this.rulesPane = rulesPane;
      this.rulesMessage = rulesMessage;
      this.unsubscribeRules = unsubscribe;
      notificationsEnabled = true;
      this.renderRules();
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        rulesPane.dispose();
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      this.rulesRoot.replaceChildren();
      this.rulesDataSource = undefined;
      this.rulesPane = undefined;
      this.rulesMessage = undefined;
      this.unsubscribeRules = undefined;
      this.renderRules();
      if (failures.length > 1) {
        throw new AggregateError(failures, "Rules binding and teardown failed");
      }
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rulesTab.removeEventListener("click", this.showRules);
    this.sourceTab.removeEventListener("click", this.showSource);
    let disposeError: unknown;
    const unsubscribeRules = this.unsubscribeRules;
    this.unsubscribeRules = undefined;
    this.rulesDataSource = undefined;
    try {
      unsubscribeRules?.();
    } catch (error) {
      disposeError = error;
    }
    const treeRendererHost = this.treeRendererHost;
    this.treeRendererHost = undefined;
    try {
      treeRendererHost?.dispose();
    } catch (error) {
      disposeError ??= error;
    }
    const rulesPane = this.rulesPane;
    this.rulesPane = undefined;
    this.rulesMessage = undefined;
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
    const rulesPane = this.rulesPane;
    if (!rulesPane) return;

    let messageText: string | undefined;
    let messageRole: "alert" | "status" = "status";
    if (snapshot.state === "loading") {
      rulesPane.clear();
      messageText = "Loading styles";
    } else if (snapshot.state === "partial") {
      rulesPane.render(snapshot.matchedStyles);
      messageText = "Some styles could not be inspected";
    } else if (snapshot.state === "ready") {
      rulesPane.render(snapshot.matchedStyles);
    } else if (snapshot.state === "error") {
      rulesPane.clear();
      messageText = snapshot.message;
      messageRole = "alert";
    } else {
      rulesPane.clear();
    }
    if (this.disposed || revision !== this.rulesRenderRevision) return;
    this.updateRulesMessage(messageText, messageRole);
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
    this.rulesRoot.setAttribute(
      "data-pseudo-state-revision",
      String(styles.pseudoStateRevision),
    );
    this.rulesRoot.setAttribute(
      "data-pseudo-states",
      styles.pseudoStates.join(" "),
    );
    const ruleRef = primaryRuleRef(styles);
    if (ruleRef) this.rulesRoot.setAttribute("data-probe-rule-ref", ruleRef);
  }

  private createRulesMessage(): HTMLElement {
    const message = this.createElement("p", {
      className: "pin-op-elements-inspector__rules-message",
      attributes: {
        "data-part": "rules-message",
      },
    });
    message.hidden = true;
    return message;
  }

  private updateRulesMessage(
    text?: string,
    role: "alert" | "status" = "status",
  ): void {
    const message = this.rulesMessage;
    if (!message) return;
    message.textContent = text ?? "";
    message.hidden = text === undefined;
    if (text === undefined) {
      message.removeAttribute("role");
    } else {
      message.setAttribute("role", role);
    }
  }

  private selectSidebarTab(tab: "rules" | "source"): void {
    if (this.disposed) return;
    const rulesSelected = tab === "rules";
    this.rulesTab.setAttribute("aria-selected", String(rulesSelected));
    this.rulesTab.setAttribute("tabindex", rulesSelected ? "0" : "-1");
    this.sourceTab.setAttribute("aria-selected", String(!rulesSelected));
    this.sourceTab.setAttribute("tabindex", rulesSelected ? "-1" : "0");
    this.rulesRoot.hidden = !rulesSelected;
    this.rulesRoot.setAttribute("aria-hidden", String(!rulesSelected));
    this.sidebarExtensionMount.hidden = rulesSelected;
    this.sidebarExtensionMount.setAttribute(
      "aria-hidden",
      String(rulesSelected),
    );
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
  "data-pseudo-state-revision",
  "data-pseudo-states",
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
  readonly sourceTab: string;
  readonly sourcePanel: string;
}

function allocateAriaIds(document: Document): InspectorAriaIds {
  let sequence = nextAriaIdSequence.get(document) ?? 1;
  while (true) {
    const suffix = sequence === 1 ? "" : `-${sequence}`;
    const ids = {
      domTitle: `pin-op-elements-dom-title${suffix}`,
      rulesTab: `pin-op-elements-rules-tab${suffix}`,
      rulesPanel: `pin-op-elements-rules-panel${suffix}`,
      sourceTab: `pin-op-elements-source-tab${suffix}`,
      sourcePanel: `pin-op-elements-source-panel${suffix}`,
    };
    if (Object.values(ids).every((id) => document.getElementById(id) === null)) {
      nextAriaIdSequence.set(document, sequence + 1);
      return ids;
    }
    sequence += 1;
  }
}
