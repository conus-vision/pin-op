import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "@pin-op/protocol";
import {
  DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
  DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  DOM_PROTOCOL_MAX_LABEL_LENGTH,
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  DOM_PROTOCOL_MAX_SUMMARY_LENGTH,
  DomProtocolError,
  boundDomNodeViewPathForEnvelope,
  parseDomEvent,
  parseDomRequest,
  parseDomResponse,
} from "../src/domProtocol.js";

describe("DOM protocol", () => {
  it("parses a paginated children request", () => {
    const parsed = parseDomRequest({
      type: "dom.getChildren",
      requestId: "request-1",
      documentEpoch: 7,
      nodeRef: "node-1",
      branchRevision: 2,
      cursor: "page-2",
    });

    expect(parsed).toEqual({
      type: "dom.getChildren",
      requestId: "request-1",
      documentEpoch: 7,
      nodeRef: "node-1",
      branchRevision: 2,
      cursor: "page-2",
    });
  });

  it("parses a root request without an epoch", () => {
    expect(
      parseDomRequest({ type: "dom.getRoot", requestId: "request-1" }),
    ).toEqual({ type: "dom.getRoot", requestId: "request-1" });
  });

  it("parses every request form", () => {
    expect(parseDomRequest({
      type: "dom.select",
      documentEpoch: 1,
      nodeRef: "node-1",
    })).toEqual({ type: "dom.select", documentEpoch: 1, nodeRef: "node-1" });
    expect(parseDomRequest({
      type: "dom.hover",
      documentEpoch: 1,
      nodeRef: "node-1",
    })).toEqual({ type: "dom.hover", documentEpoch: 1, nodeRef: "node-1" });
    expect(parseDomRequest({ type: "dom.clearHover", documentEpoch: 1 })).toEqual({
      type: "dom.clearHover",
      documentEpoch: 1,
    });
  });

  it("parses a stable locator request", () => {
    const locator = stableLocator({
      path: [pathSegment({
        tagName: "button",
        siblingIndex: 2,
        id: "save",
        classes: ["action", "primary"],
        attributes: [
          { name: "aria-label", value: "Save" },
          { name: "data-state", value: "ready" },
          { name: "role", value: "button" },
        ],
      })],
    });

    expect(parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-1",
      locator,
    })).toEqual({
      type: "dom.resolveLocator",
      requestId: "locator-1",
      locator,
    });
  });

  it("parses nested open-shadow and frame locator boundaries", () => {
    const locator = stableLocator({
      boundaries: [
        {
          kind: "shadow-root",
          hostPath: [
            pathSegment({ tagName: "html" }),
            pathSegment({ tagName: "body" }),
            pathSegment({ tagName: "app-shell", id: "shell" }),
          ],
        },
        {
          kind: "frame-document",
          hostPath: [pathSegment({
            tagName: "iframe",
            attributes: [{ name: "data-frame", value: "editor" }],
          })],
        },
      ],
      path: [
        pathSegment({ tagName: "main" }),
        pathSegment({
          tagName: "input",
          siblingIndex: 1,
          classes: ["field"],
          attributes: [{ name: "role", value: "textbox" }],
        }),
      ],
    });

    const parsed = parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-nested",
      locator,
    });

    expect(parsed).toEqual({
      type: "dom.resolveLocator",
      requestId: "locator-nested",
      locator,
    });
    if (parsed.type !== "dom.resolveLocator") {
      throw new Error("Expected a locator request");
    }
    expect(Object.isFrozen(parsed.locator)).toBe(true);
    expect(Object.isFrozen(parsed.locator.boundaries)).toBe(true);
    expect(Object.isFrozen(parsed.locator.boundaries[0])).toBe(true);
    expect(Object.isFrozen(parsed.locator.boundaries[0]?.hostPath)).toBe(true);
    expect(Object.isFrozen(parsed.locator.boundaries[0]?.hostPath[0])).toBe(true);
    expect(Object.isFrozen(parsed.locator.path)).toBe(true);
    expect(Object.isFrozen(parsed.locator.path[1])).toBe(true);
    expect(Object.isFrozen(parsed.locator.path[1]?.classes)).toBe(true);
    expect(Object.isFrozen(parsed.locator.path[1]?.attributes)).toBe(true);
  });

  it("parses every response form", () => {
    const node = nodeView();
    const prologue = [displayNodeView("document-type", {
      nodeName: "html",
      publicId: "-//W3C//DTD XHTML 1.0 Strict//EN",
      systemId: "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd",
      label: "<!DOCTYPE html>",
    })];
    const epilogue = [displayNodeView("comment", {
      nodeValue: "after html",
      label: "<!--after html-->",
    })];

    expect(parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node,
      prologue,
      epilogue,
    })).toEqual({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node,
      prologue,
      epilogue,
    });
    expect(parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 2,
      nodes: [node],
      nextCursor: "page-2",
    })).toEqual({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 2,
      nodes: [node],
      nextCursor: "page-2",
    });
    expect(parseDomResponse({
      type: "dom.error",
      requestId: "request-1",
      documentEpoch: 1,
      code: "unknown-node",
    })).toEqual({
      type: "dom.error",
      requestId: "request-1",
      documentEpoch: 1,
      code: "unknown-node",
    });
  });

  it("parses structured element and display-only node snapshots", () => {
    const element = nodeView({
      nodeName: "BUTTON",
      attributes: [
        { name: "type", value: "button" },
        { name: "aria-label", value: "Save" },
      ],
      childCount: 2,
    });
    const text = displayNodeView("text", { nodeValue: "Save", label: "Save" });
    const comment = displayNodeView("comment", {
      nodeValue: "marker",
      label: "<!--marker-->",
    });

    const parsed = parseDomResponse({
      type: "dom.children",
      requestId: "structured",
      documentEpoch: 1,
      nodeRef: "parent",
      branchRevision: 1,
      nodes: [element, text, comment],
    });

    expect(parsed).toMatchObject({ nodes: [element, text, comment] });
    if (parsed.type !== "dom.children") throw new Error("Expected children");
    expect(Object.isFrozen(parsed.nodes[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.attributes[0])).toBe(true);
  });

  it("rejects unknown structured keys and kind-dependent fields", () => {
    const invalidNodes = [
      { ...nodeView(), unknownStructuredField: true },
      { ...nodeView(), publicId: "not-a-doctype" },
      { ...nodeView(), systemId: "not-a-doctype" },
      { ...nodeView(), nodeValue: "not-character-data" },
      { ...displayNodeView("text"), locator: stableLocator() },
      { ...displayNodeView("comment"), attributes: [{ name: "x", value: "y" }] },
      { ...displayNodeView("document-type"), selectable: true },
      { ...displayNodeView("text"), expandable: true },
      { ...displayNodeView("comment"), relationship: "shadow-root" },
      { ...nodeView(), nodeType: 3 },
    ];

    for (const node of invalidNodes) {
      expect(() => parseDomResponse({
        type: "dom.children",
        requestId: "invalid-structured",
        documentEpoch: 1,
        nodeRef: "parent",
        branchRevision: 1,
        nodes: [node],
      })).toThrow(DomProtocolError);
    }
  });

  it("enforces structured attribute, value, count, and auxiliary-row limits", () => {
    const invalidNodes = [
      nodeView({ attributes: Array.from({ length: 65 }, (_, index) => ({
        name: `data-${index}`,
        value: "x",
      })) }),
      nodeView({ attributes: [{ name: "n".repeat(257), value: "x" }] }),
      nodeView({ attributes: [{ name: "data-value", value: "x".repeat(16_385) }] }),
      nodeView({ childCount: Number.MAX_SAFE_INTEGER + 1 }),
      displayNodeView("text", { nodeValue: "x".repeat(16_385) }),
      displayNodeView("document-type", { publicId: "x".repeat(4_097) }),
      displayNodeView("document-type", { systemId: "x".repeat(4_097) }),
    ];
    for (const node of invalidNodes) {
      expect(() => parseDomResponse({
        type: "dom.children",
        requestId: "bounded-structured",
        documentEpoch: 1,
        nodeRef: "parent",
        branchRevision: 1,
        nodes: [node],
      })).toThrow(DomProtocolError);
    }

    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "too-many-auxiliary-rows",
      documentEpoch: 1,
      node: nodeView(),
      prologue: Array.from({ length: 33 }, () => displayNodeView("comment")),
      epilogue: [],
    })).toThrow(DomProtocolError);
  });

  it("parses a correlated locator response with fresh ancestor views", () => {
    const node = nodeView({ nodeRef: "node-target", label: "button#save" });
    const ancestorPath = [
      nodeView({ nodeRef: "node-root", label: "html" }),
      node,
    ];

    expect(parseDomResponse({
      type: "dom.locator",
      requestId: "locator-1",
      documentEpoch: 2,
      node,
      ancestorPath,
    })).toEqual({
      type: "dom.locator",
      requestId: "locator-1",
      documentEpoch: 2,
      node,
      ancestorPath,
    });
    expect(parseDomResponse({
      type: "dom.error",
      requestId: "locator-1",
      documentEpoch: 2,
      code: "node-unavailable",
    })).toEqual({
      type: "dom.error",
      requestId: "locator-1",
      documentEpoch: 2,
      code: "node-unavailable",
    });
  });

  it("accepts optional locators on stable views while display views reject them", () => {
    const stableViews = (["element", "shadow-root", "frame-document"] as const)
      .map((kind) => {
        const { locator: _locator, ...view } = nodeView({ kind });
        return view;
      });

    expect(parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: stableViews[0],
      prologue: [],
      epilogue: [],
    })).toMatchObject({ node: stableViews[0] });
    expect(parseDomResponse({
      type: "dom.children",
      requestId: "request-2",
      documentEpoch: 1,
      nodeRef: "parent",
      branchRevision: 1,
      nodes: stableViews,
    })).toMatchObject({ nodes: stableViews });
    for (const kind of ["document-type", "text", "comment"] as const) {
      expect(() => parseDomResponse({
        type: "dom.children",
        requestId: "display-locator",
        documentEpoch: 1,
        nodeRef: "parent",
        branchRevision: 1,
        nodes: [{ ...displayNodeView(kind), locator: stableLocator() }],
      })).toThrow(DomProtocolError);
    }
  });

  it.each(["document-type", "text", "comment"] as const)(
    "rejects a valid %s display row inside a recoverable selection path",
    (kind) => {
      const target = nodeView({ nodeRef: "node-target" });

      expect(() => parseDomEvent({
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: target.nodeRef,
        ancestorPath: [
          nodeView({ nodeRef: "node-root" }),
          displayNodeView(kind),
          target,
        ],
      })).toThrow(DomProtocolError);
    },
  );

  it("requires a correlated selectable element target for selection paths", () => {
    const target = nodeView({ nodeRef: "node-target" });
    const { locator: _locator, ...targetWithoutLocator } = target;

    for (const invalidEvent of [
      {
        type: "dom.selectionChanged" as const,
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: "different-target",
        ancestorPath: [nodeView({ nodeRef: "node-root" }), target],
      },
      {
        type: "dom.selectionChanged" as const,
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: target.nodeRef,
        ancestorPath: [nodeView({ nodeRef: "node-root" }), targetWithoutLocator],
      },
      {
        type: "dom.selectionChanged" as const,
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: target.nodeRef,
        ancestorPath: [
          nodeView({ nodeRef: "node-root" }),
          nodeView({ ...target, selectable: false }),
        ],
      },
      {
        type: "dom.selectionChanged" as const,
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: "node-shadow",
        ancestorPath: [
          nodeView({ nodeRef: "node-root" }),
          nodeView({ kind: "shadow-root", nodeRef: "node-shadow" }),
        ],
      },
      {
        type: "dom.selectionChanged" as const,
        documentEpoch: 1,
        selectionRevision: 4,
        nodeRef: "node-frame",
        ancestorPath: [
          nodeView({ nodeRef: "node-root" }),
          nodeView({ kind: "frame-document", nodeRef: "node-frame" }),
        ],
      },
    ]) {
      expect(() => parseDomEvent(invalidEvent)).toThrow(DomProtocolError);
    }

    const validPath = [
      nodeView({ nodeRef: "node-root" }),
      nodeView({ kind: "shadow-root", nodeRef: "node-shadow" }),
      nodeView({ kind: "frame-document", nodeRef: "node-frame" }),
      target,
    ];
    expect(parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 4,
      nodeRef: target.nodeRef,
      ancestorPath: validPath,
    })).toMatchObject({ ancestorPath: validPath });
  });

  it("requires a correlated recoverable target for locator paths", () => {
    for (const kind of ["document-type", "text", "comment"] as const) {
      const display = displayNodeView(kind);
      const target = nodeView({ nodeRef: "node-target" });
      expect(() => parseDomResponse({
        type: "dom.locator",
        requestId: "display-target",
        documentEpoch: 1,
        node: display,
        ancestorPath: [display],
      })).toThrow(DomProtocolError);
      expect(() => parseDomResponse({
        type: "dom.locator",
        requestId: "display-ancestor",
        documentEpoch: 1,
        node: target,
        ancestorPath: [
          nodeView({ nodeRef: "node-root" }),
          display,
          target,
        ],
      })).toThrow(DomProtocolError);
    }

    const target = nodeView({ nodeRef: "node-target", label: "target" });
    expect(() => parseDomResponse({
      type: "dom.locator",
      requestId: "mismatched-target",
      documentEpoch: 1,
      node: target,
      ancestorPath: [
        nodeView({ nodeRef: "node-root" }),
        nodeView({ nodeRef: target.nodeRef, label: "different authority" }),
      ],
    })).toThrow(DomProtocolError);

    const { locator: _locator, ...targetWithoutLocator } = target;
    expect(() => parseDomResponse({
      type: "dom.locator",
      requestId: "missing-target-locator",
      documentEpoch: 1,
      node: targetWithoutLocator,
      ancestorPath: [targetWithoutLocator],
    })).toThrow(DomProtocolError);
  });

  it("requires each node locator target kind to match its DOM node kind", () => {
    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeView({
        kind: "shadow-root",
        locator: stableLocator({ targetKind: "element" }),
      }),
      prologue: [],
      epilogue: [],
    })).toThrow(DomProtocolError);
  });

  it("parses every event form", () => {
    const ancestorPath = [
      nodeView({ nodeRef: "document", label: "#document" }),
      nodeView(),
    ];
    expect(parseDomEvent({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: "node-1",
      summary: "button.save",
    })).toEqual({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: "node-1",
      summary: "button.save",
    });
    expect(parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 4,
      nodeRef: "node-1",
      ancestorPath,
    })).toEqual({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 4,
      nodeRef: "node-1",
      ancestorPath,
    });
    const selectionCleared = parseDomEvent({
      type: "dom.selectionCleared",
      documentEpoch: 1,
      selectionRevision: 5,
      nodeRef: "node-1",
    });
    expect(selectionCleared).toEqual({
      type: "dom.selectionCleared",
      documentEpoch: 1,
      selectionRevision: 5,
      nodeRef: "node-1",
    });
    expect(Object.isFrozen(selectionCleared)).toBe(true);
    expect(parseDomEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "node-1", branchRevision: 3 }],
    })).toEqual({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "node-1", branchRevision: 3 }],
    });
  });

  it("strictly rejects malformed selection-cleared authority events", () => {
    for (const event of [
      {
        type: "dom.selectionCleared",
        documentEpoch: 1,
        selectionRevision: 2,
      },
      {
        type: "dom.selectionCleared",
        documentEpoch: 1,
        selectionRevision: 2,
        nodeRef: "node-1",
        extra: true,
      },
      {
        type: "dom.selectionCleared",
        documentEpoch: 1,
        selectionRevision: 2,
        nodeRef: "",
      },
    ]) {
      expect(() => parseDomEvent(event)).toThrow(DomProtocolError);
    }
  });

  it("rejects cross-tab and unknown request fields", () => {
    for (const value of [
      { type: "dom.getRoot", requestId: "request-1", tabId: 1 },
      { type: "dom.getRoot", requestId: "request-1", channel: "channel-1" },
      { type: "dom.getRoot", requestId: "request-1", session: "session-1" },
      { type: "dom.getRoot", requestId: "request-1", extra: true },
    ]) {
      expect(() => parseDomRequest(value)).toThrow(DomProtocolError);
    }
  });

  it("ignores unknown stable locator keys at every level without enumerating them", () => {
    const inputs = [
      { ...stableLocator(), extra: true },
      stableLocator({
        boundaries: [{
          kind: "shadow-root",
          hostPath: [pathSegment()],
          extra: true,
        } as TestDomBoundary],
      }),
      stableLocator({ path: [{ ...pathSegment(), extra: true }] }),
      stableLocator({
        path: [pathSegment({
          attributes: [{ name: "role", value: "main", extra: true }],
        })],
      }),
    ];

    for (const locator of inputs) {
      expect(parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-unknown-key",
        locator,
      })).toMatchObject({ type: "dom.resolveLocator" });
    }
  });

  it("rejects duplicate or unsorted locator classes", () => {
    for (const classes of [
      ["primary", "action"],
      ["action", "action"],
    ]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-classes",
        locator: stableLocator({
          path: [pathSegment({ classes })],
        }),
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects duplicate or unsorted locator attributes", () => {
    for (const attributes of [
      [
        { name: "role", value: "button" },
        { name: "aria-label", value: "Save" },
      ],
      [
        { name: "data-state", value: "ready" },
        { name: "data-state", value: "saving" },
      ],
    ]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-attributes",
        locator: stableLocator({
          path: [pathSegment({ attributes })],
        }),
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects noncanonical locator tags and approved attribute names", () => {
    for (const tagName of ["DIV", "", "div span", "<script>"]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-tag",
        locator: stableLocator({ path: [pathSegment({ tagName })] }),
      })).toThrow(DomProtocolError);
    }
    for (const name of ["ARIA-label", "onclick", "data-", "aria-"]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-attribute-name",
        locator: stableLocator({
          path: [pathSegment({ attributes: [{ name, value: "value" }] })],
        }),
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects negative, fractional, and unsafe sibling indexes", () => {
    for (const siblingIndex of [
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-index",
        locator: stableLocator({
          path: [pathSegment({ siblingIndex })],
        }),
      })).toThrow(DomProtocolError);
    }
  });

  it("enforces locator boundary, evidence, and total-depth bounds", () => {
    const segment = pathSegment();
    const invalidLocators = [
      stableLocator({
        boundaries: Array.from({ length: 17 }, () => ({
          kind: "shadow-root",
          hostPath: [],
        })),
      }),
      stableLocator({
        path: [pathSegment({
          classes: Array.from({ length: 9 }, (_, index) => `class-${index}`),
        })],
      }),
      stableLocator({
        path: [pathSegment({
          attributes: Array.from({ length: 9 }, (_, index) => ({
            name: `data-value-${index}`,
            value: String(index),
          })),
        })],
      }),
      stableLocator({
        boundaries: [
          { kind: "shadow-root", hostPath: Array.from({ length: 32 }, () => segment) },
          { kind: "frame-document", hostPath: Array.from({ length: 32 }, () => segment) },
        ],
        path: [segment],
      }),
    ];

    for (const locator of invalidLocators) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-bounds",
        locator,
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects oversized locator tokens", () => {
    const oversized = "x".repeat(129);
    const segments = [
      pathSegment({ tagName: `x-${oversized}` }),
      pathSegment({ id: oversized }),
      pathSegment({ classes: [oversized] }),
      pathSegment({ attributes: [{ name: `data-${oversized}`, value: "x" }] }),
      pathSegment({ attributes: [{ name: "data-value", value: oversized }] }),
    ];

    for (const segment of segments) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-token",
        locator: stableLocator({ path: [segment] }),
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects invalid locator versions, target kinds, and boundary kinds", () => {
    for (const locator of [
      { ...stableLocator(), version: 2 },
      { ...stableLocator(), targetKind: "text" },
      stableLocator({
        boundaries: [{ kind: "closed-shadow-root", hostPath: [] }],
      }),
    ]) {
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-discriminant",
        locator,
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects invalid nonnegative safe integer values", () => {
    for (const value of ["4", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseDomRequest({
        type: "dom.getRoot",
        requestId: "request-1",
        documentEpoch: value,
      })).toThrow(DomProtocolError);
      expect(() => parseDomResponse({
        type: "dom.children",
        requestId: "request-1",
        documentEpoch: 1,
        nodeRef: "node-1",
        branchRevision: value,
        nodes: [],
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: [{ nodeRef: "node-1", branchRevision: value }],
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: value,
        nodeRef: "node-1",
        ancestorPath: [nodeView()],
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.selectionCleared",
        documentEpoch: 1,
        selectionRevision: value,
        nodeRef: "node-1",
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.selectionCleared",
        documentEpoch: value,
        selectionRevision: 1,
        nodeRef: "node-1",
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects oversized identifiers and display metadata", () => {
    const overlongId = "x".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH + 1);
    expect(() => parseDomRequest({
      type: "dom.getRoot",
      requestId: overlongId,
    })).toThrow(DomProtocolError);
    expect(() => parseDomRequest({
      type: "dom.getChildren",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: overlongId,
      branchRevision: 1,
    })).toThrow(DomProtocolError);
    expect(() => parseDomRequest({
      type: "dom.getChildren",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      cursor: overlongId,
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeView({ label: "x".repeat(DOM_PROTOCOL_MAX_LABEL_LENGTH + 1) }),
      prologue: [],
      epilogue: [],
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeView({ label: "" }),
      prologue: [],
      epilogue: [],
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      summary: "x".repeat(DOM_PROTOCOL_MAX_SUMMARY_LENGTH + 1),
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      summary: "",
    })).toThrow(DomProtocolError);
  });

  it("rejects oversized child pages and total serialized messages", () => {
    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes: Array.from(
        { length: DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH + 1 },
        () => nodeView(),
      ),
    })).toThrow(DomProtocolError);

    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "r".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
      documentEpoch: 1,
      nodeRef: "n".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
      branchRevision: 1,
      nodes: Array.from({ length: DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH }, () =>
        nodeView({
          nodeRef: "n".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
          label: "x".repeat(DOM_PROTOCOL_MAX_LABEL_LENGTH),
          inaccessible: true,
        }),
      ),
      nextCursor: "x".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
    })).toThrow(DomProtocolError);
  });

  it("sizes canonical output without executing attacker-provided toJSON", () => {
    let inheritedCalls = 0;
    const inherited = Object.assign(
      Object.create({
        toJSON() {
          inheritedCalls += 1;
          return { type: "dom.children" };
        },
      }),
      oversizedChildrenResponse(),
    );
    let ownCalls = 0;
    const own = { type: "dom.getRoot", requestId: "request-1" };
    Object.defineProperty(own, "toJSON", {
      enumerable: false,
      value: () => {
        ownCalls += 1;
        return {};
      },
    });

    expect(() => parseDomResponse(inherited)).toThrow(DomProtocolError);
    expect(inheritedCalls).toBe(0);
    expect(() => parseDomRequest(own)).toThrow(DomProtocolError);
    expect(ownCalls).toBe(0);
  });

  it("rejects a top-level type accessor without executing it", () => {
    let calls = 0;
    const input = { requestId: "request-1" };
    Object.defineProperty(input, "type", {
      enumerable: true,
      get: () => {
        calls += 1;
        return calls === 1 ? "dom.getRoot" : "dom.hover";
      },
    });

    expect(() => parseDomRequest(input)).toThrow(DomProtocolError);
    expect(calls).toBe(0);
  });

  it("rejects nested locator accessors without executing them", () => {
    for (const [target, field, value] of [
      [stableLocator(), "version", 1],
      [{ kind: "shadow-root", hostPath: [pathSegment()] }, "kind", "shadow-root"],
      [pathSegment(), "tagName", "div"],
      [{ name: "role", value: "main" }, "value", "main"],
    ] as const) {
      let calls = 0;
      Object.defineProperty(target, field, {
        enumerable: true,
        get: () => {
          calls += 1;
          return value;
        },
      });
      const locator = field === "version"
        ? target
        : field === "kind"
          ? stableLocator({ boundaries: [target as TestDomBoundary] })
          : field === "tagName"
            ? stableLocator({ path: [target as TestDomPathSegment] })
            : stableLocator({
              path: [pathSegment({
                attributes: [target as TestDomAttribute],
              })],
            });

      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-accessor",
        locator,
      })).toThrow(DomProtocolError);
      expect(calls).toBe(0);
    }
  });

  it("uses locator descriptor snapshots without invoking proxy get traps", () => {
    let getCalls = 0;
    const segment = new Proxy(pathSegment({
      classes: ["action", "primary"],
      attributes: [{ name: "role", value: "button" }],
    }), {
      get() {
        getCalls += 1;
        throw new Error("get trap must not run");
      },
    });
    const locator = new Proxy(stableLocator({ path: [segment] }), {
      get() {
        getCalls += 1;
        throw new Error("get trap must not run");
      },
    });

    expect(parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-proxy",
      locator,
    })).toEqual({
      type: "dom.resolveLocator",
      requestId: "locator-proxy",
      locator: stableLocator({ path: [pathSegment({
        classes: ["action", "primary"],
        attributes: [{ name: "role", value: "button" }],
      })] }),
    });
    expect(getCalls).toBe(0);
  });

  it("parses locator proxies without enumerating untrusted keys", () => {
    let ownKeysCalls = 0;
    const locator = new Proxy(stableLocator(), {
      ownKeys() {
        ownKeysCalls += 1;
        throw new Error("locator ownKeys must not run");
      },
    });

    expect(parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-reflection",
      locator,
    })).toMatchObject({ type: "dom.resolveLocator" });
    expect(ownKeysCalls).toBe(0);
  });

  it("reads only whitelisted locator properties from oversized records", () => {
    const extras = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`extra-${index}`, index]),
    );
    const descriptorReads: PropertyKey[] = [];
    const locator = new Proxy({ ...stableLocator(), ...extras }, {
      getOwnPropertyDescriptor(target, key) {
        descriptorReads.push(key);
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
      ownKeys() {
        throw new Error("oversized locator keys must not be enumerated");
      },
    });

    expect(parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-oversized",
      locator,
    })).toMatchObject({ type: "dom.resolveLocator" });
    expect(descriptorReads).toEqual([
      "version",
      "targetKind",
      "boundaries",
      "path",
    ]);
  });

  it("rejects nested node accessors without executing them", () => {
    for (const [field, fieldValue] of [
      ["kind", "element"],
      ["nodeType", 1],
      ["nodeName", "MAIN"],
      ["attributes", []],
      ["childCount", 1],
      ["relationship", "dom"],
      ["selectable", true],
      ["expandable", true],
      ["label", "main"],
      ["branchRevision", 1],
    ] as const) {
      let calls = 0;
      const node = nodeView();
      Object.defineProperty(node, field, {
        enumerable: true,
        get: () => {
          calls += 1;
          return fieldValue;
        },
      });

      expect(() => parseDomResponse({
        type: "dom.root",
        requestId: "request-1",
        documentEpoch: 1,
        node,
        prologue: [],
        epilogue: [],
      })).toThrow(DomProtocolError);
      expect(calls).toBe(0);
    }
  });

  it("snapshots hostile structured arrays and attributes without invoking accessors", () => {
    let getterCalls = 0;
    let proxyGets = 0;
    const attribute = { name: "data-safe", value: "captured" };
    Object.defineProperty(attribute, "value", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("attribute getter must not run");
      },
    });
    const proxiedAttributes = new Proxy([{ name: "role", value: "button" }], {
      get() {
        proxyGets += 1;
        throw new Error("attribute array get trap must not run");
      },
    });

    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "hostile-attribute",
      documentEpoch: 1,
      nodeRef: "parent",
      branchRevision: 1,
      nodes: [nodeView({ attributes: [attribute] })],
    })).toThrow(DomProtocolError);
    expect(parseDomResponse({
      type: "dom.children",
      requestId: "proxied-attributes",
      documentEpoch: 1,
      nodeRef: "parent",
      branchRevision: 1,
      nodes: [nodeView({ attributes: proxiedAttributes })],
    })).toMatchObject({
      nodes: [expect.objectContaining({
        attributes: [{ name: "role", value: "button" }],
      })],
    });
    expect(getterCalls).toBe(0);
    expect(proxyGets).toBe(0);
  });

  it("rejects accessor descriptors without invoking getters or setters", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const getterInput = { type: "dom.getRoot" };
    Object.defineProperty(getterInput, "requestId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });
    const setterInput = { type: "dom.getRoot" };
    Object.defineProperty(setterInput, "requestId", {
      enumerable: true,
      set: () => {
        setterCalls += 1;
      },
    });
    const toJsonInput = { type: "dom.getRoot", requestId: "request-1" };
    Object.defineProperty(toJsonInput, "toJSON", {
      enumerable: false,
      get: () => {
        getterCalls += 1;
        return () => ({});
      },
    });

    expect(() => parseDomRequest(getterInput)).toThrow(DomProtocolError);
    expect(() => parseDomRequest(setterInput)).toThrow(DomProtocolError);
    expect(() => parseDomRequest(toJsonInput)).toThrow(DomProtocolError);
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
  });

  it("uses captured descriptors without invoking proxy get traps", () => {
    let getCalls = 0;
    const input = new Proxy(
      { type: "dom.getRoot", requestId: "request-1" },
      {
        get() {
          getCalls += 1;
          throw new Error("get trap must not run");
        },
      },
    );

    expect(parseDomRequest(input)).toEqual({
      type: "dom.getRoot",
      requestId: "request-1",
    });
    expect(getCalls).toBe(0);
  });

  it("normalizes throwing and invariant-violating record reflection", () => {
    const target = { type: "dom.getRoot", requestId: "request-1" };
    const ownKeysFailure = new Proxy(target, {
      ownKeys() {
        throw new Error("ownKeys failed");
      },
    });
    const descriptorFailure = new Proxy(target, {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor failed");
      },
    });
    const frozenTarget = Object.freeze({
      type: "dom.getRoot",
      requestId: "request-1",
    });
    const invariantFailure = new Proxy(frozenTarget, {
      ownKeys() {
        return ["type"];
      },
    });

    for (const input of [
      ownKeysFailure,
      descriptorFailure,
      invariantFailure,
    ]) {
      expect(() => parseDomRequest(input)).toThrow(DomProtocolError);
    }
  });

  it("fails closed on cyclic and non-serializable input", () => {
    const cyclic: { type: string; requestId: string; self?: unknown } = {
      type: "dom.getRoot",
      requestId: "request-1",
    };
    cyclic.self = cyclic;

    expect(() => parseDomRequest(cyclic)).toThrow(DomProtocolError);
    expect(() => parseDomRequest({
      type: "dom.getRoot",
      requestId: "request-1",
      documentEpoch: BigInt(1),
    })).toThrow(DomProtocolError);
  });

  it("rejects malformed nested node, path, branch, and error data", () => {
    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: { ...nodeView(), kind: "text" },
      prologue: [],
      epilogue: [],
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "node-1",
      ancestorPath: Array.from(
        { length: DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH + 1 },
        () => nodeView(),
      ),
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "node-1",
      ancestorPath: [{ ...nodeView(), extra: true }],
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "node-1",
      ancestorPath: [{ ...nodeView(), kind: "text" }],
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: Array.from(
        { length: DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES + 1 },
        () => ({ nodeRef: "node-1", branchRevision: 1 }),
      ),
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: [{ nodeRef: "node-1", branchRevision: 1, extra: true }],
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.error",
      code: "bad-code",
    })).toThrow(DomProtocolError);
  });

  it("rejects sparse protocol arrays", () => {
    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes: new Array(1),
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "node-1",
      ancestorPath: new Array(1),
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.invalidated",
      documentEpoch: 1,
      branches: new Array(1),
    })).toThrow(DomProtocolError);
  });

  it("snapshots array length once without invoking a changing get trap", () => {
    let lengthReads = 0;
    const nodes = new Proxy([nodeView()], {
      get(target, key, receiver) {
        if (key === "length") {
          lengthReads += 1;
          return lengthReads === 1 ? 0 : 101;
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes,
    })).toMatchObject({ nodes: [nodeView()] });
    expect(lengthReads).toBe(0);
  });

  it("rejects accessor array indices without executing them", () => {
    let calls = 0;
    const nodes = [nodeView()];
    Object.defineProperty(nodes, "0", {
      configurable: true,
      enumerable: true,
      get: () => {
        calls += 1;
        return nodeView();
      },
    });

    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes,
    })).toThrow(DomProtocolError);
    expect(calls).toBe(0);
  });

  it("normalizes throwing array reflection traps", () => {
    const nodes = new Proxy([nodeView()], {
      ownKeys() {
        throw new Error("array ownKeys failed");
      },
    });

    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes,
    })).toThrow(DomProtocolError);
  });

  it("parses captured array elements without invoking stateful get traps", () => {
    let elementReads = 0;
    const nodes = new Proxy([nodeView()], {
      get(target, key, receiver) {
        if (key === "0") {
          elementReads += 1;
          return elementReads === 1
            ? nodeView()
            : nodeView({ kind: "shadow-root" });
        }
        return Reflect.get(target, key, receiver);
      },
    });

    expect(parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes,
    })).toMatchObject({ nodes: [nodeView()] });
    expect(elementReads).toBe(0);
  });

  it("rejects extra own keys on every protocol collection", () => {
    for (const key of [
      "extra",
      "toJSON",
      Symbol("extra"),
      "01",
      "4294967295",
    ]) {
      expect(() => parseDomResponse({
        type: "dom.children",
        requestId: "request-1",
        documentEpoch: 1,
        nodeRef: "node-1",
        branchRevision: 1,
        nodes: collectionWithExtraKey([nodeView()], key),
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 1,
        nodeRef: "node-1",
        ancestorPath: collectionWithExtraKey([nodeView()], key),
      })).toThrow(DomProtocolError);
      expect(() => parseDomEvent({
        type: "dom.invalidated",
        documentEpoch: 1,
        branches: collectionWithExtraKey(
          [{ nodeRef: "node-1", branchRevision: 1 }],
          key,
        ),
      })).toThrow(DomProtocolError);
    }
  });

  it("rejects invalid top-level shapes and discriminants", () => {
    for (const parse of [parseDomRequest, parseDomResponse, parseDomEvent]) {
      expect(() => parse(null)).toThrow(DomProtocolError);
      expect(() => parse([])).toThrow(DomProtocolError);
      expect(() => parse({ type: "dom.unknown" })).toThrow(DomProtocolError);
    }
  });

  it("enforces the serialized message budget in UTF-8 bytes", () => {
    const input = {
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes: Array.from(
        { length: DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH - 20 },
        () => nodeView({
          nodeRef: "n",
          label: "\ud83d\ude00".repeat(DOM_PROTOCOL_MAX_LABEL_LENGTH / 2),
        }),
      ),
    };
    const serialized = JSON.stringify(input);

    expect(serialized.length).toBeLessThan(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(utf8ByteLength(serialized)).toBeGreaterThan(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(() => parseDomResponse(input)).toThrow(DomProtocolError);
  });

  it("reduces presentation fields across the path before recovery locators", () => {
    const root = nodeView({
      nodeRef: "node-root",
      attributes: Array.from({ length: 64 }, (_, index) => ({
        name: `data-${index}`,
        value: "\u0000".repeat(1_000),
      })),
    });
    const boundary = nodeView({
      kind: "shadow-root",
      nodeRef: "node-shadow",
    });
    const target = nodeView({ nodeRef: "node-target" });
    const bounded = boundDomNodeViewPathForEnvelope(
      [root, boundary, target],
      (ancestorPath) => ({
        type: "dom.selectionChanged",
        documentEpoch: 1,
        selectionRevision: 1,
        nodeRef: target.nodeRef,
        ancestorPath,
      }),
      { requireTargetLocator: true },
    );

    expect(bounded).toBeDefined();
    expect(bounded?.[0]?.attributes).toEqual([]);
    expect(bounded?.[1]?.locator).toEqual(boundary.locator);
    expect(bounded?.at(-1)?.locator).toEqual(target.locator);
  });

  it("enforces the 64 KiB budget on otherwise bounded locator messages", () => {
    const classes = Array.from({ length: 8 }, (_, index) =>
      `class-${index}-${"x".repeat(110)}`
    );
    const attributes = Array.from({ length: 8 }, (_, index) => ({
      name: `data-value-${index}`,
      value: "v".repeat(128),
    }));
    const input = {
      type: "dom.resolveLocator",
      requestId: "locator-oversized",
      locator: stableLocator({
        path: Array.from({ length: 64 }, () => pathSegment({
          id: "i".repeat(128),
          classes,
          attributes,
        })),
      }),
    };

    expect(utf8ByteLength(JSON.stringify(input))).toBeGreaterThan(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(() => parseDomRequest(input)).toThrow(DomProtocolError);
  });

  it("rejects empty required identifiers and invalid optional values", () => {
    expect(() => parseDomRequest({
      type: "dom.getRoot",
      requestId: "",
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "",
      branchRevision: 1,
      nodes: [],
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 1,
      nodeRef: "",
      ancestorPath: [],
    })).toThrow(DomProtocolError);
    expect(() => parseDomRequest({
      type: "dom.getRoot",
      requestId: "request-1",
      documentEpoch: undefined,
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.error",
      code: "internal-error",
      requestId: undefined,
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.hoverChanged",
      documentEpoch: 1,
      nodeRef: 1,
    })).toThrow(DomProtocolError);
  });

  it("copies and recursively freezes children without treating labels as HTML", () => {
    const input = {
      type: "dom.children",
      requestId: "request-1",
      documentEpoch: 1,
      nodeRef: "node-1",
      branchRevision: 1,
      nodes: [nodeView({
        label: "<img src=x onerror=alert(1)>",
        attributes: [{ name: "title", value: "safe text" }],
      })],
    };
    const parsed = parseDomResponse(input);

    input.nodes[0]!.label = "changed";
    input.nodes.push(nodeView());

    expect(parsed.nodes).toEqual([
      nodeView({
        label: "<img src=x onerror=alert(1)>",
        attributes: [{ name: "title", value: "safe text" }],
      }),
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.nodes)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0])).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.attributes[0])).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.locator)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.locator.path)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0]?.locator.path[0])).toBe(true);
    expect(() => {
      (parsed.nodes as { push(value: unknown): void }).push(nodeView());
    }).toThrow(TypeError);
    expect(() => {
      (parsed.nodes[0] as { label: string }).label = "changed";
    }).toThrow(TypeError);
  });

  it("isolates and freezes requests, roots, selection paths, and invalidations", () => {
    const requestInput = {
      type: "dom.getRoot" as const,
      requestId: "request-1",
      documentEpoch: 1,
    };
    const rootInput = {
      type: "dom.root" as const,
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeView(),
      prologue: [displayNodeView("document-type")],
      epilogue: [displayNodeView("comment")],
    };
    const selectionInput = {
      type: "dom.selectionChanged" as const,
      documentEpoch: 1,
      selectionRevision: 2,
      nodeRef: "node-1",
      ancestorPath: [nodeView({ nodeRef: "document" }), nodeView()],
    };
    const invalidationInput = {
      type: "dom.invalidated" as const,
      documentEpoch: 1,
      branches: [{ nodeRef: "node-1", branchRevision: 1 }],
    };
    const request = parseDomRequest(requestInput);
    const root = parseDomResponse(rootInput);
    const selection = parseDomEvent(selectionInput);
    const invalidation = parseDomEvent(invalidationInput);

    requestInput.requestId = "changed";
    rootInput.node.label = "changed";
    rootInput.prologue[0]!.label = "changed";
    rootInput.epilogue.push(displayNodeView("comment", { nodeRef: "another" }));
    selectionInput.ancestorPath[0]!.label = "changed";
    selectionInput.ancestorPath.push(nodeView());
    invalidationInput.branches[0]!.branchRevision = 2;
    invalidationInput.branches.push({ nodeRef: "node-2", branchRevision: 1 });

    expect(request).toEqual({
      type: "dom.getRoot",
      requestId: "request-1",
      documentEpoch: 1,
    });
    expect(root).toMatchObject({ node: nodeView() });
    expect(selection).toMatchObject({
      ancestorPath: [nodeView({ nodeRef: "document" }), nodeView()],
    });
    expect(invalidation).toMatchObject({
      branches: [{ nodeRef: "node-1", branchRevision: 1 }],
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(Object.isFrozen(root.node)).toBe(true);
    expect(Object.isFrozen(root.prologue)).toBe(true);
    expect(Object.isFrozen(root.prologue[0])).toBe(true);
    expect(Object.isFrozen(root.epilogue)).toBe(true);
    expect(Object.isFrozen(root.node.locator)).toBe(true);
    expect(Object.isFrozen(root.node.locator.boundaries)).toBe(true);
    expect(Object.isFrozen(root.node.locator.path)).toBe(true);
    expect(Object.isFrozen(root.node.locator.path[0])).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.ancestorPath)).toBe(true);
    expect(Object.isFrozen(selection.ancestorPath[0])).toBe(true);
    expect(Object.isFrozen(selection.ancestorPath[1])).toBe(true);
    expect(Object.isFrozen(invalidation)).toBe(true);
    expect(Object.isFrozen(invalidation.branches)).toBe(true);
    expect(Object.isFrozen(invalidation.branches[0])).toBe(true);
  });
});

