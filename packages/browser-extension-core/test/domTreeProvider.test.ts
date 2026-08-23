import { describe, expect, it, vi } from "vitest";
import { utf8ByteLength } from "@pin-op/protocol";
import {
  DomTreeProvider,
  DomTreeProviderError,
  type DomTreeProviderOptions,
} from "../src/domTreeProvider.js";
import {
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  parseDomEvent,
  parseDomResponse,
  type DomNodeView,
} from "../src/domProtocol.js";
import type { DomStableLocator } from "../src/domStableLocator.js";
import type { FrameLifecycleEvent } from "../src/frameRegistry.js";

class ExternalSettlementDomTreeProvider extends DomTreeProvider {
  public settlementTrapCalls = 0;
}

Object.defineProperty(
  ExternalSettlementDomTreeProvider.prototype,
  "settleFrameRegistryDocumentResets",
  {
    configurable: true,
    value(this: ExternalSettlementDomTreeProvider): void {
      this.settlementTrapCalls += 1;
    },
  },
);

class ExternalMutationBridgeDomTreeProvider extends DomTreeProvider {
  public mutationBridgeTrapCalls = 0;
  public settlementTrapCalls = 0;
}

Object.defineProperties(ExternalMutationBridgeDomTreeProvider.prototype, {
  settleFrameRegistryDocumentResets: {
    configurable: true,
    value(this: ExternalMutationBridgeDomTreeProvider): void {
      this.settlementTrapCalls += 1;
    },
  },
  withFrameRegistryMutation: {
    configurable: true,
    value(
      this: ExternalMutationBridgeDomTreeProvider,
      operation: () => unknown,
    ): unknown {
      this.mutationBridgeTrapCalls += 1;
      return operation();
    },
  },
});

class ExternalResetAuthorityDomTreeProvider extends DomTreeProvider {
  public blockDrain = false;
  public drainTrapCalls = 0;
  public applyTrapCalls = 0;
  public currentTrapCalls = 0;
  public scanCurrentTrapCalls = 0;
}

const baseDrainDocumentResets = Object.getOwnPropertyDescriptor(
  DomTreeProvider.prototype,
  "drainDocumentResets",
)?.value as ((this: DomTreeProvider) => void) | undefined;
const baseApplyDocumentReset = Object.getOwnPropertyDescriptor(
  DomTreeProvider.prototype,
  "applyDocumentReset",
)?.value as ((this: DomTreeProvider, request: unknown) => void) | undefined;
const baseIsDocumentResetCurrent = Object.getOwnPropertyDescriptor(
  DomTreeProvider.prototype,
  "isDocumentResetCurrent",
)?.value as ((this: DomTreeProvider, request: unknown) => boolean) | undefined;
const baseIsDocumentResetScanCurrent = Object.getOwnPropertyDescriptor(
  DomTreeProvider.prototype,
  "isDocumentResetScanCurrent",
)?.value as ((this: DomTreeProvider, request: unknown) => boolean) | undefined;

Object.defineProperties(ExternalResetAuthorityDomTreeProvider.prototype, {
  drainDocumentResets: {
    configurable: true,
    value(this: ExternalResetAuthorityDomTreeProvider): void {
      this.drainTrapCalls += 1;
      if (!this.blockDrain) baseDrainDocumentResets?.call(this);
    },
  },
  applyDocumentReset: {
    configurable: true,
    value(this: ExternalResetAuthorityDomTreeProvider, request: unknown): void {
      this.applyTrapCalls += 1;
      baseApplyDocumentReset?.call(this, request);
    },
  },
  isDocumentResetCurrent: {
    configurable: true,
    value(
      this: ExternalResetAuthorityDomTreeProvider,
      request: unknown,
    ): boolean {
      this.currentTrapCalls += 1;
      return baseIsDocumentResetCurrent?.call(this, request) ?? false;
    },
  },
  isDocumentResetScanCurrent: {
    configurable: true,
    value(
      this: ExternalResetAuthorityDomTreeProvider,
      request: unknown,
    ): boolean {
      this.scanCurrentTrapCalls += 1;
      return baseIsDocumentResetScanCurrent?.call(this, request) ?? false;
    },
  },
});

