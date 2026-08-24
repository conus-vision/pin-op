import type {
  InspectorNodeSnapshot,
  RulesPresentationSnapshot,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "../../src/contracts.js";

const rowDefaults = {
  expanded: false,
  expandable: false,
  selected: false,
  focused: false,
  hovered: false,
} as const;

const tree: TreePresentationSnapshot = {
  rows: [
    nodeRow("doctype", 0, {
      kind: "document-type",
      nodeType: 10,
      nodeName: "html",
      publicId: "-//W3C//DTD HTML 4.01//EN",
      systemId: "https://www.w3.org/TR/html4/strict.dtd",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
      branchRevision: 0,
    }),
    nodeRow("html", 0, {
      kind: "element",
      nodeType: 1,
      nodeName: "HTML",
      attributes: [{ name: "lang", value: "en" }],
      childCount: 1,
      relationship: "dom",
      selectable: true,
      expandable: true,
      branchRevision: 1,
    }, { expanded: true, expandable: true }),
    nodeRow("body", 1, {
      kind: "element",
      nodeType: 1,
      nodeName: "BODY",
      attributes: [{ name: "class", value: "fixture" }],
      childCount: 5,
      relationship: "dom",
      selectable: true,
      expandable: true,
      branchRevision: 2,
    }, { expanded: true, expandable: true, selected: true, focused: true }),
    nodeRow("intro-text", 2, {
      kind: "text",
      nodeType: 3,
      nodeName: "#text",
      nodeValue: "Hello <img src=x onerror=alert(1)>",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
      branchRevision: 0,
    }, { parentRef: "body" }),
    nodeRow("comment", 2, {
      kind: "comment",
      nodeType: 8,
      nodeName: "#comment",
      nodeValue: "fixture comment",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
      branchRevision: 0,
    }, { parentRef: "body" }),
    nodeRow("lazy-main", 2, {
      kind: "element",
      nodeType: 1,
      nodeName: "MAIN",
      attributes: [{ name: "data-state", value: "lazy" }],
      childCount: 128,
      relationship: "dom",
      selectable: true,
      expandable: true,
      branchRevision: 3,
    }, { parentRef: "body", expanded: true, expandable: true }),
    {
      ...rowDefaults,
      type: "load-more",
      nodeRef: "load-more:lazy-main",
      parentRef: "lazy-main",
      depth: 3,
    },
    nodeRow("shadow-host", 2, {
      kind: "element",
      nodeType: 1,
      nodeName: "DIV",
      attributes: [{ name: "id", value: "shadow-host" }],
      childCount: 1,
      relationship: "dom",
      selectable: true,
      expandable: true,
      branchRevision: 4,
    }, { parentRef: "body", expanded: true, expandable: true }),
    nodeRow("shadow-root", 3, {
      kind: "shadow-root",
      nodeType: 11,
      nodeName: "#shadow-root",
      nodeValue: "open",
      attributes: [],
      childCount: 1,
      relationship: "shadow-root",
      selectable: false,
      expandable: true,
      branchRevision: 5,
    }, { parentRef: "shadow-host", expanded: true, expandable: true }),
    nodeRow("shadow-button", 4, {
      kind: "element",
      nodeType: 1,
      nodeName: "BUTTON",
      attributes: [{ name: "type", value: "button" }],
      childCount: 0,
      relationship: "dom",
      selectable: true,
      expandable: false,
      branchRevision: 0,
    }, { parentRef: "shadow-root" }),
    nodeRow("frame", 2, {
      kind: "element",
      nodeType: 1,
      nodeName: "IFRAME",
      attributes: [{ name: "src", value: "https://cross-origin.example/" }],
      childCount: 1,
      relationship: "dom",
      selectable: true,
      expandable: true,
      branchRevision: 6,
    }, { parentRef: "body", expanded: true, expandable: true }),
    nodeRow("inaccessible-frame-document", 3, {
      kind: "frame-document",
      nodeType: 9,
      nodeName: "#document",
      attributes: [],
      childCount: 0,
      relationship: "frame-document",
      selectable: false,
      expandable: false,
      inaccessible: true,
      branchRevision: 0,
    }, { parentRef: "frame" }),
    nodeRow("epilogue-comment", 0, {
      kind: "comment",
      nodeType: 8,
      nodeName: "#comment",
      nodeValue: "after html",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
      branchRevision: 0,
    }),
  ],
};

const rules: RulesPresentationSnapshot = deepFreeze({
  state: "ready",
  matchedStyles: {
    documentEpoch: 1,
    selectionRevision: 7,
    stylesRevision: 11,
    stylesheetRevision: 4,
    nodeRef: "body",
    inlineStyle: {
      ruleRef: "rule:inline:body",
      selectorText: "element.style",
      matchingSelectorIndices: [],
      declarations: [
        {
          declarationRef: "declaration:inline:display",
          name: "display",
          value: "block",
          important: false,
          state: "winning-known-author",
        },
      ],
      contexts: [],
    },
    matchedRules: [
      {
        ruleRef: "rule:app:17",
        selectorText: "body.fixture, .fixture",
        matchingSelectorIndices: [0, 1],
        declarations: [
          {
            declarationRef: "declaration:app:color",
            name: "color",
            value: "rebeccapurple",
            important: false,
            state: "winning-known-author",
          },
          {
            declarationRef: "declaration:app:margin",
            name: "margin",
            value: "0",
            important: false,
            state: "overridden-known-author",
            stateReason: "Overridden by a later declaration",
          },
        ],
        contexts: [
          {
            kind: "media",
            text: "(width >= 40rem)",
          },
        ],
        generatedSource: {
          label: "app.css",
          lineNumber: 17,
          columnNumber: 5,
        },
      },
    ],
    inherited: [
      {
        nodeRef: "html",
        matchedRules: [
          {
            ruleRef: "rule:base:2",
            selectorText: "html",
            matchingSelectorIndices: [0],
            declarations: [
              {
                declarationRef: "declaration:base:font-family",
                name: "font-family",
                value: "system-ui",
                important: false,
                state: "winning-known-author",
              },
            ],
            contexts: [],
            generatedSource: {
              label: "base.css",
              lineNumber: 2,
              columnNumber: 1,
            },
          },
        ],
      },
    ],
    inaccessibleStylesheetCount: 0,
    omittedRuleCount: 0,
    diagnostics: [],
  },
});

export const elementsSession: {
  readonly tree: TreePresentationSnapshot;
  readonly rules: RulesPresentationSnapshot;
} = Object.freeze({
  tree,
  rules,
});

export function withTextValue(value: string): TreePresentationSnapshot {
  return {
    rows: elementsSession.tree.rows.map((row) => (
      row.nodeRef === "intro-text" && row.node
        ? { ...row, node: { ...row.node, nodeValue: value } }
        : row
    )),
  };
}

function nodeRow(
  nodeRef: string,
  depth: number,
  node: Omit<InspectorNodeSnapshot, "nodeRef">,
  overrides: Partial<TreeRowSnapshot> = {},
): TreeRowSnapshot {
  return {
    ...rowDefaults,
    type: "node",
    nodeRef,
    depth,
    node: { ...node, nodeRef },
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