function oversizedChildrenResponse(): {
  type: "dom.children";
  requestId: string;
  documentEpoch: number;
  nodeRef: string;
  branchRevision: number;
  nodes: ReturnType<typeof nodeView>[];
  nextCursor: string;
} {
  return {
    type: "dom.children",
    requestId: "r".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
    documentEpoch: 1,
    nodeRef: "n".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
    branchRevision: 1,
    nodes: Array.from({ length: DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH }, () =>
      nodeView({
        nodeRef: "n".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
        label: "x".repeat(DOM_PROTOCOL_MAX_LABEL_LENGTH),
        inaccessible: true,
      }),
    ),
    nextCursor: "x".repeat(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH),
  };
}

function collectionWithExtraKey<T>(values: T[], key: PropertyKey): T[] {
  Object.defineProperty(values, key, {
    enumerable: false,
    value: "unexpected",
  });
  return values;
}

function nodeView(overrides: Partial<{
  nodeRef: string;
  kind: "element" | "shadow-root" | "frame-document";
  nodeType: number;
  nodeName: string;
  attributes: TestInspectorAttribute[];
  childCount: number;
  relationship: "dom" | "shadow-root" | "frame-document";
  selectable: boolean;
  label: string;
  expandable: boolean;
  inaccessible: boolean;
  branchRevision: number;
  locator: TestDomStableLocator;
}> = {}): {
  nodeRef: string;
  kind: "element" | "shadow-root" | "frame-document";
  nodeType: number;
  nodeName: string;
  attributes: TestInspectorAttribute[];
  childCount: number;
  relationship: "dom" | "shadow-root" | "frame-document";
  selectable: boolean;
  label: string;
  expandable: boolean;
  inaccessible?: boolean;
  branchRevision: number;
  locator: TestDomStableLocator;
} {
  const kind = overrides.kind ?? "element";
  return {
    nodeRef: "node-1",
    kind,
    nodeType: kind === "element" ? 1 : kind === "shadow-root" ? 11 : 9,
    nodeName: kind === "element"
      ? "MAIN"
      : kind === "shadow-root" ? "#document-fragment" : "#document",
    attributes: [],
    childCount: 1,
    relationship: kind === "element" ? "dom" : kind,
    selectable: kind === "element",
    label: "main",
    expandable: true,
    branchRevision: 1,
    locator: stableLocator({ targetKind: kind }),
    ...overrides,
  };
}