describe("DomTreeProvider", () => {
  it("binds default timers to the inspected document window", () => {
    const document = createDocument();
    const pendingTimers = new Map<number, TimerHandler>();
    let nextTimer = 1;
    const timerWindow = {
      setTimeout(this: unknown, handler: TimerHandler): number {
        if (this !== timerWindow) {
          throw new TypeError(
            "'setTimeout' called on an object that does not implement interface Window.",
          );
        }
        const timer = nextTimer;
        nextTimer += 1;
        pendingTimers.set(timer, handler);
        return timer;
      },
      clearTimeout(this: unknown, timer?: number): void {
        if (this !== timerWindow) {
          throw new TypeError(
            "'clearTimeout' called on an object that does not implement interface Window.",
          );
        }
        if (timer !== undefined) pendingTimers.delete(timer);
      },
    };
    Object.defineProperty(document, "defaultView", {
      configurable: true,
      value: timerWindow as unknown as Window,
    });
    vi.stubGlobal("setTimeout", timerWindow.setTimeout);
    vi.stubGlobal("clearTimeout", timerWindow.clearTimeout);

    try {
      const provider = new DomTreeProvider(document as unknown as Document, {
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      });

      expect(() => provider.startFrameTracking()).not.toThrow();
      expect(pendingTimers.size).toBe(1);

      provider.dispose();
      expect(pendingTimers.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns structured element, text, and comment children in fixed-size pages", () => {
    const document = createDocument();
    for (let index = 0; index < 17; index += 1) {
      document.documentElement.append(createText(`before-${index}`));
      document.documentElement.append(createElement("section", document));
      document.documentElement.append(createComment(`after-${index}`));
    }
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(root.node.locator).toMatchObject({
      version: 1,
      targetKind: "element",
      boundaries: expect.any(Array),
      path: expect.any(Array),
    });
    expect(Object.isFrozen(root.node.locator)).toBe(true);
    expect(Object.isFrozen(root.node.locator.boundaries)).toBe(true);
    expect(Object.isFrozen(root.node.locator.path)).toBe(true);

    const first = provider.getChildren({
      type: "dom.getChildren",
      requestId: "children-1",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(first.nodes).toHaveLength(50);
    expect(first.nodes.slice(0, 6).map((node) => node.kind)).toEqual([
      "text",
      "element",
      "comment",
      "text",
      "element",
      "comment",
    ]);
    expect(first.nodes[0]).toMatchObject({
      nodeType: 3,
      nodeName: "#text",
      nodeValue: "before-0",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
    });
    expect(first.nodes[1]).toMatchObject({
      nodeType: 1,
      nodeName: "SECTION",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: true,
    });
    expect(first.nodes[2]).toMatchObject({
      nodeType: 8,
      nodeName: "#comment",
      nodeValue: "after-0",
      selectable: false,
    });
    expect(first.nodes.filter((node) => node.kind !== "element")
      .every((node) => node.locator === undefined)).toBe(true);
    expect(Object.isFrozen(first.nodes[1]?.attributes)).toBe(true);
    expect(first.nextCursor).toBeDefined();

    const second = provider.getChildren({
      type: "dom.getChildren",
      requestId: "children-2",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: first.branchRevision,
      cursor: first.nextCursor,
    });
    expect(second.nodes).toHaveLength(1);
  });

  it("keeps a hostile root attribute surface displayable without selection authority", () => {
    const document = createDocument();
    Object.defineProperty(document.documentElement, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile root attributes");
      },
    });
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(root.node).toMatchObject({ attributes: [], selectable: true });
    expect(root.node).not.toHaveProperty("locator");
    expect(() => provider.resolveElement(root.node.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
  });

  it("keeps hostile child attribute proxies displayable without selection authority", () => {
    const document = createDocument();
    const child = createElement("article", document);
    child.setAttribute("title", "secret");
    const attributes = child.attributes;
    Object.defineProperty(child, "attributes", {
      configurable: true,
      get: () => new Proxy(attributes, {
        get(target, property, receiver) {
          if (property === "0") throw new Error("hostile attribute row");
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    document.documentElement.append(child);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const childView = onlyChild(provider, root.node, root.documentEpoch, "hostile-child");

    expect(childView).toMatchObject({ attributes: [], selectable: true });
    expect(childView).not.toHaveProperty("locator");
    expect(() => provider.resolveElement(childView.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
  });

  it("keeps locator-only attribute failures beyond the display bound displayable", () => {
    const document = createDocument();
    const child = createElement("article", document);
    for (let index = 0; index < 101; index += 1) {
      child.setAttribute(`data-value-${String(index).padStart(3, "0")}`, `${index}`);
    }
    const attributes = child.attributes;
    Object.defineProperty(child, "attributes", {
      configurable: true,
      get: () => new Proxy(attributes, {
        get(target, property, receiver) {
          if (property === "100") throw new Error("late hostile attribute row");
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    document.documentElement.append(child);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const childView = onlyChild(provider, root.node, root.documentEpoch, "late-hostile-child");

    expect(childView.attributes).toHaveLength(64);
    expect(childView).not.toHaveProperty("locator");
    expect(() => provider.resolveElement(childView.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
  });

  it.each([
    ["invalid tag", (child: FakeElement) => {
      Object.defineProperty(child, "tagName", {
        configurable: true,
        get: () => {
          throw new Error("hostile tag topology");
        },
      });
    }],
    ["invalid parent topology", (child: FakeElement) => {
      Object.defineProperty(child, "parentNode", {
        configurable: true,
        get: () => {
          throw new Error("hostile parent topology");
        },
      });
    }],
  ] as const)("does not hide %s failures behind a hostile attribute getter", (
    _description,
    makeUnrelatedFailure,
  ) => {
    const document = createDocument();
    const child = createElement("article", document);
    document.documentElement.append(child);
    makeUnrelatedFailure(child);
    Object.defineProperty(child, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile attributes must not mask topology");
      },
    });
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(() => onlyChild(provider, root.node, root.documentEpoch, "unrelated-failure"))
      .toThrowError("node-unavailable");
  });

  it.each([
    ["oversized length", { length: 257 }],
    ["malformed length", { length: "1", 0: { name: "data-safe", value: "x" } }],
    ["malformed row", { length: 1, 0: null }],
  ] as const)("fails closed for a %s attribute collection", (_description, attributes) => {
    const document = createDocument();
    const child = createElement("article", document);
    Object.defineProperty(child, "attributes", {
      configurable: true,
      value: attributes,
    });
    document.documentElement.append(child);
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(() => onlyChild(provider, root.node, root.documentEpoch, "malformed-attributes"))
      .toThrowError("node-unavailable");
  });

  it("distinguishes known non-element refs from unknown and stale element refs", () => {
    const document = createDocument();
    const doctype = createDocumentType();
    const text = createText("text");
    const comment = createComment("comment");
    const host = createElement("article", document);
    host.attachShadow().append(createElement("span", document));
    const frame = createFrameElement(document, createDocument());
    document.prepend(doctype);
    document.documentElement.append(text);
    document.documentElement.append(comment);
    document.documentElement.append(host);
    document.documentElement.append(frame);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const children = provider.getChildren({
      type: "dom.getChildren",
      requestId: "known-non-elements",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const shadow = onlyChild(
      provider,
      children.find((node) => node.nodeName === "ARTICLE")!,
      root.documentEpoch,
      "known-shadow",
    );
    const frameDocument = onlyChild(
      provider,
      children.find((node) => node.nodeName === "IFRAME")!,
      root.documentEpoch,
      "known-frame-document",
    );
    const known = [
      root.prologue.find((node) => node.kind === "document-type")!,
      children.find((node) => node.kind === "text")!,
      children.find((node) => node.kind === "comment")!,
      shadow,
      frameDocument,
    ];

    for (const view of known) {
      try {
        provider.resolveElement(view.nodeRef, root.documentEpoch);
        throw new Error(`expected ${view.kind} to be unavailable`);
      } catch (error) {
        expect(error).toMatchObject({ code: "node-unavailable" });
      }
    }
    expect(provider.resolveElement("missing-ref", root.documentEpoch)).toBeUndefined();
    expect(() => provider.resolveElement(root.node.nodeRef, root.documentEpoch - 1))
      .toThrowError("stale-document");
  });

  it("never splits astral characters at element label token boundaries", () => {
    const document = createDocument();
    const tag = createElement("section", document);
    let tagReads = 0;
    Object.defineProperty(tag, "tagName", {
      configurable: true,
      get: () => tagReads++ === 4 ? `${"t".repeat(63)}😀` : "SECTION",
    });
    const identified = createElement("article", document);
    identified.id = `${"i".repeat(63)}😀`;
    const classified = createElement("aside", document);
    classified.className = `${"c".repeat(63)}😀`;
    for (const element of [identified, classified]) {
      Object.defineProperty(element, "attributes", {
        configurable: true,
        get: () => {
          throw new Error("label-only hostile attributes");
        },
      });
    }
    document.documentElement.append(tag);
    document.documentElement.append(identified);
    document.documentElement.append(classified);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const labels = provider.getChildren({
      type: "dom.getChildren",
      requestId: "astral-labels",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label);

    expect(labels).toHaveLength(3);
    expect(labels.every((label) => !containsUnpairedSurrogate(label))).toBe(true);
  });

  it.each([
    ["simple", "", "", "<!DOCTYPE html>"],
    ["PUBLIC", "-//W3C//DTD XHTML 1.0 Strict//EN", "xhtml1-strict.dtd", "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Strict//EN\" \"xhtml1-strict.dtd\">"],
    ["SYSTEM", "", "about:legacy-compat", "<!DOCTYPE html SYSTEM \"about:legacy-compat\">"],
  ])("preserves %s doctypes and top-level comment placement", (
    _case,
    publicId,
    systemId,
    expectedLabel,
  ) => {
    const document = createDocument();
    const leading = createComment("leading");
    const doctype = createDocumentType("html", publicId, systemId);
    const trailing = createComment("trailing");
    document.prepend(leading);
    document.prepend(doctype);
    document.append(trailing);
    const root = createProvider(document).getRoot();

    expect(root.node).toMatchObject({
      kind: "element",
      nodeType: 1,
      nodeName: "HTML",
      attributes: [],
      childCount: 0,
      relationship: "dom",
      selectable: true,
    });
    expect(root.prologue).toEqual([
      expect.objectContaining({
        kind: "document-type",
        nodeType: 10,
        nodeName: "html",
        publicId,
        systemId,
        attributes: [],
        childCount: 0,
        relationship: "dom",
        selectable: false,
        expandable: false,
        label: expectedLabel,
      }),
      expect.objectContaining({
        kind: "comment",
        nodeValue: "leading",
      }),
    ]);
    expect(root.epilogue).toEqual([
      expect.objectContaining({ kind: "comment", nodeValue: "trailing" }),
    ]);
    expect([...root.prologue, ...root.epilogue]
      .every((node) => node.locator === undefined)).toBe(true);
    expect(Object.isFrozen(root.prologue)).toBe(true);
    expect(Object.isFrozen(root.epilogue)).toBe(true);
  });

  it("bounds attributes, root scans, auxiliary rows, and UTF-16 values", () => {
    const document = createDocument();
    for (let index = 0; index < 140; index += 1) {
      document.prepend(createComment(`leading-${index}`));
    }
    const element = createElement("article", document);
    for (let index = 0; index < 70; index += 1) {
      element.setAttribute(
        `data-${index}-${"n".repeat(300)}`,
        `${"v".repeat(16_383)}😀tail`,
      );
    }
    const text = createText(`${"t".repeat(16_383)}😀tail`);
    element.append(text);
    document.documentElement.append(element);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const elementView = provider.getChildren({
      type: "dom.getChildren",
      requestId: "bounded-root-child",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.at(-1)!;
    const textView = onlyChild(
      provider,
      elementView,
      root.documentEpoch,
      "bounded-text",
    );

    expect(root.prologue).toHaveLength(32);
    expect(elementView.attributes.length).toBeLessThanOrEqual(64);
    expect(elementView.attributes.every(({ name }) => name.length <= 256)).toBe(true);
    expect(elementView.attributes.every(({ value }) => value.length <= 16_384)).toBe(true);
    expect(elementView.attributes.every(({ value }) => !endsWithUnpairedSurrogate(value)))
      .toBe(true);
    expect(elementView.expandable).toBe(true);
    expect(textView.nodeValue?.length).toBeLessThanOrEqual(16_384);
    expect(endsWithUnpairedSurrogate(textView.nodeValue ?? "")).toBe(false);
  });

  it("keeps generated child responses within the UTF-8 envelope by omitting whole fields or rows", () => {
    const document = createDocument();
    const source = `${"😀".repeat(8_191)}x😀tail`;
    for (let index = 0; index < 50; index += 1) {
      document.documentElement.append(createText(source));
    }
    const provider = createProvider(document);
    const root = provider.getRoot();

    const response = provider.getChildren({
      type: "dom.getChildren",
      requestId: "utf8-envelope",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(utf8ByteLength(JSON.stringify(response))).toBeLessThanOrEqual(64 * 1024);
    expect(response.nodes).not.toHaveLength(0);
    expect(response.nodes.every((node) => (
      node.nodeValue === undefined ||
      (node.nodeValue.length <= 16_384 && !endsWithUnpairedSurrogate(node.nodeValue))
    ))).toBe(true);
    expect(response.nodes.length < 50 || response.nodes.some((node) => node.nodeValue === undefined))
      .toBe(true);
  });

  it("bounds attribute-heavy child envelopes with one whole-response scan", () => {
    const document = createDocument();
    const attributeNames = Array.from(
      { length: 16 },
      (_, index) => `data-payload-${String(index).padStart(2, "0")}`,
    );
    const attributeValue = `${"v".repeat(2_047)}😀`;
    for (let nodeIndex = 0; nodeIndex < 8; nodeIndex += 1) {
      const child = createElement("article", document);
      for (const name of attributeNames) child.setAttribute(name, attributeValue);
      document.documentElement.append(child);
    }
    const provider = createProvider(document);
    const root = provider.getRoot();

    const work = measureDomEnvelopeSerialization("dom.children", () => (
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "bounded-children-work",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      })
    ));
    const repeated = provider.getChildren({
      type: "dom.getChildren",
      requestId: "bounded-children-work",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(work.envelopeCalls).toBeLessThanOrEqual(1);
    expect(work.envelopeBytes).toBeLessThanOrEqual(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(utf8ByteLength(JSON.stringify(work.result))).toBeLessThanOrEqual(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(() => parseDomResponse(work.result)).not.toThrow();
    expect(Object.isFrozen(work.result)).toBe(true);
    expect(Object.isFrozen(work.result.nodes)).toBe(true);
    expect(work.result.nodes).toEqual(repeated.nodes);
    expect(work.result.nodes.some((node) => node.attributes.length === 16)).toBe(true);
    expect(work.result.nodes.some((node) => node.attributes.length < 16)).toBe(true);
    for (const node of work.result.nodes) {
      expect(Object.isFrozen(node)).toBe(true);
      expect(Object.isFrozen(node.attributes)).toBe(true);
      expect(node.attributes.map(({ name }) => name)).toEqual(
        attributeNames.slice(0, node.attributes.length),
      );
      for (const attribute of node.attributes) {
        expect(Object.isFrozen(attribute)).toBe(true);
        expect(attribute.value).toBe(attributeValue);
        expect(containsUnpairedSurrogate(attribute.value)).toBe(false);
      }
    }
  });

  it("bounds attribute-heavy root envelopes with one whole-response scan", () => {
    const document = createDocument();
    const attributeNames = Array.from(
      { length: 64 },
      (_, index) => `data-root-${String(index).padStart(2, "0")}`,
    );
    const attributeValue = `${"r".repeat(2_047)}😀`;
    for (const name of attributeNames) {
      document.documentElement.setAttribute(name, attributeValue);
    }
    const provider = createProvider(document);

    const work = measureDomEnvelopeSerialization("dom.root", () => provider.getRoot());
    const repeated = provider.getRoot();

    expect(work.envelopeCalls).toBeLessThanOrEqual(1);
    expect(work.envelopeBytes).toBeLessThanOrEqual(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(utf8ByteLength(JSON.stringify(work.result))).toBeLessThanOrEqual(
      DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
    );
    expect(() => parseDomResponse(work.result)).not.toThrow();
    expect(Object.isFrozen(work.result)).toBe(true);
    expect(Object.isFrozen(work.result.node)).toBe(true);
    expect(Object.isFrozen(work.result.node.attributes)).toBe(true);
    expect(work.result.node).toEqual(repeated.node);
    expect(work.result.node.attributes.length).toBeGreaterThan(0);
    expect(work.result.node.attributes.length).toBeLessThan(64);
    expect(work.result.node.attributes.map(({ name }) => name)).toEqual(
      attributeNames.slice(0, work.result.node.attributes.length),
    );
    for (const attribute of work.result.node.attributes) {
      expect(Object.isFrozen(attribute)).toBe(true);
      expect(attribute.value).toBe(attributeValue);
      expect(containsUnpairedSurrogate(attribute.value)).toBe(false);
    }
  });

  it("paginates every row exactly once when mandatory labels force envelope row drops", () => {
    const document = createDocument();
    for (let index = 0; index < 50; index += 1) {
      document.documentElement.append(createText(
        `${String(index).padStart(2, "0")}${"\u0000".repeat(498)}`,
      ));
    }
    const provider = createProvider(document);
    const root = provider.getRoot();
    const nodeRefs: string[] = [];
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const response = provider.getChildren({
        type: "dom.getChildren",
        requestId: `row-drop-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      expect(() => parseDomResponse(response)).not.toThrow();
      expect(utf8ByteLength(JSON.stringify(response))).toBeLessThanOrEqual(
        DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
      );
      expect(Object.isFrozen(response)).toBe(true);
      expect(Object.isFrozen(response.nodes)).toBe(true);
      expect(response.nodes.length).toBeGreaterThan(0);
      if (pageIndex === 0) expect(response.nodes.length).toBeLessThan(50);
      nodeRefs.push(...response.nodes.map(({ nodeRef }) => nodeRef));
      cursor = response.nextCursor;
      pageIndex += 1;
    } while (cursor);

    expect(nodeRefs).toHaveLength(50);
    expect(new Set(nodeRefs).size).toBe(50);
  });

  it("reserves the root envelope for a maximally escaped request identifier", () => {
    const document = createDocument();
    for (let index = 0; index < 64; index += 1) {
      document.documentElement.setAttribute(`data-${index}`, "v".repeat(1_000));
    }
    const provider = createProvider(document);
    const routed = {
      ...provider.getRoot(),
      requestId: "\u0000".repeat(128),
    };

    expect(utf8ByteLength(JSON.stringify(routed))).toBeLessThanOrEqual(64 * 1024);
  });

  it("bounds hostile character-data getters without losing safe siblings", () => {
    const document = createDocument();
    const safe = createElement("section", document);
    safe.setAttribute("data-safe", "yes");
    const hostile = createElement("article", document);
    const hostileText = createText("secret text");
    Object.defineProperty(hostileText, "nodeValue", {
      get: () => {
        throw new Error("hostile character data");
      },
    });
    hostile.append(hostileText);
    document.documentElement.append(safe);
    document.documentElement.append(hostile);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const children = provider.getChildren({
      type: "dom.getChildren",
      requestId: "hostile-structured",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const hostileView = children.find((node) => node.nodeName === "ARTICLE")!;

    expect(children.find((node) => node.nodeName === "SECTION")?.attributes)
      .toEqual([{ name: "data-safe", value: "yes" }]);
    expect(hostileView.attributes).toEqual([]);
    expect(onlyChild(provider, hostileView, root.documentEpoch, "hostile-text"))
      .not.toHaveProperty("nodeValue");
  });

  it("serializes an explicit expandable open-shadow-root container", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const hostView = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;

    const children = provider.getChildren({
      type: "dom.getChildren",
      requestId: "host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });

    expect(hostView.expandable).toBe(true);
    expect(children.nodes).toContainEqual(expect.objectContaining({
      kind: "shadow-root",
      nodeType: 11,
      nodeName: "#document-fragment",
      attributes: [],
      childCount: 1,
      relationship: "shadow-root",
      selectable: false,
      expandable: true,
    }));
    expect(children.nodes.find((node) => node.kind === "shadow-root")?.locator)
      .toMatchObject({ version: 1, targetKind: "shadow-root" });
  });

  it("invalidates an expanded branch before serving revision two", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });

    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();

    expect(invalidated).toEqual([
      { nodeRef: parentView.nodeRef, branchRevision: 2 },
      { nodeRef: root.node.nodeRef, branchRevision: 2 },
    ]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).branchRevision).toBe(2);
  });

  it("bounds and snapshots a 100k-record observer callback at intake", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    let indexedRecordReads = 0;
    let targetReads = 0;
    const repeatedRecord = new Proxy(
      attributeMutationRecord(document.documentElement, "data-hostile"),
      {
        get(target, property, receiver) {
          if (property === "target") targetReads += 1;
          return Reflect.get(target, property, receiver) as unknown;
        },
      },
    );
    const records = repeatedIndexedList(
      100_000,
      repeatedRecord,
      () => { indexedRecordReads += 1; },
    );

    harness.observers[0]!.emit(records);

    const state = harness.provider as unknown as {
      pendingMutations: readonly Array<Record<string, unknown>>;
      pendingMutationNodeCount: number;
      pendingMutationOverflow?: {
        observedRoots: ReadonlySet<Node>;
        targets: ReadonlySet<Node>;
      };
    };
    expect(indexedRecordReads).toBeGreaterThan(0);
    expect(indexedRecordReads).toBeLessThanOrEqual(4_097);
    expect(targetReads).toBeGreaterThan(0);
    expect(targetReads).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutations).toHaveLength(4_096);
    expect(state.pendingMutations[0]).not.toHaveProperty("record");
    expect(state.pendingMutationNodeCount).toBe(0);
    expect(state.pendingMutationOverflow?.observedRoots.size).toBeLessThanOrEqual(128);
    expect(state.pendingMutationOverflow?.targets.size).toBeLessThanOrEqual(128);

    let tailReads = 0;
    const unreadTail = new Proxy([] as MutationRecord[], {
      get(target, property, receiver) {
        if (property === "length") {
          tailReads += 1;
          throw new Error("overflow tail inspected");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    expect(() => harness.observers[0]!.emit(unreadTail)).not.toThrow();
    expect(tailReads).toBe(0);
  });

  it("does not retain hostile MutationRecord or NodeList access until its timer", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const added = createElement("aside", document);
    let armed = false;
    let recordReads = 0;
    let nodeReads = 0;
    const addedNodes = repeatedIndexedList(1, added, () => {
      nodeReads += 1;
      if (armed) throw new Error("late NodeList read");
    });
    const record = new Proxy({
      type: "childList",
      target: document.documentElement,
      addedNodes,
      removedNodes: [] as readonly FakeNode[],
    } as unknown as MutationRecord, {
      get(target, property, receiver) {
        recordReads += 1;
        if (armed) throw new Error("late MutationRecord read");
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    harness.observers[0]!.emit([record]);
    expect(recordReads).toBeGreaterThan(0);
    expect(nodeReads).toBe(1);

    armed = true;
    expect(() => harness.flushTimers()).not.toThrow();
  });

  it("bounds record intake from the synchronous takeRecords barrier", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    let indexedRecordReads = 0;
    const record = attributeMutationRecord(
      document.documentElement,
      "data-barrier",
    );
    harness.observers[0]!.queue(repeatedIndexedList(
      100_000,
      record,
      () => { indexedRecordReads += 1; },
    ));

    expect(() => harness.provider.getRoot()).not.toThrow();

    const state = harness.provider as unknown as {
      pendingMutations: readonly unknown[];
      pendingMutationNodeCount: number;
    };
    expect(indexedRecordReads).toBeGreaterThan(0);
    expect(indexedRecordReads).toBeLessThanOrEqual(4_097);
    expect(state.pendingMutations).toHaveLength(0);
    expect(state.pendingMutationNodeCount).toBe(0);
  });

  it("bounds hostile child-list traversal during observer intake", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const added = createElement("aside", document);
    let indexedNodeReads = 0;
    const hostileNodes = repeatedIndexedList(100_000, added, () => {
      indexedNodeReads += 1;
      if (indexedNodeReads > 300) {
        throw new Error("unbounded NodeList traversal");
      }
    });
    let tailGetterReads = 0;
    const recordSource = {
      type: "childList",
      target: document.documentElement,
      removedNodes: hostileNodes,
    };
    Object.defineProperty(recordSource, "addedNodes", {
      get: () => {
        tailGetterReads += 1;
        throw new Error("overflow tail NodeList inspected");
      },
    });
    const record = recordSource as unknown as MutationRecord;

    expect(() => harness.observers[0]!.emit([record])).not.toThrow();
    expect(indexedNodeReads).toBeGreaterThan(0);
    expect(indexedNodeReads).toBeLessThanOrEqual(257);
    expect(tailGetterReads).toBe(0);
    expect(() => harness.flushTimers()).not.toThrow();
  });

  it("bounds copied child-list nodes across the complete pending drain", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const added = createElement("aside", document);
    let indexedNodeReads = 0;
    const records = Array.from({ length: 17 }, () => ({
      type: "childList",
      target: document.documentElement,
      addedNodes: repeatedIndexedList(256, added, () => {
        indexedNodeReads += 1;
      }),
      removedNodes: [] as readonly FakeNode[],
    } as unknown as MutationRecord));

    harness.observers[0]!.emit(records.slice(0, 16));
    harness.observers[0]!.emit(records.slice(16));

    const state = harness.provider as unknown as {
      pendingMutationNodeCount: number;
      pendingMutationOverflow?: unknown;
    };
    expect(indexedNodeReads).toBeGreaterThan(0);
    expect(indexedNodeReads).toBeLessThanOrEqual(4_097);
    expect(state.pendingMutationNodeCount).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutationOverflow).toBeDefined();
  });

  it("bounds record intake when an indexed record getter reenters", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const record = attributeMutationRecord(
      document.documentElement,
      "data-reentrant-index",
    );
    let reentered = false;
    const outerRecords = new Proxy([] as MutationRecord[], {
      get(target, property, receiver) {
        if (property === "length") return 101;
        if (typeof property === "string" && /^\d+$/.test(property)) {
          if (!reentered) {
            reentered = true;
            harness.observers[0]!.emit(repeatedIndexedList(
              4_096,
              record,
              () => undefined,
            ));
          }
          return record;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    harness.observers[0]!.emit(outerRecords);

    const state = harness.provider as unknown as {
      pendingMutations: readonly unknown[];
      pendingMutationOverflow?: unknown;
    };
    expect(reentered).toBe(true);
    expect(state.pendingMutations.length).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutationOverflow).toBeDefined();
  });

  it("bounds record intake when a MutationRecord getter reenters", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const nestedRecord = attributeMutationRecord(
      document.documentElement,
      "data-nested-record",
    );
    let reentered = false;
    const outerRecord = new Proxy(attributeMutationRecord(
      document.documentElement,
      "data-outer-record",
    ), {
      get(target, property, receiver) {
        if (property === "type" && !reentered) {
          reentered = true;
          harness.observers[0]!.emit(repeatedIndexedList(
            4_096,
            nestedRecord,
            () => undefined,
          ));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    harness.observers[0]!.emit([outerRecord]);

    const state = harness.provider as unknown as {
      pendingMutations: readonly unknown[];
      pendingMutationOverflow?: unknown;
    };
    expect(reentered).toBe(true);
    expect(state.pendingMutations.length).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutationOverflow).toBeDefined();
  });

  it("bounds copied nodes when a NodeList getter reenters intake", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const node = createElement("aside", document);
    const nestedRecords = Array.from({ length: 16 }, () => mutationRecord(
      document.documentElement,
      Array.from({ length: 256 }, () => node),
    ));
    let reentered = false;
    const outerNodes = repeatedIndexedList(256, node, () => {
      if (!reentered) {
        reentered = true;
        harness.observers[0]!.emit(nestedRecords);
      }
    });
    const outerRecord = {
      type: "childList",
      target: document.documentElement,
      removedNodes: outerNodes,
      addedNodes: [] as readonly FakeNode[],
    } as unknown as MutationRecord;

    harness.observers[0]!.emit([outerRecord]);

    const state = harness.provider as unknown as {
      pendingMutations: readonly unknown[];
      pendingMutationNodeCount: number;
      pendingMutationOverflow?: unknown;
    };
    expect(reentered).toBe(true);
    expect(state.pendingMutations.length).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutationNodeCount).toBeLessThanOrEqual(4_096);
    expect(state.pendingMutationOverflow).toBeDefined();
  });

  it("releases the intake guard after a reentrant getter throws", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    let reentered = false;
    const hostile = new Proxy(attributeMutationRecord(
      document.documentElement,
      "data-hostile-reentry",
    ), {
      get(target, property, receiver) {
        if (property === "type" && !reentered) {
          reentered = true;
          harness.observers[0]!.emit([
            attributeMutationRecord(document.documentElement, "data-nested"),
          ]);
          throw new Error("hostile record getter");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    harness.observers[0]!.emit([hostile]);
    harness.flushTimers();

    const currentObserver = harness.observers.at(-1)!;
    currentObserver.emit([
      attributeMutationRecord(document.documentElement, "data-after-error"),
    ]);

    const state = harness.provider as unknown as {
      pendingMutations: readonly unknown[];
    };
    expect(state.pendingMutations).toHaveLength(1);
  });

  it("conservatively recovers branch, cursor, and selected authority after overflow", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    for (let index = 0; index < 50; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    let selectedRef: string | undefined;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: (branch) => invalidated.push(branch),
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const root = harness.provider.getRoot();
    const rootPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "overflow-root-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });
    const parentView = rootPage.nodes[0]!;
    const selectedView = onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "overflow-parent-page",
    );
    selectedRef = selectedView.nodeRef;
    expect(harness.provider.retainNode(
      selectedRef,
      root.documentEpoch,
      "selected",
    )).toBe(true);
    expect(rootPage.nextCursor).toBeDefined();

    parent.remove(selected);
    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));
    harness.flushTimers();
    harness.flushEffects();

    expect(removed).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(harness.provider.resolveElement(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toBeUndefined();
    expect(invalidated).toEqual(expect.arrayContaining([
      { nodeRef: root.node.nodeRef, branchRevision: 2 },
      { nodeRef: parentView.nodeRef, branchRevision: 2 },
    ]));
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "overflow-stale-cursor",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
      cursor: rootPage.nextCursor,
    })).toThrow();
    expect(harness.provider.getRoot()).toMatchObject({
      documentEpoch: root.documentEpoch,
      node: {
        nodeRef: root.node.nodeRef,
        branchRevision: 2,
      },
    });
  });

  it("bounds branch generations across repeated overflow namespaces", () => {
    const document = createDocument();
    const initialChild = createElement("main", document);
    initialChild.append(createElement("p", document));
    document.documentElement.append(initialChild);
    const harness = createProviderHarness(document);
    const branchGenerations = (harness.provider as unknown as {
      readonly branchGenerations: ReadonlyMap<string, number>;
    }).branchGenerations;
    let root = harness.provider.getRoot();

    for (let cycle = 0; cycle < 8; cycle += 1) {
      const oldRootRevision = root.node.branchRevision;
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `overflow-cycle-root-${cycle}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      });
      const retired = page.nodes[0]!;
      harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `overflow-cycle-child-${cycle}`,
        documentEpoch: root.documentEpoch,
        nodeRef: retired.nodeRef,
        branchRevision: retired.branchRevision,
      });

      const oldElement = document.documentElement.childNodes[0]!;
      const replacement = createElement("main", document);
      replacement.append(createElement("p", document));
      document.documentElement.remove(oldElement);
      document.documentElement.append(replacement);
      harness.observers.at(-1)!.emit(repeatedIndexedList(
        4_097,
        attributeMutationRecord(document.documentElement, "data-overflow"),
        () => undefined,
      ));
      harness.flushTimers();

      root = harness.provider.getRoot();
      expect(root.node.branchRevision).toBe(oldRootRevision + 1);
      expect(branchGenerations).toEqual(new Map([
        [root.node.nodeRef, root.node.branchRevision],
      ]));
      const refreshed = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `overflow-cycle-refreshed-root-${cycle}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      }).nodes[0]!;
      expect(refreshed.nodeRef).not.toBe(retired.nodeRef);
      expect(() => harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `overflow-cycle-refreshed-child-${cycle}`,
        documentEpoch: root.documentEpoch,
        nodeRef: refreshed.nodeRef,
        branchRevision: refreshed.branchRevision,
      })).not.toThrow();
    }
  });

  it("retires removed frames and rediscovers current frames after overflow", () => {
    const document = createDocument();
    const oldChildDocument = createDocument();
    const oldFrame = createFrameElement(document, oldChildDocument);
    document.documentElement.append(oldFrame);
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    expect(harness.provider.frameAuthority.getContextForDocument(
      oldChildDocument as unknown as Document,
    )).toBeDefined();
    lifecycle.length = 0;

    const newChildDocument = createDocument();
    const newFrame = createFrameElement(document, newChildDocument);
    document.documentElement.remove(oldFrame);
    document.documentElement.append(newFrame);
    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));
    harness.flushTimers();
    harness.flushTimers();
    harness.flushEffects();

    expect(oldFrame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.getContextForDocument(
      oldChildDocument as unknown as Document,
    )).toBeUndefined();
    expect(newFrame.loadListenerCount).toBe(1);
    expect(harness.provider.frameAuthority.getContextForDocument(
      newChildDocument as unknown as Document,
    )).toBeDefined();
    expect(lifecycle.map((event) => event.type)).toEqual(
      expect.arrayContaining(["removed", "registered"]),
    );
  });

  it("fails closed when overflow frame discovery cannot read nodeType", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const oldFrame = createFrameElement(document, childDocument);
    document.documentElement.append(oldFrame);
    const harness = createProviderHarness(document);
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const hostile = createElement("main", document);
    document.documentElement.append(hostile);
    Object.defineProperty(hostile, "nodeType", {
      configurable: true,
      get: () => {
        throw new Error("hostile nodeType");
      },
    });

    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));

    expect(() => harness.flushTimers()).not.toThrow();
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(oldFrame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when overflow frame discovery cannot read child-list length", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const oldFrame = createFrameElement(document, childDocument);
    document.documentElement.append(oldFrame);
    const harness = createProviderHarness(document);
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const hostile = createElement("main", document);
    document.documentElement.append(hostile);
    Object.defineProperty(hostile, "childNodes", {
      configurable: true,
      get: () => ({
        get length(): number {
          throw new Error("hostile child-list length");
        },
      }),
    });

    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));
    harness.flushTimers();

    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(oldFrame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("reads overflow frame child-list length once before rediscovery", () => {
    const document = createDocument();
    const oldChildDocument = createDocument();
    const oldFrame = createFrameElement(document, oldChildDocument);
    document.documentElement.append(oldFrame);
    const harness = createProviderHarness(document);
    harness.provider.startFrameTracking();
    harness.flushTimers();
    document.documentElement.remove(oldFrame);
    const newChildDocument = createDocument();
    const newFrame = createFrameElement(document, newChildDocument);
    const container = createElement("main", document);
    container.append(newFrame);
    document.documentElement.append(container);
    const childNodes = container.childNodes;
    let lengthReads = 0;
    Object.defineProperty(container, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get(target, property, receiver) {
          if (property === "length") {
            lengthReads += 1;
            if (lengthReads > 1) {
              throw new Error("child-list length read twice");
            }
          }
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    });

    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));

    expect(() => harness.flushTimers()).not.toThrow();
    expect(lengthReads).toBe(1);
    expect(oldFrame.loadListenerCount).toBe(0);
    expect(newFrame.loadListenerCount).toBe(1);
    expect(harness.provider.frameAuthority.getContextForDocument(
      newChildDocument as unknown as Document,
    )).toBeDefined();
  });

  it("fails closed when overflow frame discovery cannot read a child index", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const oldFrame = createFrameElement(document, childDocument);
    document.documentElement.append(oldFrame);
    const harness = createProviderHarness(document);
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const hostile = createElement("main", document);
    const childNodes = [createElement("aside", document)];
    document.documentElement.append(hostile);
    Object.defineProperty(hostile, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get(target, property, receiver) {
          if (property === "0") throw new Error("hostile child index");
          return Reflect.get(target, property, receiver) as unknown;
        },
      }),
    });

    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));

    expect(() => harness.flushTimers()).not.toThrow();
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(oldFrame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when overflow frame rediscovery exhausts its total visit budget", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    harness.provider.startFrameTracking();
    harness.flushTimers();

    for (let index = 0; index < 4_100; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const childDocument = createDocument();
    document.documentElement.append(createFrameElement(document, childDocument));
    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));
    for (let slice = 0; slice < 8; slice += 1) {
      harness.flushTimers();
    }

    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it.each(["reset", "dispose"] as const)(
    "clears bounded mutation overflow state on %s",
    (action) => {
      const document = createDocument();
      const harness = createProviderHarness(document);
      harness.observers[0]!.emit(repeatedIndexedList(
        4_097,
        attributeMutationRecord(document.documentElement, "data-overflow"),
        () => undefined,
      ));
      const before = harness.provider as unknown as {
        pendingMutationOverflow?: unknown;
      };
      expect(before.pendingMutationOverflow).toBeDefined();

      if (action === "reset") {
        harness.provider.resetDocument(createDocument() as unknown as Document, 4);
      } else {
        harness.provider.dispose();
      }

      const after = harness.provider as unknown as {
        pendingMutations: readonly unknown[];
        pendingMutationNodeCount: number;
        pendingMutationOverflow?: unknown;
      };
      expect(after.pendingMutations).toEqual([]);
      expect(after.pendingMutationNodeCount).toBe(0);
      expect(after.pendingMutationOverflow).toBeUndefined();
      expect(harness.pendingTimerCount()).toBe(0);
    },
  );

  it("restores bounded mutation overflow coalescing on authority rollback", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "rollback-root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "rollback-host-children",
    );
    onlyChild(
      harness.provider,
      shadowView,
      root.documentEpoch,
      "rollback-shadow-children",
    );
    const shadowObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;
    harness.observers[0]!.emit(repeatedIndexedList(
      4_097,
      attributeMutationRecord(document.documentElement, "data-overflow"),
      () => undefined,
    ));
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      pendingMutations: readonly unknown[];
      pendingMutationNodeCount: number;
      pendingMutationOverflow?: {
        observedRoots: ReadonlySet<Node>;
      };
    };
    expect(state.pendingMutationOverflow?.observedRoots.size).toBe(1);
    const pendingTimerCount = harness.pendingTimerCount();
    const operation = state.beginProviderAuthorityOperation()!;

    shadowObserver.emit([
      attributeMutationRecord(host, "data-shadow-overflow"),
    ]);
    expect(state.pendingMutationOverflow?.observedRoots.size).toBe(2);
    expect(operation.rollback()).toBe(true);

    expect(state.pendingMutations).toHaveLength(4_096);
    expect(state.pendingMutationNodeCount).toBe(0);
    expect(state.pendingMutationOverflow?.observedRoots.size).toBe(1);
    expect(harness.pendingTimerCount()).toBe(pendingTimerCount);
  });

  it("revisions every affected branch before invalidation callbacks re-enter", () => {
    const document = createDocument();
    const firstParent = createElement("main", document);
    const secondParent = createElement("aside", document);
    firstParent.append(createElement("p", document));
    secondParent.append(createElement("p", document));
    document.documentElement.append(firstParent);
    document.documentElement.append(secondParent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    let provider: DomTreeProvider | undefined;
    let documentEpoch = 0;
    let firstRef: string | undefined;
    let secondRef: string | undefined;
    let reentryResult: string | undefined;
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => {
        invalidated.push(branch);
        if (branch.nodeRef !== firstRef || !provider || !secondRef) {
          return;
        }
        try {
          provider.getChildren({
            type: "dom.getChildren",
            requestId: "reentrant-second-parent",
            documentEpoch,
            nodeRef: secondRef,
            branchRevision: 1,
          });
          reentryResult = "served";
        } catch (error) {
          reentryResult = error instanceof DomTreeProviderError
            ? error.code
            : "unexpected-error";
        }
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    documentEpoch = root.documentEpoch;
    const parents = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    firstRef = parents[0]!.nodeRef;
    secondRef = parents[1]!.nodeRef;
    provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent",
      documentEpoch,
      nodeRef: firstRef,
      branchRevision: 1,
    });
    provider.getChildren({
      type: "dom.getChildren",
      requestId: "second-parent",
      documentEpoch,
      nodeRef: secondRef,
      branchRevision: 1,
    });

    const firstAdded = createElement("section", document);
    const secondAdded = createElement("section", document);
    firstParent.append(firstAdded);
    secondParent.append(secondAdded);
    harness.observers[0]!.emit([
      mutationRecord(firstParent, [firstAdded]),
      mutationRecord(secondParent, [secondAdded]),
    ]);
    harness.flushTimers();

    expect(reentryResult).toBe("stale-branch");
    expect(invalidated).toEqual([
      { nodeRef: firstRef, branchRevision: 2 },
      { nodeRef: root.node.nodeRef, branchRevision: 2 },
      { nodeRef: secondRef, branchRevision: 2 },
    ]);
  });

  it("invalidates the owning materialized branch for character-data mutations", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const text = createText("before");
    parent.append(text);
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    text.nodeValue = "after";
    harness.observers[0]!.emit([characterDataMutationRecord(text)]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }]);
    expect(harness.observers[0]!.observedOptions).toContainEqual(
      expect.objectContaining({ characterData: true }),
    );
  });

  it.each(["leading", "trailing"] as const)(
    "invalidates the root branch when a %s auxiliary comment changes",
    (position) => {
      const document = createDocument();
      const comment = createComment("before");
      position === "leading" ? document.prepend(comment) : document.append(comment);
      const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
      const harness = createProviderHarness(document, {
        onInvalidated: (branch) => invalidated.push(branch),
      });
      const root = harness.provider.getRoot();
      if (position === "leading") {
        harness.provider.getChildren({
          type: "dom.getChildren",
          requestId: "expanded-auxiliary-root",
          documentEpoch: root.documentEpoch,
          nodeRef: root.node.nodeRef,
          branchRevision: root.node.branchRevision,
        });
      }
      comment.nodeValue = "after";
      harness.observers[0]!.emit([characterDataMutationRecord(comment)]);
      harness.flushTimers();

      expect(invalidated).toEqual([{
        nodeRef: root.node.nodeRef,
        branchRevision: 2,
      }]);
      const refreshed = harness.provider.getRoot();
      const auxiliary = position === "leading" ? refreshed.prologue : refreshed.epilogue;
      expect(auxiliary).toEqual([
        expect.objectContaining({
          kind: "comment",
          nodeValue: "after",
          selectable: false,
          expandable: false,
        }),
      ]);
      expect(auxiliary[0]).not.toHaveProperty("locator");
    },
  );

  it.each([
    ["comment", "add"],
    ["comment", "remove"],
    ["document-type", "add"],
    ["document-type", "remove"],
  ] as const)("invalidates root auxiliaries for a top-level %s %s operation", (
    kind,
    action,
  ) => {
    const document = createDocument();
    const auxiliary = kind === "comment"
      ? createComment("marker")
      : createDocumentType();
    if (action === "remove") document.prepend(auxiliary);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    if (action === "add") {
      document.prepend(auxiliary);
      harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
    } else {
      document.remove(auxiliary);
      harness.observers[0]!.emit([mutationRecord(document, [], [auxiliary])]);
    }
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: root.node.nodeRef,
      branchRevision: 2,
    }]);
    const refreshed = harness.provider.getRoot();
    expect(refreshed.prologue.some((node) => node.kind === kind))
      .toBe(action === "add");
    expect(refreshed.prologue.every((node) => (
      node.selectable === false && node.expandable === false && node.locator === undefined
    ))).toBe(true);
  });

  it("invalidates the published root when documentElement is atomically replaced", () => {
    const document = createDocument();
    const oldElement = document.documentElement;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const oldRoot = harness.provider.getRoot();
    const replacement = createElement("html", document);

    document.remove(oldElement);
    document.append(replacement);
    harness.observers[0]!.emit([
      mutationRecord(document, [replacement], [oldElement]),
    ]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: 2,
    }]);
    expect(providerRefForNode(harness.provider, replacement)).toBeUndefined();
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "removed-root",
      documentEpoch: oldRoot.documentEpoch,
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: 2,
    })).toThrowError("unknown-node");

    const refreshed = harness.provider.getRoot(oldRoot.documentEpoch);
    expect(refreshed.documentEpoch).toBe(oldRoot.documentEpoch);
    expect(refreshed.node.nodeRef).not.toBe(oldRoot.node.nodeRef);
    expect(providerRefForNode(harness.provider, replacement)).toBe(
      refreshed.node.nodeRef,
    );

    const auxiliary = createComment("after replacement");
    document.append(auxiliary);
    harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
    harness.flushTimers();
    expect(invalidated.at(-1)).toEqual({
      nodeRef: refreshed.node.nodeRef,
      branchRevision: 2,
    });
  });

  it("keeps the removed root presentation invalidatable across a documentElement gap", () => {
    const document = createDocument();
    const oldElement = document.documentElement;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const oldRoot = harness.provider.getRoot();

    document.remove(oldElement);
    harness.observers[0]!.emit([mutationRecord(document, [], [oldElement])]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: 2,
    }]);
    expect(() => harness.provider.getRoot(oldRoot.documentEpoch))
      .toThrowError("node-unavailable");

    const replacement = createElement("html", document);
    document.append(replacement);
    harness.observers[0]!.emit([mutationRecord(document, [replacement])]);
    harness.flushTimers();

    expect(invalidated).toEqual([
      { nodeRef: oldRoot.node.nodeRef, branchRevision: 2 },
      { nodeRef: oldRoot.node.nodeRef, branchRevision: 3 },
    ]);
    expect(providerRefForNode(harness.provider, replacement)).toBeUndefined();
    const refreshed = harness.provider.getRoot(oldRoot.documentEpoch);
    expect(refreshed.documentEpoch).toBe(oldRoot.documentEpoch);
    expect(refreshed.node.nodeRef).not.toBe(oldRoot.node.nodeRef);
  });

  it("deduplicates synchronous documentElement removal and addition into one root invalidation", () => {
    const document = createDocument();
    const oldElement = document.documentElement;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const oldRoot = harness.provider.getRoot();
    const replacement = createElement("html", document);

    document.remove(oldElement);
    document.append(replacement);
    harness.observers[0]!.emit([
      mutationRecord(document, [], [oldElement]),
      mutationRecord(document, [replacement]),
    ]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: 2,
    }]);
    expect(providerRefForNode(harness.provider, replacement)).toBeUndefined();
    expect(harness.provider.getRoot(oldRoot.documentEpoch).node.nodeRef)
      .not.toBe(oldRoot.node.nodeRef);
  });

  it("retires each replaced root revision namespace after publishing its successor", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    let published = harness.provider.getRoot();
    const branchGenerations = (harness.provider as unknown as {
      readonly branchGenerations: Map<string, number>;
    }).branchGenerations;

    for (let replacementIndex = 0; replacementIndex < 4; replacementIndex += 1) {
      const previousRef = published.node.nodeRef;
      const previousElement = document.documentElement;
      const replacement = createElement("html", document);
      document.remove(previousElement);
      document.append(replacement);
      harness.observers[0]!.emit([
        mutationRecord(document, [replacement], [previousElement]),
      ]);
      harness.flushTimers();

      expect(branchGenerations.get(previousRef)).toBe(2);
      published = harness.provider.getRoot(published.documentEpoch);
      expect(branchGenerations.has(previousRef)).toBe(false);
      expect(branchGenerations.size).toBeLessThanOrEqual(1);
    }
  });

  it("aborts an old mutation drain when documentElement reentry resets authority", () => {
    const document = createDocument();
    const replacementDocument = createDocument();
    const invalidated: string[] = [];
    const frameEvents: string[] = [];
    const settledEpochs: number[] = [];
    let provider!: DomTreeProvider;
    const harness = createProviderHarness(document, {
      onInvalidated: ({ nodeRef }) => invalidated.push(nodeRef),
      onFrameLifecycle: ({ frameRef }) => frameEvents.push(frameRef),
      onMutationSettled: () => settledEpochs.push(provider.currentDocumentEpoch),
    });
    provider = harness.provider;
    const auxiliary = createComment("old-document");
    document.append(auxiliary);
    document.onDocumentElementRead = () => {
      document.onDocumentElementRead = undefined;
      provider.resetDocument(replacementDocument as unknown as Document, 4);
    };

    harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
    harness.flushTimers();

    expect(provider.currentDocumentEpoch).toBe(4);
    expect(invalidated).toEqual([]);
    expect(frameEvents).toEqual([]);
    expect(settledEpochs).toEqual([]);
    expect(provider.getRoot(4).node.label).toBe("html");
    expect((provider as unknown as {
      readonly pendingMutations: readonly unknown[];
      readonly pendingFrameMutationScans: readonly unknown[];
    })).toMatchObject({
      pendingMutations: [],
      pendingFrameMutationScans: [],
    });
  });

  it("delivers replacement-frame discovery outside a reentered old mutation journal", async () => {
    const document = createDocument();
    const replacementDocument = createDocument();
    const childDocument = createDocument();
    const replacementFrame = createFrameElement(
      replacementDocument,
      childDocument,
    );
    replacementDocument.documentElement.append(replacementFrame);
    const lifecycle: Array<{
      readonly type: string;
      readonly frameRef: string;
      readonly documentEpoch: number;
    }> = [];
    const invalidated: string[] = [];
    const settledEpochs: number[] = [];
    let provider!: DomTreeProvider;
    const harness = createProviderHarness(document, {
      onInvalidated: ({ nodeRef }) => invalidated.push(nodeRef),
      onFrameLifecycle: (event) => lifecycle.push(event),
      onMutationSettled: () => settledEpochs.push(provider.currentDocumentEpoch),
    });
    provider = harness.provider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    lifecycle.length = 0;

    const auxiliary = createComment("old-document");
    document.append(auxiliary);
    document.onDocumentElementRead = () => {
      document.onDocumentElementRead = undefined;
      provider.resetDocument(replacementDocument as unknown as Document, 4);
    };
    harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
    harness.flushTimers();
    await Promise.resolve();
    harness.flushTimers();
    harness.flushEffects();

    expect(invalidated).toEqual([]);
    expect(settledEpochs).toEqual([]);
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({
      type: "registered",
      documentEpoch: 4,
    });
    const childContext = provider.frameAuthority.accessibleContexts().find(
      (context) => context.document === childDocument,
    );
    expect(childContext).toBeDefined();
    expect(lifecycle[0]?.frameRef).toBe(childContext?.frameRef);
    expect(provider.frameAuthority.getContext(childContext!.frameRef))
      .toBe(childContext);
    const root = provider.getRoot(4);
    const frameView = onlyChild(provider, root.node, 4, "replacement-frame");
    expect(frameView.label).toBe("iframe");
  });

  it.each(["is-excluded", "create-observer", "observe"] as const)(
    "serializes a newer framed reset reentered from the %s root-observer hook",
    async (phase) => {
      const document = createDocument();
      const intermediateDocument = createDocument();
      const latestDocument = createDocument();
      const childDocument = createDocument();
      const latestFrame = createFrameElement(latestDocument, childDocument);
      latestDocument.documentElement.append(latestFrame);
      const lifecycle: FrameLifecycleEvent[] = [];
      const invalidated: string[] = [];
      const settledEpochs: number[] = [];
      let provider!: DomTreeProvider;
      let armed = false;
      let nestedResetCount = 0;
      const reenterLatestReset = () => {
        if (!armed) return;
        armed = false;
        nestedResetCount += 1;
        provider.resetDocument(latestDocument as unknown as Document, 5);
      };
      const harness = createProviderHarness(document, {
        createMutationObserver: (callback) => {
          const observer = new TestMutationObserver(callback);
          if (phase === "create-observer" && armed) {
            reenterLatestReset();
          }
          if (phase === "observe") {
            const observe = observer.observe.bind(observer);
            observer.observe = (target, options) => {
              observe(target, options);
              if (target === intermediateDocument as unknown as Node) {
                reenterLatestReset();
              }
            };
          }
          return observer;
        },
        isExcludedNode: (node) => {
          if (
            phase === "is-excluded" &&
            node === intermediateDocument as unknown as Node
          ) {
            reenterLatestReset();
          }
          return false;
        },
        onInvalidated: ({ nodeRef }) => invalidated.push(nodeRef),
        onFrameLifecycle: (event) => lifecycle.push(event),
        onMutationSettled: () => settledEpochs.push(provider.currentDocumentEpoch),
      });
      provider = harness.provider;
      provider.startFrameTracking();
      harness.flushTimers();
      harness.flushEffects();
      lifecycle.length = 0;

      const auxiliary = createComment("old-document");
      document.append(auxiliary);
      let epochAfterOuterReset: number | undefined;
      document.onDocumentElementRead = () => {
        document.onDocumentElementRead = undefined;
        armed = true;
        provider.resetDocument(intermediateDocument as unknown as Document, 4);
        epochAfterOuterReset = provider.currentDocumentEpoch;
      };
      harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
      harness.flushTimers();
      await Promise.resolve();
      harness.flushTimers();
      harness.flushEffects();

      expect(nestedResetCount).toBe(1);
      expect(epochAfterOuterReset).toBe(5);
      expect(provider.currentDocumentEpoch).toBe(5);
      expect(invalidated).toEqual([]);
      expect(settledEpochs).toEqual([]);
      const registered = lifecycle.filter((event) => event.type === "registered");
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({ documentEpoch: 5 });
      const contexts = provider.frameAuthority.accessibleContexts();
      const latestTop = contexts.find((context) => (
        context.document === latestDocument as unknown as Document
      ));
      const childContext = contexts.find((context) => (
        context.document === childDocument as unknown as Document
      ));
      expect(latestTop).toBeDefined();
      expect(childContext).toBeDefined();
      expect(registered[0]?.frameRef).toBe(childContext?.frameRef);
      const rootObservers = (provider as unknown as {
        readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
      }).rootObservers;
      expect(rootObservers.has(intermediateDocument as unknown as Node)).toBe(false);
      expect(rootObservers.has(latestDocument as unknown as Node)).toBe(true);
      expect(harness.observers.filter((observer) => (
        observer.observedTargets.includes(intermediateDocument)
      )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    },
  );

  it.each(["timer-cancel", "observer-disconnect"] as const)(
    "keeps the latest reset authoritative after reentry during %s",
    (phase) => {
      const document = createDocument();
      const intermediateDocument = createDocument();
      const latestDocument = createDocument();
      const childDocument = createDocument();
      latestDocument.documentElement.append(
        createFrameElement(latestDocument, childDocument),
      );
      const lifecycle: FrameLifecycleEvent[] = [];
      const harness = createProviderHarness(document, {
        onFrameLifecycle: (event) => lifecycle.push(event),
      });
      const provider = harness.provider;
      provider.startFrameTracking();
      harness.flushTimers();
      harness.flushEffects();
      lifecycle.length = 0;
      const state = provider as unknown as {
        mutationTimer: unknown;
        cancelTimeout(handle: unknown): void;
        readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
      };
      let armed = true;
      let nestedResetCount = 0;
      const reenterLatestReset = () => {
        if (!armed) return;
        armed = false;
        nestedResetCount += 1;
        provider.resetDocument(latestDocument as unknown as Document, 5);
      };

      if (phase === "timer-cancel") {
        state.mutationTimer = 90210;
        state.cancelTimeout = (handle) => {
          if (handle === 90210) reenterLatestReset();
        };
      } else {
        const initialObserver = harness.observers[0]!;
        const disconnect = initialObserver.disconnect.bind(initialObserver);
        initialObserver.disconnect = () => {
          disconnect();
          reenterLatestReset();
        };
      }

      expect(() => provider.resetDocument(
        intermediateDocument as unknown as Document,
        4,
      )).not.toThrow();
      harness.flushTimers();
      harness.flushEffects();

      expect(nestedResetCount).toBe(1);
      expect(provider.currentDocumentEpoch).toBe(5);
      const registered = lifecycle.filter((event) => event.type === "registered");
      expect(registered).toHaveLength(1);
      expect(registered[0]).toMatchObject({ documentEpoch: 5 });
      const childContext = provider.frameAuthority.accessibleContexts().find(
        (context) => context.document === childDocument as unknown as Document,
      );
      expect(childContext?.frameRef).toBe(registered[0]?.frameRef);
      expect(state.rootObservers.has(intermediateDocument as unknown as Node)).toBe(false);
      expect(state.rootObservers.has(latestDocument as unknown as Node)).toBe(true);
    },
  );

  it("stops an outer reset when an observer hook disposes the provider", () => {
    const document = createDocument();
    const intermediateDocument = createDocument();
    let provider!: DomTreeProvider;
    let armed = false;
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => {
        if (
          armed &&
          node === intermediateDocument as unknown as Node
        ) {
          armed = false;
          provider.dispose();
        }
        return false;
      },
    });
    provider = harness.provider;
    armed = true;

    expect(() => provider.resetDocument(
      intermediateDocument as unknown as Document,
      4,
    )).not.toThrow();

    const rootObservers = (provider as unknown as {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    }).rootObservers;
    expect(rootObservers.size).toBe(0);
    expect(harness.observers.filter((observer) => (
      observer.observedTargets.includes(intermediateDocument)
    )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    expect(() => provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
  });

  it("queues a newer reset reentered while the frame registry is mutating", () => {
    const document = createDocument();
    const initialChildDocument = createDocument();
    const initialFrame = createFrameElement(document, initialChildDocument);
    document.documentElement.append(initialFrame);
    const intermediateDocument = createDocument();
    const latestDocument = createDocument();
    const latestChildDocument = createDocument();
    latestDocument.documentElement.append(
      createFrameElement(latestDocument, latestChildDocument),
    );
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    const provider = harness.provider;
    let armed = false;
    let nestedResetCount = 0;
    const removeEventListener = initialFrame.removeEventListener.bind(initialFrame);
    initialFrame.removeEventListener = (type, listener) => {
      if (armed && type === "load") {
        armed = false;
        nestedResetCount += 1;
        provider.resetDocument(latestDocument as unknown as Document, 5);
      }
      removeEventListener(type, listener);
    };
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    expect(initialFrame.loadListenerCount).toBe(1);
    lifecycle.length = 0;
    armed = true;

    expect(() => provider.resetDocument(
      intermediateDocument as unknown as Document,
      4,
    )).not.toThrow();
    harness.flushTimers();
    harness.flushEffects();

    expect(nestedResetCount).toBe(1);
    expect(provider.currentDocumentEpoch).toBe(5);
    const registered = lifecycle.filter((event) => event.type === "registered");
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ documentEpoch: 5 });
    const childContext = provider.frameAuthority.accessibleContexts().find(
      (context) => context.document === latestChildDocument as unknown as Document,
    );
    expect(childContext?.frameRef).toBe(registered[0]?.frameRef);
  });

  it("fails closed after a bounded number of continuously reentered document resets", () => {
    const document = createDocument();
    const applicationLimit = 16;
    const attemptedApplications = applicationLimit * 2;
    const lifecycle: FrameLifecycleEvent[] = [];
    let provider!: DomTreeProvider;
    let armed = false;
    let appliedHooks = 0;
    let nextEpoch = 5;
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => {
        if (!armed || node.nodeType !== 9) return false;
        appliedHooks += 1;
        if (appliedHooks < attemptedApplications) {
          provider.resetDocument(
            createDocument() as unknown as Document,
            nextEpoch,
          );
          nextEpoch += 1;
        }
        return false;
      },
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    provider = harness.provider;
    armed = true;

    expect(() => provider.resetDocument(
      createDocument() as unknown as Document,
      4,
    )).toThrowError(expect.objectContaining({ code: "node-unavailable" }));

    expect(appliedHooks).toBe(applicationLimit);
    expect(lifecycle).toHaveLength(0);
    expect(harness.observers.length).toBeLessThanOrEqual(applicationLimit + 1);
    expect(provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(() => provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect((provider as unknown as {
      readonly topDocument: Document | undefined;
      readonly activeDocumentReset: unknown;
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
      readonly rootObservers: ReadonlyMap<Node, unknown>;
    })).toMatchObject({
      topDocument: undefined,
      activeDocumentReset: undefined,
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
      rootObservers: new Map(),
    });
  });

  it("fails closed through native cleanup when a public subclass overrides dispose", () => {
    class NoopDisposeDomTreeProvider extends DomTreeProvider {
      public disposeCalls = 0;

      public override dispose(): void {
        this.disposeCalls += 1;
      }
    }

    const document = createDocument();
    let provider!: NoopDisposeDomTreeProvider;
    let armed = false;
    let nextEpoch = 5;
    const harness = createProviderHarness(document, {
      createProvider: (topDocument, options) => {
        provider = new NoopDisposeDomTreeProvider(topDocument, options);
        return provider;
      },
      isExcludedNode: (node) => {
        if (!armed || node.nodeType !== 9) return false;
        provider.resetDocument(
          createDocument() as unknown as Document,
          nextEpoch,
        );
        nextEpoch += 1;
        return false;
      },
    });
    armed = true;

    expect(() => provider.resetDocument(
      createDocument() as unknown as Document,
      4,
    )).toThrowError(expect.objectContaining({ code: "node-unavailable" }));

    expect(provider.disposeCalls).toBe(0);
    expect(provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(() => provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("does not prototype-dispatch locator creation during document reset", () => {
    const initialDocument = createDocument();
    const replacementDocument = createDocument();
    const harness = createProviderHarness(initialDocument, { documentEpoch: 1 });
    const provider = harness.provider;
    const state = provider as unknown as {
      createLocatorService(document: Document): unknown;
      readonly frameRegistry: { readonly documentEpoch: number };
    };
    let trapCalls = 0;
    state.createLocatorService = () => {
      trapCalls += 1;
      throw new Error("external locator factory trap");
    };

    expect(() => provider.resetDocument(
      replacementDocument as unknown as Document,
      2,
    )).not.toThrow();

    expect(trapCalls).toBe(0);
    expect(provider.currentDocumentEpoch).toBe(2);
    expect(state.frameRegistry.documentEpoch).toBe(2);
    expect(provider.getRoot()).toMatchObject({ documentEpoch: 2 });
  });

  it("stops a stale reset-owned frame scan after lifecycle reentry", () => {
    const document = createDocument();
    const intermediateDocument = createDocument();
    const intermediateChildren = [
      createDocument(),
      createDocument(),
      createDocument(),
    ];
    for (const childDocument of intermediateChildren) {
      intermediateDocument.documentElement.append(
        createFrameElement(intermediateDocument, childDocument),
      );
    }
    const latestDocument = createDocument();
    const latestChildren = [createDocument(), createDocument()];
    for (const childDocument of latestChildren) {
      latestDocument.documentElement.append(
        createFrameElement(latestDocument, childDocument),
      );
    }
    const lifecycle: FrameLifecycleEvent[] = [];
    let provider!: DomTreeProvider;
    let reentered = false;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        lifecycle.push(event);
        if (
          !reentered &&
          event.type === "registered" &&
          event.documentEpoch === 4
        ) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 5);
        }
      },
    });
    provider = harness.provider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    lifecycle.length = 0;

    provider.resetDocument(intermediateDocument as unknown as Document, 4);
    harness.flushTimers();
    harness.flushEffects();

    expect(reentered).toBe(true);
    expect(provider.currentDocumentEpoch).toBe(5);
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 4
    ))).toHaveLength(1);
    const latestRegistered = lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 5
    ));
    expect(latestRegistered).toHaveLength(latestChildren.length);
    const contexts = provider.frameAuthority.accessibleContexts();
    expect(contexts.map((context) => context.document)).toEqual(
      expect.arrayContaining([
        latestDocument as unknown as Document,
        ...latestChildren.map((child) => child as unknown as Document),
      ]),
    );
    expect(contexts).toHaveLength(latestChildren.length + 1);
    for (const childDocument of intermediateChildren) {
      expect(provider.frameAuthority.getContextForDocument(
        childDocument as unknown as Document,
      )).toBeUndefined();
    }
  });

  it("rejects stale frame registration when contentDocument accepts a newer reset", () => {
    const document = createDocument();
    const intermediateDocument = createDocument();
    const intermediateChild = createDocument();
    const intermediateFrame = createFrameElement(
      intermediateDocument,
      intermediateChild,
    );
    intermediateDocument.documentElement.append(intermediateFrame);
    const latestDocument = createDocument();
    const latestChild = createDocument();
    latestDocument.documentElement.append(
      createFrameElement(latestDocument, latestChild),
    );
    const lifecycle: FrameLifecycleEvent[] = [];
    const staleOwnership: Array<{
      readonly context: boolean;
      readonly owned: boolean;
    }> = [];
    let provider!: DomTreeProvider;
    let armed = false;
    let reentered = false;
    Object.defineProperty(intermediateFrame, "contentDocument", {
      configurable: true,
      get: () => {
        intermediateFrame.contentDocumentReads += 1;
        if (armed && !reentered) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 5);
        }
        return intermediateChild as unknown as Document;
      },
    });
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        lifecycle.push(event);
        if (event.type === "registered" && event.documentEpoch === 4) {
          staleOwnership.push({
            context: provider.frameAuthority.getContextForDocument(
              intermediateChild as unknown as Document,
            ) !== undefined,
            owned: (provider as unknown as {
              readonly ownedFramesByRef: ReadonlyMap<string, unknown>;
            }).ownedFramesByRef.has(event.frameRef),
          });
        }
      },
    });
    provider = harness.provider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    lifecycle.length = 0;
    armed = true;

    provider.resetDocument(intermediateDocument as unknown as Document, 4);
    harness.flushTimers();
    harness.flushEffects();

    expect(reentered).toBe(true);
    expect(staleOwnership).toEqual([]);
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 4
    ))).toEqual([]);
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 5
    ))).toHaveLength(1);
    expect(provider.currentDocumentEpoch).toBe(5);
    expect(provider.frameAuthority.getContextForDocument(
      intermediateChild as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      latestChild as unknown as Document,
    )).toBeDefined();
  });

  it("drains a newer reset accepted during a later frame-scan slice", () => {
    const document = createDocument();
    const intermediateDocument = createDocument();
    for (let index = 0; index < 1_030; index += 1) {
      intermediateDocument.documentElement.append(
        createElement("section", intermediateDocument),
      );
    }
    const intermediateChild = createDocument();
    const intermediateFrame = createFrameElement(
      intermediateDocument,
      intermediateChild,
    );
    intermediateDocument.documentElement.append(intermediateFrame);
    const latestDocument = createDocument();
    const latestChild = createDocument();
    latestDocument.documentElement.append(
      createFrameElement(latestDocument, latestChild),
    );
    const lifecycle: FrameLifecycleEvent[] = [];
    let provider!: DomTreeProvider;
    let reentered = false;
    let armed = false;
    Object.defineProperty(intermediateFrame, "contentDocument", {
      configurable: true,
      get: () => {
        intermediateFrame.contentDocumentReads += 1;
        if (armed && !reentered) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 5);
        }
        return intermediateChild as unknown as Document;
      },
    });
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    provider = harness.provider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    lifecycle.length = 0;
    armed = true;

    provider.resetDocument(intermediateDocument as unknown as Document, 4);
    expect(provider.currentDocumentEpoch).toBe(4);
    expect(reentered).toBe(false);

    expect(() => harness.flushTimers()).not.toThrow();
    harness.flushEffects();

    expect(reentered).toBe(true);
    expect(provider.currentDocumentEpoch).toBe(5);
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 4
    ))).toEqual([]);
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 5
    ))).toHaveLength(1);
    expect(provider.frameAuthority.getContextForDocument(
      intermediateChild as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      latestChild as unknown as Document,
    )).toBeDefined();
    expect((provider as unknown as {
      readonly activeDocumentReset: unknown;
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      activeDocumentReset: undefined,
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("settles a newer reset when frame navigation exits without lifecycle", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const latestDocument = createDocument();
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    const provider = harness.provider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    expect(frame.loadListenerCount).toBe(1);
    lifecycle.length = 0;

    let reentered = false;
    const wrongOwnerDocument = createDocument();
    Object.defineProperty(frame, "ownerDocument", {
      configurable: true,
      get: () => {
        if (!reentered) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 4);
        }
        return wrongOwnerDocument;
      },
    });

    frame.dispatchLoad();
    harness.flushTimers();
    harness.flushEffects();

    expect(reentered).toBe(true);
    expect(provider.currentDocumentEpoch).toBe(4);
    expect(lifecycle.filter((event) => event.type === "navigated")).toEqual([]);
    expect(frame.loadListenerCount).toBe(0);
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect((provider as unknown as {
      readonly activeDocumentReset: unknown;
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      activeDocumentReset: undefined,
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("does not let external subclasses override frame-registry settlement", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const latestDocument = createDocument();
    let provider!: ExternalSettlementDomTreeProvider;
    let reentered = false;
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => {
        frame.contentDocumentReads += 1;
        if (!reentered) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 1);
        }
        return childDocument as unknown as Document;
      },
    });
    provider = new ExternalSettlementDomTreeProvider(
      document as unknown as Document,
      {
        documentEpoch: 0,
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      },
    );
    const root = provider.getRoot();

    try {
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "external-settlement-attack",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      });
    } catch {
      // The authority transition may invalidate the in-flight old-root query.
    }

    expect(reentered).toBe(true);
    expect.soft(provider.settlementTrapCalls).toBe(0);
    expect.soft(provider.currentDocumentEpoch).toBe(1);
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(frame.loadListenerCount).toBe(0);
    expect((provider as unknown as {
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("does not let external subclasses bypass frame-registry mutation settlement", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const latestDocument = createDocument();
    let provider!: ExternalMutationBridgeDomTreeProvider;
    let reentered = false;
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => {
        frame.contentDocumentReads += 1;
        if (!reentered) {
          reentered = true;
          provider.resetDocument(latestDocument as unknown as Document, 1);
        }
        return childDocument as unknown as Document;
      },
    });
    provider = new ExternalMutationBridgeDomTreeProvider(
      document as unknown as Document,
      {
        documentEpoch: 0,
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      },
    );
    const root = provider.getRoot();

    try {
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "external-mutation-bridge-attack",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      });
    } catch {
      // The authority transition may invalidate the in-flight old-root query.
    }

    expect(reentered).toBe(true);
    expect.soft(provider.mutationBridgeTrapCalls).toBe(0);
    expect.soft(provider.settlementTrapCalls).toBe(0);
    expect.soft(provider.currentDocumentEpoch).toBe(1);
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(frame.loadListenerCount).toBe(0);
    expect((provider as unknown as {
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("does not let external subclasses strand the latest reset drain", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const intermediateDocument = createDocument();
    const latestDocument = createDocument();
    let provider!: ExternalResetAuthorityDomTreeProvider;
    let reentered = false;
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      get: () => {
        frame.contentDocumentReads += 1;
        if (!reentered) {
          reentered = true;
          provider.resetDocument(intermediateDocument as unknown as Document, 1);
          provider.resetDocument(latestDocument as unknown as Document, 2);
        }
        return childDocument as unknown as Document;
      },
    });
    provider = new ExternalResetAuthorityDomTreeProvider(
      document as unknown as Document,
      {
        documentEpoch: 0,
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      },
    );
    provider.blockDrain = true;
    const root = provider.getRoot();

    try {
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "external-reset-drain-attack",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
      });
    } catch {
      // The authority transition may invalidate the in-flight old-root query.
    }

    expect(reentered).toBe(true);
    expect.soft(provider.drainTrapCalls).toBe(0);
    expect.soft(provider.applyTrapCalls).toBe(0);
    expect.soft(provider.currentTrapCalls).toBe(0);
    expect.soft(provider.scanCurrentTrapCalls).toBe(0);
    expect.soft(provider.currentDocumentEpoch).toBe(2);
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeUndefined();
    expect((provider as unknown as {
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("does not let external subclasses intercept ordinary reset authority", () => {
    const document = createDocument();
    const latestDocument = createDocument();
    const provider = new ExternalResetAuthorityDomTreeProvider(
      document as unknown as Document,
      {
        documentEpoch: 0,
        createMutationObserver: (callback) => new TestMutationObserver(callback),
      },
    );

    provider.resetDocument(latestDocument as unknown as Document, 1);

    expect.soft(provider.drainTrapCalls).toBe(0);
    expect.soft(provider.applyTrapCalls).toBe(0);
    expect.soft(provider.currentTrapCalls).toBe(0);
    expect.soft(provider.scanCurrentTrapCalls).toBe(0);
    expect(provider.currentDocumentEpoch).toBe(1);
    expect(provider.getRoot()).toMatchObject({ documentEpoch: 1 });
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
  });

  it("does not let external subclasses intercept deferred reset scan authority", () => {
    const document = createDocument();
    const latestDocument = createDocument();
    for (let index = 0; index < 1_030; index += 1) {
      latestDocument.documentElement.append(
        createElement("section", latestDocument),
      );
    }
    const latestChild = createDocument();
    latestDocument.documentElement.append(
      createFrameElement(latestDocument, latestChild),
    );
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      documentEpoch: 0,
      onFrameLifecycle: (event) => lifecycle.push(event),
      createProvider: (topDocument, options) => (
        new ExternalResetAuthorityDomTreeProvider(topDocument, options)
      ),
    });
    const provider = harness.provider as ExternalResetAuthorityDomTreeProvider;
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();

    provider.resetDocument(latestDocument as unknown as Document, 1);
    harness.flushTimers();
    harness.flushEffects();

    expect.soft(provider.drainTrapCalls).toBe(0);
    expect.soft(provider.applyTrapCalls).toBe(0);
    expect.soft(provider.currentTrapCalls).toBe(0);
    expect.soft(provider.scanCurrentTrapCalls).toBe(0);
    expect(provider.currentDocumentEpoch).toBe(1);
    expect(provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      latestChild as unknown as Document,
    )).toBeDefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();
    expect(lifecycle.filter((event) => (
      event.type === "registered" && event.documentEpoch === 1
    ))).toHaveLength(1);
    expect((provider as unknown as {
      readonly activeDocumentReset: unknown;
      readonly pendingDocumentReset: unknown;
      readonly drainingDocumentResets: boolean;
    })).toMatchObject({
      activeDocumentReset: undefined,
      pendingDocumentReset: undefined,
      drainingDocumentResets: false,
    });
  });

  it("keeps frame authority terminal when listener registration disposes the provider", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    const provider = harness.provider;
    const addEventListener = frame.addEventListener.bind(frame);
    let disposed = false;
    frame.addEventListener = (type, listener) => {
      addEventListener(type, listener);
      if (!disposed && type === "load") {
        disposed = true;
        provider.dispose();
      }
    };

    expect(() => provider.startFrameTracking()).not.toThrow();
    harness.flushTimers();
    harness.flushEffects();

    expect(disposed).toBe(true);
    expect(frame.loadListenerCount).toBe(0);
    expect(lifecycle).toEqual([]);
    expect(provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(provider.frameAuthority.getContext("frame-1")).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      document as unknown as Document,
    )).toBeUndefined();

    frame.dispatchLoad();
    harness.flushTimers();
    harness.flushEffects();
    expect(lifecycle).toEqual([]);
    expect(provider.frameAuthority.accessibleContexts()).toEqual([]);
  });

  it("continues an authoritative reset-owned frame scan in later slices", () => {
    const document = createDocument();
    const replacementDocument = createDocument();
    for (let index = 0; index < 1_030; index += 1) {
      replacementDocument.documentElement.append(
        createElement("section", replacementDocument),
      );
    }
    const childDocument = createDocument();
    replacementDocument.documentElement.append(
      createFrameElement(replacementDocument, childDocument),
    );
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    lifecycle.length = 0;

    harness.provider.resetDocument(
      replacementDocument as unknown as Document,
      4,
    );

    expect(lifecycle.filter((event) => event.type === "registered")).toEqual([]);
    harness.flushTimers();
    expect(lifecycle.filter((event) => event.type === "registered")).toHaveLength(1);
    expect(harness.provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeDefined();
  });

  it("finishes frame-registry disposal after dispose reenters its reset", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const replacementDocument = createDocument();
    const lifecycle: FrameLifecycleEvent[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });
    const provider = harness.provider;
    let armed = false;
    const removeEventListener = frame.removeEventListener.bind(frame);
    frame.removeEventListener = (type, listener) => {
      if (armed && type === "load") {
        armed = false;
        provider.dispose();
      }
      removeEventListener(type, listener);
    };
    provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    expect(frame.loadListenerCount).toBe(1);
    lifecycle.length = 0;
    armed = true;

    expect(() => provider.resetDocument(
      replacementDocument as unknown as Document,
      4,
    )).not.toThrow();
    harness.flushTimers();
    harness.flushEffects();

    expect(armed).toBe(false);
    expect(lifecycle).toEqual([]);
    expect(frame.loadListenerCount).toBe(0);
    expect(provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(provider.frameAuthority.getContext("frame-1")).toBeUndefined();
    expect(provider.frameAuthority.getContextForDocument(
      replacementDocument as unknown as Document,
    )).toBeUndefined();
    expect(() => provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
  });

  it("bounds unpublished root namespaces across remove and re-add cycles", () => {
    const document = createDocument();
    const invalidated: string[] = [];
    const harness = createProviderHarness(document, {
      maxRecords: 2,
      onInvalidated: ({ nodeRef }) => invalidated.push(nodeRef),
    });
    const rootElement = document.documentElement;
    let revealed = harness.provider.revealElement(rootElement as unknown as Element);

    for (let cycle = 0; cycle < 12; cycle += 1) {
      document.remove(rootElement);
      harness.observers[0]!.emit([
        mutationRecord(document, [], [rootElement]),
      ]);
      harness.flushTimers();
      document.append(rootElement);
      harness.observers[0]!.emit([
        mutationRecord(document, [rootElement]),
      ]);
      harness.flushTimers();
      const previousRef = revealed.nodeRef;
      revealed = harness.provider.revealElement(rootElement as unknown as Element);
      expect(revealed.nodeRef).not.toBe(previousRef);
    }

    const state = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly branchGenerations: ReadonlyMap<string, number>;
      readonly publishedRootPresentation?: unknown;
    };
    expect(state.records.size).toBeLessThanOrEqual(2);
    expect(state.branchGenerations.size).toBeLessThanOrEqual(2);
    expect(state.publishedRootPresentation).toBeUndefined();
    expect(new Set(invalidated).size).toBeLessThanOrEqual(2);
  });

  it("invalidates a legitimately materialized root auxiliary before root publication", () => {
    const document = createDocument();
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const revealed = harness.provider.revealElement(
      document.documentElement as unknown as Element,
    );
    const auxiliary = createComment("prepublication");
    document.append(auxiliary);

    harness.observers[0]!.emit([mutationRecord(document, [auxiliary])]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: revealed.nodeRef,
      branchRevision: 2,
    }]);
    expect((harness.provider as unknown as {
      readonly publishedRootPresentation?: unknown;
    }).publishedRootPresentation).toBeUndefined();
  });

  it("invalidates a parent page when a visible child becomes expandable", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("article", document);
    parent.append(child);
    for (let index = 0; index < 50; index += 1) {
      parent.append(createElement("section", document));
    }
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(firstPage.nodes[0]).toMatchObject({ expandable: false });

    const grandchild = createElement("button", document);
    child.append(grandchild);
    harness.observers[0]!.emit([mutationRecord(child, [grandchild])]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]).toMatchObject({ expandable: true });
  });

  it("invalidates a parent page when a visible child label changes", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("article", document);
    child.setAttribute("id", "before");
    parent.append(child);
    for (let index = 0; index < 50; index += 1) {
      parent.append(createElement("section", document));
    }
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(firstPage.nodes[0]?.label).toBe("article#before");

    child.setAttribute("id", "after");
    harness.observers[0]!.emit([attributeMutationRecord(child, "id")]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.label).toBe("article#after");
  });

  it("invalidates when an unapproved attribute shifts role into the label window", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("div", document);
    for (let index = 0; index < 32; index += 1) {
      child.setAttribute(`title-${index}`, `private-${index}`);
    }
    child.setAttribute("role", "region");
    parent.append(child);
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    expect(onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "initial-parent",
    ).label).toBe("div");

    child.removeAttribute("title-0");
    harness.observers[0]!.emit([attributeMutationRecord(child, "title-0")]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.label).toBe("div [role]");
  });

  it("invalidates when a structured attribute value changes without changing the label", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const child = createElement("div", document);
    child.setAttribute("title", "private-before");
    parent.append(child);
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    expect(onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "initial-parent",
    ).label).toBe("div");

    child.setAttribute("title", "private-after");
    harness.observers[0]!.emit([attributeMutationRecord(child, "title")]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "structured-attribute-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]).toMatchObject({
      label: "div",
      attributes: [{ name: "title", value: "private-after" }],
    });
  });

  it("refreshes structured state when the visible root mutates while collapsed", () => {
    const document = createDocument();
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();

    document.documentElement.setAttribute("data-state", "after");
    harness.observers[0]!.emit([
      attributeMutationRecord(document.documentElement, "data-state"),
    ]);
    harness.flushTimers();

    expect(invalidated).toEqual([{
      nodeRef: root.node.nodeRef,
      branchRevision: 2,
    }]);
    expect(harness.provider.getRoot().node).toMatchObject({
      branchRevision: 2,
      attributes: [{ name: "data-state", value: "after" }],
    });
  });

  it.each(["add", "remove"] as const)(
    "refreshes a collapsed visible child's structured count after a child %s",
    (action) => {
      const document = createDocument();
      const child = createElement("article", document);
      const firstGrandchild = createElement("span", document);
      const secondGrandchild = createElement("span", document);
      child.append(firstGrandchild);
      child.append(secondGrandchild);
      document.documentElement.append(child);
      const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
      const harness = createProviderHarness(document, {
        onInvalidated: (branch) => invalidated.push(branch),
      });
      const root = harness.provider.getRoot();
      const initialChild = onlyChild(
        harness.provider,
        root.node,
        root.documentEpoch,
        "initial-visible-child",
      );

      const changedGrandchild = action === "add"
        ? createElement("button", document)
        : secondGrandchild;
      if (action === "add") {
        child.append(changedGrandchild);
      } else {
        child.remove(changedGrandchild);
      }
      harness.observers[0]!.emit([
        action === "add"
          ? mutationRecord(child, [changedGrandchild])
          : mutationRecord(child, [], [changedGrandchild]),
      ]);
      harness.flushTimers();

      expect(invalidated).toEqual(expect.arrayContaining([
        { nodeRef: root.node.nodeRef, branchRevision: 2 },
        { nodeRef: initialChild.nodeRef, branchRevision: 2 },
      ]));
      expect(new Set(invalidated.map(({ nodeRef }) => nodeRef)).size).toBe(2);
      expect(invalidated).toHaveLength(2);
      const refreshedChild = onlyChild(
        harness.provider,
        { ...root.node, branchRevision: 2 },
        root.documentEpoch,
        `refreshed-visible-child-${action}`,
      );
      expect(refreshedChild).toMatchObject({
        branchRevision: 2,
        childCount: action === "add" ? 3 : 1,
        expandable: true,
      });
    },
  );

  it("rejects a cursor from an older branch revision as stale-branch", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    for (let index = 0; index < 51; index += 1) {
      parent.append(createElement("p", document));
    }
    document.documentElement.append(parent);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const parentView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes[0]!;
    const first = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
      cursor: first.nextCursor,
    })).toThrowError("stale-branch");
  });

  it("rejects a stale first expansion without acquiring branch ownership", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    })).toThrowError("stale-branch");
    expect(harness.observers).toHaveLength(1);

    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "current-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 1,
    });
    expect(harness.observers).toHaveLength(2);
  });

  it("rejects an unknown first cursor without acquiring branch ownership", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "unknown-first-cursor",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
      cursor: "missing-cursor",
    })).toThrowError("invalid-cursor");
    expect(harness.observers).toHaveLength(1);
  });

  it("returns the full root-to-node path across a shadow boundary", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    body.append(host);
    document.documentElement.append(body);
    const provider = createProvider(document);
    const root = provider.getRoot(3);
    const bodyView = onlyChild(provider, root.node, root.documentEpoch, "body");
    const hostView = onlyChild(provider, bodyView, root.documentEpoch, "host");
    const shadowView = onlyChild(provider, hostView, root.documentEpoch, "shadow");
    const buttonView = onlyChild(provider, shadowView, root.documentEpoch, "button");

    const path = provider.ancestorPath(buttonView.nodeRef, root.documentEpoch);

    expect(path.map((node) => node.nodeRef)).toEqual([
      root.node.nodeRef,
      bodyView.nodeRef,
      hostView.nodeRef,
      shadowView.nodeRef,
      buttonView.nodeRef,
    ]);
    expect(path.map((node) => node.kind)).toEqual([
      "element",
      "element",
      "element",
      "shadow-root",
      "element",
    ]);
    expect(Object.isFrozen(path)).toBe(true);
  });

  it("bounds ancestor-path and locator egress without dropping path identity", () => {
    const document = createDocument();
    const target = createElement("button", document);
    for (let index = 0; index < 64; index += 1) {
      target.setAttribute(`onclick-${index}`, "\u0000".repeat(1_000));
    }
    document.documentElement.append(target);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const targetView = onlyChild(provider, root.node, root.documentEpoch, "egress-target");
    const ancestorPath = provider.ancestorPath(targetView.nodeRef, root.documentEpoch);
    const selectionEvent = {
      type: "dom.selectionChanged" as const,
      documentEpoch: root.documentEpoch,
      selectionRevision: Number.MAX_SAFE_INTEGER,
      nodeRef: targetView.nodeRef,
      ancestorPath,
    };

    expect(ancestorPath.map(({ nodeRef }) => nodeRef)).toEqual([
      root.node.nodeRef,
      targetView.nodeRef,
    ]);
    expect(ancestorPath.at(-1)?.locator).toEqual(targetView.locator);
    expect(utf8ByteLength(JSON.stringify(selectionEvent)))
      .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    expect(() => parseDomEvent(selectionEvent)).not.toThrow();

    const resolved = provider.resolveLocator(targetView.locator!);
    expect(resolved).toBeDefined();
    const locatorResponse = {
      type: "dom.locator" as const,
      requestId: "\u0000".repeat(128),
      documentEpoch: root.documentEpoch,
      node: resolved!.node,
      ancestorPath: resolved!.ancestorPath,
    };
    expect(resolved!.ancestorPath.map(({ nodeRef }) => nodeRef)).toEqual([
      root.node.nodeRef,
      targetView.nodeRef,
    ]);
    expect(resolved!.node.locator).toEqual(targetView.locator);
    expect(resolved!.ancestorPath.at(-1)?.locator).toEqual(targetView.locator);
    expect(utf8ByteLength(JSON.stringify(locatorResponse)))
      .toBeLessThanOrEqual(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES);
    expect(() => parseDomResponse(locatorResponse)).not.toThrow();
  });

  it("discovers an open shadow root created after host expansion", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.append(createElement("span", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });

    host.attachShadow().append(createElement("button", document));
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revised-host-children",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 2,
    }).nodes[0]).toMatchObject({
      kind: "shadow-root",
      expandable: true,
    });
  });

  it("observes each discovered open shadow root independently", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "shadow-children",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
    });

    expect(harness.observers).toHaveLength(2);
    expect(harness.observers[1]!.observedTargets).toEqual([shadowRoot]);
    const added = createElement("span", document);
    shadowRoot.append(added);
    harness.observers[1]!.emit([mutationRecord(shadowRoot, [added])]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: shadowView.nodeRef,
      branchRevision: 2,
    });
  });

  it("disconnects observers across nested shadow boundaries on removal", () => {
    const document = createDocument();
    const outerHost = createElement("article", document);
    const outerShadow = outerHost.attachShadow();
    const innerHost = createElement("section", document);
    const innerShadow = innerHost.attachShadow();
    innerShadow.append(createElement("button", document));
    outerShadow.append(innerHost);
    document.documentElement.append(outerHost);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const outerHostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const outerShadowView = onlyChild(
      harness.provider,
      outerHostView,
      root.documentEpoch,
      "outer-host-children",
    );
    const innerHostView = onlyChild(
      harness.provider,
      outerShadowView,
      root.documentEpoch,
      "outer-shadow-children",
    );
    onlyChild(
      harness.provider,
      innerHostView,
      root.documentEpoch,
      "inner-host-children",
    );
    const outerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(outerShadow)
    ))!;
    const innerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(innerShadow)
    ))!;

    document.documentElement.remove(outerHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [outerHost]),
    ]);
    harness.flushTimers();

    expect(outerObserver.disconnectCount).toBe(1);
    expect(innerObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("retains shadow cleanup ownership through record pressure", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    const unrelatedHost = createElement("aside", document);
    const unrelatedShadow = unrelatedHost.attachShadow();
    unrelatedShadow.append(createElement("span", document));
    const pressureParent = createElement("main", document);
    for (let index = 0; index < 100; index += 1) {
      pressureParent.append(createElement("p", document));
    }
    document.documentElement.append(host);
    document.documentElement.append(unrelatedHost);
    document.documentElement.append(pressureParent);
    const harness = createProviderHarness(document, { maxRecords: 64 });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const shadowView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "host-shadow",
    );
    const unrelatedShadowView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "unrelated-shadow",
    );
    const firstPressurePage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "pressure-one",
      documentEpoch: root.documentEpoch,
      nodeRef: topChildren[2]!.nodeRef,
      branchRevision: topChildren[2]!.branchRevision,
    });
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "pressure-two",
      documentEpoch: root.documentEpoch,
      nodeRef: topChildren[2]!.nodeRef,
      branchRevision: topChildren[2]!.branchRevision,
      cursor: firstPressurePage.nextCursor,
    });
    const hostObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedShadow)
    ))!;
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };

    expect(internals.records.has(shadowView.nodeRef)).toBe(true);
    expect(internals.records.has(unrelatedShadowView.nodeRef)).toBe(true);
    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      hostObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
  });

  it("serializes and observes an accessible same-origin frame document", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );

    expect(frameView).toMatchObject({ kind: "element", expandable: true });
    expect(frameDocumentView).toMatchObject({
      kind: "frame-document",
      nodeType: 9,
      nodeName: "#document",
      attributes: [],
      childCount: 1,
      relationship: "frame-document",
      selectable: false,
      expandable: true,
      locator: expect.objectContaining({
        version: 1,
        targetKind: "frame-document",
      }),
    });
    expect(harness.observers[1]!.observedTargets).toEqual([childDocument]);
    expect(harness.provider.ancestorPath(childRootView.nodeRef, root.documentEpoch)
      .map((node) => node.kind)).toEqual([
      "element",
      "element",
      "frame-document",
      "element",
    ]);
  });

  it("serializes a cross-origin frame as an inaccessible locked leaf", () => {
    const document = createDocument();
    const frame = createFrameElement(
      document,
      null,
      new Error("cross-origin"),
    );
    document.documentElement.append(frame);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const frameView = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(frameView).toMatchObject({
      kind: "element",
      nodeType: 1,
      nodeName: "IFRAME",
      childCount: 0,
      relationship: "dom",
      selectable: false,
      expandable: false,
      inaccessible: true,
    });
    expect(frame.contentDocumentReads).toBe(2);
    expect(frame.contentWindowReads).toBe(0);
  });

  it("notifies when the selected node is removed", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    let selectedRef: string | undefined;
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      parentView,
      root.documentEpoch,
      "parent-children",
    );
    selectedRef = selectedView.nodeRef;

    parent.remove(selected);
    harness.observers[0]!.emit([mutationRecord(parent, [], [selected])]);
    harness.flushTimers();

    expect(removed).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("invalidates the nearest surviving reveal-only owner of a removed selection", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    let selectedRef: string | undefined;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: (branch) => invalidated.push(branch),
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const revealed = harness.provider.revealElement(selected as unknown as Element);
    const parentView = revealed.ancestorPath.at(-2)!;
    selectedRef = revealed.nodeRef;

    parent.remove(selected);
    harness.observers[0]!.emit([mutationRecord(parent, [], [selected])]);
    harness.flushTimers();

    expect(removed).toEqual([{
      nodeRef: revealed.nodeRef,
      documentEpoch: revealed.documentEpoch,
    }]);
    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision + 1,
    });
  });

  it("resolves a removed selection owner after the complete mutation batch", () => {
    const document = createDocument();
    const section = createElement("section", document);
    const main = createElement("main", document);
    const selected = createElement("button", document);
    main.append(selected);
    section.append(main);
    document.documentElement.append(section);
    let selectedRef: string | undefined;
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const revealed = harness.provider.revealElement(selected as unknown as Element);
    const sectionView = revealed.ancestorPath.at(-3)!;
    const mainView = revealed.ancestorPath.at(-2)!;
    selectedRef = revealed.nodeRef;

    main.remove(selected);
    section.remove(main);
    harness.observers[0]!.emit([
      mutationRecord(main, [], [selected]),
      mutationRecord(section, [], [main]),
    ]);
    harness.flushTimers();

    expect(invalidated).toContainEqual({
      nodeRef: sectionView.nodeRef,
      branchRevision: sectionView.branchRevision + 1,
    });
    expect(invalidated.map(({ nodeRef }) => nodeRef)).not.toContain(
      mainView.nodeRef,
    );
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "surviving-selection-owner",
      nodeRef: sectionView.nodeRef,
      documentEpoch: revealed.documentEpoch,
      branchRevision: sectionView.branchRevision + 1,
    }).nodes).toEqual([]);
  });

  it("notifies after retained hovered nodes reach their final moved or detached state", () => {
    const document = createDocument();
    const source = createElement("main", document);
    const destination = createElement("aside", document);
    const hovered = createElement("button", document);
    source.append(hovered);
    document.documentElement.append(source);
    document.documentElement.append(destination);
    const attachedAtSettlement: boolean[] = [];
    const harness = createProviderHarness(document, {
      onMutationSettled: () => {
        attachedAtSettlement.push(document.documentElement.contains(
          hovered as unknown as Node,
        ));
      },
    });
    const revealed = harness.provider.revealElement(hovered as unknown as Element);
    expect(harness.provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);

    source.remove(hovered);
    destination.append(hovered);
    harness.observers[0]!.emit([
      mutationRecord(source, [], [hovered]),
      mutationRecord(destination, [hovered]),
    ]);
    harness.flushTimers();

    expect(attachedAtSettlement).toEqual([true]);
    expect(harness.provider.resolveElement(
      revealed.nodeRef,
      revealed.documentEpoch,
    )?.element).toBe(hovered);

    destination.remove(hovered);
    harness.observers[0]!.emit([
      mutationRecord(destination, [], [hovered]),
    ]);
    harness.flushTimers();

    expect(attachedAtSettlement).toEqual([true, false]);
    expect(harness.provider.resolveElement(
      revealed.nodeRef,
      revealed.documentEpoch,
    )).toBeUndefined();
  });

  it("preserves a selected node ref when it moves within one scope", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const newParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    document.documentElement.append(oldParent);
    document.documentElement.append(newParent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const parents = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      parents[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "new-parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: parents[1]!.branchRevision,
    });

    oldParent.remove(selected);
    newParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(newParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    expect(invalidated).toEqual(expect.arrayContaining([
      { nodeRef: parents[0]!.nodeRef, branchRevision: 2 },
      { nodeRef: parents[1]!.nodeRef, branchRevision: 2 },
    ]));
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path.map((node) => node.nodeRef)).toEqual([
      root.node.nodeRef,
      parents[1]!.nodeRef,
      selectedView.nodeRef,
    ]);
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "moved-children",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: 2,
    }).nodes[0]?.nodeRef).toBe(selectedView.nodeRef);
  });

  it("preserves a selected ref moved beneath an unmaterialized parent", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const destinationContainer = createElement("section", document);
    const destinationParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    destinationContainer.append(destinationParent);
    document.documentElement.append(oldParent);
    document.documentElement.append(destinationContainer);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;

    oldParent.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path.map((node) => node.label)).toEqual([
      "html",
      "section",
      "aside",
      "button",
    ]);
    expect(path[1]?.nodeRef).toBe(topChildren[1]!.nodeRef);
    expect(path.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
  });

  it("atomically replaces a selected path at record capacity", () => {
    const document = createDocument();
    const unrelated = createElement("nav", document);
    const sourceRoot = createElement("main", document);
    let sourceParent = sourceRoot;
    for (let depth = 0; depth < 34; depth += 1) {
      const child = createElement("section", document);
      sourceParent.append(child);
      sourceParent = child;
    }
    const selected = createElement("button", document);
    sourceParent.append(selected);
    const destinationRoot = createElement("aside", document);
    let destinationParent = destinationRoot;
    for (let depth = 0; depth < 34; depth += 1) {
      const child = createElement("div", document);
      destinationParent.append(child);
      destinationParent = child;
    }
    document.documentElement.append(unrelated);
    document.documentElement.append(sourceRoot);
    document.documentElement.append(destinationRoot);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const unrelatedView = topChildren.find((node) => node.label === "nav")!;
    const sourceView = topChildren.find((node) => node.label === "main")!;
    const destinationView = topChildren.find((node) => node.label === "aside")!;
    let selectedView = sourceView;
    for (let depth = 0; depth < 35; depth += 1) {
      selectedView = onlyChild(
        harness.provider,
        selectedView,
        root.documentEpoch,
        `source-depth-${depth}`,
      );
    }
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(sourceView.nodeRef, root.documentEpoch);

    sourceParent.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(sourceParent, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([]);
    const path = harness.provider.ancestorPath(selectedView.nodeRef, root.documentEpoch);
    expect(path).toHaveLength(37);
    expect(path[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(path[1]?.nodeRef).toBe(destinationView.nodeRef);
    expect(path.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
    expect(() => harness.provider.ancestorPath(
      unrelatedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(internals.records.size).toBeLessThanOrEqual(64);
  });

  it("fails closed when a moved selected path cannot fit record capacity", () => {
    const document = createDocument();
    const unrelated = createElement("nav", document);
    let unrelatedParent = unrelated;
    for (let depth = 0; depth < 4; depth += 1) {
      const child = createElement("article", document);
      unrelatedParent.append(child);
      unrelatedParent = child;
    }
    const source = createElement("main", document);
    const selected = createElement("button", document);
    source.append(selected);
    const destinationRoot = createElement("aside", document);
    const destinationNodes: FakeElement[] = [];
    let destinationParent = destinationRoot;
    for (let depth = 0; depth < 10; depth += 1) {
      const child = createElement("section", document);
      destinationNodes.push(child);
      destinationParent.append(child);
      destinationParent = child;
    }
    document.documentElement.append(unrelated);
    document.documentElement.append(source);
    document.documentElement.append(destinationRoot);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 16,
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const unrelatedView = topChildren.find((node) => node.label === "nav")!;
    const sourceView = topChildren.find((node) => node.label === "main")!;
    let unrelatedProtectedView = unrelatedView;
    for (let depth = 0; depth < 4; depth += 1) {
      unrelatedProtectedView = onlyChild(
        harness.provider,
        unrelatedProtectedView,
        root.documentEpoch,
        `unrelated-depth-${depth}`,
      );
    }
    const selectedView = onlyChild(
      harness.provider,
      sourceView,
      root.documentEpoch,
      "selected",
    );
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(sourceView.nodeRef, root.documentEpoch);

    source.remove(selected);
    destinationParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(source, [], [selected]),
      mutationRecord(destinationParent, [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    expect(harness.provider.ancestorPath(
      unrelatedProtectedView.nodeRef,
      root.documentEpoch,
    ).at(-1)?.nodeRef).toBe(unrelatedProtectedView.nodeRef);
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    for (const node of destinationNodes) {
      const nodeRef = internals.refsByNode.get(node);
      expect(nodeRef ? internals.records.has(nodeRef) : false).toBe(false);
    }
  });

  it("invalidates a selected ref after a remove-add-remove batch", () => {
    const document = createDocument();
    const oldParent = createElement("main", document);
    const temporaryParent = createElement("aside", document);
    const selected = createElement("button", document);
    oldParent.append(selected);
    document.documentElement.append(oldParent);
    document.documentElement.append(temporaryParent);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const parents = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      parents[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;

    oldParent.remove(selected);
    temporaryParent.append(selected);
    temporaryParent.remove(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
      mutationRecord(temporaryParent, [selected]),
      mutationRecord(temporaryParent, [], [selected]),
    ]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("invalidates a selected ref when a node moves across frame scopes", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const oldParent = createElement("main", document);
    const newParent = createElement("aside", childDocument);
    const selected = createElement("button", document);
    oldParent.append(selected);
    childDocument.documentElement.append(newParent);
    document.documentElement.append(oldParent);
    document.documentElement.append(createFrameElement(document, childDocument));
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const selectedView = onlyChild(
      harness.provider,
      topChildren[0]!,
      root.documentEpoch,
      "old-parent-children",
    );
    selectedRef = selectedView.nodeRef;
    const frameDocumentView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "frame-children",
    );
    const frameRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "frame-document-children",
    );
    const newParentView = onlyChild(
      harness.provider,
      frameRootView,
      root.documentEpoch,
      "frame-root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "new-parent-children",
      documentEpoch: root.documentEpoch,
      nodeRef: newParentView.nodeRef,
      branchRevision: newParentView.branchRevision,
    });

    oldParent.remove(selected);
    newParent.append(selected);
    harness.observers[0]!.emit([
      mutationRecord(oldParent, [], [selected]),
    ]);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    childObserver.emit([mutationRecord(newParent, [selected])]);
    harness.flushTimers();

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const movedView = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "cross-scope-children",
      documentEpoch: root.documentEpoch,
      nodeRef: newParentView.nodeRef,
      branchRevision: 2,
    }).nodes[0]!;
    expect(movedView.nodeRef).not.toBe(selectedView.nodeRef);
  });

  it("invalidates affected branches before selected-removal callbacks re-enter", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    const selected = createElement("button", document);
    parent.append(selected);
    document.documentElement.append(parent);
    let selectedRef: string | undefined;
    let parentRef = "";
    let provider: DomTreeProvider;
    let reentrantError: unknown;
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => events.push("invalidated"),
      onSelectedNodeRemoved: () => {
        events.push("removed");
        try {
          provider.getChildren({
            type: "dom.getChildren",
            requestId: "reentrant-parent-children",
            documentEpoch: 3,
            nodeRef: parentRef,
            branchRevision: 1,
          });
        } catch (error) {
          reentrantError = error;
        }
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    const parentView = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    parentRef = parentView.nodeRef;
    const selectedView = onlyChild(
      provider,
      parentView,
      root.documentEpoch,
      "parent-children",
    );
    selectedRef = selectedView.nodeRef;

    parent.remove(selected);
    harness.observers[0]!.emit([mutationRecord(parent, [], [selected])]);
    harness.flushTimers();

    expect(events).toEqual(["invalidated", "invalidated", "removed"]);
    expect(reentrantError).toMatchObject({ code: "stale-branch" });
  });

  it("notifies when the selected node is inside a removed frame", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const selected = createElement("button", childDocument);
    childDocument.documentElement.append(selected);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    const removed: Array<{ nodeRef: string; documentEpoch: number }> = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removed.push(event),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      childRootView,
      root.documentEpoch,
      "child-root-children",
    );
    selectedRef = selectedView.nodeRef;

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(removed).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
  });

  it("invalidates all old state when the top document epoch resets", () => {
    const document = createDocument();
    for (let index = 0; index < 51; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document);
    const oldRoot = harness.provider.getRoot();
    const oldPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "old-page",
      documentEpoch: oldRoot.documentEpoch,
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: oldRoot.node.branchRevision,
    });
    const nextDocument = createDocument();

    harness.provider.resetDocument(nextDocument as unknown as Document, 4);

    expect(() => harness.provider.getRoot(3)).toThrowError("stale-document");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-page",
      documentEpoch: 3,
      nodeRef: oldRoot.node.nodeRef,
      branchRevision: oldPage.branchRevision,
      cursor: oldPage.nextCursor,
    })).toThrowError("stale-document");
    const nextRoot = harness.provider.getRoot(4);
    expect(nextRoot.documentEpoch).toBe(4);
    expect(nextRoot.node.nodeRef).not.toBe(oldRoot.node.nodeRef);
    expect(harness.observers[0]!.disconnectCount).toBe(1);
    expect(harness.observers.at(-1)!.observedTargets).toEqual([nextDocument]);
  });

  it("disposes all ownership and fails closed afterward", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );

    harness.provider.dispose();
    expect(() => harness.provider.dispose()).not.toThrow();

    expect(harness.observers.every((observer) => observer.disconnectCount === 1)).toBe(true);
    harness.observers[0]!.emit([mutationRecord(document.documentElement)]);
    harness.flushTimers();
    expect(invalidated).toEqual([]);
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "disposed-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("session-disposed");
    expect(() => harness.provider.ancestorPath(
      root.node.nodeRef,
      root.documentEpoch,
    )).toThrowError("session-disposed");
    expect(() => harness.provider.resetDocument(
      createDocument() as unknown as Document,
      4,
    )).toThrowError("session-disposed");
  });

  it("releases document and registry ownership when disposed at the maximum epoch", () => {
    const document = createDocument();
    document.documentElement.append(createElement("main", document));
    const harness = createProviderHarness(document, {
      documentEpoch: Number.MAX_SAFE_INTEGER,
    });
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retain-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });
    const before = harness.provider as unknown as {
      readonly nodeRegistry: { readonly size: number; readonly retainedSize: number };
      readonly topDocument?: Document;
    };
    const oldRegistry = before.nodeRegistry;
    expect(oldRegistry.size).toBeGreaterThan(0);
    expect(oldRegistry.retainedSize).toBeGreaterThan(0);

    harness.provider.dispose();

    const after = harness.provider as unknown as {
      readonly nodeRegistry: { readonly size: number; readonly retainedSize: number };
      readonly topDocument?: Document;
    };
    expect([
      after.topDocument === undefined,
      after.nodeRegistry !== oldRegistry,
      after.nodeRegistry.size,
      after.nodeRegistry.retainedSize,
    ]).toEqual([true, true, 0, 0]);
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
  });

  it("binds each cursor exactly to its node, epoch, and branch revision", () => {
    const document = createDocument();
    const firstParent = createElement("main", document);
    const secondParent = createElement("aside", document);
    for (let index = 0; index < 51; index += 1) {
      firstParent.append(createElement("p", document));
      secondParent.append(createElement("span", document));
    }
    document.documentElement.append(firstParent);
    document.documentElement.append(secondParent);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const parents = provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstPage = provider.getChildren({
      type: "dom.getChildren",
      requestId: "first-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[0]!.nodeRef,
      branchRevision: parents[0]!.branchRevision,
    });

    expect(() => provider.getChildren({
      type: "dom.getChildren",
      requestId: "mismatched-page",
      documentEpoch: root.documentEpoch,
      nodeRef: parents[1]!.nodeRef,
      branchRevision: parents[1]!.branchRevision,
      cursor: firstPage.nextCursor,
    })).toThrowError("invalid-request");
  });

  it("bounds cursor storage and evicts the oldest record", () => {
    const document = createDocument();
    for (let index = 0; index < 51; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document, { maxCursors: 2 });
    const root = harness.provider.getRoot();
    const request = {
      type: "dom.getChildren" as const,
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    };
    const oldest = harness.provider.getChildren({
      ...request,
      requestId: "page-1",
    }).nextCursor!;
    const middle = harness.provider.getChildren({
      ...request,
      requestId: "page-2",
    }).nextCursor!;
    harness.provider.getChildren({
      ...request,
      requestId: "page-3",
    });

    expect(() => harness.provider.getChildren({
      ...request,
      requestId: "evicted-page",
      cursor: oldest,
    })).toThrowError("invalid-cursor");
    expect(harness.provider.getChildren({
      ...request,
      requestId: "live-page",
      cursor: middle,
    }).nodes).toHaveLength(1);
  });

  it("releases descendant cursors and shadow observation on collapse", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    for (let index = 0; index < 51; index += 1) {
      shadowRoot.append(createElement("button", document));
    }
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const shadowPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "shadow-page",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
    });

    harness.provider.collapse(hostView.nodeRef, root.documentEpoch);

    expect(harness.observers[0]!.disconnectCount).toBe(0);
    expect(harness.observers[1]!.disconnectCount).toBe(1);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "released-page",
      documentEpoch: root.documentEpoch,
      nodeRef: shadowView.nodeRef,
      branchRevision: shadowView.branchRevision,
      cursor: shadowPage.nextCursor,
    })).toThrowError("invalid-cursor");
  });

  it("flushes pending selected removal before collapsing its observed host", () => {
    const document = createDocument();
    const host = createElement("article", document);
    const shadowRoot = host.attachShadow();
    const selected = createElement("button", document);
    shadowRoot.append(selected);
    document.documentElement.append(host);
    const removals: Array<{ nodeRef: string; documentEpoch: number }> = [];
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onSelectedNodeRemoved: (event) => removals.push(event),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const shadowView = onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const selectedView = onlyChild(
      harness.provider,
      shadowView,
      root.documentEpoch,
      "shadow-children",
    );
    selectedRef = selectedView.nodeRef;
    const shadowObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;

    shadowRoot.remove(selected);
    shadowObserver.emit([mutationRecord(shadowRoot, [], [selected])]);
    harness.provider.collapse(hostView.nodeRef, root.documentEpoch);

    expect(removals).toEqual([{
      nodeRef: selectedView.nodeRef,
      documentEpoch: root.documentEpoch,
    }]);
    expect(() => harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("preserves a branch generation across collapse and re-expansion", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    for (let index = 0; index < 51; index += 1) {
      parent.append(createElement("p", document));
    }
    document.documentElement.append(parent);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const firstPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    });
    const added = createElement("p", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);
    harness.flushTimers();
    harness.provider.collapse(parentView.nodeRef, root.documentEpoch);

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "delayed-revision-one",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "delayed-cursor",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
      cursor: firstPage.nextCursor,
    })).toThrowError("stale-branch");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "revision-two-re-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    }).branchRevision).toBe(2);
  });

  it("fails a branch closed when its revision space is exhausted", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const internals = harness.provider as unknown as {
      readonly expandedBranches: Map<string, { revision: number }>;
    };
    internals.expandedBranches.get(parentView.nodeRef)!.revision =
      Number.MAX_SAFE_INTEGER;
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);

    expect(() => harness.flushTimers()).toThrowError("internal-error");
    expect(invalidated).toEqual([]);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "exhausted-branch",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: Number.MAX_SAFE_INTEGER,
    })).toThrowError("internal-error");
  });

  it("disconnects an expanded frame-document observer on ancestor collapse", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;

    harness.provider.collapse(frameView.nodeRef, root.documentEpoch);

    expect(childObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("releases a discovered unexpanded frame document on iframe collapse", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const unrelatedDocument = createDocument();
    document.documentElement.append(createFrameElement(document, childDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "root-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    expect(frameViews).toHaveLength(2);
    const frameDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "discover-frame-document",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    expect(childObserver.disconnectCount).toBe(1);
    expect(unrelatedObserver.disconnectCount).toBe(0);
    expect(() => harness.provider.ancestorPath(
      frameDocumentView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("releases an unmaterialized nested frame document on outer iframe collapse", () => {
    const document = createDocument();
    const outerDocument = createDocument();
    const nestedDocument = createDocument();
    const unrelatedDocument = createDocument();
    const nestedFrame = createFrameElement(outerDocument, nestedDocument);
    outerDocument.documentElement.append(nestedFrame);
    document.documentElement.append(createFrameElement(document, outerDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const outerDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "outer-frame-children",
    );
    const outerRootView = onlyChild(
      harness.provider,
      outerDocumentView,
      root.documentEpoch,
      "outer-document-children",
    );
    const nestedFrameView = onlyChild(
      harness.provider,
      outerRootView,
      root.documentEpoch,
      "outer-root-children",
    );
    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    expect(internals.refsByNode.get(nestedDocument)).toBeUndefined();
    const outerObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(outerDocument)
    ))!;
    const nestedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(nestedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    expect([
      outerObserver.disconnectCount,
      nestedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
      unrelatedObserver.disconnectCount,
    ]).toEqual([1, 1, 0, 0]);
    expect([...internals.frameDocumentsByRef.values()]).toEqual([
      unrelatedDocument,
    ]);
    expect(() => harness.provider.ancestorPath(
      nestedFrameView.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("releases an unmaterialized frame discovered below an ordinary ancestor", () => {
    const document = createDocument();
    const ancestor = createElement("main", document);
    const nestedDocument = createDocument();
    const nestedFrame = createFrameElement(document, nestedDocument);
    const unrelatedDocument = createDocument();
    document.documentElement.append(ancestor);
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;

    ancestor.append(nestedFrame);
    harness.observers[0]!.emit([mutationRecord(ancestor, [nestedFrame])]);
    harness.flushTimers();
    const nestedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(nestedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
      readonly refsByNode: WeakMap<FakeNode, string>;
    };
    expect(internals.refsByNode.get(nestedFrame)).toBeUndefined();

    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      nestedObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
    expect([...internals.frameDocumentsByRef.values()]).toEqual([
      unrelatedDocument,
    ]);
  });

  it("does not observe a collapsed iframe navigation until re-expansion", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "first-frame-document",
    );
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);
    expect(firstObserver.disconnectCount).toBe(1);

    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect([...internals.frameDocumentsByRef.values()]).not.toContain(nextDocument);
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const nextFrameDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "reexpanded-frame-document",
    );
    expect(nextFrameDocumentView.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("keeps a collapsed frame inactive while refreshing its parent row", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    document.documentElement.append(frame);
    document.documentElement.append(unrelatedFrame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "first-frame-document",
    );
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);

    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();

    expect(firstObserver.disconnectCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    const parentRevision = [...invalidated].reverse().find((branch) => (
      branch.nodeRef === root.node.nodeRef
    ))?.branchRevision;
    expect(parentRevision).toBe(2);

    const refreshedFrames = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "refreshed-top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: parentRevision!,
    }).nodes;

    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const currentDocumentView = onlyChild(
      harness.provider,
      refreshedFrames[0]!,
      root.documentEpoch,
      "current-frame-document",
    );
    expect(currentDocumentView.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("does not resurrect frames from a collapsed queued scan", () => {
    const document = createDocument();
    const collapsedDocument = createDocument();
    const unrelatedDocument = createDocument();
    document.documentElement.append(createFrameElement(document, collapsedDocument));
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "collapsed-frame-children",
    );
    onlyChild(
      harness.provider,
      frameViews[1]!,
      root.documentEpoch,
      "unrelated-frame-children",
    );
    const collapsedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(collapsedDocument)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    const collapsedContainer = createElement("main", collapsedDocument);
    const unrelatedContainer = createElement("main", unrelatedDocument);
    for (let index = 0; index < 1_100; index += 1) {
      collapsedContainer.append(createElement("span", collapsedDocument));
      unrelatedContainer.append(createElement("span", unrelatedDocument));
    }
    const collapsedLateDocument = createDocument();
    const unrelatedLateDocument = createDocument();
    const collapsedLateFrame = createFrameElement(
      collapsedDocument,
      collapsedLateDocument,
    );
    const unrelatedLateFrame = createFrameElement(
      unrelatedDocument,
      unrelatedLateDocument,
    );
    collapsedContainer.append(collapsedLateFrame);
    unrelatedContainer.append(unrelatedLateFrame);
    collapsedDocument.documentElement.append(collapsedContainer);
    unrelatedDocument.documentElement.append(unrelatedContainer);
    collapsedObserver.emit([
      mutationRecord(collapsedDocument.documentElement, [collapsedContainer]),
    ]);
    unrelatedObserver.emit([
      mutationRecord(unrelatedDocument.documentElement, [unrelatedContainer]),
    ]);
    harness.flushTimers();
    expect([
      collapsedLateFrame.loadListenerCount,
      unrelatedLateFrame.loadListenerCount,
    ]).toEqual([0, 0]);

    harness.provider.collapse(frameViews[0]!.nodeRef, root.documentEpoch);
    harness.flushTimers();
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    const ownedDocuments = [...internals.frameDocumentsByRef.values()];
    expect([
      collapsedLateFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(collapsedLateDocument)
      )),
      ownedDocuments.includes(collapsedLateDocument),
      unrelatedLateFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(unrelatedLateDocument)
      )),
      ownedDocuments.includes(unrelatedLateDocument),
      collapsedObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([0, false, false, 1, true, true, 1, 0, 0]);
  });

  it("does not reactivate a collapsed frame from a bounded discovery scan", () => {
    const document = createDocument();
    const scannedContainer = createElement("main", document);
    const unrelatedContainer = createElement("aside", document);
    for (let index = 0; index < 250; index += 1) {
      scannedContainer.append(createElement("span", document));
      unrelatedContainer.append(createElement("span", document));
    }
    const firstDocument = createDocument();
    const nextDocument = createDocument();
    const unrelatedDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    scannedContainer.append(frame);
    unrelatedContainer.append(unrelatedFrame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    document.documentElement.append(scannedContainer);
    document.documentElement.append(unrelatedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [
        scannedContainer,
        unrelatedContainer,
      ]),
    ]);
    harness.flushTimers();
    expect([frame.loadListenerCount, unrelatedFrame.loadListenerCount]).toEqual([
      1,
      1,
    ]);
    const rootRevision = [...invalidated].reverse().find((branch) => (
      branch.nodeRef === root.node.nodeRef
    ))?.branchRevision;
    expect(rootRevision).toBe(2);
    const containers = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "containers",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: rootRevision!,
    }).nodes;
    const scannedContainerView = containers.find((node) => node.label === "main")!;
    let frameView: typeof scannedContainerView | undefined;
    let cursor: string | undefined;
    let pageIndex = 0;
    do {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `scanned-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: scannedContainerView.nodeRef,
        branchRevision: scannedContainerView.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      frameView ??= page.nodes.find((node) => node.label === "iframe");
      cursor = page.nextCursor;
      pageIndex += 1;
    } while (cursor);
    expect(frameView).toBeDefined();
    expect(frame.loadListenerCount).toBe(1);
    const firstObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstDocument)
    ))!;

    harness.provider.collapse(frameView!.nodeRef, root.documentEpoch);
    expect(firstObserver.disconnectCount).toBe(1);
    frame.setFrameDocument(nextDocument);
    frame.dispatchLoad();
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);

    harness.flushTimers();
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(false);
    expect([...internals.frameDocumentsByRef.values()]).not.toContain(nextDocument);
    expect(unrelatedFrame.loadListenerCount).toBe(1);
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedDocument)
    ))!;
    expect(unrelatedObserver.disconnectCount).toBe(0);

    const currentFrameDocument = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "direct-frame-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: frameView!.nodeRef,
      branchRevision: frameView!.branchRevision,
    });
    expect(currentFrameDocument.nodes).toHaveLength(1);
    expect(currentFrameDocument.nodes[0]?.kind).toBe("frame-document");
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextDocument)
    ))).toBe(true);
    expect(unrelatedObserver.disconnectCount).toBe(0);
  });

  it("does not register a queued frame after its scan root is detached", () => {
    const document = createDocument();
    const detachedContainer = createElement("main", document);
    const unrelatedContainer = createElement("aside", document);
    for (let index = 0; index < 1_100; index += 1) {
      detachedContainer.append(createElement("span", document));
      unrelatedContainer.append(createElement("span", document));
    }
    const detachedDocument = createDocument();
    const unrelatedDocument = createDocument();
    const detachedFrame = createFrameElement(document, detachedDocument);
    const unrelatedFrame = createFrameElement(document, unrelatedDocument);
    detachedContainer.append(detachedFrame);
    unrelatedContainer.append(unrelatedFrame);
    const harness = createProviderHarness(document);

    document.documentElement.append(detachedContainer);
    document.documentElement.append(unrelatedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [
        detachedContainer,
        unrelatedContainer,
      ]),
    ]);
    harness.flushTimers();
    expect([
      detachedFrame.loadListenerCount,
      unrelatedFrame.loadListenerCount,
    ]).toEqual([0, 0]);

    document.documentElement.remove(detachedContainer);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [detachedContainer]),
    ]);
    harness.flushTimers();

    const internals = harness.provider as unknown as {
      readonly frameDocumentsByRef: ReadonlyMap<string, FakeDocument>;
    };
    expect([
      detachedFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(detachedDocument)
      )),
      [...internals.frameDocumentsByRef.values()].includes(detachedDocument),
    ]).toEqual([0, false, false]);

    harness.flushTimers();
    expect([
      unrelatedFrame.loadListenerCount,
      harness.observers.some((observer) => (
        observer.observedTargets.includes(unrelatedDocument)
      )),
      [...internals.frameDocumentsByRef.values()].includes(unrelatedDocument),
    ]).toEqual([1, true, true]);
  });

  it("registers and unregisters frame contexts from document mutations", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-root",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });
    const frame = createFrameElement(document, childDocument);

    document.documentElement.append(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [frame]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(childDocument)
    ))).toBe(true);

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(0);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ));
    expect(childObserver?.disconnectCount).toBe(1);
  });

  it("fails closed when a removed frame subtree cannot be traversed", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [container]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);
    expect(harness.provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeDefined();

    document.documentElement.remove(container);
    Object.defineProperty(container, "childNodes", {
      configurable: true,
      get: () => {
        throw new Error("hostile removed child collection");
      },
    });
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [container]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    const state = harness.provider as unknown as {
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(state.pendingFrameMutationScans).toHaveLength(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when a removed registered frame hides its tag name", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const harness = createProviderHarness(document);
    document.documentElement.append(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [frame]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);

    document.documentElement.remove(frame);
    Object.defineProperty(frame, "tagName", {
      configurable: true,
      get: () => {
        throw new Error("hostile removed frame tag name");
      },
    });
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when a removed registered frame changes its tag name", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const harness = createProviderHarness(document);
    document.documentElement.append(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [frame]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);

    document.documentElement.remove(frame);
    Object.defineProperty(frame, "tagName", {
      configurable: true,
      get: () => "DIV",
    });
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    const state = harness.provider as unknown as {
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(state.pendingFrameMutationScans).toHaveLength(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when a removed shadow host hides a registered frame", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const host = createElement("section", document);
    const shadowRoot = host.attachShadow();
    const frame = createFrameElement(document, childDocument);
    shadowRoot.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(host);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [host]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);

    document.documentElement.remove(host);
    Object.defineProperty(host, "shadowRoot", {
      configurable: true,
      get: () => {
        throw new Error("hostile removed shadow root");
      },
    });
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [host]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when a removed shadow host returns no shadow root", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const host = createElement("section", document);
    const shadowRoot = host.attachShadow();
    const frame = createFrameElement(document, childDocument);
    shadowRoot.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(host);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [host]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);

    document.documentElement.remove(host);
    Object.defineProperty(host, "shadowRoot", {
      configurable: true,
      get: () => null,
    });
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [host]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    const state = harness.provider as unknown as {
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(state.pendingFrameMutationScans).toHaveLength(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("fails closed when a removed shadow host changes its shadow root", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const host = createElement("section", document);
    const originalShadowRoot = host.attachShadow();
    const frame = createFrameElement(document, childDocument);
    originalShadowRoot.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(host);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [host]),
    ]);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);

    document.documentElement.remove(host);
    const replacementShadowRoot = host.attachShadow();
    expect(replacementShadowRoot).not.toBe(originalShadowRoot);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [host]),
    ]);

    expect(() => harness.flushTimers()).not.toThrow();
    const state = harness.provider as unknown as {
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    expect(() => harness.provider.getRoot()).toThrowError(
      expect.objectContaining({ code: "session-disposed" }),
    );
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.accessibleContexts()).toEqual([]);
    expect(state.pendingFrameMutationScans).toHaveLength(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("conservatively skips unreadable added frame topology", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const hiddenFrameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    const host = createElement("section", document);
    host.attachShadow().append(createFrameElement(document, hiddenFrameDocument));
    Object.defineProperty(frame, "tagName", {
      configurable: true,
      get: () => {
        throw new Error("hostile added frame tag name");
      },
    });
    Object.defineProperty(host, "shadowRoot", {
      configurable: true,
      get: () => {
        throw new Error("hostile added shadow root");
      },
    });
    const harness = createProviderHarness(document);
    document.documentElement.append(frame);
    document.documentElement.append(host);

    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [frame, host]),
    ]);
    expect(() => harness.flushTimers()).not.toThrow();

    expect(() => harness.provider.getRoot()).not.toThrow();
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.getContextForDocument(
      frameDocument as unknown as Document,
    )).toBeUndefined();
    expect(harness.provider.frameAuthority.getContextForDocument(
      hiddenFrameDocument as unknown as Document,
    )).toBeUndefined();
  });

  it("conservatively skips an unreadable added frame subtree", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const childNodes = container.childNodes;
    const harness = createProviderHarness(document);
    document.documentElement.append(container);
    Object.defineProperty(container, "childNodes", {
      configurable: true,
      get: () => {
        throw new Error("hostile added child collection");
      },
    });
    try {
      expect(() => harness.provider.startFrameTracking()).not.toThrow();
    } finally {
      Object.defineProperty(container, "childNodes", {
        configurable: true,
        value: childNodes,
      });
    }
    const state = harness.provider as unknown as {
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    expect(() => harness.provider.getRoot()).not.toThrow();
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.provider.frameAuthority.getContextForDocument(
      childDocument as unknown as Document,
    )).toBeUndefined();
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(state.pendingFrameMutationScans).toHaveLength(0);
  });

  it("continues a bounded scan to register a late frame in an added subtree", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    for (let index = 0; index < 1_100; index += 1) {
      container.append(createElement("span", document));
    }
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const harness = createProviderHarness(document);

    document.documentElement.append(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [container]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(0);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(childDocument)
    ))).toBe(true);
  });

  it("continues a bounded scan to unregister a late frame in a removed subtree", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const container = createElement("main", document);
    for (let index = 0; index < 1_100; index += 1) {
      container.append(createElement("span", document));
    }
    const frame = createFrameElement(document, childDocument);
    container.append(frame);
    const harness = createProviderHarness(document);
    document.documentElement.append(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [container]),
    ]);
    harness.flushTimers();
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(1);
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;

    document.documentElement.remove(container);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [container]),
    ]);
    harness.flushTimers();

    expect(frame.loadListenerCount).toBe(1);
    harness.flushTimers();
    expect(frame.loadListenerCount).toBe(0);
    expect(childObserver.disconnectCount).toBe(1);
  });

  it("replaces observed frame documents when a frame navigates", () => {
    const document = createDocument();
    const firstChildDocument = createDocument();
    const frame = createFrameElement(document, firstChildDocument);
    document.documentElement.append(frame);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const documentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const firstChildRoot = onlyChild(
      harness.provider,
      documentView,
      root.documentEpoch,
      "document-children",
    );
    const nextChildDocument = createDocument();

    frame.setFrameDocument(nextChildDocument);
    frame.dispatchLoad();

    const oldObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(firstChildDocument)
    ));
    expect(oldObserver?.disconnectCount).toBe(1);
    expect(harness.observers.some((observer) => (
      observer.observedTargets.includes(nextChildDocument)
    ))).toBe(true);
    expect(invalidated).toContainEqual({
      nodeRef: frameView.nodeRef,
      branchRevision: 2,
    });
    expect(() => harness.provider.ancestorPath(
      firstChildRoot.nodeRef,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("disconnects nested shadow observers when a frame navigates", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const host = createElement("article", childDocument);
    const shadowRoot = host.attachShadow();
    shadowRoot.append(createElement("button", childDocument));
    childDocument.documentElement.append(host);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    const frameDocumentView = onlyChild(
      harness.provider,
      frameView,
      root.documentEpoch,
      "frame-children",
    );
    const childRootView = onlyChild(
      harness.provider,
      frameDocumentView,
      root.documentEpoch,
      "document-children",
    );
    const hostView = onlyChild(
      harness.provider,
      childRootView,
      root.documentEpoch,
      "child-root-children",
    );
    onlyChild(
      harness.provider,
      hostView,
      root.documentEpoch,
      "host-children",
    );
    const childObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(childDocument)
    ))!;
    const shadowObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(shadowRoot)
    ))!;

    frame.setFrameDocument(createDocument());
    frame.dispatchLoad();

    expect(childObserver.disconnectCount).toBe(1);
    expect(shadowObserver.disconnectCount).toBe(1);
    expect(harness.observers[0]!.disconnectCount).toBe(0);
  });

  it("invalidates queued mutations before serving any child data", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("p", document));
    document.documentElement.append(parent);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    const added = createElement("aside", document);
    parent.append(added);
    harness.observers[0]!.emit([mutationRecord(parent, [added])]);

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "old-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(invalidated).toContainEqual({
      nodeRef: parentView.nodeRef,
      branchRevision: 2,
    });
  });

  it("fails closed rather than delivering a hostile tag with an empty locator", () => {
    const document = createDocument();
    const hostileTagName = `<SCRIPT>${"x".repeat(600)}</SCRIPT>`;
    document.documentElement.append(new FakeElement(hostileTagName, document));
    const provider = createProvider(document);
    const root = provider.getRoot();

    expect(() => onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    )).toThrowError("node-unavailable");
  });

  it("includes approved identity and attribute names without private values", () => {
    const document = createDocument();
    const element = createElement("div", document);
    element.setAttribute("id", "hero");
    element.setAttribute("class", "card featured");
    element.setAttribute("role", "region");
    element.setAttribute("data-state", "secret-ready");
    element.setAttribute("aria-label", "Private account name");
    element.setAttribute("value", "private form value");
    element.setAttribute("onclick", "sendPrivateData() <script>");
    element.setAttribute("style", "background:url(private)");
    document.documentElement.append(element);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const child = onlyChild(
      provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );

    expect(child.label).toBe(
      "div#hero.card.featured [role] [data-state] [aria-label]",
    );
    expect(child.label).not.toMatch(
      /region|secret-ready|Private account|private form|sendPrivateData|style|onclick|[<>]/,
    );
    expect(child.attributes).toEqual([
      { name: "id", value: "hero" },
      { name: "class", value: "card featured" },
      { name: "role", value: "region" },
      { name: "data-state", value: "secret-ready" },
      { name: "aria-label", value: "Private account name" },
      { name: "value", value: "private form value" },
      { name: "onclick", value: "sendPrivateData() <script>" },
      { name: "style", value: "background:url(private)" },
    ]);
  });

  it("rejects malformed child requests with a typed invalid-request error", () => {
    const document = createDocument();
    const provider = createProvider(document);
    const root = provider.getRoot();

    let error: unknown;
    try {
      provider.getChildren({
        type: "dom.getChildren",
        requestId: "malformed",
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: Number.NaN,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(DomTreeProviderError);
    expect(error).toMatchObject({
      code: "invalid-request",
      message: "invalid-request",
    });
  });

  it("rechecks a late shadow root before a direct child response", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.append(createElement("span", document));
    document.documentElement.append(host);
    const invalidated: Array<{ nodeRef: string; branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-children",
    );
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "initial-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    host.attachShadow().append(createElement("button", document));

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "stale-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: 1,
    })).toThrowError("stale-branch");
    expect(invalidated).toEqual([]);
  });

  it("resumes physical traversal without rescanning earlier child pages", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const provider = createProvider(document);
    const root = provider.getRoot();
    indexedReads = 0;

    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      const readsBeforePage = indexedReads;
      const page = provider.getChildren({
        type: "dom.getChildren",
        requestId: `page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });

      expect(page.nodes).toHaveLength(50);
      expect(page.nextCursor).toBeDefined();
      expect(indexedReads - readsBeforePage).toBeLessThanOrEqual(100_000);
      cursor = page.nextCursor;
    }
  });

  it("bounds physical traversal through non-element children", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createText(`text-${index}`));
    }
    document.documentElement.append(createElement("section", document));
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    const provider = createProvider(document);
    const root = provider.getRoot();
    indexedReads = 0;
    let cursor: string | undefined;
    const found: DomNodeView[] = [];

    for (let pageIndex = 0; pageIndex < 5 && found.length === 0; pageIndex += 1) {
      const readsBeforePage = indexedReads;
      const page = provider.getChildren({
        type: "dom.getChildren",
        requestId: `text-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      found.push(...page.nodes.filter((node) => node.kind === "element"));

      expect(indexedReads - readsBeforePage).toBeLessThanOrEqual(12_000);
      if (found.length === 0) {
        expect(page.nextCursor).toBeDefined();
      }
      cursor = page.nextCursor;
    }

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "element", label: "section" });
  });

  it("probes root and row expandability without scanning text-heavy children", () => {
    const rootDocument = createDocument();
    for (let index = 0; index < 10_000; index += 1) {
      rootDocument.documentElement.append(createText(`root-text-${index}`));
    }
    const rootChild = createElement("main", rootDocument);
    rootDocument.documentElement.append(rootChild);
    const rootChildNodes = rootDocument.documentElement.childNodes;
    let rootIndexedReads = 0;
    Object.defineProperty(rootDocument.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(rootChildNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rootIndexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(rootDocument.documentElement, "childElementCount", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(rootDocument.documentElement, "firstElementChild", {
      configurable: true,
      get: () => rootChild,
    });

    const rootView = createProvider(rootDocument).getRoot();
    expect(rootView.node.expandable).toBe(true);
    expect(rootIndexedReads).toBe(0);

    const rowDocument = createDocument();
    const row = createElement("article", rowDocument);
    for (let index = 0; index < 10_000; index += 1) {
      row.append(createText(`row-text-${index}`));
    }
    const rowChild = createElement("button", rowDocument);
    row.append(rowChild);
    rowDocument.documentElement.append(row);
    const rowChildNodes = row.childNodes;
    let rowIndexedReads = 0;
    Object.defineProperty(row, "childNodes", {
      configurable: true,
      get: () => new Proxy(rowChildNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            rowIndexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(row, "childElementCount", {
      configurable: true,
      get: () => 1,
    });
    Object.defineProperty(row, "firstElementChild", {
      configurable: true,
      get: () => rowChild,
    });
    const rowProvider = createProvider(rowDocument);
    const rowRoot = rowProvider.getRoot();
    rowIndexedReads = 0;

    const rowView = onlyChild(
      rowProvider,
      rowRoot.node,
      rowRoot.documentEpoch,
      "row",
    );
    expect(rowView.expandable).toBe(true);
    expect(rowIndexedReads).toBe(0);
  });

  it("keeps an invalid expandable primitive conservative and constant-time", () => {
    const document = createDocument();
    for (let index = 0; index < 10_000; index += 1) {
      document.documentElement.append(createText(`text-${index}`));
    }
    document.documentElement.append(createElement("main", document));
    const childNodes = document.documentElement.childNodes;
    let indexedReads = 0;
    Object.defineProperty(document.documentElement, "childNodes", {
      configurable: true,
      get: () => new Proxy(childNodes, {
        get: (target, property, receiver) => {
          if (typeof property === "string" && /^\d+$/.test(property)) {
            indexedReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    });
    Object.defineProperty(document.documentElement, "childElementCount", {
      configurable: true,
      get: () => "invalid",
    });
    Object.defineProperty(document.documentElement, "firstElementChild", {
      configurable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });

    const root = createProvider(document).getRoot();

    expect(root.node.expandable).toBe(true);
    expect(indexedReads).toBe(0);
  });

  it("bounds provider records while retaining selected and expanded authority", () => {
    const document = createDocument();
    for (let index = 0; index < 200; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
    });
    const root = harness.provider.getRoot();
    let cursor: string | undefined;
    let evictedRef: string | undefined;
    let lastRef: string | undefined;

    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `materialize-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: root.node.nodeRef,
        branchRevision: root.node.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.nodes).toHaveLength(50);
      if (pageIndex === 0) {
        selectedRef = page.nodes[0]!.nodeRef;
        evictedRef = page.nodes[1]!.nodeRef;
      }
      lastRef = page.nodes.at(-1)!.nodeRef;
      cursor = page.nextCursor;
    }

    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(cursor).toBeUndefined();
    expect(internals.records.size).toBeLessThanOrEqual(64);
    expect(internals.records.has(root.node.nodeRef)).toBe(true);
    expect(internals.records.has(selectedRef!)).toBe(true);
    expect(internals.records.has(lastRef!)).toBe(true);
    expect(() => harness.provider.ancestorPath(
      selectedRef!,
      root.documentEpoch,
    )).not.toThrow();
    expect(() => harness.provider.ancestorPath(
      evictedRef!,
      root.documentEpoch,
    )).toThrowError("unknown-node");
  });

  it("protects the complete selected ancestor path under record pressure", () => {
    const document = createDocument();
    const selectedRoot = createElement("main", document);
    let selectedParent = selectedRoot;
    for (let depth = 0; depth < 8; depth += 1) {
      const child = createElement("section", document);
      selectedParent.append(child);
      selectedParent = child;
    }
    const selected = createElement("button", document);
    selectedParent.append(selected);
    const unrelatedParent = createElement("aside", document);
    for (let index = 0; index < 200; index += 1) {
      unrelatedParent.append(createElement("p", document));
    }
    document.documentElement.append(selectedRoot);
    document.documentElement.append(unrelatedParent);
    let selectedRef: string | undefined;
    const harness = createProviderHarness(document, {
      maxRecords: 64,
      getSelectedNodeRef: () => selectedRef,
    });
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    let selectedView = topChildren[0]!;
    for (let depth = 0; depth < 9; depth += 1) {
      selectedView = onlyChild(
        harness.provider,
        selectedView,
        root.documentEpoch,
        `selected-depth-${depth}`,
      );
    }
    selectedRef = selectedView.nodeRef;
    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    let cursor: string | undefined;
    let staleUnrelatedRef: string | undefined;
    for (let pageIndex = 0; pageIndex < 4; pageIndex += 1) {
      const page = harness.provider.getChildren({
        type: "dom.getChildren",
        requestId: `unrelated-page-${pageIndex}`,
        documentEpoch: root.documentEpoch,
        nodeRef: topChildren[1]!.nodeRef,
        branchRevision: topChildren[1]!.branchRevision,
        ...(cursor ? { cursor } : {}),
      });
      staleUnrelatedRef ??= page.nodes[0]!.nodeRef;
      cursor = page.nextCursor;
    }

    const selectedPath = harness.provider.ancestorPath(
      selectedView.nodeRef,
      root.documentEpoch,
    );
    expect(selectedPath).toHaveLength(11);
    expect(selectedPath[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(selectedPath.at(-1)?.nodeRef).toBe(selectedView.nodeRef);
    expect(() => harness.provider.ancestorPath(
      staleUnrelatedRef!,
      root.documentEpoch,
    )).toThrowError("unknown-node");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    };
    expect(internals.records.size).toBeLessThanOrEqual(64);
  });

  it("fails closed when the record capacity is fully retained", () => {
    const document = createDocument();
    const parent = createElement("main", document);
    parent.append(createElement("button", document));
    document.documentElement.append(parent);
    const harness = createProviderHarness(document, { maxRecords: 2 });
    const root = harness.provider.getRoot();
    const parentView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "root-child",
    );

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "capacity-exhausted",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    })).toThrowError("node-unavailable");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    expect([internals.records.size, internals.nodeRegistry.size]).toEqual([2, 2]);
  });

  it("does not evict rows while assembling the same child page", () => {
    const document = createDocument();
    for (let index = 0; index < 10; index += 1) {
      document.documentElement.append(createElement("section", document));
    }
    const harness = createProviderHarness(document, { maxRecords: 8 });
    const root = harness.provider.getRoot();

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "oversized-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    const internals = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    expect(internals.records.size).toBeLessThanOrEqual(8);
    expect(internals.nodeRegistry.size).toBeLessThanOrEqual(8);
  });

  it("cleans nested branches and observers on collapse", () => {
    const document = createDocument();
    const collapsedRoot = createElement("main", document);
    let current = collapsedRoot;
    for (let depth = 0; depth < 60; depth += 1) {
      const child = createElement("section", document);
      current.append(child);
      current = child;
    }
    const deepShadow = current.attachShadow();
    for (let index = 0; index < 51; index += 1) {
      deepShadow.append(createElement("button", document));
    }
    const unrelatedHost = createElement("aside", document);
    const unrelatedShadow = unrelatedHost.attachShadow();
    unrelatedShadow.append(createElement("span", document));
    document.documentElement.append(collapsedRoot);
    document.documentElement.append(unrelatedHost);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const topChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "top-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    let deepView = topChildren[0]!;
    for (let depth = 0; depth < 60; depth += 1) {
      deepView = onlyChild(
        harness.provider,
        deepView,
        root.documentEpoch,
        `depth-${depth}`,
      );
    }
    const deepShadowView = onlyChild(
      harness.provider,
      deepView,
      root.documentEpoch,
      "deep-shadow",
    );
    const deepPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "deep-page",
      documentEpoch: root.documentEpoch,
      nodeRef: deepShadowView.nodeRef,
      branchRevision: deepShadowView.branchRevision,
    });
    const unrelatedShadowView = onlyChild(
      harness.provider,
      topChildren[1]!,
      root.documentEpoch,
      "unrelated-shadow",
    );
    onlyChild(
      harness.provider,
      unrelatedShadowView,
      root.documentEpoch,
      "unrelated-child",
    );
    const deepObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(deepShadow)
    ))!;
    const unrelatedObserver = harness.observers.find((observer) => (
      observer.observedTargets.includes(unrelatedShadow)
    ))!;

    expect(harness.provider.ancestorPath(
      deepShadowView.nodeRef,
      root.documentEpoch,
    )).toHaveLength(63);

    harness.provider.collapse(topChildren[0]!.nodeRef, root.documentEpoch);

    expect([
      deepObserver.disconnectCount,
      unrelatedObserver.disconnectCount,
      harness.observers[0]!.disconnectCount,
    ]).toEqual([1, 0, 0]);
    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "released-deep-page",
      documentEpoch: root.documentEpoch,
      nodeRef: deepShadowView.nodeRef,
      branchRevision: deepShadowView.branchRevision,
      cursor: deepPage.nextCursor,
    })).toThrowError("invalid-cursor");
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "unrelated-still-live",
      documentEpoch: root.documentEpoch,
      nodeRef: unrelatedShadowView.nodeRef,
      branchRevision: unrelatedShadowView.branchRevision,
    }).nodes).toHaveLength(1);
  });

  it("looks up only already-materialized live elements with their frame identity", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const card = createElement("article", document);
    body.append(card);
    document.documentElement.append(body);
    const provider = createProvider(document);

    const root = provider.getRoot();
    const records = (provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
    }).records;
    const recordCount = records.size;

    expect(provider.lookupElement(card as unknown as Element)).toBeUndefined();
    expect(records.size).toBe(recordCount);
    expect(provider.lookupElement(document.documentElement as unknown as Element))
      .toEqual({
        nodeRef: root.node.nodeRef,
        frameRef: "frame-1",
        frameEpoch: 1,
        documentEpoch: root.documentEpoch,
      });
  });

  it("reveals an attached element through one bounded materialized ancestor path", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const card = createElement("article", document);
    body.append(card);
    document.documentElement.append(body);
    const provider = createProvider(document);
    const root = provider.getRoot();

    const revealed = provider.revealElement(card as unknown as Element);

    expect(revealed).toMatchObject({
      frameRef: "frame-1",
      frameEpoch: 1,
      documentEpoch: root.documentEpoch,
    });
    expect(revealed.ancestorPath.map((node) => node.label)).toEqual([
      "html",
      "body",
      "article",
    ]);
    expect(revealed.ancestorPath[0]?.nodeRef).toBe(root.node.nodeRef);
    expect(revealed.ancestorPath.at(-1)?.nodeRef).toBe(revealed.nodeRef);
    expect(provider.lookupElement(card as unknown as Element)?.nodeRef)
      .toBe(revealed.nodeRef);
  });

  it("resolves and retains current element refs for independent session authorities", () => {
    const document = createDocument();
    const card = createElement("article", document);
    document.documentElement.append(card);
    const provider = createProvider(document);
    const revealed = provider.revealElement(card as unknown as Element);

    expect(provider.resolveElement(revealed.nodeRef, revealed.documentEpoch))
      .toEqual({
        element: card,
        nodeRef: revealed.nodeRef,
        frameRef: "frame-1",
        frameEpoch: 1,
        documentEpoch: revealed.documentEpoch,
      });
    expect(provider.resolveElement("node-999", revealed.documentEpoch))
      .toBeUndefined();
    expect(() => provider.resolveElement(revealed.nodeRef, 2))
      .toThrowError("stale-document");

    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "selected",
    )).toBe(true);
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);
    const registry = (provider as unknown as {
      readonly nodeRegistry: {
        retentionReasons(nodeRef: string): readonly string[];
      };
    }).nodeRegistry;
    expect(registry.retentionReasons(revealed.nodeRef))
      .toEqual(["selected", "hovered"]);

    provider.releaseNode(revealed.nodeRef, "hovered");
    expect(registry.retentionReasons(revealed.nodeRef)).toEqual(["selected"]);
    provider.releaseNode(revealed.nodeRef, "selected");
    expect(registry.retentionReasons(revealed.nodeRef)).toEqual([]);
  });

  it("stops resolving a retained element as soon as it detaches", () => {
    const document = createDocument();
    const card = createElement("article", document);
    document.documentElement.append(card);
    const provider = createProvider(document);
    const revealed = provider.revealElement(card as unknown as Element);
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "hovered",
    )).toBe(true);

    document.documentElement.remove(card);

    expect(provider.lookupElement(card as unknown as Element)).toBeUndefined();
    expect(provider.resolveElement(revealed.nodeRef, revealed.documentEpoch))
      .toBeUndefined();
    expect(provider.retainNode(
      revealed.nodeRef,
      revealed.documentEpoch,
      "selected",
    )).toBe(false);
  });

  it("exposes read-only frame authority and forwards tracked frame lifecycle", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const replacementDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    const lifecycle: Array<{
      readonly type: string;
      readonly frameRef: string;
      readonly frameEpoch: number;
    }> = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => lifecycle.push(event),
    });

    expect(Object.isFrozen(harness.provider.frameAuthority)).toBe(true);
    expect("describeFrame" in harness.provider.frameAuthority).toBe(false);
    expect(harness.provider.currentDocumentEpoch).toBe(3);

    harness.provider.startFrameTracking();

    const child = harness.provider.frameAuthority
      .getContextForDocument(childDocument as unknown as Document);
    expect(child).toMatchObject({
      frameRef: "frame-2",
      frameEpoch: 1,
      documentEpoch: 3,
    });
    expect(lifecycle.map(({ type }) => type)).toEqual(["registered"]);

    frame.setFrameDocument(replacementDocument);
    frame.dispatchLoad();
    expect(harness.provider.frameAuthority
      .getContextForDocument(childDocument as unknown as Document))
      .toBeUndefined();
    expect(harness.provider.frameAuthority
      .getContextForDocument(replacementDocument as unknown as Document))
      .toMatchObject({ frameRef: "frame-2", frameEpoch: 2 });

    document.documentElement.remove(frame);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [frame]),
    ]);
    harness.flushTimers();

    expect(lifecycle.map(({ type }) => type)).toEqual([
      "registered",
      "navigated",
      "removed",
    ]);
    expect(harness.provider.frameAuthority.getContext("frame-2"))
      .toBeUndefined();
  });

  it("excludes overlay-owned nodes from traversal and mutation discovery", () => {
    const document = createDocument();
    const pageContent = createElement("main", document);
    const overlayHost = createElement("pin-op-overlay", document);
    const overlayRoot = overlayHost.attachShadow();
    const overlayArtifact = createElement("div", document);
    overlayRoot.append(overlayArtifact);
    document.documentElement.append(pageContent);
    document.documentElement.append(overlayHost);
    const overlayNodes = new Set<FakeNode>([
      overlayHost,
      overlayRoot,
      overlayArtifact,
    ]);
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => overlayNodes.has(node as unknown as FakeNode),
    });

    const root = harness.provider.getRoot();
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "without-overlay",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["main"]);
    expect(harness.provider.lookupElement(overlayHost as unknown as Element))
      .toBeUndefined();
    expect(() => harness.provider.revealElement(
      overlayHost as unknown as Element,
    )).toThrowError("node-unavailable");
    expect(() => harness.provider.revealElement(
      overlayArtifact as unknown as Element,
    )).toThrowError("node-unavailable");

    document.documentElement.remove(overlayHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [], [overlayHost]),
    ]);
    document.documentElement.append(overlayHost);
    harness.observers[0]!.emit([
      mutationRecord(document.documentElement, [overlayHost]),
    ]);
    harness.flushTimers();

    const refreshedRoot = harness.provider.getRoot();
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "without-reattached-overlay",
      documentEpoch: refreshedRoot.documentEpoch,
      nodeRef: refreshedRoot.node.nodeRef,
      branchRevision: refreshedRoot.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["main"]);
    expect(harness.provider.lookupElement(overlayHost as unknown as Element))
      .toBeUndefined();
  });

  it("resolves an equivalent heading through fresh refs and its complete ancestor path", () => {
    const first = createHeadingTree({ includeAttributes: false });
    const unrelated = createElement("aside", first.document);
    first.document.documentElement.append(unrelated);
    first.provider.revealElement(unrelated as unknown as Element);
    const original = first.provider.revealElement(first.target as unknown as Element);
    const second = createHeadingTree({ includeAttributes: false });

    const restored = resolveLocator(
      second.provider,
      original.ancestorPath.at(-1)!.locator,
    );

    expect(restored?.node.nodeRef).not.toBe(original.nodeRef);
    expect(restored?.ancestorPath.map(({ label }) => label)).toEqual([
      "html",
      "body",
      "main",
      "h2#section_title_id1.block_title",
    ]);
  });

  it("rejects a locator whose captured ID is duplicated in the current boundary", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const duplicate = createElement("h2", second.document);
    duplicate.id = "section_title_id1";
    duplicate.className = "block_title";
    duplicate.setAttribute("data-section", "intro");
    second.main.append(duplicate);

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when the exact structural index has a changed tag", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ tagName: "p" });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when its captured class evidence changes", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ className: "replaced_title" });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it.each([
    ["data-section", "changed"],
    ["aria-label", "changed"],
    ["role", "heading"],
  ])("rejects a locator when captured %s evidence changes", (name, value) => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ attribute: { name, value } });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a locator when a structural sibling is missing", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("resolves nested open-shadow paths and rejects a missing shadow boundary", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toBe("button#shadow_target.action");

    const missing = createNestedShadowTree({ attachInnerShadow: false });
    expect(resolveLocator(missing.provider, locator)).toBeUndefined();
  });

  it("resolves a registered same-origin frame and rejects an inaccessible replacement", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree();

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toBe("button#frame_target.action");

    const inaccessible = createFramedButtonTree({
      accessError: new Error("cross-origin"),
    });
    expect(resolveLocator(inaccessible.provider, locator)).toBeUndefined();
  });

  it("does not consult materialized session refs while resolving a locator", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    second.provider.resolveElement = () => {
      throw new Error("stale ref consulted");
    };

    expect(resolveLocator(second.provider, locator)?.node.label)
      .toContain("h2#section_title_id1.block_title");
  });

  it("rejects a locator whose traversal exceeds 64 structural segments", () => {
    const provider = createProvider(createDocument());
    const segment = Object.freeze({ tagName: "div", siblingIndex: 0 });
    const locator = Object.freeze({
      version: 1 as const,
      targetKind: "element" as const,
      boundaries: Object.freeze([]),
      path: Object.freeze(Array.from({ length: 65 }, () => segment)),
    });

    expect(resolveLocator(provider, locator)).toBeUndefined();
  });

  it("never delivers an empty locator when capture cannot prove identity", () => {
    const hostileDocument = createDocument();
    hostileDocument.documentElement.append(
      new FakeElement(`<SCRIPT>${"x".repeat(600)}</SCRIPT>`, hostileDocument),
    );
    const hostileProvider = createProvider(hostileDocument);
    const hostileRoot = hostileProvider.getRoot();
    expect(() => onlyChild(
      hostileProvider,
      hostileRoot.node,
      hostileRoot.documentEpoch,
      "hostile-capture",
    )).toThrowError("node-unavailable");

    const deepDocument = createDocument();
    let parent = deepDocument.documentElement;
    for (let depth = 0; depth < 64; depth += 1) {
      const child = createElement("section", deepDocument);
      parent.append(child);
      parent = child;
    }
    const deepProvider = createProvider(deepDocument);
    let view = deepProvider.getRoot().node;
    for (let depth = 0; depth < 63; depth += 1) {
      view = onlyChild(deepProvider, view, 3, `deep-${depth}`);
      expect(view.locator.path).not.toHaveLength(0);
    }
    expect(() => onlyChild(deepProvider, view, 3, "too-deep")).toThrowError(
      "node-unavailable",
    );
  });

  it("captures canonical punctuation-bearing attributes in parser order", () => {
    const first = createHeadingTree({ includeAttributes: false });
    first.target.setAttribute("data-a_", "underscore");
    first.target.setAttribute("data-a.0", "dot");
    first.target.setAttribute("data-a1", "digit");
    first.target.setAttribute("data-a", "dash");
    const locator = locatorFor(first.provider, first.target);
    const attributes = locator.path.at(-1)?.attributes ?? [];

    expect(attributes.map(({ name }) => name)).toEqual([
      "data-a",
      "data-a.0",
      "data-a1",
      "data-a_",
    ]);

    const second = createHeadingTree({ includeAttributes: false });
    second.target.setAttribute("data-a1", "digit");
    second.target.setAttribute("data-a_", "underscore");
    second.target.setAttribute("data-a", "dash");
    second.target.setAttribute("data-a.0", "dot");
    expect(resolveLocator(second.provider, locator)?.node.kind).toBe("element");
  });

  it("captures deterministic bounded evidence and rejects oversized hostile collections", () => {
    const first = createHeadingTree({ includeAttributes: false });
    for (let index = 9; index >= 0; index -= 1) {
      first.target.setAttribute(`data-key-${index}`, String(index));
    }
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.attributes?.map(({ name }) => name)).toEqual([
      "data-key-0",
      "data-key-1",
      "data-key-2",
      "data-key-3",
      "data-key-4",
      "data-key-5",
      "data-key-6",
      "data-key-7",
    ]);

    const oversized = createHeadingTree({ includeAttributes: false });
    for (let index = 0; index <= 256; index += 1) {
      oversized.target.setAttribute(`data-overflow-${index}`, String(index));
    }
    expect(() => locatorFor(oversized.provider, oversized.target)).toThrowError(
      "node-unavailable",
    );
  });

  it("delivers only non-empty recoverable locators for ordinary element, shadow, and frame views", () => {
    const document = createDocument();
    const host = createElement("article", document);
    host.attachShadow().append(createElement("button", document));
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(host);
    document.documentElement.append(frame);
    const provider = createProvider(document);
    const root = provider.getRoot();
    const [hostView, frameView] = provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordinary-views",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const shadowView = onlyChild(provider, hostView!, root.documentEpoch, "ordinary-shadow");
    const frameDocumentView = onlyChild(provider, frameView!, root.documentEpoch, "ordinary-frame");

    for (const view of [root.node, hostView!, shadowView, frameView!, frameDocumentView]) {
      expect(view.locator.path.length + view.locator.boundaries.length).toBeGreaterThan(0);
      expect(resolveLocator(provider, view.locator)?.node.kind).toBe(view.kind);
    }
  });

  it("fails closed before scanning more than 256 physical children in one level", () => {
    const first = createDocument();
    let firstTarget!: FakeElement;
    for (let index = 0; index < 1_025; index += 1) {
      const sibling = createElement("span", first);
      first.documentElement.append(sibling);
      firstTarget = sibling;
    }
    firstTarget.id = "wide_target";
    expect(() => locatorFor(createProvider(first), firstTarget)).toThrowError("node-unavailable");
  });

  it("rejects an oversized child collection before indexed structural reads", () => {
    const tree = createHeadingTree();
    let indexedReads = 0;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => new Proxy({ length: 257 }, {
        get: (collection, key) => {
          if (typeof key === "string" && /^\\d+$/.test(key)) indexedReads += 1;
          return Reflect.get(collection, key);
        },
      }),
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
    expect(indexedReads).toBe(0);
  });

  it("shares the locator visit budget across nested structural proofs", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    const collections: Array<{ readonly parent: FakeElement; readonly children: FakeNode[] }> = [];
    for (let depth = 0; depth < 53; depth += 1) {
      const next = createElement(depth === 52 ? "h2" : "section", document);
      const children: FakeNode[] = [];
      for (let index = 0; index < 255; index += 1) {
        const sibling = createElement("span", document);
        parent.append(sibling);
        children.push(sibling);
      }
      parent.append(next);
      children.push(next);
      collections.push({ parent, children });
      parent = next;
      target = next;
    }
    const provider = createProvider(document);
    const service = (provider as unknown as {
      readonly locatorService: {
        capture(node: Node, kind: "element"): DomStableLocator;
        resolve(locator: DomStableLocator): unknown;
      };
    }).locatorService;
    const locator = service.capture(target as unknown as Node, "element");
    let indexedReads = 0;
    for (const { parent: collectionParent, children } of collections) {
      Object.defineProperty(collectionParent, "childNodes", {
        configurable: true,
        get: () => new Proxy(children, {
          get: (collection, key) => {
            if (typeof key === "string" && /^\\d+$/.test(key)) indexedReads += 1;
            return Reflect.get(collection, key);
          },
        }),
      });
    }

    expect(service.resolve(locator)).toBeUndefined();
    expect(indexedReads).toBeLessThanOrEqual(65_536);
  });

  it("charges previous-sibling walks to the shared locator visit budget", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    let siblingReads = 0;
    for (let depth = 0; depth < 63; depth += 1) {
      const next = createElement(depth === 62 ? "h2" : "section", document);
      const children: FakeElement[] = [];
      for (let index = 0; index < 255; index += 1) {
        const sibling = createElement("span", document);
        parent.append(sibling);
        children.push(sibling);
      }
      parent.append(next);
      children.push(next);
      for (const child of children) {
        const previous = child.previousElementSibling;
        Object.defineProperty(child, "previousElementSibling", {
          configurable: true,
          get: () => {
            siblingReads += 1;
            return previous;
          },
        });
      }
      parent = next;
      target = next;
    }
    const provider = createProvider(document);
    const service = (provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;

    expect(() => service.capture(target as unknown as Node, "element"))
      .toThrow("Invalid stable DOM locator");
    expect(siblingReads).toBeLessThanOrEqual(65_536);
  });

  it("charges bounded class and attribute evidence reads to the shared locator budget", () => {
    const document = createDocument();
    let parent = document.documentElement;
    let target!: FakeElement;
    let evidenceReads = 0;
    for (let depth = 0; depth < 53; depth += 1) {
      const next = createElement(depth === 52 ? "h2" : "section", document);
      for (let index = 0; index < 255; index += 1) {
        parent.append(createElement("span", document));
      }
      parent.append(next);
      const classes = Array.from({ length: 256 }, (_, index) => `class-${index}`);
      const attributes = Array.from({ length: 256 }, (_, index) => ({
        name: `data-key-${index}`,
        value: String(index),
      }));
      for (const collection of [classes, attributes]) {
        Object.defineProperty(next, collection === classes ? "classList" : "attributes", {
          configurable: true,
          get: () => new Proxy(collection, {
            get: (value, key) => {
              if (typeof key === "string" && /^\d+$/.test(key)) evidenceReads += 1;
              return Reflect.get(value, key);
            },
          }),
        });
      }
      parent = next;
      target = next;
    }
    const service = (createProvider(document) as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;

    expect(() => service.capture(target as unknown as Node, "element")).toThrow();
    expect(evidenceReads).toBeLessThanOrEqual(65_536);
  });

  it("resolves a captured shadow-root target with a fresh full materialized path", () => {
    const first = createNestedShadowTree();
    const firstUnrelated = createElement("aside", first.document);
    first.document.documentElement.append(firstUnrelated);
    first.provider.revealElement(firstUnrelated as unknown as Element);
    first.document.documentElement.remove(firstUnrelated);
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-shadow-root");
    const second = createNestedShadowTree();
    const secondRoot = second.provider.getRoot();
    const secondHost = onlyChild(second.provider, secondRoot.node, 3, "second-shadow-host");
    onlyChild(second.provider, secondHost, 3, "second-shadow-root");

    const restored = resolveLocator(second.provider, firstShadow.locator);

    expect(restored?.node.kind).toBe("shadow-root");
    expect(restored?.node.nodeRef).not.toBe(firstShadow.nodeRef);
    expect(restored?.ancestorPath.map(({ kind }) => kind)).toEqual([
      "element",
      "element",
      "shadow-root",
    ]);
  });

  it("rejects malformed shadow-root targets during capture and resolution", () => {
    const first = createNestedShadowTree();
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-malformed-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-malformed-shadow-root");
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const unrelated = createElement("aside", second.document);
    const unrelatedRoot = unrelated.attachShadow();

    outer.shadowRoot = unrelatedRoot;
    expect(resolveStableLocator(second.provider, firstShadow.locator)).toBeUndefined();

    const capture = createNestedShadowTree();
    const captureRoot = capture.provider.getRoot();
    const captureHost = onlyChild(capture.provider, captureRoot.node, 3, "hostile-shadow-host");
    const captureShadow = (capture.document.documentElement.childNodes[0] as FakeElement).shadowRoot!;
    Object.defineProperty(captureShadow, "host", {
      configurable: true,
      get: () => {
        throw new Error("hostile shadow host");
      },
    });
    expect(() => onlyChild(
      capture.provider,
      captureHost,
      3,
      "hostile-shadow-root",
    )).toThrowError("node-unavailable");
  });

  it("rejects a cyclic shadow-root target", () => {
    const first = createNestedShadowTree();
    const firstRoot = first.provider.getRoot();
    const firstHost = onlyChild(first.provider, firstRoot.node, 3, "first-cyclic-shadow-host");
    const firstShadow = onlyChild(first.provider, firstHost, 3, "first-cyclic-shadow-root");
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const outerShadow = outer.shadowRoot!;

    Object.defineProperty(outerShadow, "host", {
      configurable: true,
      value: outerShadow,
    });

    expect(resolveStableLocator(second.provider, firstShadow.locator)).toBeUndefined();
  });

  it("rejects malformed shadow-root boundaries before resolving an element target", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const outerShadow = outer.shadowRoot!;

    Object.defineProperty(outerShadow, "host", {
      configurable: true,
      value: outerShadow,
    });
    Object.defineProperty(outerShadow, "getRootNode", {
      configurable: true,
      value: () => outer,
    });

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects a shadow boundary whose host points at a different element", () => {
    const first = createNestedShadowTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createNestedShadowTree();
    const outer = second.document.documentElement.childNodes[0] as FakeElement;
    const unrelated = createElement("aside", second.document);
    const unrelatedRoot = unrelated.attachShadow();

    outer.shadowRoot = unrelatedRoot;

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
  });

  it("resolves a captured frame-document target through its registered exact host", () => {
    const first = createFramedButtonTree({ materialize: false });
    const firstUnrelated = createElement("aside", first.document);
    first.document.documentElement.append(firstUnrelated);
    first.provider.revealElement(firstUnrelated as unknown as Element);
    first.document.documentElement.remove(firstUnrelated);
    const firstRoot = first.provider.getRoot();
    const firstFrame = onlyChild(first.provider, firstRoot.node, 3, "first-frame");
    const firstDocument = onlyChild(first.provider, firstFrame, 3, "first-frame-document");
    const second = createFramedButtonTree({
      materialize: false,
      includeUnrelatedFrame: true,
    });
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);

    const restored = resolveLocator(second.provider, firstDocument.locator);

    expect(restored?.node.kind).toBe("frame-document");
    expect(restored?.node.nodeRef).not.toBe(firstDocument.nodeRef);
    expect(restored?.ancestorPath.map(({ kind }) => kind)).toEqual([
      "element",
      "element",
      "frame-document",
    ]);
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(2);
    expect(second.provider.frameAuthority.accessibleContexts().map(({ document }) => document))
      .not.toContain(second.unrelatedDocument as unknown as Document);
  });

  it("fails locator resolution for excluded, inaccessible, and cyclic current DOM", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const excluded = createHeadingTree();
    const excludedProvider = createProviderHarness(excluded.document, {
      isExcludedNode: (node) => node === excluded.target,
    }).provider;
    expect(resolveLocator(excludedProvider, locator)).toBeUndefined();

    const framed = createFramedButtonTree();
    const framedRoot = framed.provider.getRoot();
    const framedHost = onlyChild(framed.provider, framedRoot.node, 3, "framed-host");
    const framedDocument = onlyChild(framed.provider, framedHost, 3, "framed-document");
    const inaccessible = createFramedButtonTree({
      accessError: new Error("cross-origin"),
      materialize: false,
    });
    expect(resolveLocator(inaccessible.provider, framedDocument.locator)).toBeUndefined();

    const cyclic = createHeadingTree();
    cyclic.target.parentNode = cyclic.target;
    expect(resolveLocator(createProvider(cyclic.document), locator)).toBeUndefined();
  });

  it("fails closed for previous-sibling cycles and inaccessible evidence access", () => {
    const document = createHeadingTree();
    document.target.previousElementSibling = document.target;
    expect(() => locatorFor(document.provider, document.target)).toThrowError(
      "node-unavailable",
    );

    const hostile = createHeadingTree();
    Object.defineProperty(hostile.target, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile attributes");
      },
    });
    expect(() => locatorFor(hostile.provider, hostile.target)).toThrowError(
      "node-unavailable",
    );
  });

  it("fails closed during resolution for hostile evidence and child collections", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const classes = createHeadingTree();
    Object.defineProperty(classes.target, "classList", {
      configurable: true,
      get: () => ({ length: 257 }),
    });
    expect(resolveLocator(classes.provider, locator)).toBeUndefined();

    const attributes = createHeadingTree();
    Object.defineProperty(attributes.target, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile resolution attributes");
      },
    });
    expect(resolveLocator(attributes.provider, locator)).toBeUndefined();

    const children = createHeadingTree();
    Object.defineProperty(children.main, "childNodes", {
      configurable: true,
      get: () => ({ length: 65_537 }),
    });
    expect(resolveLocator(children.provider, locator)).toBeUndefined();
  });

  it("compares canonical top-eight evidence exactly while ignoring noncanonical additions", () => {
    const first = createHeadingTree({ includeAttributes: false });
    first.target.className = Array.from({ length: 10 }, (_, index) => `class-${index}`)
      .join(" ");
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.classes).toEqual([
      "class-0", "class-1", "class-2", "class-3",
      "class-4", "class-5", "class-6", "class-7",
    ]);

    const equivalent = createHeadingTree({ includeAttributes: false });
    equivalent.target.className = `${first.target.className} zzz`;
    expect(resolveLocator(equivalent.provider, locator)?.node.kind).toBe("element");

    const changed = createHeadingTree({ includeAttributes: false });
    changed.target.className = `aaa ${first.target.className}`;
    expect(resolveLocator(changed.provider, locator)).toBeUndefined();
  });

  it("counts excluded duplicate IDs and fails closed on unreadable uniqueness descendants", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);

    const duplicate = createHeadingTree();
    const hiddenDuplicate = createElement("aside", duplicate.document);
    hiddenDuplicate.id = duplicate.target.id;
    duplicate.main.append(hiddenDuplicate);
    const excluded = createProviderHarness(duplicate.document, {
      isExcludedNode: (node) => node === hiddenDuplicate,
    }).provider;
    expect(resolveLocator(excluded, locator)).toBeUndefined();

    const unreadable = createHeadingTree();
    Object.defineProperty(unreadable.document.documentElement, "childNodes", {
      configurable: true,
      get: () => {
        throw new Error("hostile uniqueness descendants");
      },
    });
    expect(resolveLocator(unreadable.provider, locator)).toBeUndefined();
  });

  it("omits duplicate captured IDs while preserving structural locator recovery", () => {
    const first = createHeadingTree();
    const duplicate = createElement("h2", first.document);
    duplicate.id = first.target.id;
    duplicate.className = first.target.className;
    duplicate.setAttribute("data-section", "intro");
    duplicate.setAttribute("aria-label", "Introduction");
    duplicate.setAttribute("role", "presentation");
    first.main.append(duplicate);
    const locator = locatorFor(first.provider, first.target);
    expect(locator.path.at(-1)?.id).toBeUndefined();

    const second = createHeadingTree();
    const secondDuplicate = createElement("h2", second.document);
    secondDuplicate.id = second.target.id;
    secondDuplicate.className = second.target.className;
    secondDuplicate.setAttribute("data-section", "intro");
    secondDuplicate.setAttribute("aria-label", "Introduction");
    secondDuplicate.setAttribute("role", "presentation");
    second.main.append(secondDuplicate);
    expect(resolveLocator(second.provider, locator)?.node.label)
      .toContain("h2#section_title_id1.block_title");
  });

  it("rolls back exact frame authorization when later locator proof fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    second.target.tagName = "P";

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(second.frame.loadListenerCount).toBe(0);
  });

  it("drains a newer reset after locator frame authorization aborts without lifecycle", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    const latestDocument = createDocument();
    let reentered = false;
    second.frame.addEventListener = (type) => {
      if (type === "load" && !reentered) {
        reentered = true;
        second.provider.resetDocument(latestDocument as unknown as Document, 4);
      }
      throw new Error("listener installation failed");
    };

    expect(resolveLocator(second.provider, locator)).toBeUndefined();

    expect(reentered).toBe(true);
    expect(second.provider.currentDocumentEpoch).toBe(4);
    expect(second.provider.frameAuthority.getContextForDocument(
      latestDocument as unknown as Document,
    )).toBeDefined();
    expect(second.provider.frameAuthority.getContextForDocument(
      second.document as unknown as Document,
    )).toBeUndefined();
    expect(second.frame.loadListenerCount).toBe(0);
  });

  it("keeps pre-existing inaccessible frame authority when locator recovery fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({
      accessError: new Error("cross-origin"),
      materialize: false,
    });
    const root = second.provider.getRoot();
    onlyChild(second.provider, root.node, root.documentEpoch, "register-inaccessible-frame");

    expect(second.frame.loadListenerCount).toBe(1);
    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.frame.loadListenerCount).toBe(1);
  });

  it("rolls back recovery frame authority when provider path materialization fails", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    const provider = second.provider as unknown as {
      materializeLogicalPath(): undefined;
    };
    provider.materializeLogicalPath = () => undefined;

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.provider.frameAuthority.accessibleContexts()).toHaveLength(1);
    expect(second.frame.loadListenerCount).toBe(0);
  });

  it("contains temporary locator frame lifecycle effects until resolution commits", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const provider = harness.provider as unknown as {
      frameTracking: boolean;
      materializeLogicalPath: (...args: readonly unknown[]) => unknown;
      readonly pendingFrameMutationScans: readonly unknown[];
    };
    provider.frameTracking = true;
    const originalMaterialize = provider.materializeLogicalPath;
    provider.materializeLogicalPath = () => undefined;

    expect(resolveLocator(harness.provider, locator)).toBeUndefined();
    expect(events).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(provider.pendingFrameMutationScans).toHaveLength(0);
    expect(frame.loadListenerCount).toBe(0);

    provider.materializeLogicalPath = originalMaterialize;
    expect(resolveLocator(harness.provider, locator)?.node.label)
      .toContain("button#frame_target.action");
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(harness.pendingTimerCount()).toBe(1);
  });

  it("returns locator refs before a post-commit frame callback resets authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") provider?.resetDocument(createDocument() as unknown as Document, 4);
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    expect(harness.provider.currentDocumentEpoch).toBe(3);
    harness.flushEffects();
    expect(harness.provider.currentDocumentEpoch).toBe(4);
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("returns locator refs before a post-commit frame callback disposes authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") provider?.dispose();
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
    expect(() => harness.provider.getRoot()).toThrowError("session-disposed");
    expect(frame.loadListenerCount).toBe(0);
  });

  it("returns locator refs before a post-commit frame callback navigates authority", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") {
          frame.setFrameDocument(createDocument());
          frame.dispatchLoad();
        }
      },
    });

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
  });

  it("publishes locator effects once for read-only callback reentry", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const events: string[] = [];
    let observedContexts = 0;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        events.push(event.type);
        observedContexts = provider?.frameAuthority.accessibleContexts().length ?? 0;
      },
    });
    provider = harness.provider;

    expect(resolveLocator(harness.provider, locator)?.node.label).toContain("button#frame_target.action");
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(observedContexts).toBe(2);
  });

  it("returns a child page before a post-commit callback resets authority", () => {
    const document = createDocument();
    let armed = false;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (armed && event.type === "registered") {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    document.documentElement.append(createFrameElement(document, createDocument()));
    armed = true;

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "published-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(1);
    harness.flushEffects();
    expect(harness.provider.currentDocumentEpoch).toBe(4);
  });

  it("does not return an ancestor path after callback reentry resets authority", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    let armed = false;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (armed && event.type === "navigated") {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "ancestor-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "ancestor-document");
    const targetView = onlyChild(harness.provider, frameDocument, root.documentEpoch, "ancestor-target");
    const state = harness.provider as unknown as {
      viewFrameDocument(document: Document, ...args: readonly unknown[]): unknown;
    };
    const originalViewFrameDocument = state.viewFrameDocument;
    let navigated = false;
    state.viewFrameDocument = (frameDocumentNode, ...args) => {
      const view = originalViewFrameDocument.call(state, frameDocumentNode, ...args);
      if (armed && !navigated) {
        navigated = true;
        frame.setFrameDocument(createDocument());
        frame.dispatchLoad();
      }
      return view;
    };
    armed = true;

    expect(() => harness.provider.ancestorPath(targetView.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
    expect(harness.provider.currentDocumentEpoch).toBe(3);
  });

  it.each([
    ["reset", (provider: DomTreeProvider, _frame: FakeFrameElement) => (
      provider.resetDocument(createDocument() as unknown as Document, 4)
    )],
    ["dispose", (provider: DomTreeProvider, _frame: FakeFrameElement) => provider.dispose()],
    ["navigate", (_provider: DomTreeProvider, frame: FakeFrameElement) => {
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
    }],
  ] as const)("stops ordered post-commit frame delivery after a callback %s authority", (_name, invalidate) => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    let provider: DomTreeProvider | undefined;
    let invalidated = false;
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        registered.push(event.frameRef);
        if (!invalidated) {
          invalidated = true;
          invalidate(provider!, frames[0]);
        }
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordered-frame-effects",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(3);
    harness.flushEffects();
    expect(registered).toHaveLength(1);
  });

  it("replays all ordered frame effects once for a read-only callback", () => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") registered.push(event.frameRef);
      },
    });
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    const response = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "ordered-frame-effects-read-only",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    });

    expect(response.nodes).toHaveLength(3);
    harness.flushEffects();
    expect(new Set(registered)).toHaveLength(3);
    expect(registered).toHaveLength(3);
  });

  it("returns a root before its first post-commit callback changes it", () => {
    const document = createDocument();
    const invalidations: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => {
        invalidations.push(branch.nodeRef);
        if (invalidations.length === 1) document.documentElement.className = "changed";
      },
    });
    const state = harness.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalViewElement = state.viewElement;
    state.viewElement = (element, ...args) => {
      const view = originalViewElement.call(state, element, ...args);
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      return view;
    };

    expect(harness.provider.getRoot().node.label).toBe("html");
    harness.flushEffects();
    expect(invalidations).toHaveLength(3);
  });

  it("returns children before their first post-commit callback replaces them", () => {
    const document = createDocument();
    const frames = [
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
      createFrameElement(document, createDocument()),
    ];
    const registered: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        registered.push(event.frameRef);
        if (registered.length === 1) {
          document.documentElement.remove(frames[0]);
          document.documentElement.append(createFrameElement(document, createDocument()));
        }
      },
    });
    const root = harness.provider.getRoot();
    for (const frame of frames) document.documentElement.append(frame);

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "published-child-dom-change",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(3);
    harness.flushEffects();
    expect(registered).toHaveLength(3);
  });

  it("returns an ancestor path before its first post-commit callback moves it", () => {
    const tree = createHeadingTree();
    const root = tree.provider.getRoot();
    const body = onlyChild(tree.provider, root.node, root.documentEpoch, "ancestor-live-body");
    const main = onlyChild(tree.provider, body, root.documentEpoch, "ancestor-live-main");
    const target = onlyChild(tree.provider, main, root.documentEpoch, "ancestor-live-target");
    let effects = 0;
    const state = tree.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
      onInvalidated: ((branch: { readonly nodeRef: string; readonly branchRevision: number }) => void) | undefined;
    };
    const originalViewElement = state.viewElement;
    state.onInvalidated = () => {
      effects += 1;
      if (effects === 1) {
        tree.main.remove(tree.target);
        tree.document.documentElement.append(tree.target);
      }
    };
    state.viewElement = (element, ...args) => {
      const view = originalViewElement.call(state, element, ...args);
      if (element === tree.target) {
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
        state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      }
      return view;
    };

    expect(tree.provider.ancestorPath(target.nodeRef, root.documentEpoch)).toHaveLength(4);
    flushPostCommitEffects(tree.provider);
    expect(effects).toBe(3);
  });

  it("returns a locator result before its post-commit callback changes it", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type === "registered") target.className = "changed";
      },
    });

    expect(resolveLocator(harness.provider, locator)).toBeDefined();
    harness.flushEffects();
    expect(target.className).toBe("changed");
  });

  it("emits no lifecycle callback for a failed locator transaction", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    const target = createElement("button", childDocument);
    target.id = "frame_target";
    target.className = "action";
    childDocument.documentElement.append(target);
    document.documentElement.append(frame);
    const observedFrameRefs: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered") return;
        observedFrameRefs.push(event.frameRef);
      },
    });
    const state = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly frameAuthority: { accessibleContexts(): readonly unknown[] };
      materializeLogicalPath: (...args: readonly unknown[]) => unknown;
    };
    const recordsBefore = state.records.size;
    const contextsBefore = state.frameAuthority.accessibleContexts().length;

    const materialize = state.materializeLogicalPath;
    state.materializeLogicalPath = () => undefined;
    expect(resolveLocator(harness.provider, locator)).toBeUndefined();
    expect(state.records.size).toBe(recordsBefore);
    expect(state.frameAuthority.accessibleContexts()).toHaveLength(contextsBefore);
    expect(frame.loadListenerCount).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(observedFrameRefs).toEqual([]);
    expect((state as unknown as {
      readonly postCommitEffectBatches: readonly unknown[];
      readonly postCommitDeliveryScheduled: boolean;
    }).postCommitEffectBatches).toEqual([]);
    expect((state as unknown as {
      readonly postCommitDeliveryScheduled: boolean;
    }).postCommitDeliveryScheduled).toBe(false);

    state.materializeLogicalPath = materialize;
    expect(resolveLocator(harness.provider, locator)?.node.label).toContain("button#frame_target.action");
    expect(observedFrameRefs).toEqual([]);
    harness.flushEffects();
    expect(observedFrameRefs).toHaveLength(1);
  });

  it.each([
    ["reset", (provider: DomTreeProvider) => (
      provider.resetDocument(createDocument() as unknown as Document, 4)
    )],
    ["dispose", (provider: DomTreeProvider) => provider.dispose()],
  ] as const)("drops committed effects when %s occurs before their outbox delivery", (_name, invalidate) => {
    const document = createDocument();
    const invalidated: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch.nodeRef),
    });
    const state = harness.provider as unknown as {
      viewElement(element: Element, ...args: readonly unknown[]): { readonly nodeRef: string; readonly branchRevision: number };
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const viewElement = state.viewElement;
    state.viewElement = (element, ...args) => {
      const view = viewElement.call(state, element, ...args);
      state.emitInvalidated({ nodeRef: view.nodeRef, branchRevision: view.branchRevision });
      return view;
    };

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(invalidated).toEqual([]);
    invalidate(harness.provider);
    harness.flushEffects();
    expect(invalidated).toEqual([]);
  });

  it("holds nested authority-operation effects for the owning operation's outbox", () => {
    const document = createDocument();
    const invalidated: string[] = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch.nodeRef),
    });
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): {
        publish(validate?: () => boolean): boolean;
        finalize(validate?: () => boolean): boolean;
      } | undefined;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const outer = state.beginProviderAuthorityOperation()!;
    const inner = state.beginProviderAuthorityOperation()!;
    state.emitInvalidated({ nodeRef: "nested", branchRevision: 1 });

    expect(inner.publish()).toBe(true);
    expect(inner.finalize()).toBe(true);
    expect(invalidated).toEqual([]);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    expect(invalidated).toEqual([]);
    harness.flushEffects();
    expect(invalidated).toEqual(["nested"]);
  });

  it("does not publish a failed nested frame effect reentered during an outer operation", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;

    expect(state.emitFrameLifecycle(frameLifecycleEvent("nested-frame"))).toBe(true);
    expect(nested.rollback()).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    expect(observed).toEqual([]);

    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("drops a nested frame journal opened by a hostile child getter", () => {
    const document = createDocument();
    const child = createElement("aside", document);
    document.documentElement.append(child);
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as AuthorityOperationInternals;
    let reentered = false;
    Object.defineProperty(child, "tagName", {
      configurable: true,
      get: () => {
        if (!reentered) {
          reentered = true;
          const nested = state.beginProviderAuthorityOperation()!;
          state.emitFrameLifecycle(frameLifecycleEvent("hostile-frame"));
          nested.rollback();
        }
        return "ASIDE";
      },
    });

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "hostile-nested-effect",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes).toHaveLength(1);
    expect(reentered).toBe(true);
    expect(observed).toEqual([]);
    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("keeps only committed nested journal slices in outer effect order", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("outer-before"))).toBe(true);
    const middle = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("middle"))).toBe(true);
    const rejected = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("rejected"))).toBe(true);
    expect(rejected.rollback()).toBe(true);
    expect(middle.publish()).toBe(true);
    expect(middle.finalize()).toBe(true);
    expect(state.emitFrameLifecycle(frameLifecycleEvent("outer-after"))).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);

    harness.flushEffects();
    expect(observed).toEqual(["outer-before", "middle", "outer-after"]);
  });

  it("truncates effects generated by nested rollback cleanup", () => {
    const document = createDocument();
    const observed: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => observed.push(event.frameRef),
    });
    const state = harness.provider as unknown as AuthorityOperationInternals;
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;
    expect(state.emitFrameLifecycle(frameLifecycleEvent("nested"))).toBe(true);

    expect(nested.rollback(() => {
      state.emitFrameLifecycle(frameLifecycleEvent("cleanup"));
    })).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);
    harness.flushEffects();
    expect(observed).toEqual([]);
  });

  it("reconciles retained frame navigation authority without publishing a failed owner journal", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "retained-frame");
    harness.flushEffects();
    events.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly frameDescriptions: ReadonlyMap<string, { readonly document?: Document }>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const replacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(replacement);
    frame.dispatchLoad();
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(replacement as unknown as Document);
    expect(state.frameDescriptions.get(frameView.nodeRef)?.document)
      .toBe(replacement as unknown as Document);
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual([]);
  });

  it("reconciles retained frame events in order while suppressing secondary callbacks", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const selected = createElement("button", firstDocument);
    firstDocument.documentElement.append(selected);
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    let selectedRef: string | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retained-frame-views",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    expect(frameViews).toHaveLength(2);
    const firstFrameView = frameViews[0]!;
    const secondFrameView = frameViews[1]!;
    const firstFrameDocument = onlyChild(
      harness.provider,
      firstFrameView,
      root.documentEpoch,
      "retained-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstFrameDocument,
      root.documentEpoch,
      "retained-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "retained-selected",
    ).nodeRef;
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      handleFrameLifecycle(event: FrameLifecycleEvent): boolean;
    };
    const contexts = harness.provider.frameAuthority.accessibleContexts();
    const firstContext = contexts.find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = contexts.find((candidate) => candidate.frameElement === secondFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;
    const reconciledFrames: string[] = [];
    const handleFrameLifecycle = state.handleFrameLifecycle;
    let reconciling = false;
    state.handleFrameLifecycle = (event) => {
      if (reconciling) reconciledFrames.push(event.frameRef);
      return handleFrameLifecycle.call(state, event);
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    secondFrame.setFrameDocument(secondReplacement);
    secondFrame.dispatchLoad();
    reconciling = true;
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(reconciledFrames).toEqual([firstContext.frameRef, secondContext.frameRef]);
    expect(secondFrameView.label).toBe("iframe");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains a frame navigation appended by timer cancellation after retained-event capture", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "drain-timer-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    onlyChild(harness.provider, frameViews[0]!, root.documentEpoch, "drain-timer-first");
    onlyChild(harness.provider, frameViews[1]!, root.documentEpoch, "drain-timer-second");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      mutationTimer: unknown;
      cancelTimeout(handle: unknown): void;
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const firstContext = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === secondFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const owner = state.beginProviderAuthorityOperation()!;
    state.mutationTimer = 101;
    state.cancelTimeout = (handle) => {
      if (handle !== 101) return;
      secondFrame.setFrameDocument(secondReplacement);
      secondFrame.dispatchLoad();
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    expect(owner.rollback()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains chained retained frame events for nested rollback without publishing callbacks", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const selected = createElement("button", firstDocument);
    firstDocument.documentElement.append(selected);
    const secondDocument = createDocument();
    const thirdDocument = createDocument();
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    const thirdFrame = createFrameElement(document, thirdDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    document.documentElement.append(thirdFrame);
    let selectedRef: string | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameViews = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "drain-nested-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstDocumentView = onlyChild(
      harness.provider,
      frameViews[0]!,
      root.documentEpoch,
      "drain-nested-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstDocumentView,
      root.documentEpoch,
      "drain-nested-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "drain-nested-selected",
    ).nodeRef;
    onlyChild(harness.provider, frameViews[1]!, root.documentEpoch, "drain-nested-second");
    onlyChild(harness.provider, frameViews[2]!, root.documentEpoch, "drain-nested-third");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      mutationTimer: unknown;
      cancelTimeout(handle: unknown): void;
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const contexts = harness.provider.frameAuthority.accessibleContexts();
    const firstContext = contexts.find((candidate) => candidate.frameElement === firstFrame)!;
    const secondContext = contexts.find((candidate) => candidate.frameElement === secondFrame)!;
    const thirdContext = contexts.find((candidate) => candidate.frameElement === thirdFrame)!;
    const firstReplacement = createDocument();
    const secondReplacement = createDocument();
    const thirdReplacement = createDocument();
    secondFrame.addEventListener("load", () => {
      thirdFrame.setFrameDocument(thirdReplacement);
      thirdFrame.dispatchLoad();
    });
    const outer = state.beginProviderAuthorityOperation()!;
    const nested = state.beginProviderAuthorityOperation()!;
    state.mutationTimer = 202;
    state.cancelTimeout = (handle) => {
      if (handle !== 202) return;
      secondFrame.setFrameDocument(secondReplacement);
      secondFrame.dispatchLoad();
    };

    firstFrame.setFrameDocument(firstReplacement);
    firstFrame.dispatchLoad();
    expect(nested.rollback()).toBe(true);
    expect(outer.publish()).toBe(true);
    expect(outer.finalize()).toBe(true);

    expect(state.frameDocumentsByRef.get(firstContext.frameRef)).toBe(firstReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(state.frameDocumentsByRef.get(thirdContext.frameRef)).toBe(thirdReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("fails closed when rollback frame reconciliation never reaches a fixed point", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "drain-endless-frame");
    onlyChild(harness.provider, frameView, root.documentEpoch, "drain-endless-document");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly nodeRegistry: { restore(snapshot: unknown): boolean };
    };
    const restore = state.nodeRegistry.restore;
    let navigations = 0;
    state.nodeRegistry.restore = (snapshot) => {
      const restored = restore.call(state.nodeRegistry, snapshot);
      navigations += 1;
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
      return restored;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    expect(owner.rollback()).toBe(false);
    expect(navigations).toBeGreaterThan(1);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains a nested frame navigation from observer installation during retained replay", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const replacement = createDocument();
    const latest = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const customObservers: TestMutationObserver[] = [];
    let armObserver = false;
    let reentered = false;
    let replacementObservations = 0;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const observe = observer.observe.bind(observer);
        observer.observe = (target, options) => {
          observe(target, options);
          if (target === replacement as unknown as Node) {
            replacementObservations += 1;
          }
          if (
            armObserver &&
            !reentered &&
            target === replacement as unknown as Node &&
            replacementObservations > 1
          ) {
            reentered = true;
            frame.setFrameDocument(latest);
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(replacement);
    frame.dispatchLoad();
    armObserver = true;

    expect(owner.rollback()).toBe(true);
    expect(reentered).toBe(true);
    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(latest as unknown as Document);
    expect(state.rootObservers.has(replacement as unknown as Node)).toBe(false);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      latest as unknown as Node,
    ]);
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(replacement)
    )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("drains chained observer reentries and removes every stale observer root", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const thirdDocument = createDocument();
    const fourthDocument = createDocument();
    const frame = createFrameElement(document, firstDocument);
    document.documentElement.append(frame);
    const callbacks: string[] = [];
    const customObservers: TestMutationObserver[] = [];
    let replaying = false;
    let secondDocumentObservations = 0;
    const replacements = new Map<Node, FakeDocument>([
      [secondDocument as unknown as Node, thirdDocument],
      [thirdDocument as unknown as Node, fourthDocument],
    ]);
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const observe = observer.observe.bind(observer);
        observer.observe = (target, options) => {
          observe(target, options);
          if (target === secondDocument as unknown as Node) {
            secondDocumentObservations += 1;
          }
          const next = replacements.get(target);
          if (
            next &&
            replaying &&
            (target !== secondDocument as unknown as Node || secondDocumentObservations > 1)
          ) {
            replacements.delete(target);
            frame.setFrameDocument(next);
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const context = harness.provider.frameAuthority.accessibleContexts()
      .find((candidate) => candidate.frameElement === frame)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.setFrameDocument(secondDocument);
    frame.dispatchLoad();
    replaying = true;

    expect(owner.rollback()).toBe(true);
    expect(state.frameDocumentsByRef.get(context.frameRef)).toBe(fourthDocument as unknown as Document);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      fourthDocument as unknown as Node,
    ]);
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(secondDocument) ||
      observer.observedTargets.includes(thirdDocument)
    )).every((observer) => observer.disconnectCount === 1)).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("disconnects a superseded same-document observer before retained replay replaces it", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: () => callbacks.push("frame"),
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const initialObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    const supersededObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(supersededObserver).not.toBe(initialObserver);

    expect(owner.rollback()).toBe(true);
    const replayObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(replayObserver).not.toBe(initialObserver);
    expect(replayObserver).not.toBe(supersededObserver);
    expect(supersededObserver.disconnectCount).toBe(1);
    supersededObserver.emit([mutationRecord(frameDocument.documentElement)]);
    expect(supersededObserver.emitCount).toBe(0);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
    expect(customObservers).toContain(replayObserver);
  });

  it("drains a lifecycle event reentered from superseded observer disconnect", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    let reentered = false;
    let armDisconnect = false;
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        const disconnect = observer.disconnect.bind(observer);
        observer.disconnect = () => {
          disconnect();
          if (
            armDisconnect &&
            !reentered &&
            observer.observedTargets.includes(frameDocument)
          ) {
            reentered = true;
            frame.dispatchLoad();
          }
        };
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    const supersededObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    armDisconnect = true;

    expect(owner.rollback()).toBe(true);
    expect(reentered).toBe(true);
    expect(supersededObserver.disconnectCount).toBe(1);
    expect([...state.rootObservers.keys()]).toEqual([
      document as unknown as Node,
      frameDocument as unknown as Node,
    ]);
    expect(customObservers).toContain(state.rootObservers.get(frameDocument as unknown as Node)!);
  });

  it("disconnects every superseded instance across repeated same-document loads", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const customObservers: TestMutationObserver[] = [];
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        customObservers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
    };
    const owner = state.beginProviderAuthorityOperation()!;

    frame.dispatchLoad();
    frame.dispatchLoad();

    expect(owner.rollback()).toBe(true);
    const currentObserver = state.rootObservers.get(frameDocument as unknown as Node)!;
    expect(customObservers.filter((observer) => (
      observer.observedTargets.includes(frameDocument) && observer !== currentObserver
    )).every((observer) => observer.disconnectCount > 0)).toBe(true);
  });

  it("rejects mutation records from a superseded observer instance", () => {
    const document = createDocument();
    const frameDocument = createDocument();
    const frame = createFrameElement(document, frameDocument);
    document.documentElement.append(frame);
    const observers: TestMutationObserver[] = [];
    const harness = createProviderHarness(document, {
      createMutationObserver: (callback) => {
        const observer = new TestMutationObserver(callback);
        observers.push(observer);
        return observer;
      },
    });
    harness.provider.startFrameTracking();
    harness.flushTimers();
    const state = harness.provider as unknown as {
      readonly rootObservers: ReadonlyMap<Node, TestMutationObserver>;
      readonly pendingMutations: readonly unknown[];
    };
    const stale = state.rootObservers.get(frameDocument as unknown as Node)!;

    frame.dispatchLoad();
    expect(state.rootObservers.get(frameDocument as unknown as Node)).not.toBe(stale);

    stale.emitUnchecked([mutationRecord(frameDocument.documentElement)]);
    expect(state.pendingMutations).toHaveLength(0);
    expect(observers).toContain(stale);
  });

  it("stops frame callback fan-out after its first invalidation callback resets authority", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let provider: DomTreeProvider | undefined;
    let armed = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => {
        callbacks.push("invalidated");
        if (callbacks.length === 1) {
          provider?.resetDocument(createDocument() as unknown as Document, 4);
        }
      },
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "fanout-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "fanout-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "fanout-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "fanout-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (armed) {
            armed = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    armed = true;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual(["invalidated"]);
  });

  it("replays frame callback fan-out once in deterministic order for read-only callbacks", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let armed = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => selectedRef,
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "fanout-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "fanout-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "fanout-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "fanout-read-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (armed) {
            armed = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    armed = true;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([
      "invalidated",
      "invalidated",
      "selected-removed",
      "frame",
    ]);
  });

  it.each([
    ["reset", (provider: DomTreeProvider, _frame: FakeFrameElement) => {
      provider.resetDocument(createDocument() as unknown as Document, 4);
    }],
    ["dispose", (provider: DomTreeProvider, _frame: FakeFrameElement) => {
      provider.dispose();
    }],
    ["navigate", (_provider: DomTreeProvider, frame: FakeFrameElement) => {
      frame.setFrameDocument(createDocument());
      frame.dispatchLoad();
    }],
  ] as const)("stops frame publication when the selected-ref reader %s authority", (_name, invalidate) => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let provider: DomTreeProvider | undefined;
    let triggerSelectionRead = false;
    let selectionRead = false;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        if (triggerSelectionRead && !selectionRead) {
          selectionRead = true;
          invalidate(provider!, frame);
        }
        return selectedRef;
      },
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "selection-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "selection-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "selection-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "selection-read-target");
    selectedRef = targetView.nodeRef;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    let triggerNavigation = false;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (triggerNavigation) {
            triggerNavigation = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;
    triggerSelectionRead = true;
    triggerNavigation = true;

    expect(() => harness.provider.getRoot()).toThrowError("node-unavailable");
    expect(selectionRead).toBe(true);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it("keeps selected-ref reads read-only during frame publication", () => {
    const document = createDocument();
    const childDocument = createDocument();
    const target = createElement("button", childDocument);
    childDocument.documentElement.append(target);
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let selectedRef: string | undefined;
    let selectionReads = 0;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        selectionReads += 1;
        return selectedRef;
      },
      onInvalidated: () => callbacks.push("invalidated"),
      onSelectedNodeRemoved: () => callbacks.push("selected-removed"),
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frameView = onlyChild(harness.provider, root.node, root.documentEpoch, "selection-read-read-frame");
    const frameDocument = onlyChild(harness.provider, frameView, root.documentEpoch, "selection-read-read-document");
    const childRoot = onlyChild(harness.provider, frameDocument, root.documentEpoch, "selection-read-read-html");
    const targetView = onlyChild(harness.provider, childRoot, root.documentEpoch, "selection-read-read-target");
    selectedRef = targetView.nodeRef;
    selectionReads = 0;
    const state = harness.provider as unknown as {
      beginProviderAuthorityOperation(): { publish(validate?: () => boolean): boolean } | undefined;
    };
    const originalBeginOperation = state.beginProviderAuthorityOperation;
    let triggerNavigation = true;
    state.beginProviderAuthorityOperation = () => {
      const operation = originalBeginOperation.call(state);
      if (!operation) return undefined;
      return Object.freeze({
        ...operation,
        publish: (validate?: () => boolean) => {
          if (triggerNavigation) {
            triggerNavigation = false;
            frame.setFrameDocument(createDocument());
            frame.dispatchLoad();
          }
          return operation.publish(validate);
        },
      });
    };
    harness.flushEffects();
    callbacks.length = 0;

    expect(harness.provider.getRoot().node.label).toBe("html");
    expect(selectionReads).toBe(1);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([
      "invalidated",
      "invalidated",
      "selected-removed",
      "frame",
    ]);
  });

  it("drains a frame navigation triggered by a selected-ref reader during rollback", () => {
    const document = createDocument();
    const firstDocument = createDocument();
    const secondDocument = createDocument();
    const target = createElement("button", firstDocument);
    firstDocument.documentElement.append(target);
    const firstFrame = createFrameElement(document, firstDocument);
    const secondFrame = createFrameElement(document, secondDocument);
    document.documentElement.append(firstFrame);
    document.documentElement.append(secondFrame);
    let selectedRef: string | undefined;
    let armSelectionRead = false;
    let secondReplacement: FakeDocument | undefined;
    const callbacks: string[] = [];
    const harness = createProviderHarness(document, {
      getSelectedNodeRef: () => {
        if (armSelectionRead) {
          armSelectionRead = false;
          secondReplacement = createDocument();
          secondFrame.setFrameDocument(secondReplacement);
          secondFrame.dispatchLoad();
        }
        return selectedRef;
      },
      onFrameLifecycle: () => callbacks.push("frame"),
    });
    const root = harness.provider.getRoot();
    const frames = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "selected-reader-frames",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const firstDocumentView = onlyChild(
      harness.provider,
      frames[0]!,
      root.documentEpoch,
      "selected-reader-first-document",
    );
    const firstRoot = onlyChild(
      harness.provider,
      firstDocumentView,
      root.documentEpoch,
      "selected-reader-first-root",
    );
    selectedRef = onlyChild(
      harness.provider,
      firstRoot,
      root.documentEpoch,
      "selected-reader-target",
    ).nodeRef;
    onlyChild(harness.provider, frames[1]!, root.documentEpoch, "selected-reader-second-document");
    harness.flushEffects();
    callbacks.length = 0;
    const state = harness.provider as unknown as AuthorityOperationInternals & {
      readonly frameDocumentsByRef: ReadonlyMap<string, Document>;
    };
    const secondContext = harness.provider.frameAuthority.accessibleContexts()
      .find((context) => context.frameElement === secondFrame)!;
    const owner = state.beginProviderAuthorityOperation()!;
    armSelectionRead = true;

    firstFrame.setFrameDocument(createDocument());
    firstFrame.dispatchLoad();

    expect(owner.rollback()).toBe(true);
    expect(state.frameDocumentsByRef.get(secondContext.frameRef)).toBe(secondReplacement as unknown as Document);
    expect(callbacks).toEqual([]);
    harness.flushEffects();
    expect(callbacks).toEqual([]);
  });

  it.each([
    ["detached", (document: FakeDocument, parent: FakeElement) => {
      (parent.parentNode as FakeElement).remove(parent);
    }],
    ["moved", (document: FakeDocument, parent: FakeElement) => {
      const body = parent.parentNode as FakeElement;
      body.remove(parent);
      document.documentElement.append(parent);
    }],
    ["replaced", (document: FakeDocument, parent: FakeElement) => {
      const body = parent.parentNode as FakeElement;
      body.remove(parent);
      body.append(createElement("main", document));
    }],
    ["given a child", (_document: FakeDocument, parent: FakeElement) => {
      parent.append(createElement("button", parent.ownerDocument));
    }],
  ] as const)("returns an empty page before its parent is %s by a post-commit callback", (_name, mutate) => {
    const document = createDocument();
    const body = createElement("body", document);
    const parent = createElement("main", document);
    body.append(parent);
    document.documentElement.append(body);
    let callbackCount = 0;
    const harness = createProviderHarness(document, {
      onInvalidated: () => {
        callbackCount += 1;
        mutate(document, parent);
      },
    });
    const root = harness.provider.getRoot();
    const bodyView = onlyChild(harness.provider, root.node, root.documentEpoch, "empty-page-body");
    const parentView = onlyChild(harness.provider, bodyView, root.documentEpoch, "empty-page-parent");
    const state = harness.provider as unknown as {
      logicalChildPage(node: Node, ...args: readonly unknown[]): unknown;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalLogicalChildPage = state.logicalChildPage;
    let injected = false;
    state.logicalChildPage = (node, ...args) => {
      const page = originalLogicalChildPage.call(state, node, ...args);
      if (!injected && node === parent) {
        injected = true;
        state.emitInvalidated({
          nodeRef: parentView.nodeRef,
          branchRevision: parentView.branchRevision,
        });
      }
      return page;
    };

    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-page-live-parent",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    }).nodes).toEqual([]);
    expect(callbackCount).toBe(0);
    harness.flushEffects();
    expect(callbackCount).toBe(1);
  });

  it("returns an empty page after a read-only callback", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const parent = createElement("main", document);
    body.append(parent);
    document.documentElement.append(body);
    let callbackCount = 0;
    const harness = createProviderHarness(document, {
      onInvalidated: () => { callbackCount += 1; },
    });
    const root = harness.provider.getRoot();
    const bodyView = onlyChild(harness.provider, root.node, root.documentEpoch, "empty-read-body");
    const parentView = onlyChild(harness.provider, bodyView, root.documentEpoch, "empty-read-parent");
    const state = harness.provider as unknown as {
      logicalChildPage(node: Node, ...args: readonly unknown[]): unknown;
      emitInvalidated(branch: { readonly nodeRef: string; readonly branchRevision: number }): void;
    };
    const originalLogicalChildPage = state.logicalChildPage;
    let injected = false;
    state.logicalChildPage = (node, ...args) => {
      const page = originalLogicalChildPage.call(state, node, ...args);
      if (!injected && node === parent) {
        injected = true;
        state.emitInvalidated({
          nodeRef: parentView.nodeRef,
          branchRevision: parentView.branchRevision,
        });
      }
      return page;
    };

    const response = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "empty-page-read-only",
      documentEpoch: root.documentEpoch,
      nodeRef: parentView.nodeRef,
      branchRevision: parentView.branchRevision,
    });
    expect(response.nodes).toEqual([]);
    expect(callbackCount).toBe(0);
    harness.flushEffects();
    expect(callbackCount).toBe(1);
  });

  it("fails capture when a registered frame host is moved or has the wrong parent owner", () => {
    const framed = createFramedButtonTree();
    const service = (framed.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    framed.document.documentElement.remove(framed.frame);

    expect(() => service.capture(framed.target as unknown as Node, "element"))
      .toThrow();

    framed.document.documentElement.append(framed.frame);
    (framed.frame as unknown as { ownerDocument: FakeDocument }).ownerDocument = createDocument();
    expect(() => service.capture(framed.target as unknown as Node, "element"))
      .toThrow();
  });

  it("rejects stable recovery through a frame whose live document changed before load", () => {
    const first = createFramedButtonTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createFramedButtonTree({ materialize: false });
    const root = second.provider.getRoot();
    onlyChild(second.provider, root.node, root.documentEpoch, "register-stale-frame");
    const context = second.provider.frameAuthority.accessibleContexts().at(-1)!;
    second.frame.setFrameDocument(createDocument());

    expect(second.provider.frameAuthority.getContext(context.frameRef)).toBeUndefined();
    expect(resolveLocator(second.provider, locator)).toBeUndefined();
    expect(second.frame.loadListenerCount).toBe(1);
  });

  it("rejects locator recovery when the final child frame read silently changes its parent", () => {
    const topDocument = createDocument();
    const parentDocument = createDocument();
    const childDocument = createDocument();
    const parentFrame = createFrameElement(topDocument, parentDocument);
    const childFrame = createFrameElement(parentDocument, childDocument);
    const target = createElement("button", childDocument);
    target.id = "nested_frame_target";
    childDocument.documentElement.append(target);
    parentDocument.documentElement.append(childFrame);
    topDocument.documentElement.append(parentFrame);

    const provider = createProvider(topDocument);
    const root = provider.getRoot();
    const parentFrameView = onlyChild(provider, root.node, root.documentEpoch, "parent-frame");
    const parentDocumentView = onlyChild(provider, parentFrameView, root.documentEpoch, "parent-document");
    const childFrameView = onlyChild(provider, parentDocumentView, root.documentEpoch, "child-frame");
    const childDocumentView = onlyChild(provider, childFrameView, root.documentEpoch, "child-document");
    const targetView = onlyChild(provider, childDocumentView, root.documentEpoch, "nested-target");
    const locator = targetView.locator;
    const stableChildDocument = childFrame.contentDocument;
    let reads = 0;

    Object.defineProperty(childFrame, "contentDocument", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 2) parentFrame.setFrameDocument(createDocument());
        return stableChildDocument;
      },
    });

    expect(resolveStableLocator(provider, locator)).toBeUndefined();
  });

  it("rejects capture when a sibling shortcut hides an excessive child collection", () => {
    const tree = createHeadingTree();
    tree.target.id = "";
    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => ({ 0: tree.target, length: 65_537 }),
    });

    expect(() => service.capture(tree.target as unknown as Node, "element")).toThrow();
  });

  it("rejects locator resolution when uniqueness scanning mutates verified evidence", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const children = second.target.childNodes;
    let mutated = false;
    Object.defineProperty(second.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!mutated) {
          mutated = true;
          second.target.className = "mutated";
        }
        return children;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("fails capture when a previous-element sibling read throws partway through the chain", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0] as FakeElement;
    Object.defineProperty(sibling, "previousElementSibling", {
      configurable: true,
      get: () => {
        throw new Error("hostile previous sibling");
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails capture when a verified child collection spoofs the same-length sibling position", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0]!;
    const originalChildren = tree.main.childNodes;
    let reads = 0;
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? originalChildren : [tree.target, sibling];
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails recovery when a verified child collection reorders same-length siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0]!;
    const originalChildren = second.main.childNodes;
    let reads = 0;
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? originalChildren : [second.target, sibling];
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("fails capture when a final same-length child collection read reorders siblings", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0]!;
    const originalChildren = tree.main.childNodes;
    let afterPreviousSiblingReads = 0;
    Object.defineProperty(tree.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads = 0;
        return sibling;
      },
    });
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads += 1;
        return afterPreviousSiblingReads === 2 ? [tree.target, sibling] : originalChildren;
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails recovery when a final same-length child collection read reorders siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0]!;
    const originalChildren = second.main.childNodes;
    let afterPreviousSiblingReads = 0;
    Object.defineProperty(second.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads = 0;
        return sibling;
      },
    });
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        afterPreviousSiblingReads += 1;
        return afterPreviousSiblingReads === 2 ? [second.target, sibling] : originalChildren;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("rejects capture when a formerly post-snapshot parent getter reorders same-length siblings", () => {
    const tree = createHeadingTree({ includeSibling: true });
    const sibling = tree.main.childNodes[0] as FakeElement;
    const children = tree.main.childNodes;
    let childReadsAfterPrevious = 0;
    let reordered = false;
    Object.defineProperty(tree.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious = 0;
        return sibling;
      },
    });
    Object.defineProperty(tree.main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return children;
      },
    });
    Object.defineProperty(tree.target, "parentNode", {
      configurable: true,
      get: () => {
        if (!reordered && childReadsAfterPrevious === 2) {
          reordered = true;
          tree.main.childNodes.splice(0, 2, tree.target, sibling);
          tree.target.previousElementSibling = null;
          sibling.previousElementSibling = tree.target;
        }
        return tree.main;
      },
    });

    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    expect(() => service.capture(tree.target as unknown as Node, "element")).toThrow("Invalid stable DOM locator");
    expect(reordered).toBe(true);
  });

  it("rejects recovery when a formerly post-snapshot parent getter reorders same-length siblings", () => {
    const first = createHeadingTree({ includeSibling: true });
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree({ includeSibling: true });
    const sibling = second.main.childNodes[0] as FakeElement;
    const children = second.main.childNodes;
    let childReadsAfterPrevious = 0;
    let reordered = false;
    Object.defineProperty(second.target, "previousElementSibling", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious = 0;
        return sibling;
      },
    });
    Object.defineProperty(second.main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return children;
      },
    });
    Object.defineProperty(second.target, "parentNode", {
      configurable: true,
      get: () => {
        if (!reordered && childReadsAfterPrevious === 2) {
          reordered = true;
          second.main.childNodes.splice(0, 2, second.target, sibling);
          second.target.previousElementSibling = null;
          sibling.previousElementSibling = second.target;
        }
        return second.main;
      },
    });

    expect(resolveStableLocator(second.provider, locator)).toBeUndefined();
    expect(reordered).toBe(true);
  });

  it("does not read the capture root after the final path proof", () => {
    const tree = createHeadingTree();
    const html = tree.document.documentElement;
    let pathProofComplete = false;
    let mutated = false;
    Object.defineProperty(html, "previousElementSibling", {
      configurable: true,
      get: () => {
        pathProofComplete = true;
        return null;
      },
    });
    Object.defineProperty(tree.document, "nodeType", {
      configurable: true,
      get: () => {
        if (pathProofComplete && !mutated) {
          mutated = true;
          tree.main.remove(tree.target);
        }
        return 9;
      },
    });

    const service = (tree.provider as unknown as {
      readonly locatorService: { capture(node: Node, kind: "element"): DomStableLocator };
    }).locatorService;
    const locator = service.capture(tree.target as unknown as Node, "element");

    expect(mutated).toBe(false);
    Object.defineProperty(tree.document, "nodeType", {
      configurable: true,
      value: 9,
    });
    expect(resolveStableLocator(tree.provider, locator)).toBeDefined();
  });

  it("does not read the resolved target after the final segment proof", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const target = createElement("h2", document);
    target.id = "section_title_id1";
    target.className = "block_title";
    target.setAttribute("data-section", "intro");
    target.setAttribute("aria-label", "Introduction");
    target.setAttribute("role", "presentation");
    const sibling = createElement("p", document);
    document.documentElement.append(body);
    body.append(main);
    main.append(target);
    main.append(sibling);
    const provider = createProvider(document);
    let childReadsAfterPrevious = 0;
    let previousRead = false;
    let finalSnapshotComplete = false;
    let mutated = false;
    Object.defineProperty(target, "previousElementSibling", {
      configurable: true,
      get: () => {
        previousRead = true;
        childReadsAfterPrevious = 0;
        return null;
      },
    });
    Object.defineProperty(main, "childNodes", {
      configurable: true,
      get: () => {
        childReadsAfterPrevious += 1;
        return [target, sibling];
      },
    });
    Object.defineProperty(sibling, "nodeType", {
      configurable: true,
      get: () => {
        if (previousRead && childReadsAfterPrevious === 2) finalSnapshotComplete = true;
        return 1;
      },
    });
    Object.defineProperty(target, "nodeType", {
      configurable: true,
      get: () => {
        if (finalSnapshotComplete && !mutated) {
          mutated = true;
          target.className = "mutated-after-proof";
        }
        return 1;
      },
    });

    expect(resolveStableLocator(provider, locator)).toBeUndefined();
    expect(mutated).toBe(true);
  });

  it("omits a capture ID when a second bounded scan finds a late duplicate", () => {
    const tree = createHeadingTree();
    const earlier = createElement("aside", tree.document);
    tree.document.documentElement.remove(tree.document.documentElement.childNodes[0]!);
    tree.document.documentElement.append(earlier);
    tree.document.documentElement.append(tree.main.parentNode as FakeNode);
    const originalChildren = tree.target.childNodes;
    let inserted = false;
    Object.defineProperty(tree.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!inserted) {
          inserted = true;
          const duplicate = createElement("aside", tree.document);
          duplicate.id = tree.target.id;
          earlier.append(duplicate);
        }
        return originalChildren;
      },
    });

    expect(locatorFor(tree.provider, tree.target).path.at(-1)?.id).toBeUndefined();
  });

  it("omits an ID when final evidence adds an excluded duplicate", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const target = createElement("h2", document);
    target.id = "stable_target";
    target.className = "title";
    document.documentElement.append(body);
    body.append(main);
    main.append(target);
    let duplicate: FakeElement | undefined;
    const harness = createProviderHarness(document, {
      isExcludedNode: (node) => node === duplicate,
    });
    const classes = target.classList;
    let reads = 0;
    Object.defineProperty(target, "classList", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 3) {
          duplicate = createElement("aside", document);
          duplicate.id = target.id;
          document.documentElement.append(duplicate);
        }
        return classes;
      },
    });

    expect(locatorFor(harness.provider, target).path.at(-1)?.id).toBeUndefined();
  });

  it("rejects resolution when final evidence adds an excluded duplicate", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    let duplicate: FakeElement | undefined;
    const harness = createProviderHarness(second.document, {
      isExcludedNode: (node) => node === duplicate,
    });
    const classes = second.target.classList;
    let reads = 0;
    Object.defineProperty(second.target, "classList", {
      configurable: true,
      get: () => {
        reads += 1;
        if (reads === 3) {
          duplicate = createElement("aside", second.document);
          duplicate.id = second.target.id;
          second.document.documentElement.append(duplicate);
        }
        return classes;
      },
    });

    expect(resolveStableLocator(harness.provider, locator)).toBeUndefined();
  });

  it("fails capture when uniqueness traversal mutates candidate evidence", () => {
    const tree = createHeadingTree();
    const children = tree.target.childNodes;
    let mutated = false;
    Object.defineProperty(tree.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!mutated) {
          mutated = true;
          tree.target.className = "mutated";
        }
        return children;
      },
    });

    expect(() => locatorFor(tree.provider, tree.target)).toThrowError("node-unavailable");
  });

  it("fails locator resolution when a second uniqueness scan finds a late duplicate", () => {
    const first = createHeadingTree();
    const locator = locatorFor(first.provider, first.target);
    const second = createHeadingTree();
    const originalChildren = second.target.childNodes;
    let inserted = false;
    Object.defineProperty(second.target, "childNodes", {
      configurable: true,
      get: () => {
        if (!inserted) {
          inserted = true;
          const duplicate = createElement("aside", second.document);
          duplicate.id = second.target.id;
          second.main.append(duplicate);
        }
        return originalChildren;
      },
    });

    expect(resolveLocator(second.provider, locator)).toBeUndefined();
  });

  it("preflights every child locator before durable page materialization", () => {
    const document = createDocument();
    const first = createElement("article", document);
    const second = createElement("aside", document);
    document.documentElement.append(first);
    document.documentElement.append(second);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const providerState = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
    };
    const recordCount = providerState.records.size;
    const referenceCount = providerState.nodeRegistry.size;
    const originalTagName = second.tagName;
    Object.defineProperty(second, "tagName", {
      configurable: true,
      get: () => {
        throw new Error("late hostile child tag");
      },
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "atomic-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    expect(providerState.records.size).toBe(recordCount);
    expect(providerState.nodeRegistry.size).toBe(referenceCount);
    expect(harness.observers).toHaveLength(1);
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(1);

    Object.defineProperty(second, "tagName", {
      configurable: true,
      value: originalTagName,
    });
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "recovered-child-page",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["article", "aside"]);
  });

  it("rolls back expansion authority when child locator capture fails", () => {
    const document = createDocument();
    const child = createElement("article", document);
    document.documentElement.append(child);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      readonly expandedBranches: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
    };
    const originalTagName = child.tagName;
    Object.defineProperty(child, "tagName", {
      configurable: true,
      get: () => {
        throw new Error("hostile first expansion tag");
      },
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-first-expansion",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("node-unavailable");
    expect(provider.expandedBranches.has(root.node.nodeRef)).toBe(false);
    expect(provider.nodeRegistry.retentionReasons(root.node.nodeRef)).toEqual([]);
    expect(harness.observers).toHaveLength(1);

    Object.defineProperty(child, "tagName", {
      configurable: true,
      value: originalTagName,
    });
    expect(onlyChild(harness.provider, root.node, root.documentEpoch, "retried-first-expansion").label)
      .toBe("article");
  });

  it("restores an unaliased expanded branch after shadow discovery fails", () => {
    const document = createDocument();
    const host = createElement("article", document);
    for (let index = 0; index < 51; index += 1) {
      host.append(createElement("span", document));
    }
    document.documentElement.append(host);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const hostView = onlyChild(harness.provider, root.node, root.documentEpoch, "branch-host");
    const initialPage = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    const cursor = initialPage.nextCursor!;
    const shadow = host.attachShadow();
    const provider = harness.provider as unknown as {
      readonly expandedBranches: ReadonlyMap<string, { revision: number }>;
      readonly cursors: ReadonlyMap<string, { readonly branchRevision: number; readonly active: boolean }>;
    };
    const before = provider.expandedBranches.get(hostView.nodeRef)!;
    const beforeCursor = provider.cursors.get(cursor)!;
    let exposeShadow = true;
    Object.defineProperty(host, "shadowRoot", {
      configurable: true,
      get: () => exposeShadow ? shadow : null,
    });

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-shadow-discovery",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    })).toThrowError("stale-branch");
    const restored = provider.expandedBranches.get(hostView.nodeRef)!;
    expect(restored).not.toBe(before);
    expect(restored.revision).toBe(hostView.branchRevision);
    expect(provider.cursors.get(cursor)).toEqual(beforeCursor);

    exposeShadow = false;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retried-shadow-discovery",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    }).nodes).toHaveLength(50);
  });

  it("rolls back ancestor-path materialization before a late view failure", () => {
    const tree = createHeadingTree();
    const revealed = tree.provider.revealElement(tree.target as unknown as Element);
    const documentEpoch = tree.provider.getRoot().documentEpoch;
    const provider = tree.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    const records = [...provider.records.entries()];
    const referenceCount = provider.nodeRegistry.size;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === tree.main.parentNode) throw new Error("late ancestor view failure");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => tree.provider.ancestorPath(revealed.nodeRef, documentEpoch))
      .toThrowError("late ancestor view failure");
    expect([...provider.records.entries()]).toEqual(records);
    expect(provider.nodeRegistry.size).toBe(referenceCount);

    provider.viewElement = originalViewElement;
    expect(tree.provider.ancestorPath(revealed.nodeRef, documentEpoch)
      .map(({ label }) => label)).toEqual(["html", "body", "main", "h2#section_title_id1.block_title [data-section] [aria-label] [role]"]);
  });

  it("buffers invalidation callbacks until a child page commits", () => {
    const document = createDocument();
    const host = createElement("article", document);
    document.documentElement.append(host);
    const invalidated: Array<{ readonly nodeRef: string; readonly branchRevision: number }> = [];
    const harness = createProviderHarness(document, {
      onInvalidated: (branch) => invalidated.push(branch),
    });
    const root = harness.provider.getRoot();
    const hostView = onlyChild(harness.provider, root.node, root.documentEpoch, "callback-host");
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "expand-callback-host",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision,
    });
    host.attachShadow();
    const provider = harness.provider as unknown as {
      viewShadowRoot(root: ShadowRoot, ...args: readonly unknown[]): unknown;
    };
    const originalViewShadowRoot = provider.viewShadowRoot;
    provider.viewShadowRoot = () => {
      throw new Error("late invalidation view failure");
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "failed-callback-page",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    })).toThrowError("late invalidation view failure");
    expect(invalidated).toEqual([]);

    provider.viewShadowRoot = originalViewShadowRoot;
    harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "committed-callback-page",
      documentEpoch: root.documentEpoch,
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    });
    expect(invalidated).toEqual([]);
    harness.flushEffects();
    expect(invalidated).toEqual([{
      nodeRef: hostView.nodeRef,
      branchRevision: hostView.branchRevision + 1,
    }]);
  });

  it("rolls back earlier child views when a later materialization throws", () => {
    const document = createDocument();
    const first = createElement("article", document);
    const second = createElement("aside", document);
    document.documentElement.append(first);
    document.documentElement.append(second);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, unknown>;
      readonly nodeRegistry: { readonly size: number };
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    const recordCount = provider.records.size;
    const referenceCount = provider.nodeRegistry.size;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === second) throw new Error("late child view failure");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "late-child-view-failure",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("late child view failure");
    expect(provider.records.size).toBe(recordCount);
    expect(provider.nodeRegistry.size).toBe(referenceCount);
    expect(harness.observers).toHaveLength(1);

    provider.viewElement = originalViewElement;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "retried-late-child-view",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["article", "aside"]);
  });

  it("buffers frame lifecycle work until an entire child page commits", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    const second = createElement("aside", document);
    document.documentElement.append(frame);
    document.documentElement.append(second);
    const events: string[] = [];
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => events.push(event.type),
    });
    const root = harness.provider.getRoot();
    const provider = harness.provider as unknown as {
      frameTracking: boolean;
      readonly pendingFrameMutationScans: readonly unknown[];
      viewElement(element: Element, ...args: readonly unknown[]): unknown;
    };
    provider.frameTracking = true;
    const originalViewElement = provider.viewElement;
    provider.viewElement = (element, ...args) => {
      if (element === second) throw new Error("late hostile child view");
      return originalViewElement.call(provider, element, ...args);
    };

    expect(() => harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "buffered-frame-failure",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    })).toThrowError("late hostile child view");
    expect(events).toEqual([]);
    expect(harness.pendingTimerCount()).toBe(0);
    expect(provider.pendingFrameMutationScans).toHaveLength(0);
    expect(frame.loadListenerCount).toBe(0);

    provider.viewElement = originalViewElement;
    expect(harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "buffered-frame-success",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes.map(({ label }) => label)).toEqual(["iframe", "aside"]);
    expect(events).toEqual([]);
    harness.flushEffects();
    expect(events).toEqual(["registered"]);
    expect(harness.pendingTimerCount()).toBe(2);
    expect(provider.pendingFrameMutationScans).toHaveLength(1);
  });

  it("releases transient path retentions before replaying frame lifecycle callbacks", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    document.documentElement.append(frame);
    let observedReasons: readonly string[] | undefined;
    let provider: DomTreeProvider | undefined;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "registered" || !provider) return;
        const registry = provider as unknown as {
          readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
        };
        observedReasons = registry.nodeRegistry.retentionReasons("node-1");
      },
    });
    provider = harness.provider;
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, { readonly scope: unknown }>;
      readonly nodeRegistry: { retentionReasons(nodeRef: string): readonly string[] };
      materializeLogicalPath(path: readonly unknown[]): readonly { readonly nodeRef: string }[] | undefined;
    };
    const scope = state.records.get(root.node.nodeRef)!.scope;

    const path = state.materializeLogicalPath([
      { kind: "element", node: document.documentElement, scope },
      { kind: "element", node: frame, scope },
    ]);

    expect(path?.map(({ nodeRef }) => nodeRef)).toEqual([root.node.nodeRef, "node-2"]);
    expect(observedReasons).toBeUndefined();
    harness.flushEffects();
    expect(observedReasons).toEqual([]);
    expect(state.nodeRegistry.retentionReasons(root.node.nodeRef)).toEqual([]);
  });

  it("restores evicted records when path materialization fails after reserving capacity", () => {
    const document = createDocument();
    const body = createElement("body", document);
    const main = createElement("main", document);
    const aside = createElement("aside", document);
    body.append(main);
    document.documentElement.append(body);
    document.documentElement.append(aside);
    const harness = createProviderHarness(document, { maxRecords: 3 });
    const root = harness.provider.getRoot();
    const rootChildren = harness.provider.getChildren({
      type: "dom.getChildren",
      requestId: "capacity-root-children",
      documentEpoch: root.documentEpoch,
      nodeRef: root.node.nodeRef,
      branchRevision: root.node.branchRevision,
    }).nodes;
    const bodyView = rootChildren.find(({ label }) => label === "body")!;
    const asideView = rootChildren.find(({ label }) => label === "aside")!;
    const provider = harness.provider as unknown as {
      readonly records: ReadonlyMap<string, { readonly scope: unknown }>;
      materializeLogicalPath(path: readonly unknown[]): readonly unknown[] | undefined;
      materializePathEntry(entry: { readonly node: Node }): unknown;
    };
    const originalRefs = [...provider.records.keys()];
    const scope = provider.records.get(root.node.nodeRef)!.scope;
    const originalMaterialize = provider.materializePathEntry;
    provider.materializePathEntry = (entry) => {
      if (entry.node === main) throw new Error("forced post-reservation failure");
      return originalMaterialize.call(provider, entry);
    };

    expect(provider.materializeLogicalPath([
      { kind: "element", node: document.documentElement, scope },
      { kind: "element", node: body, scope },
      { kind: "element", node: main, scope },
    ])).toBeUndefined();
    expect([...provider.records.keys()]).toEqual(originalRefs);
    expect(harness.provider.resolveElement(asideView.nodeRef, root.documentEpoch))
      .toBeDefined();
    expect(harness.provider.resolveElement(bodyView.nodeRef, root.documentEpoch))
      .toBeDefined();
  });

  it("materializes a safe frame display row when locator capture is hostile", () => {
    const document = createDocument();
    const frame = createFrameElement(document, createDocument());
    document.documentElement.append(frame);
    const harness = createProviderHarness(document);
    const root = harness.provider.getRoot();
    const originalAttributes = frame.attributes;
    Object.defineProperty(frame, "attributes", {
      configurable: true,
      get: () => {
        throw new Error("hostile frame identity");
      },
    });

    const frameView = onlyChild(
      harness.provider,
      root.node,
      root.documentEpoch,
      "hostile-frame",
    );
    expect(frameView).toMatchObject({
      kind: "element",
      nodeName: "IFRAME",
      attributes: [],
      selectable: true,
    });
    expect(frameView).not.toHaveProperty("locator");
    expect(() => harness.provider.resolveElement(frameView.nodeRef, root.documentEpoch))
      .toThrowError("node-unavailable");
    expect((harness.provider as unknown as { records: Map<string, unknown> }).records.size)
      .toBeGreaterThan(1);
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(2);
    expect(frame.loadListenerCount).toBe(1);

    Object.defineProperty(frame, "attributes", {
      configurable: true,
      value: originalAttributes,
    });
    expect(onlyChild(harness.provider, root.node, root.documentEpoch, "recovered-frame").kind)
      .toBe("element");
    expect(harness.provider.frameAuthority.accessibleContexts()).toHaveLength(2);
  });

  it.each([
    ["mutationTimer", "reset"],
    ["frameMutationScanTimer", "dispose"],
    ["shadowScanTimer", "reset"],
  ] as const)("abandons rollback when canceling %s reenters through %s", (timerField, action) => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const currentHandle = 101;
    const replacementHandle = 202;
    let reentered = false;
    internals[timerField] = currentHandle;
    internals.cancelTimeout = () => {
      if (reentered) return;
      reentered = true;
      if (action === "reset") {
        provider.resetDocument(replacement as unknown as Document, 4);
      } else {
        provider.dispose();
      }
      internals[timerField] = replacementHandle;
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(internals[timerField]).toBe(replacementHandle);
    expect(reentered).toBe(true);
  });

  it("abandons timer rollback when cancellation throws after replacing state", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    internals.mutationTimer = 101;
    internals.cancelTimeout = () => {
      internals.mutationTimer = 202;
      throw new Error("hostile timer cancellation");
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(internals.mutationTimer).toBe(202);
  });

  it("does not cancel later timer replacements from mutation-timer cancellation", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const originalFrameTimer = { timer: "frame" };
    const originalShadowTimer = { timer: "shadow" };
    const replacementFrameTimer = { timer: "frame" };
    const replacementShadowTimer = { timer: "shadow" };
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = originalFrameTimer;
    internals.shadowScanTimer = originalShadowTimer;
    internals.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) {
        internals.frameMutationScanTimer = replacementFrameTimer;
        internals.shadowScanTimer = replacementShadowTimer;
      }
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBe(replacementFrameTimer);
    expect(internals.shadowScanTimer).toBe(replacementShadowTimer);
  });

  it("abandons timer rollback when the first cancellation clears a later timer", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = 102;
    internals.shadowScanTimer = 103;
    internals.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) internals.frameMutationScanTimer = undefined;
    };

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBeUndefined();
    expect(internals.shadowScanTimer).toBe(103);
  });

  it("abandons provider rollback after an observer disconnect resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const extraRoot = createElement("aside", document);
    internals.rootObservers.set(extraRoot as unknown as Node, {
      disconnect: () => provider.resetDocument(replacement as unknown as Document, 4),
    });

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
    expect(internals.rootObservers.has(document as unknown as Node)).toBe(false);
    expect(internals.rootObservers.has(replacement as unknown as Node)).toBe(true);
  });

  it("abandons provider rollback after frame unregistration resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const childDocument = createDocument();
    const frame = createFrameElement(document, childDocument);
    document.documentElement.append(frame);
    let provider: DomTreeProvider | undefined;
    let reentered = false;
    const harness = createProviderHarness(document, {
      onFrameLifecycle: (event) => {
        if (event.type !== "removed" || reentered || !provider) return;
        reentered = true;
        provider.resetDocument(replacement as unknown as Document, 4);
      },
    });
    provider = harness.provider;
    const root = provider.getRoot();
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();

    onlyChild(provider, root.node, root.documentEpoch, "operation-frame");

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
    expect(reentered).toBe(true);
  });

  it("abandons provider rollback after registry restoration resets authority", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const internals = provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    internals.nodeRegistry.restore = () => {
      provider.resetDocument(replacement as unknown as Document, 4);
      return true;
    };

    expect(internals.restoreProviderAuthority(snapshot)).toBe(false);
    expect(internals.topDocument).toBe(replacement as unknown as Document);
  });

  it("cleans the three entry timer handles exactly once", () => {
    const document = createDocument();
    const harness = createProviderHarness(document);
    const internals = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = internals.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    internals.mutationTimer = 101;
    internals.frameMutationScanTimer = 102;
    internals.shadowScanTimer = 103;
    internals.cancelTimeout = (handle) => cancelled.push(handle);

    expect(internals.restoreSnapshotTimers(snapshot)).toBe(true);
    expect(cancelled).toEqual([101, 102, 103]);
    expect(internals.mutationTimer).toBeUndefined();
    expect(internals.frameMutationScanTimer).toBeUndefined();
    expect(internals.shadowScanTimer).toBeUndefined();
  });

  it("preserves reentrant reset timer ownership while canceling scheduled work", () => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const provider = harness.provider;
    const state = provider as unknown as ProviderRollbackInternals & {
      cancelScheduledWork(): void;
    };
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    let reentered = false;
    state.cancelTimeout = (handle) => {
      if (handle !== 101 || reentered) return;
      reentered = true;
      provider.resetDocument(replacement as unknown as Document, 4);
      state.mutationTimer = 201;
      state.frameMutationScanTimer = 202;
      state.shadowScanTimer = 203;
    };

    expect(() => state.cancelScheduledWork()).not.toThrow();
    expect(state.mutationTimer).toBe(201);
    expect(state.frameMutationScanTimer).toBe(202);
    expect(state.shadowScanTimer).toBe(203);
  });

  it("continues scheduled-work cancellation after a hostile timer throws", () => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & {
      cancelScheduledWork(): void;
    };
    const cancelled: unknown[] = [];
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    state.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) throw new Error("hostile cancellation");
    };

    expect(() => state.cancelScheduledWork()).not.toThrow();
    expect(cancelled).toEqual([101, 103, 102]);
    expect(state.mutationTimer).toBeUndefined();
    expect(state.frameMutationScanTimer).toBeUndefined();
    expect(state.shadowScanTimer).toBeUndefined();
  });

  it("continues rollback timer cancellation after a hostile timer throws", () => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals;
    const snapshot = state.snapshotProviderAuthority();
    const cancelled: unknown[] = [];
    state.mutationTimer = 101;
    state.frameMutationScanTimer = 102;
    state.shadowScanTimer = 103;
    state.cancelTimeout = (handle) => {
      cancelled.push(handle);
      if (handle === 101) throw new Error("hostile rollback cancellation");
    };

    expect(state.restoreSnapshotTimers(snapshot)).toBe(false);
    expect(cancelled).toEqual([101, 102, 103]);
    expect(state.mutationTimer).toBeUndefined();
    expect(state.frameMutationScanTimer).toBeUndefined();
    expect(state.shadowScanTimer).toBeUndefined();
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("clears the %s timer before hostile cancellation", (_path, timer, cancel) => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    let observed: unknown;
    state.cancelTimeout = () => {
      observed = state[timer];
      throw new Error("hostile cancellation");
    };

    expect(() => cancel(state)).not.toThrow();
    expect(observed).toBeUndefined();
    expect(state[timer]).toBeUndefined();
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("preserves a reentrant %s timer replacement", (_path, timer, cancel) => {
    const harness = createProviderHarness(createDocument());
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    state.cancelTimeout = () => {
      state[timer] = 202;
    };

    cancel(state);
    expect(state[timer]).toBe(202);
  });

  it.each([
    ["mutation barrier", "mutationTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.flushMutationBarrier()],
    ["collapsed frame scan", "frameMutationScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.pruneCollapsedFrameMutationScans(undefined)],
    ["idle shadow scan", "shadowScanTimer", (state: ProviderRollbackInternals & ProviderTimerCancellationInternals) => state.stopShadowScanIfIdle()],
  ] as const)("preserves a reentrant reset replacement from the %s timer", (_path, timer, cancel) => {
    const document = createDocument();
    const replacement = createDocument();
    const harness = createProviderHarness(document);
    const state = harness.provider as unknown as ProviderRollbackInternals & ProviderTimerCancellationInternals;
    state[timer] = 101;
    state.cancelTimeout = () => {
      harness.provider.resetDocument(replacement as unknown as Document, 4);
      state[timer] = 202;
    };

    cancel(state);
    expect(state.topDocument).toBe(replacement as unknown as Document);
    expect(state[timer]).toBe(202);
  });

  it("does not invoke an outward callback after publication authority is already stale", () => {
    const provider = createProvider(createDocument());
    const state = provider as unknown as {
      activePublicationGuard: (() => boolean) | undefined;
      invokeOutwardCallback(callback: () => void): boolean;
    };
    let callbacks = 0;
    state.activePublicationGuard = () => false;

    expect(state.invokeOutwardCallback(() => { callbacks += 1; })).toBe(false);
    expect(callbacks).toBe(0);
  });

  it("does not read selected state after publication authority is already stale", () => {
    let reads = 0;
    const harness = createProviderHarness(createDocument(), {
      getSelectedNodeRef: () => {
        reads += 1;
        return "selected-ref";
      },
    });
    const state = harness.provider as unknown as {
      activePublicationGuard: (() => boolean) | undefined;
      readSelectedNodeRef(): { readonly valid: boolean; readonly nodeRef?: string };
    };
    state.activePublicationGuard = () => false;

    expect(state.readSelectedNodeRef()).toEqual({ valid: false });
    expect(reads).toBe(0);
  });

  it("never reuses a tentative cursor after provider authority restoration", () => {
    const harness = createProviderHarness(createDocument());
    const root = harness.provider.getRoot();
    const state = harness.provider as unknown as {
      snapshotProviderAuthority(): unknown;
      restoreProviderAuthority(snapshot: unknown): boolean;
      createCursor(record: {
        readonly nodeRef: string;
        readonly documentEpoch: number;
        readonly branchRevision: number;
        readonly offset: number;
        readonly physicalOffset: number;
      }): string;
    };
    const snapshot = state.snapshotProviderAuthority();
    const cursorRecord = {
      nodeRef: root.node.nodeRef,
      documentEpoch: root.documentEpoch,
      branchRevision: root.node.branchRevision,
      offset: 1,
      physicalOffset: 1,
    };
    const tentative = state.createCursor(cursorRecord);

    expect(state.restoreProviderAuthority(snapshot)).toBe(true);
    expect(state.createCursor(cursorRecord)).not.toBe(tentative);
  });
});

interface ProviderRollbackInternals {
  topDocument: Document | undefined;
  mutationTimer: unknown;
  frameMutationScanTimer: unknown;
  shadowScanTimer: unknown;
  cancelTimeout: (handle: unknown) => void;
  rootObservers: Map<Node, { disconnect(): void }>;
  nodeRegistry: { restore(snapshot: unknown): boolean };
  snapshotProviderAuthority(): unknown;
  restoreSnapshotTimers(snapshot: unknown): boolean;
  restoreProviderAuthority(snapshot: unknown): boolean;
}

interface ProviderTimerCancellationInternals {
  flushMutationBarrier(): void;
  pruneCollapsedFrameMutationScans(collapsedNode: Node | undefined): void;
  stopShadowScanIfIdle(): void;
}

interface AuthorityOperationInternals {
  beginProviderAuthorityOperation(): {
    publish(validate?: () => boolean): boolean;
    finalize(validate?: () => boolean): boolean;
    rollback(cleanup?: () => void): boolean;
  } | undefined;
  emitFrameLifecycle(event: FrameLifecycleEvent): boolean;
}

function frameLifecycleEvent(frameRef: string): FrameLifecycleEvent {
  return Object.freeze({
    type: "registered" as const,
    frameRef,
    frameEpoch: 1,
    documentEpoch: 3,
    parentFrameRef: "top",
    accessible: true,
  });
}

function onlyChild(
  provider: DomTreeProvider,
  parent: { readonly nodeRef: string; readonly branchRevision: number },
  documentEpoch: number,
  requestId: string,
) {
  const children = provider.getChildren({
    type: "dom.getChildren",
    requestId,
    documentEpoch,
    nodeRef: parent.nodeRef,
    branchRevision: parent.branchRevision,
  }).nodes;
  expect(children).toHaveLength(1);
  return children[0]!;
}

function providerRefForNode(
  provider: DomTreeProvider,
  node: FakeNode,
): string | undefined {
  return (provider as unknown as { readonly refsByNode: WeakMap<Node, string> })
    .refsByNode.get(node as unknown as Node);
}

function createProvider(document: FakeDocument): DomTreeProvider {
  return createProviderHarness(document).provider;
}

function resolveLocator(
  provider: DomTreeProvider,
  locator: DomStableLocator,
): { readonly node: { readonly nodeRef: string; readonly label: string }; readonly ancestorPath: readonly { readonly label: string }[] } | undefined {
  return (provider as unknown as {
    resolveLocator(locator: DomStableLocator): { readonly node: { readonly nodeRef: string; readonly label: string }; readonly ancestorPath: readonly { readonly label: string }[] } | undefined;
  }).resolveLocator(locator);
}

function resolveStableLocator(
  provider: DomTreeProvider,
  locator: DomStableLocator,
): unknown {
  return (provider as unknown as {
    readonly locatorService: { resolve(locator: DomStableLocator): unknown };
  }).locatorService.resolve(locator);
}

function flushPostCommitEffects(provider: DomTreeProvider): void {
  (provider as unknown as { flushPostCommitEffects(): void }).flushPostCommitEffects();
}

function locatorFor(provider: DomTreeProvider, target: FakeElement): DomStableLocator {
  return provider.revealElement(target as unknown as Element).ancestorPath.at(-1)!.locator;
}

function createHeadingTree(options: {
  readonly tagName?: string;
  readonly className?: string;
  readonly includeSibling?: boolean;
  readonly includeAttributes?: boolean;
  readonly attribute?: { readonly name: string; readonly value: string };
} = {}) {
  const document = createDocument();
  const body = createElement("body", document);
  const main = createElement("main", document);
  const target = createElement(options.tagName ?? "h2", document);
  target.id = "section_title_id1";
  target.className = options.className ?? "block_title";
  if (options.includeAttributes !== false) {
    target.setAttribute("data-section", "intro");
    target.setAttribute("aria-label", "Introduction");
    target.setAttribute("role", "presentation");
  }
  if (options.attribute) target.setAttribute(options.attribute.name, options.attribute.value);
  document.documentElement.append(body);
  body.append(main);
  if (options.includeSibling) main.append(createElement("p", document));
  main.append(target);
  return { document, main, target, provider: createProvider(document) };
}

function createNestedShadowTree(options: { readonly attachInnerShadow?: boolean } = {}) {
  const document = createDocument();
  const outer = createElement("article", document);
  outer.id = "outer_host";
  const outerShadow = outer.attachShadow();
  const inner = createElement("section", document);
  inner.id = "inner_host";
  outerShadow.append(inner);
  const target = createElement("button", document);
  target.id = "shadow_target";
  target.className = "action";
  if (options.attachInnerShadow !== false) {
    inner.attachShadow().append(target);
  } else {
    inner.append(target);
  }
  document.documentElement.append(outer);
  return { document, provider: createProvider(document), target };
}

function createFramedButtonTree(options: {
  readonly accessError?: Error;
  readonly materialize?: boolean;
  readonly includeUnrelatedFrame?: boolean;
} = {}) {
  const document = createDocument();
  const childDocument = createDocument();
  const frame = createFrameElement(document, childDocument, options.accessError);
  const target = createElement("button", childDocument);
  target.id = "frame_target";
  target.className = "action";
  childDocument.documentElement.append(target);
  document.documentElement.append(frame);
  const unrelatedDocument = options.includeUnrelatedFrame ? createDocument() : undefined;
  if (unrelatedDocument) {
    document.documentElement.append(createFrameElement(document, unrelatedDocument));
  }
  const provider = createProvider(document);
  if (options.materialize !== false) {
    const root = provider.getRoot();
    const frameView = onlyChild(provider, root.node, root.documentEpoch, "frame");
    if (!options.accessError) {
      onlyChild(provider, frameView, root.documentEpoch, "frame-document");
    }
  }
  return { document, provider, target, frame, unrelatedDocument };
}

interface ProviderHarnessOptions {
  readonly documentEpoch?: number;
  readonly createProvider?: (
    document: Document,
    options: DomTreeProviderOptions,
  ) => DomTreeProvider;
  readonly createMutationObserver?: (
    callback: (records: readonly MutationRecord[]) => void,
  ) => TestMutationObserver;
  readonly onInvalidated?: (branch: {
    readonly nodeRef: string;
    readonly branchRevision: number;
  }) => void;
  readonly getSelectedNodeRef?: () => string | undefined;
  readonly onSelectedNodeRemoved?: (event: {
    readonly nodeRef: string;
    readonly documentEpoch: number;
  }) => void;
  readonly onFrameLifecycle?: (event: {
    readonly type: string;
    readonly frameRef: string;
    readonly frameEpoch: number;
    readonly documentEpoch: number;
  }) => void;
  readonly onMutationSettled?: () => void;
  readonly maxCursors?: number;
  readonly maxRecords?: number;
  readonly isExcludedNode?: (node: Node) => boolean;
}

function createProviderHarness(
  document: FakeDocument,
  options: ProviderHarnessOptions = {},
): {
  readonly provider: DomTreeProvider;
  readonly observers: TestMutationObserver[];
  readonly flushTimers: () => void;
  readonly flushEffects: () => void;
  readonly pendingTimerCount: () => number;
} {
  const observers: TestMutationObserver[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const providerOptions = {
    documentEpoch: options.documentEpoch ?? 3,
    createMutationObserver: (callback) => {
      const observer = options.createMutationObserver?.(callback) ??
        new TestMutationObserver(callback);
      observers.push(observer);
      return observer;
    },
    setTimeout: (callback) => {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, callback);
      return timer;
    },
    clearTimeout: (timer) => {
      timers.delete(timer as unknown as number);
    },
    onInvalidated: options.onInvalidated,
    getSelectedNodeRef: options.getSelectedNodeRef,
    onSelectedNodeRemoved: options.onSelectedNodeRemoved,
    onFrameLifecycle: options.onFrameLifecycle,
    onMutationSettled: options.onMutationSettled,
    isExcludedNode: options.isExcludedNode,
    maxCursors: options.maxCursors,
    maxRecords: options.maxRecords,
  };
  const provider = options.createProvider
    ? options.createProvider(document as unknown as Document, providerOptions)
    : new DomTreeProvider(document as unknown as Document, providerOptions);
  return {
    provider,
    observers,
    flushTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    flushEffects: () => {
      (provider as unknown as { flushPostCommitEffects(): void }).flushPostCommitEffects();
    },
    pendingTimerCount: () => timers.size,
  };
}

class TestMutationObserver {
  private records: readonly MutationRecord[] = [];
  public readonly observedTargets: FakeNode[] = [];
  public readonly observedOptions: MutationObserverInit[] = [];
  public disconnectCount = 0;
  public emitCount = 0;

  public constructor(
    private readonly callback: (records: readonly MutationRecord[]) => void,
  ) {}

  public observe(target: Node, options: MutationObserverInit): void {
    this.observedTargets.push(target as unknown as FakeNode);
    this.observedOptions.push({ ...options });
  }

  public disconnect(): void {
    this.disconnectCount += 1;
    this.records = [];
  }

  public takeRecords(): readonly MutationRecord[] {
    const records = this.records;
    this.records = [];
    return records;
  }

  public queue(records: readonly MutationRecord[]): void {
    this.records = records;
  }

  public emit(records: readonly MutationRecord[]): void {
    if (this.disconnectCount > 0) return;
    this.emitCount += 1;
    this.callback(records);
  }

  public emitUnchecked(records: readonly MutationRecord[]): void {
    this.callback(records);
  }
}

function mutationRecord(
  target: FakeNode,
  addedNodes: readonly FakeNode[] = [],
  removedNodes: readonly FakeNode[] = [],
): MutationRecord {
  return {
    type: "childList",
    target,
    addedNodes,
    removedNodes,
  } as unknown as MutationRecord;
}

function attributeMutationRecord(
  target: FakeElement,
  attributeName: string,
): MutationRecord {
  return {
    type: "attributes",
    target,
    attributeName,
  } as unknown as MutationRecord;
}

function characterDataMutationRecord(target: FakeNode): MutationRecord {
  return {
    type: "characterData",
    target,
  } as unknown as MutationRecord;
}

function repeatedIndexedList<T>(
  length: number,
  value: T,
  onIndexedRead: () => void,
): readonly T[] {
  return new Proxy([] as T[], {
    get(target, property, receiver) {
      if (property === "length") return length;
      if (typeof property === "string" && /^\d+$/.test(property)) {
        onIndexedRead();
        return value;
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

class FakeNode {
  public parentNode: FakeNode | null = null;
  public readonly childNodes: FakeNode[] = [];
  public previousElementSibling: FakeElement | null = null;

  public constructor(
    public readonly nodeType: number,
    public nodeName = "",
    public nodeValue: string | null = null,
  ) {}

  public prepend(child: FakeNode): void {
    child.parentNode = this;
    child.previousElementSibling = null;
    this.childNodes.unshift(child);
    for (let childIndex = 1; childIndex < this.childNodes.length; childIndex += 1) {
      const current = this.childNodes[childIndex]!;
      current.previousElementSibling = this.lastElementBefore(childIndex);
    }
  }

  public append(child: FakeNode): void {
    child.parentNode = this;
    child.previousElementSibling = this.lastElementChild();
    this.childNodes.push(child);
  }

  public remove(child: FakeNode): void {
    const index = this.childNodes.indexOf(child);
    if (index < 0) return;
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    child.previousElementSibling = null;
    for (let childIndex = index; childIndex < this.childNodes.length; childIndex += 1) {
      const current = this.childNodes[childIndex]!;
      current.previousElementSibling = this.lastElementBefore(childIndex);
    }
  }

  private lastElementChild(): FakeElement | null {
    return this.lastElementBefore(this.childNodes.length);
  }

  private lastElementBefore(end: number): FakeElement | null {
    for (let index = end - 1; index >= 0; index -= 1) {
      const candidate = this.childNodes[index];
      if (candidate?.nodeType === 1) return candidate as FakeElement;
    }
    return null;
  }

  public contains(candidate: Node): boolean {
    let current: FakeNode | null = candidate as unknown as FakeNode;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return false;
  }
}

class FakeElement extends FakeNode {
  public id = "";
  public className = "";
  public readonly attributes: Array<{ name: string; value: string }> = [];
  public shadowRoot: FakeShadowRoot | null = null;

  public constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeDocument,
  ) {
    super(1, tagName);
  }

  public attachShadow(): FakeShadowRoot {
    const shadowRoot = new FakeShadowRoot(this);
    this.shadowRoot = shadowRoot;
    return shadowRoot;
  }

  public get childElementCount(): number {
    let count = 0;
    for (const child of this.childNodes) {
      if (child.nodeType === 1) {
        count += 1;
      }
    }
    return count;
  }

  public get firstElementChild(): FakeElement | null {
    return (this.childNodes.find((child) => child.nodeType === 1) as
      | FakeElement
      | undefined) ?? null;
  }

  public get classList(): readonly string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }

  public setAttribute(name: string, value: string): void {
    const normalized = name.toLowerCase();
    const existing = this.attributes.find((attribute) => (
      attribute.name === normalized
    ));
    if (existing) {
      existing.value = value;
    } else {
      this.attributes.push({ name: normalized, value });
    }
    if (normalized === "id") {
      this.id = value;
    } else if (normalized === "class") {
      this.className = value;
    }
  }

  public removeAttribute(name: string): void {
    const normalized = name.toLowerCase();
    const index = this.attributes.findIndex((attribute) => (
      attribute.name === normalized
    ));
    if (index >= 0) {
      this.attributes.splice(index, 1);
    }
    if (normalized === "id") {
      this.id = "";
    } else if (normalized === "class") {
      this.className = "";
    }
  }
}

class FakeFrameElement extends FakeElement {
  private readonly loadListeners = new Set<EventListener>();
  private readonly contentWindowValue: { document: FakeDocument | null };
  public contentDocumentReads = 0;
  public contentWindowReads = 0;

  public constructor(
    ownerDocument: FakeDocument,
    private frameDocument: FakeDocument | null,
    private readonly accessError?: Error,
  ) {
    super("IFRAME", ownerDocument);
    this.contentWindowValue = { document: frameDocument };
  }

  public get contentDocument(): Document | null {
    this.contentDocumentReads += 1;
    if (this.accessError) throw this.accessError;
    return this.frameDocument as unknown as Document | null;
  }

  public get contentWindow(): Window | null {
    this.contentWindowReads += 1;
    return this.frameDocument
      ? (this.contentWindowValue as unknown as Window)
      : null;
  }

  public addEventListener(type: string, listener: EventListener): void {
    if (type === "load") this.loadListeners.add(listener);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    if (type === "load") this.loadListeners.delete(listener);
  }

  public getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 10,
      bottom: 10,
      width: 10,
      height: 10,
      toJSON: () => ({}),
    } as DOMRect;
  }

  public get loadListenerCount(): number {
    return this.loadListeners.size;
  }

  public setFrameDocument(document: FakeDocument | null): void {
    this.frameDocument = document;
    this.contentWindowValue.document = document;
  }

  public dispatchLoad(): void {
    for (const listener of [...this.loadListeners]) {
      listener(new Event("load"));
    }
  }
}

class FakeShadowRoot extends FakeNode {
  public readonly mode = "open";

  public constructor(public readonly host: FakeElement) {
    super(11, "#document-fragment");
  }

  public getRootNode(): FakeShadowRoot {
    return this;
  }
}

class FakeDocument extends FakeNode {
  public onDocumentElementRead: (() => void) | undefined;

  public constructor() {
    super(9, "#document");
    this.append(new FakeElement("HTML", this));
  }

  public get documentElement(): FakeElement {
    this.onDocumentElementRead?.();
    return this.childNodes.find((child) => child.nodeType === 1) as FakeElement;
  }
}

class FakeDocumentType extends FakeNode {
  public constructor(
    public readonly name: string,
    public readonly publicId = "",
    public readonly systemId = "",
  ) {
    super(10, name, null);
  }
}

function createDocument(): FakeDocument {
  return new FakeDocument();
}

function createElement(tagName: string, document: FakeDocument): FakeElement {
  return new FakeElement(tagName.toUpperCase(), document);
}

function createFrameElement(
  document: FakeDocument,
  frameDocument: FakeDocument | null,
  accessError?: Error,
): FakeFrameElement {
  return new FakeFrameElement(document, frameDocument, accessError);
}

function createText(text: string): FakeNode {
  return new FakeNode(3, "#text", text);
}

function createComment(text: string): FakeNode {
  return new FakeNode(8, "#comment", text);
}

function createDocumentType(
  name = "html",
  publicId = "",
  systemId = "",
): FakeDocumentType {
  return new FakeDocumentType(name, publicId, systemId);
}

function measureDomEnvelopeSerialization<Result>(
  type: "dom.root" | "dom.children",
  operation: () => Result,
): {
  readonly result: Result;
  readonly envelopeCalls: number;
  readonly envelopeBytes: number;
} {
  const originalStringify = JSON.stringify;
  let envelopeCalls = 0;
  let envelopeBytes = 0;
  const stringify = ((value: unknown): string | undefined => {
    const serialized = originalStringify(value);
    if (
      serialized !== undefined &&
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      value.type === type
    ) {
      envelopeCalls += 1;
      envelopeBytes += utf8ByteLength(serialized);
    }
    return serialized;
  }) as typeof JSON.stringify;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation(stringify);
  try {
    const result = operation();
    return { result, envelopeCalls, envelopeBytes };
  } finally {
    spy.mockRestore();
  }
}

function endsWithUnpairedSurrogate(value: string): boolean {
  if (value.length === 0) return false;
  const final = value.charCodeAt(value.length - 1);
  return final >= 0xd800 && final <= 0xdbff;
}

function containsUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      return true;
    }
  }
  return false;
}
