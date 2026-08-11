import { describe, expect, it } from "vitest";
import { utf8ByteLength } from "@browser2ide/protocol";
import {
  DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
  DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  DOM_PROTOCOL_MAX_LABEL_LENGTH,
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  DOM_PROTOCOL_MAX_SUMMARY_LENGTH,
  DomProtocolError,
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

    expect(parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node,
    })).toEqual({ type: "dom.root", requestId: "request-1", documentEpoch: 1, node });
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

  it("requires a locator on every DOM node view", () => {
    const { locator: _locator, ...nodeWithoutLocator } = nodeView();

    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeWithoutLocator,
    })).toThrow(DomProtocolError);
    expect(() => parseDomEvent({
      type: "dom.selectionChanged",
      documentEpoch: 1,
      selectionRevision: 4,
      nodeRef: "node-1",
      ancestorPath: [nodeWithoutLocator],
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

  it("rejects unknown stable locator keys at every level", () => {
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
      expect(() => parseDomRequest({
        type: "dom.resolveLocator",
        requestId: "locator-unknown-key",
        locator,
      })).toThrow(DomProtocolError);
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
    })).toThrow(DomProtocolError);
    expect(() => parseDomResponse({
      type: "dom.root",
      requestId: "request-1",
      documentEpoch: 1,
      node: nodeView({ label: "" }),
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

  it("normalizes throwing locator proxy reflection", () => {
    const locator = new Proxy(stableLocator(), {
      ownKeys() {
        throw new Error("locator ownKeys failed");
      },
    });

    expect(() => parseDomRequest({
      type: "dom.resolveLocator",
      requestId: "locator-reflection",
      locator,
    })).toThrow(DomProtocolError);
  });

  it("rejects nested node accessors without executing them", () => {
    for (const [field, fieldValue] of [
      ["kind", "element"],
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
      })).toThrow(DomProtocolError);
      expect(calls).toBe(0);
    }
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
      nodes: [nodeView({ label: "<img src=x onerror=alert(1)>" })],
    };
    const parsed = parseDomResponse(input);

    input.nodes[0]!.label = "changed";
    input.nodes.push(nodeView());

    expect(parsed.nodes).toEqual([
      nodeView({ label: "<img src=x onerror=alert(1)>" }),
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.nodes)).toBe(true);
    expect(Object.isFrozen(parsed.nodes[0])).toBe(true);
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
  label: string;
  expandable: boolean;
  inaccessible: boolean;
  branchRevision: number;
  locator: TestDomStableLocator;
}> = {}): {
  nodeRef: string;
  kind: "element" | "shadow-root" | "frame-document";
  label: string;
  expandable: boolean;
  inaccessible?: boolean;
  branchRevision: number;
  locator: TestDomStableLocator;
} {
  return {
    nodeRef: "node-1",
    kind: "element",
    label: "main",
    expandable: true,
    branchRevision: 1,
    locator: stableLocator(),
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