interface TestInspectorAttribute {
  name: string;
  value: string;
}

function displayNodeView(
  kind: "document-type" | "text" | "comment",
  overrides: Partial<{
    nodeRef: string;
    nodeType: number;
    nodeName: string;
    nodeValue: string;
    publicId: string;
    systemId: string;
    attributes: TestInspectorAttribute[];
    childCount: number;
    relationship: "dom" | "shadow-root" | "frame-document";
    selectable: boolean;
    expandable: boolean;
    inaccessible: boolean;
    branchRevision: number;
    label: string;
  }> = {},
) {
  return {
    nodeRef: `node-${kind}`,
    kind,
    nodeType: kind === "document-type" ? 10 : kind === "text" ? 3 : 8,
    nodeName: kind === "document-type" ? "html" : kind === "text" ? "#text" : "#comment",
    ...(kind === "document-type"
      ? { publicId: "", systemId: "" }
      : { nodeValue: kind === "text" ? "text" : "comment" }),
    attributes: [],
    childCount: 0,
    relationship: "dom" as const,
    selectable: false,
    expandable: false,
    branchRevision: 0,
    label: kind === "document-type" ? "<!DOCTYPE html>" : kind,
    ...overrides,
  };
}

interface TestDomAttribute {
  name: string;
  value: string;
}

interface TestDomPathSegment {
  tagName: string;
  siblingIndex: number;
  id?: string;
  classes?: string[];
  attributes?: TestDomAttribute[];
}

interface TestDomBoundary {
  kind: string;
  hostPath: TestDomPathSegment[];
}

interface TestDomStableLocator {
  version: number;
  targetKind: string;
  boundaries: TestDomBoundary[];
  path: TestDomPathSegment[];
}

function stableLocator(
  overrides: Partial<TestDomStableLocator> = {},
): TestDomStableLocator {
  return {
    version: 1,
    targetKind: "element",
    boundaries: [],
    path: [pathSegment()],
    ...overrides,
  };
}

function pathSegment(
  overrides: Partial<TestDomPathSegment> = {},
): TestDomPathSegment {
  return {
    tagName: "div",
    siblingIndex: 0,
    ...overrides,
  };
}
