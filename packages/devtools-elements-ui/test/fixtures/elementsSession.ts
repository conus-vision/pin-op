import type {
  InspectorNodeSnapshot,
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

export const elementsSession: {
  readonly tree: TreePresentationSnapshot;
  readonly rules: readonly never[];
} = {
  tree,
  rules: [],
};

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
