import { describe, expect, it, vi } from "vitest";
import {
  PageOverlay,
  type PageOverlayOptions,
} from "../src/pageOverlay.js";
import type {
  FrameContext,
  FrameIdentity,
  TopViewportRect,
  ViewportRect,
} from "../src/frameRegistry.js";

describe("PageOverlay", () => {
  it("renders exact margin, border, padding, and content geometry", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 100, y: 80, width: 200, height: 100 }],
      style: {
        marginTop: "10px",
        marginRight: "20px",
        marginBottom: "30px",
        marginLeft: "40px",
        borderTopWidth: "2px",
        borderRightWidth: "4px",
        borderBottomWidth: "6px",
        borderLeftWidth: "8px",
        paddingTop: "3px",
        paddingRight: "5px",
        paddingBottom: "7px",
        paddingLeft: "9px",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readBoxGeometry(environment.document, "margin")).toEqual({
      left: "60px",
      top: "70px",
      width: "260px",
      height: "140px",
    });
    expect(readBoxGeometry(environment.document, "border")).toEqual({
      left: "100px",
      top: "80px",
      width: "200px",
      height: "100px",
    });
    expect(readBoxGeometry(environment.document, "padding")).toEqual({
      left: "108px",
      top: "82px",
      width: "188px",
      height: "92px",
    });
    expect(readBoxGeometry(environment.document, "content")).toEqual({
      left: "117px",
      top: "85px",
      width: "174px",
      height: "82px",
    });
  });

  it("renders every client rect of a multiline inline element", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [
        { x: 10, y: 20, width: 80, height: 12 },
        { x: 10, y: 32, width: 120, height: 12 },
        { x: 10, y: 44, width: 50, height: 12 },
      ],
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "border")).toEqual([
      { left: "10px", top: "20px", width: "80px", height: "12px" },
      { left: "10px", top: "32px", width: "120px", height: "12px" },
      { left: "10px", top: "44px", width: "50px", height: "12px" },
    ]);
    expect(readAllBoxGeometry(environment.document, "content")).toHaveLength(3);
  });

  it("slices nonzero box edges across horizontal multiline fragments", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [
        { x: 100, y: 20, width: 80, height: 60 },
        { x: 100, y: 80, width: 100, height: 60 },
        { x: 100, y: 140, width: 60, height: 60 },
      ],
      style: {
        marginTop: "1px",
        marginRight: "2px",
        marginBottom: "3px",
        marginLeft: "4px",
        borderTopWidth: "5px",
        borderRightWidth: "6px",
        borderBottomWidth: "7px",
        borderLeftWidth: "8px",
        paddingTop: "9px",
        paddingRight: "10px",
        paddingBottom: "11px",
        paddingLeft: "12px",
        boxDecorationBreak: "slice",
        writingMode: "horizontal-tb",
        direction: "ltr",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "margin")).toEqual([
      { left: "96px", top: "19px", width: "84px", height: "64px" },
      { left: "100px", top: "79px", width: "100px", height: "64px" },
      { left: "100px", top: "139px", width: "62px", height: "64px" },
    ]);
    expect(readAllBoxGeometry(environment.document, "padding")).toEqual([
      { left: "108px", top: "25px", width: "72px", height: "48px" },
      { left: "100px", top: "85px", width: "100px", height: "48px" },
      { left: "100px", top: "145px", width: "54px", height: "48px" },
    ]);
    expect(readAllBoxGeometry(environment.document, "content")).toEqual([
      { left: "120px", top: "34px", width: "60px", height: "28px" },
      { left: "100px", top: "94px", width: "100px", height: "28px" },
      { left: "100px", top: "154px", width: "44px", height: "28px" },
    ]);
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(3);
  });

  it.each([
    [
      "horizontal-tb",
      "rtl",
      [
        { left: "10px", top: "19px", width: "32px", height: "44px" },
        { left: "46px", top: "59px", width: "34px", height: "44px" },
      ],
    ],
    [
      "vertical-rl",
      "ltr",
      [
        { left: "6px", top: "19px", width: "36px", height: "41px" },
        { left: "46px", top: "60px", width: "36px", height: "43px" },
      ],
    ],
    [
      "vertical-rl",
      "rtl",
      [
        { left: "6px", top: "20px", width: "36px", height: "43px" },
        { left: "46px", top: "59px", width: "36px", height: "41px" },
      ],
    ],
    [
      "vertical-lr",
      "ltr",
      [
        { left: "6px", top: "19px", width: "36px", height: "41px" },
        { left: "46px", top: "60px", width: "36px", height: "43px" },
      ],
    ],
    [
      "vertical-lr",
      "rtl",
      [
        { left: "6px", top: "20px", width: "36px", height: "43px" },
        { left: "46px", top: "59px", width: "36px", height: "41px" },
      ],
    ],
  ] as const)(
    "maps sliced inline edges for %s %s",
    (writingMode, direction, expectedMargins) => {
      const environment = createEnvironment();
      const element = environment.createElement({
        rects: [
          { x: 10, y: 20, width: 30, height: 40 },
          { x: 50, y: 60, width: 30, height: 40 },
        ],
        style: {
          marginTop: "1px",
          marginRight: "2px",
          marginBottom: "3px",
          marginLeft: "4px",
          boxDecorationBreak: "slice",
          writingMode,
          direction,
        },
      });
      const overlay = environment.createOverlay();

      overlay.show(element, environment.identity);
      environment.animation.flush();

      expect(readAllBoxGeometry(environment.document, "margin")).toEqual(
        expectedMargins,
      );
      expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(2);
    },
  );

  it("clones every nonzero edge for each fragment", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [
        { x: 10, y: 20, width: 50, height: 40 },
        { x: 10, y: 60, width: 50, height: 40 },
      ],
      style: {
        marginTop: "2px",
        marginRight: "2px",
        marginBottom: "2px",
        marginLeft: "2px",
        borderTopWidth: "2px",
        borderRightWidth: "2px",
        borderBottomWidth: "2px",
        borderLeftWidth: "2px",
        paddingTop: "2px",
        paddingRight: "2px",
        paddingBottom: "2px",
        paddingLeft: "2px",
        boxDecorationBreak: "clone",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "margin")).toEqual([
      { left: "8px", top: "18px", width: "54px", height: "44px" },
      { left: "8px", top: "58px", width: "54px", height: "44px" },
    ]);
    expect(readAllBoxGeometry(environment.document, "content")).toEqual([
      { left: "14px", top: "24px", width: "42px", height: "32px" },
      { left: "14px", top: "64px", width: "42px", height: "32px" },
    ]);
  });

  it("fails closed for nonzero-edge multi-rect block fragmentation", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [
        { x: 10, y: 20, width: 50, height: 30 },
        { x: 10, y: 50, width: 40, height: 30 },
      ],
      style: {
        display: "block",
        marginTop: "1px",
        marginRight: "2px",
        marginBottom: "3px",
        marginLeft: "4px",
        borderTopWidth: "5px",
        borderRightWidth: "6px",
        borderBottomWidth: "7px",
        borderLeftWidth: "8px",
        paddingTop: "9px",
        paddingRight: "10px",
        paddingBottom: "11px",
        paddingLeft: "12px",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(element.clientRectReads).toBe(1);
    expect(element.boundingRectReads).toBe(0);
    expect(environment.registry.toTopViewportCalls).toEqual([]);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
  });

  it("keeps exact box geometry for a single-rect block", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 10, y: 20, width: 50, height: 30 }],
      style: {
        display: "block",
        marginTop: "1px",
        marginRight: "1px",
        marginBottom: "1px",
        marginLeft: "1px",
        borderTopWidth: "2px",
        borderRightWidth: "2px",
        borderBottomWidth: "2px",
        borderLeftWidth: "2px",
        paddingTop: "3px",
        paddingRight: "3px",
        paddingBottom: "3px",
        paddingLeft: "3px",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "margin")).toEqual([{
      left: "9px",
      top: "19px",
      width: "52px",
      height: "32px",
    }]);
    expect(readAllBoxGeometry(environment.document, "content")).toEqual([{
      left: "15px",
      top: "25px",
      width: "40px",
      height: "20px",
    }]);
  });

  it.each([
    { writingMode: "sideways-rl" },
    { direction: "auto" },
    { boxDecorationBreak: "unsupported" },
  ] as const)("fails closed for unsupported fragment style $writingMode$direction$boxDecorationBreak", (style) => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 10, y: 20, width: 50, height: 40 }],
      style,
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(element.clientRectReads).toBe(0);
    expect(element.boundingRectReads).toBe(0);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
  });

  it("uses the translated platform bounding rect for the label while retaining empty fragments", () => {
    const environment = createEnvironment();
    const child = environment.createFrame({ x: 100, y: 200 });
    const element = environment.createElement(
      {
        rects: [
          { x: -100, y: -100, width: 0, height: 0 },
          { x: 10, y: 20, width: 30, height: 10 },
          { x: 10, y: 30, width: 50, height: 10 },
        ],
      },
      child.document,
    );
    const overlay = environment.createOverlay();

    overlay.show(element, child.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "border")).toEqual([
      { left: "0px", top: "100px", width: "0px", height: "0px" },
      { left: "110px", top: "220px", width: "30px", height: "10px" },
      { left: "110px", top: "230px", width: "50px", height: "10px" },
    ]);
    const label = findElements(environment.document).find(
      (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
    );
    expect(label?.textContent).toMatch(/ 50 x 20$/);
    expect(label?.style.left).toBe("110px");
    expect(label?.style.top).toBe("198px");
    expect(element.boundingRectReads).toBe(1);
    expect(environment.registry.toTopViewportCalls).toHaveLength(1);
    expect(environment.registry.toTopViewportCalls[0]?.identity).toEqual(child.identity);
    expect(environment.registry.toTopViewportCalls[0]?.rect).toEqual({
      x: 10,
      y: 20,
      width: 50,
      height: 20,
    });
  });

  it.each([
    [64, true],
    [65, false],
  ] as const)("enforces the fragment and visual-node budget at %i fragments", (count, accepted) => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: Array.from({ length: count }, (_, index) => ({
        x: index,
        y: index * 2,
        width: 10,
        height: 5,
      })),
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(
      accepted ? count : 0,
    );
    expect(environment.registry.toTopViewportCalls).toHaveLength(accepted ? 1 : 0);
    expect(element.boundingRectReads).toBe(accepted ? 1 : 0);
    const host = findOverlayHost(environment.document);
    const visualNodes = findElementsIn(host.attachedShadowRoot!).filter(
      (candidate) =>
        candidate.getAttribute("data-browser2ide-box") !== null ||
        candidate.getAttribute("data-browser2ide-label") === "",
    );
    expect(visualNodes).toHaveLength(accepted ? count * 4 + 1 : 0);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(
      accepted ? 1 : 0,
    );
  });

  it("translates nested-frame rects and clears listeners when identity is stale", () => {
    const environment = createEnvironment();
    const parent = environment.createFrame({ x: 100, y: 200 });
    const child = environment.createFrame({
      x: 20,
      y: 30,
      parentFrameRef: parent.identity.frameRef,
    });
    const element = environment.createElement(
      { rects: [{ x: 5, y: 6, width: 40, height: 10 }] },
      child.document,
    );
    const overlay = environment.createOverlay();

    overlay.show(element, child.identity);
    environment.animation.flush();

    expect(readBoxGeometry(environment.document, "border")).toEqual({
      left: "125px",
      top: "236px",
      width: "40px",
      height: "10px",
    });
    for (const source of [
      environment.document.defaultView,
      parent.document.defaultView,
      child.document.defaultView,
    ]) {
      expect(source.listenerCount("scroll")).toBe(1);
      expect(source.listenerCount("resize")).toBe(1);
    }

    environment.registry.invalidate(child.identity.frameRef);
    const styleReadsBeforeStaleShow = element.computedStyleReads;
    const clientReadsBeforeStaleShow = element.clientRectReads;
    const boundingReadsBeforeStaleShow = element.boundingRectReads;
    overlay.show(element, child.identity);
    environment.animation.flush();

    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(element.computedStyleReads).toBe(styleReadsBeforeStaleShow);
    expect(element.clientRectReads).toBe(clientReadsBeforeStaleShow);
    expect(element.boundingRectReads).toBe(boundingReadsBeforeStaleShow);
    for (const source of [
      environment.document.defaultView,
      parent.document.defaultView,
      child.document.defaultView,
    ]) {
      expect(source.listenerCount("scroll")).toBe(0);
      expect(source.listenerCount("resize")).toBe(0);
    }
  });

  it("rejects a target from another document before style or geometry reads", () => {
    const environment = createEnvironment();
    const overlay = environment.createOverlay();
    const valid = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    overlay.show(valid, environment.identity);
    environment.animation.flush();
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(1);
    const foreignDocument = new FakeDocument();
    const adopted = environment.createElement(
      { rects: [{ x: 5, y: 6, width: 70, height: 80 }] },
      foreignDocument,
    );

    overlay.show(adopted, environment.identity);
    environment.animation.flush();

    expect(adopted.computedStyleReads).toBe(0);
    expect(adopted.clientRectReads).toBe(0);
    expect(adopted.boundingRectReads).toBe(0);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
  });

  it.each([
    ["getContext", "clear"],
    ["getContext", "dispose"],
    ["ownerDocument", "clear"],
    ["ownerDocument", "dispose"],
  ] as const)(
    "does not read target geometry when %s reenters %s",
    (accessPoint, action) => {
      const environment = createEnvironment();
      let overlay!: PageOverlay;
      let reentered = false;
      const reenter = (): void => {
        if (reentered) return;
        reentered = true;
        overlay[action]();
      };
      const element = environment.createElement({
        rects: [{ x: 5, y: 6, width: 70, height: 80 }],
        ...(accessPoint === "ownerDocument" ? { onOwnerDocumentRead: reenter } : {}),
      });
      overlay = environment.createOverlay();
      if (accessPoint === "getContext") environment.registry.onGetContext = reenter;

      overlay.show(element, environment.identity);
      expect(() => environment.animation.flush()).not.toThrow();

      expect(reentered).toBe(true);
      expect(element.computedStyleReads).toBe(0);
      expect(element.clientRectReads).toBe(0);
      expect(element.boundingRectReads).toBe(0);
      expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
      expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
      expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
    },
  );

  it.each([
    ["transform", { transform: "matrix(1, 0, 0, 1, 10, 0)" }],
    ["translate", { translate: "1px" }],
    ["rotate", { rotate: "1deg" }],
    ["scale", { scale: "2" }],
    ["zoom", { zoom: "2" }],
    ["perspective", { perspective: "10px" }],
    ["offset path", { offsetPath: "path('M 0 0 L 1 1')" }],
    ["motion path", { motionPath: "path('M 0 0 L 1 1')" }],
  ] as const)("fails closed before rect reads for target %s", (_name, style) => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
      style,
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(element.clientRectReads).toBe(0);
    expect(element.boundingRectReads).toBe(0);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
  });

  it("fails closed before rect reads for a transformed target ancestor", () => {
    const environment = createEnvironment();
    const ancestor = environment.createElement({
      rects: [],
      style: { transform: "matrix(1, 0, 0, 1, 10, 0)" },
    });
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
      parentElement: ancestor,
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(ancestor.computedStyleReads).toBe(1);
    expect(element.clientRectReads).toBe(0);
    expect(element.boundingRectReads).toBe(0);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
  });

  it.each(["clear", "dispose"] as const)(
    "does not publish when ancestor computed style reenters %s",
    (action) => {
      const environment = createEnvironment();
      let overlay!: PageOverlay;
      let reentered = false;
      const ancestor = environment.createElement({
        rects: [],
        onComputedStyle: () => {
          if (reentered) return;
          reentered = true;
          overlay[action]();
        },
      });
      const element = environment.createElement({
        rects: [{ x: 5, y: 6, width: 70, height: 80 }],
        parentElement: ancestor,
      });
      overlay = environment.createOverlay();

      overlay.show(element, environment.identity);
      expect(() => environment.animation.flush()).not.toThrow();

      expect(reentered).toBe(true);
      expect(element.clientRectReads).toBe(0);
      expect(element.boundingRectReads).toBe(0);
      expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
      expect(environment.animation.pendingCount).toBe(0);
    },
  );

  it("coalesces show, scroll, and resize bursts and the latest target wins", () => {
    const environment = createEnvironment();
    const child = environment.createFrame({ x: 50, y: 60 });
    const childElement = environment.createElement(
      { rects: [{ x: 1, y: 2, width: 3, height: 4 }] },
      child.document,
    );
    const first = environment.createElement({
      rects: [{ x: 10, y: 20, width: 30, height: 40 }],
    });
    const latest = environment.createElement({
      rects: [{ x: 70, y: 80, width: 90, height: 100 }],
    });
    const overlay = environment.createOverlay();
    overlay.show(childElement, child.identity);
    environment.animation.flush();

    overlay.show(first, environment.identity);
    overlay.show(latest, environment.identity);
    overlay.show(latest, environment.identity);

    expect(environment.animation.pendingCount).toBe(1);
    expect(child.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(child.document.defaultView.listenerCount("resize")).toBe(0);
    environment.animation.flush();
    expect(first.clientRectReads).toBe(0);
    expect(latest.clientRectReads).toBe(1);
    expect(readBoxGeometry(environment.document, "border")).toEqual({
      left: "70px",
      top: "80px",
      width: "90px",
      height: "100px",
    });

    for (let index = 0; index < 5; index += 1) {
      environment.document.defaultView.dispatch("scroll");
      environment.document.defaultView.dispatch("resize");
    }

    expect(environment.animation.pendingCount).toBe(1);
    environment.animation.flush();
    expect(latest.clientRectReads).toBe(2);
    expect(environment.animation.requestCount).toBe(3);
  });

  it("owns a style-isolated, noninteractive, aria-hidden shadow overlay", () => {
    const environment = createEnvironment();
    const pageElement = environment.createElement({
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
    });
    pageElement.textContent = "<button onclick=alert(1)>page markup</button>";
    const otherDocument = new FakeDocument();
    const otherNode = new FakeElement("div", otherDocument);
    const overlay = environment.createOverlay();

    overlay.show(pageElement, environment.identity);
    environment.animation.flush();

    const host = findOverlayHost(environment.document);
    expect(host.shadowRoot).toBeNull();
    expect(host.attachedShadowRoot).toBeInstanceOf(FakeShadowRoot);
    expect(host.attachedShadowRoot?.mode).toBe("closed");
    expect(host.style.pointerEvents).toBe("none");
    expect(host.getAttribute("aria-hidden")).toBe("true");
    const visualDescendants = findElementsIn(host.attachedShadowRoot!);
    expect(visualDescendants.length).toBeGreaterThan(1);
    for (const descendant of visualDescendants) {
      expect(descendant.style.pointerEvents).toBe("none");
      expect(descendant.getAttribute("aria-hidden")).toBe("true");
    }
    expect(overlay.ownsNode(host as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(host.attachedShadowRoot as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(visualDescendants[0] as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(pageElement)).toBe(false);
    expect(overlay.ownsNode(otherNode as unknown as Node)).toBe(false);
    expect(environment.document.createdElements.every(
      (element) => element.innerHtmlReads === 0 && element.innerHtmlWrites === 0,
    )).toBe(true);
  });

  it("keeps pointer events disabled in computed style after all resets", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    const host = findOverlayHost(environment.document);
    const ownedElements = [host, ...findElementsIn(host.attachedShadowRoot!)];
    expect(ownedElements.length).toBeGreaterThan(2);
    for (const ownedElement of ownedElements) {
      expect(
        environment.document.getComputedStyle(ownedElement).pointerEvents,
      ).toBe("none");
    }
  });

  it("keeps critical host styles above page important rules and isolates bidi", () => {
    const environment = createEnvironment();
    environment.document.setPageImportantStyle("pointer-events", "auto");
    environment.document.setPageImportantStyle("position", "static");
    environment.document.setPageImportantStyle("display", "inline");
    environment.document.setPageImportantStyle("direction", "rtl");
    environment.document.setPageImportantStyle("unicode-bidi", "normal");
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    const host = findOverlayHost(environment.document);
    const computed = environment.document.getComputedStyle(host);
    expect(computed.pointerEvents).toBe("none");
    expect(computed.position).toBe("fixed");
    expect(computed.display).toBe("block");
    expect(computed.direction).toBe("ltr");
    expect(computed.unicodeBidi).toBe("isolate");
    for (const property of [
      "all",
      "pointer-events",
      "position",
      "top",
      "right",
      "bottom",
      "left",
      "z-index",
      "display",
      "direction",
      "unicode-bidi",
    ]) {
      expect(host.style.getPropertyPriority(property)).toBe("important");
    }
    for (const descendant of findElementsIn(host.attachedShadowRoot!)) {
      expect(descendant.style.direction).toBe("ltr");
      expect(descendant.style.unicodeBidi).toBe("isolate");
    }

    overlay.clear();
    expect(environment.document.getComputedStyle(host).display).toBe("none");
    expect(host.style.getPropertyPriority("display")).toBe("important");
  });

  it("renders a bounded plain-text label with dimensions inside the viewport", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      tagName: "button",
      id: `target\"><img-src=x-onerror=alert(1)>${"x".repeat(100)}`,
      classes: ["primary", `evil></div><script>${"y".repeat(100)}`],
      rects: [{ x: 990, y: 2, width: 80, height: 20 }],
    });
    element.textContent = "private page text and form value";
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    const label = findElements(environment.document).find(
      (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
    );
    expect(label).toBeDefined();
    expect(label?.textContent).toContain("button#target\"><img-src=x-onerror=alert(1)>");
    expect(label?.textContent).toContain(".primary.evil></div><script>");
    expect(label?.textContent).toMatch(/ 80 x 20$/);
    expect(label?.textContent).not.toContain("private page text");
    expect(label?.textContent.length).toBeLessThanOrEqual(180);
    expect(label?.style.left).toBe("704px");
    expect(label?.style.top).toBe("22px");
    expect(label?.style.maxWidth).toBe("320px");
    expect(label?.innerHtmlWrites).toBe(0);
  });

  it("bounds an oversized tag name before lowercasing it", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      tagName: "X".repeat(4_096),
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const lowercasedLengths: number[] = [];
    const originalToLowerCase = String.prototype.toLowerCase;
    const toLowerCase = vi
      .spyOn(String.prototype, "toLowerCase")
      .mockImplementation(function observeBoundedLowercase(this: string): string {
        lowercasedLengths.push(String(this).length);
        return originalToLowerCase.call(this);
      });
    const overlay = environment.createOverlay();

    try {
      overlay.show(element, environment.identity);
      environment.animation.flush();
    } finally {
      toLowerCase.mockRestore();
    }

    const label = findElements(environment.document).find(
      (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
    );
    expect(Math.max(...lowercasedLengths)).toBe(64);
    expect(lowercasedLengths).not.toContain(4_096);
    expect(label?.textContent).toMatch(/^x+\.\.\. 30 x 40$/);
    expect(label?.textContent.length).toBeLessThanOrEqual(180);
  });

  it("owns generated text descendants and fails closed for foreign or hostile nodes", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const overlay = environment.createOverlay();
    overlay.show(element, environment.identity);
    environment.animation.flush();
    const label = findElements(environment.document).find(
      (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
    );
    const labelText = label?.firstChild;
    if (!label || !labelText) throw new Error("expected label text node");
    const otherDocument = new FakeDocument();
    const foreignText = new FakeText(otherDocument, "foreign");
    const hostileNode = new Proxy({} as Node, {
      get: (_target, property) => {
        if (property === "ownerDocument") return environment.document;
        if (property === "parentNode") throw new Error("parent unavailable");
        return undefined;
      },
    });

    expect(overlay.ownsNode(labelText as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(foreignText as unknown as Node)).toBe(false);
    foreignText.parentNode = label;
    expect(overlay.ownsNode(foreignText as unknown as Node)).toBe(false);
    expect(() => overlay.ownsNode(hostileNode)).not.toThrow();
    expect(overlay.ownsNode(hostileNode)).toBe(false);

    overlay.clear();
    expect(overlay.ownsNode(labelText as unknown as Node)).toBe(true);
  });

  it("restores retained host and root authority before publishing without duplicates", () => {
    const environment = createEnvironment();
    const overlay = environment.createOverlay();
    const host = findOverlayHost(environment.document);
    const shadowRoot = host.attachedShadowRoot!;
    const root = shadowRoot.firstChild as FakeElement;
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });
    element.onGetBoundingClientRect = () => {
      host.remove();
      root.remove();
    };

    overlay.show(element, environment.identity);
    expect(() => environment.animation.flush()).not.toThrow();

    expect(host.parentNode).toBe(environment.document.documentElement);
    expect(root.parentNode).toBe(shadowRoot);
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(1);
    expect(environment.document.createdElements.filter(
      (candidate) => candidate.getAttribute("data-browser2ide-page-overlay") === "",
    )).toEqual([host]);
    expect(overlay.ownsNode(shadowRoot as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(root as unknown as Node)).toBe(true);
  });

  it("restores a host adopted into another document without duplicate active hosts", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const overlay = environment.createOverlay();
    const originalHost = findOverlayHost(environment.document);
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });

    foreignDocument.documentElement.append(originalHost);
    expect(originalHost.ownerDocument).toBe(foreignDocument);

    overlay.show(element, environment.identity);
    environment.animation.flush();

    const activeHosts = findOverlayHosts(environment.document);
    expect(activeHosts).toHaveLength(1);
    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(activeHosts[0]?.ownerDocument).toBe(environment.document);
    expect(activeHosts[0]?.attachedShadowRoot?.ownerDocument).toBe(
      environment.document,
    );
    expect(activeHosts[0]?.attachedShadowRoot?.firstChild?.ownerDocument).toBe(
      environment.document,
    );
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(1);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(1);

    overlay.clear();
    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(
      environment.document.getComputedStyle(activeHosts[0]!).display,
    ).toBe("none");
  });

  it("restores a host adopted during geometry reads before publishing", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const overlay = environment.createOverlay();
    const originalHost = findOverlayHost(environment.document);
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
      onGetBoundingClientRect: () => {
        foreignDocument.documentElement.append(originalHost);
      },
    });

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(findOverlayHosts(environment.document)).toHaveLength(1);
    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([{
      left: "5px",
      top: "6px",
      width: "70px",
      height: "80px",
    }]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(1);
  });

  it("restores an adopted active host during clear and reuses it", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const overlay = environment.createOverlay();
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });
    overlay.show(element, environment.identity);
    environment.animation.flush();
    const host = findOverlayHost(environment.document);
    foreignDocument.documentElement.append(host);

    overlay.clear();

    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(findOverlayHosts(environment.document)).toEqual([host]);
    expect(environment.document.getComputedStyle(host).display).toBe("none");
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);

    overlay.show(element, environment.identity);
    environment.animation.flush();
    expect(findOverlayHosts(environment.document)).toEqual([host]);
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(1);
  });

  it("retires an adopted host when clear-time restoration throws", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const overlay = environment.createOverlay();
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });
    overlay.show(element, environment.identity);
    environment.animation.flush();
    const host = findOverlayHost(environment.document);
    foreignDocument.documentElement.append(host);
    environment.document.documentElement.onAppend = () => {
      throw new Error("restoration rejected");
    };

    expect(() => overlay.clear()).not.toThrow();

    expect(findOverlayHosts(environment.document)).toEqual([]);
    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    overlay.show(element, environment.identity);
    environment.animation.flush();
    expect(findOverlayHosts(environment.document)).toEqual([]);
  });

  it("releases an adopted host when disposal reenters its restoration", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const overlay = environment.createOverlay();
    const originalHost = findOverlayHost(environment.document);
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });
    foreignDocument.documentElement.append(originalHost);
    let disposeReentered = false;
    environment.document.documentElement.onAppend = () => {
      environment.document.documentElement.onAppend = undefined;
      disposeReentered = true;
      overlay.dispose();
    };

    overlay.show(element, environment.identity);
    expect(() => environment.animation.flush()).not.toThrow();

    expect(disposeReentered).toBe(true);
    expect(findOverlayHosts(environment.document)).toEqual([]);
    expect(findOverlayHosts(foreignDocument)).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(environment.animation.pendingCount).toBe(0);
    overlay.show(element, environment.identity);
    environment.animation.flush();
    expect(findOverlayHosts(environment.document)).toEqual([]);
  });

  it.each([
    "client rects throw",
    "computed style throws",
    "translated geometry is non-finite",
    "bounding rect throws",
    "bounding rect is invalid",
    "bounding translation is stale",
  ] as const)("fails closed without stale fragments when %s", (failure) => {
    const environment = createEnvironment();
    const overlay = environment.createOverlay();
    const valid = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    overlay.show(valid, environment.identity);
    environment.animation.flush();
    expect(readAllBoxGeometry(environment.document, "border")).toHaveLength(1);

    const failing = environment.createElement({
      rects: [{ x: 5, y: 6, width: 7, height: 8 }],
      ...(failure === "client rects throw"
        ? { clientRectsError: new Error("rects unavailable") }
        : {}),
      ...(failure === "computed style throws"
        ? { computedStyleError: new Error("style unavailable") }
        : {}),
      ...(failure === "bounding rect throws"
        ? { boundingRectError: new Error("bounds unavailable") }
        : {}),
      ...(failure === "bounding rect is invalid"
        ? { boundingRect: { x: 5, y: 6, width: Number.NaN, height: 8 } }
        : {}),
    });
    if (failure === "translated geometry is non-finite") {
      environment.registry.toTopViewportOverride = () => ({
        x: Number.NaN,
        y: 0,
        left: Number.NaN,
        top: 0,
        right: Number.NaN,
        bottom: 8,
        width: 7,
        height: 8,
      });
    } else if (failure === "bounding translation is stale") {
      environment.registry.toTopViewportOverride = () => undefined;
    }

    overlay.show(failing, environment.identity);

    expect(() => environment.animation.flush()).not.toThrow();
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
  });

  it("clear cancels work and releases listeners, target, fragments, and label", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const overlay = environment.createOverlay();
    overlay.show(element, environment.identity);
    environment.animation.flush();
    environment.document.defaultView.dispatch("scroll");
    expect(environment.animation.pendingCount).toBe(1);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(1);

    overlay.clear();

    expect(environment.animation.pendingCount).toBe(0);
    expect(environment.animation.cancelCount).toBe(1);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(findElements(environment.document).some(
      (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
    )).toBe(false);
    const readsAfterClear = element.clientRectReads;
    environment.document.defaultView.dispatch("scroll");
    environment.animation.flush();
    expect(element.clientRectReads).toBe(readsAfterClear);
    expect(environment.document.documentElement.childNodes).toContain(
      findOverlayHost(environment.document),
    );

    const pendingElement = environment.createElement({
      rects: [{ x: 5, y: 6, width: 7, height: 8 }],
    });
    overlay.show(pendingElement, environment.identity);
    overlay.clear();
    environment.animation.flush();
    expect(pendingElement.clientRectReads).toBe(0);
  });

  it("dispose removes the host, is idempotent, and later methods fail closed", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 30, height: 40 }],
    });
    const overlay = environment.createOverlay();
    overlay.show(element, environment.identity);
    environment.animation.flush();
    const host = findOverlayHost(environment.document);
    const shadowRoot = host.attachedShadowRoot!;
    const ownedLayer = findElementsIn(shadowRoot).find(
      (candidate) => candidate.getAttribute("data-browser2ide-box") === "border",
    )!;
    environment.document.defaultView.dispatch("resize");
    const readsBeforeDispose = element.clientRectReads;

    overlay.dispose();
    overlay.dispose();

    expect(environment.animation.pendingCount).toBe(0);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
    expect(host.parentNode).toBeNull();
    expect(overlay.ownsNode(host as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(shadowRoot as unknown as Node)).toBe(true);
    expect(overlay.ownsNode(ownedLayer as unknown as Node)).toBe(true);

    overlay.show(element, environment.identity);
    overlay.clear();
    environment.document.defaultView.dispatch("scroll");
    environment.animation.flush();
    expect(environment.animation.pendingCount).toBe(0);
    expect(element.clientRectReads).toBe(readsBeforeDispose);
    expect(environment.document.documentElement.childNodes).not.toContain(host);
    expect(environment.document.createdElements.filter(
      (candidate) => candidate.getAttribute("data-browser2ide-page-overlay") === "",
    )).toEqual([host]);
    expect(overlay.ownsNode(element)).toBe(false);
  });

  it.each([
    ["getComputedStyle", "clear"],
    ["getComputedStyle", "dispose"],
    ["getClientRects", "clear"],
    ["getClientRects", "dispose"],
    ["getBoundingClientRect", "clear"],
    ["getBoundingClientRect", "dispose"],
    ["toTopViewport", "clear"],
    ["toTopViewport", "dispose"],
  ] as const)(
    "does not publish stale layers when %s reenters %s",
    (accessPoint, action) => {
      const environment = createEnvironment();
      let overlay!: PageOverlay;
      let reentered = false;
      const reenter = (): void => {
        if (reentered) return;
        reentered = true;
        overlay[action]();
      };
      const element = environment.createElement({
        rects: [{ x: 5, y: 6, width: 70, height: 80 }],
        ...(accessPoint === "getComputedStyle" ? { onComputedStyle: reenter } : {}),
        ...(accessPoint === "getClientRects" ? { onGetClientRects: reenter } : {}),
        ...(accessPoint === "getBoundingClientRect"
          ? { onGetBoundingClientRect: reenter }
          : {}),
      });
      overlay = environment.createOverlay();
      const host = findOverlayHost(environment.document);
      const shadowRoot = host.attachedShadowRoot!;
      if (accessPoint === "toTopViewport") {
        environment.registry.toTopViewportOverride = (_identity, rect) => {
          reenter();
          return topViewportRect(rect);
        };
      }

      overlay.show(element, environment.identity);

      expect(() => environment.animation.flush()).not.toThrow();
      expect(reentered).toBe(true);
      expect(findElementsIn(shadowRoot).filter(
        (candidate) => candidate.getAttribute("data-browser2ide-box") !== null,
      )).toEqual([]);
      expect(findElementsIn(shadowRoot).some(
        (candidate) => candidate.getAttribute("data-browser2ide-label") === "",
      )).toBe(false);
      expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
      expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
      expect(environment.animation.pendingCount).toBe(0);
      environment.document.defaultView.dispatch("scroll");
      environment.animation.flush();
      expect(element.clientRectReads).toBe(accessPoint === "getComputedStyle" ? 0 : 1);
      expect(element.boundingRectReads).toBe(
        accessPoint === "getBoundingClientRect" || accessPoint === "toTopViewport"
          ? 1
          : 0,
      );
    },
  );

  it.each(["invalidate", "clear", "dispose"] as const)(
    "fails closed when final frame validation reenters %s",
    (action) => {
      const environment = createEnvironment();
      const element = environment.createElement({
        rects: [{ x: 5, y: 6, width: 70, height: 80 }],
      });
      let overlay!: PageOverlay;
      let contextReads = 0;
      let finalValidationReached = false;
      overlay = environment.createOverlay();
      environment.registry.onGetContext = () => {
        contextReads += 1;
        if (contextReads !== 3) return;
        finalValidationReached = true;
        if (action === "invalidate") {
          environment.registry.invalidate(environment.identity.frameRef);
        } else {
          overlay[action]();
        }
      };

      overlay.show(element, environment.identity);
      expect(() => environment.animation.flush()).not.toThrow();

      expect(finalValidationReached).toBe(true);
      expect(element.clientRectReads).toBe(1);
      expect(element.boundingRectReads).toBe(1);
      expect(environment.registry.toTopViewportCalls).toHaveLength(1);
      expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
      expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
      expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
      expect(environment.animation.pendingCount).toBe(0);
    },
  );

  it("revalidates the target document after listener collection", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeDocument();
    const element = environment.createElement({
      rects: [{ x: 5, y: 6, width: 70, height: 80 }],
    });
    const overlay = environment.createOverlay({
      getEventTarget: (frameDocument) => {
        element.adoptInto(foreignDocument);
        return (frameDocument as unknown as FakeDocument).defaultView as unknown as EventTarget;
      },
    });

    overlay.show(element, environment.identity);
    expect(() => environment.animation.flush()).not.toThrow();

    expect(element.clientRectReads).toBe(1);
    expect(element.boundingRectReads).toBe(1);
    expect(readAllBoxGeometry(environment.document, "border")).toEqual([]);
    expect(environment.document.defaultView.listenerCount("scroll")).toBe(0);
    expect(environment.document.defaultView.listenerCount("resize")).toBe(0);
  });

  it("keeps sizes finite and nonnegative with negative margins and oversized insets", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 10, y: 20, width: 30, height: 40 }],
      style: {
        marginTop: "-100px",
        marginRight: "-200px",
        marginBottom: "-300px",
        marginLeft: "-400px",
        borderTopWidth: "50px",
        borderRightWidth: "60px",
        borderBottomWidth: "70px",
        borderLeftWidth: "80px",
        paddingTop: "500px",
        paddingRight: "600px",
        paddingBottom: "700px",
        paddingLeft: "800px",
      },
    });
    const overlay = environment.createOverlay();

    overlay.show(element, environment.identity);
    environment.animation.flush();

    expect(readBoxGeometry(environment.document, "margin")).toMatchObject({
      width: "0px",
      height: "0px",
    });
    expect(readBoxGeometry(environment.document, "padding")).toMatchObject({
      width: "0px",
      height: "0px",
    });
    expect(readBoxGeometry(environment.document, "content")).toMatchObject({
      width: "0px",
      height: "0px",
    });
    for (const box of ["margin", "border", "padding", "content"] as const) {
      const geometry = readBoxGeometry(environment.document, box);
      expect(geometry).toBeDefined();
      for (const value of Object.values(geometry!)) {
        expect(value).not.toMatch(/NaN|Infinity/);
      }
      expect(Number.parseFloat(geometry!.width)).toBeGreaterThanOrEqual(0);
      expect(Number.parseFloat(geometry!.height)).toBeGreaterThanOrEqual(0);
    }
  });

  it("cancels a frame handle returned after requestAnimationFrame reenters dispose", () => {
    const environment = createEnvironment();
    const element = environment.createElement({
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
    });
    let overlay!: PageOverlay;
    let queuedCallback: FrameRequestCallback | undefined;
    const cancelled: number[] = [];
    overlay = environment.createOverlay({
      requestAnimationFrame: (callback) => {
        queuedCallback = callback;
        overlay.dispose();
        return 42;
      },
      cancelAnimationFrame: (handle) => cancelled.push(handle),
    });

    overlay.show(element, environment.identity);

    expect(cancelled).toEqual([42]);
    queuedCallback?.(0);
    expect(element.clientRectReads).toBe(0);
    expect(environment.document.documentElement.childNodes.some(
      (node) => node instanceof FakeElement &&
        node.getAttribute("data-browser2ide-page-overlay") === "",
    )).toBe(false);
  });

  it("reschedules the latest target when a reentrant frame request throws", () => {
    const environment = createEnvironment();
    const first = environment.createElement({
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
    });
    const latest = environment.createElement({
      rects: [{ x: 50, y: 60, width: 70, height: 80 }],
    });
    let overlay!: PageOverlay;
    let requests = 0;
    let queuedCallback: FrameRequestCallback | undefined;
    overlay = environment.createOverlay({
      requestAnimationFrame: (callback) => {
        requests += 1;
        if (requests === 1) {
          overlay.show(latest, environment.identity);
          throw new Error("request failed after reentry");
        }
        queuedCallback = callback;
        return requests;
      },
    });

    overlay.show(first, environment.identity);

    expect(requests).toBe(2);
    expect(queuedCallback).toBeDefined();
    queuedCallback?.(0);
    expect(first.clientRectReads).toBe(0);
    expect(latest.clientRectReads).toBe(1);
    expect(readBoxGeometry(environment.document, "border")).toEqual({
      left: "50px",
      top: "60px",
      width: "70px",
      height: "80px",
    });
  });
});

const DEFAULT_STYLE = Object.freeze({
  marginTop: "0px",
  marginRight: "0px",
  marginBottom: "0px",
  marginLeft: "0px",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  paddingTop: "0px",
  paddingRight: "0px",
  paddingBottom: "0px",
  paddingLeft: "0px",
  transform: "none",
  zoom: "1",
  translate: "none",
  rotate: "none",
  scale: "none",
  perspective: "none",
  offsetPath: "none",
  motionPath: "none",
  boxDecorationBreak: "slice",
  display: "inline",
  writingMode: "horizontal-tb",
  direction: "ltr",
});

type BoxSideStyle = typeof DEFAULT_STYLE;

interface RectInit {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ElementInit {
  readonly rects: readonly RectInit[];
  readonly boundingRect?: RectInit;
  readonly style?: Partial<BoxSideStyle>;
  readonly tagName?: string;
  readonly id?: string;
  readonly classes?: readonly string[];
  readonly parentElement?: FakeElement;
  readonly clientRectsError?: Error;
  readonly boundingRectError?: Error;
  readonly computedStyleError?: Error;
  readonly onGetClientRects?: () => void;
  readonly onGetBoundingClientRect?: () => void;
  readonly onComputedStyle?: () => void;
  readonly onOwnerDocumentRead?: () => void;
}

class FakeNode {
  public parentNode: FakeNode | null = null;
  public readonly childNodes: FakeNode[] = [];
  public onOwnerDocumentRead: (() => void) | undefined;
  public onAppend: ((nodes: readonly FakeNode[]) => void) | undefined;
  private ownerDocumentValue: FakeDocument;

  public constructor(ownerDocument: FakeDocument) {
    this.ownerDocumentValue = ownerDocument;
  }

  public get ownerDocument(): FakeDocument {
    this.onOwnerDocumentRead?.();
    return this.ownerDocumentValue;
  }

  public adoptInto(ownerDocument: FakeDocument): void {
    this.ownerDocumentValue = ownerDocument;
    for (const child of this.childNodes) child.adoptInto(ownerDocument);
  }

  public get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  public append(...nodes: FakeNode[]): void {
    for (const node of nodes) {
      node.remove();
      if (node.ownerDocument !== this.ownerDocument) {
        node.adoptInto(this.ownerDocument);
      }
      node.parentNode = this;
      this.childNodes.push(node);
    }
    this.onAppend?.(nodes);
  }

  public replaceChildren(...nodes: FakeNode[]): void {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    this.append(...nodes);
  }

  public remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    if (index >= 0) parent.childNodes.splice(index, 1);
    this.parentNode = null;
  }

  public get isConnected(): boolean {
    let current: FakeNode | null = this;
    while (current?.parentNode) current = current.parentNode;
    return current === this.ownerDocument.documentElement;
  }
}

class FakeElement extends FakeNode {
  public readonly style = createFakeStyleDeclaration();
  public readonly tagName: string;
  public readonly localName: string;
  public id = "";
  public classList: readonly string[] = [];
  public parentElement: FakeElement | null = null;
  public assignedSlot: FakeElement | null = null;
  public shadowRoot: FakeShadowRoot | null = null;
  public attachedShadowRoot: FakeShadowRoot | null = null;
  public rects: readonly RectInit[] = [];
  public boundingRect: RectInit | undefined;
  public computedStyle: BoxSideStyle = DEFAULT_STYLE;
  public computedStyleReads = 0;
  public clientRectReads = 0;
  public boundingRectReads = 0;
  public clientRectsError: Error | undefined;
  public boundingRectError: Error | undefined;
  public computedStyleError: Error | undefined;
  public onGetClientRects: (() => void) | undefined;
  public onGetBoundingClientRect: (() => void) | undefined;
  public onComputedStyle: (() => void) | undefined;
  public innerHtmlReads = 0;
  public innerHtmlWrites = 0;
  private readonly attributes = new Map<string, string>();
  private textContentValue = "";

  public constructor(tagName: string, ownerDocument: FakeDocument) {
    super(ownerDocument);
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
  }

  public attachShadow(init: ShadowRootInit): FakeShadowRoot & ShadowRoot {
    const root = new FakeShadowRoot(this, init.mode);
    this.attachedShadowRoot = root;
    this.shadowRoot = init.mode === "open" ? root : null;
    return root as FakeShadowRoot & ShadowRoot;
  }

  public override adoptInto(ownerDocument: FakeDocument): void {
    super.adoptInto(ownerDocument);
    this.attachedShadowRoot?.adoptInto(ownerDocument);
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public getClientRects(): DOMRectList {
    this.clientRectReads += 1;
    this.onGetClientRects?.();
    if (this.clientRectsError) throw this.clientRectsError;
    return this.rects.map(toDomRect) as unknown as DOMRectList;
  }

  public getRootNode(): FakeDocument {
    return this.ownerDocument;
  }

  public getBoundingClientRect(): DOMRect {
    this.boundingRectReads += 1;
    this.onGetBoundingClientRect?.();
    if (this.boundingRectError) throw this.boundingRectError;
    return toDomRect(this.boundingRect ?? platformBoundingRect(this.rects));
  }

  public get textContent(): string {
    return this.textContentValue;
  }

  public set textContent(value: string) {
    this.textContentValue = value;
    this.replaceChildren();
    if (value !== "") this.append(new FakeText(this.ownerDocument, value));
  }

  public get innerHTML(): string {
    this.innerHtmlReads += 1;
    return "";
  }

  public set innerHTML(_value: string) {
    this.innerHtmlWrites += 1;
  }
}

class FakeText extends FakeNode {
  public constructor(ownerDocument: FakeDocument, public readonly data: string) {
    super(ownerDocument);
  }
}

class FakeShadowRoot extends FakeNode {
  public readonly host: FakeElement;

  public constructor(host: FakeElement, public readonly mode: ShadowRootMode) {
    super(host.ownerDocument);
    this.host = host;
  }
}

class FakeEventSource {
  private readonly listeners = new Map<string, Set<EventListener>>();

  public addEventListener(type: string, listener: EventListener): void {
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set<EventListener>();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  public removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(new Event(type));
    }
  }

  public listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeDocument {
  public readonly documentElement: FakeElement;
  public readonly defaultView = new FakeEventSource();
  public readonly createdElements: FakeElement[] = [];
  private readonly pageImportantStyles = new Map<string, string>();

  public constructor() {
    this.documentElement = new FakeElement("html", this);
  }

  public createElement(tagName: string): HTMLElement {
    const element = new FakeElement(tagName, this);
    this.createdElements.push(element);
    return element as unknown as HTMLElement;
  }

  public setPageImportantStyle(property: string, value: string): void {
    this.pageImportantStyles.set(canonicalStyleProperty(property), value);
  }

  public getComputedStyle(element: FakeElement): {
    readonly pointerEvents: string;
    readonly position: string;
    readonly display: string;
    readonly direction: string;
    readonly unicodeBidi: string;
  } {
    const computed = (property: string, initialValue: string): string => (
      element.style.getComputedValue(
        property,
        initialValue,
        this.pageImportantStyles.get(canonicalStyleProperty(property)),
      )
    );
    return {
      pointerEvents: computed("pointer-events", "auto"),
      position: computed("position", "static"),
      display: computed("display", "inline"),
      direction: computed("direction", "ltr"),
      unicodeBidi: computed("unicode-bidi", "normal"),
    };
  }
}

interface FakeStyleDeclaration extends Record<string, string> {
  getComputedValue(
    property: string,
    initialValue: string,
    pageImportantValue?: string,
  ): string;
  getPropertyPriority(property: string): string;
  getPropertyValue(property: string): string;
  setProperty(property: string, value: string, priority?: string): void;
}

function createFakeStyleDeclaration(): FakeStyleDeclaration {
  interface Declaration {
    readonly value: string;
    readonly order: number;
    readonly priority: string;
  }
  const declarations = new Map<string, Declaration>();
  let order = 0;
  const setDeclaration = (property: string, value: string, priority = ""): void => {
    order += 1;
    declarations.set(canonicalStyleProperty(property), {
      value,
      order,
      priority: priority.toLowerCase() === "important" ? "important" : "",
    });
  };
  return new Proxy({} as FakeStyleDeclaration, {
    get: (_target, property) => {
      if (property === "getComputedValue") {
        return (
          name: string,
          initialValue: string,
          pageImportantValue?: string,
        ): string => {
          const declaration = declarations.get(canonicalStyleProperty(name));
          const all = declarations.get("all");
          const winningInline = !all
            ? declaration
            : !declaration
              ? all
              : declaration.priority !== all.priority
                ? declaration.priority === "important" ? declaration : all
                : declaration.order > all.order ? declaration : all;
          if (pageImportantValue !== undefined && winningInline?.priority !== "important") {
            return pageImportantValue;
          }
          return winningInline?.value === "initial"
            ? initialValue
            : winningInline?.value ?? initialValue;
        };
      }
      if (property === "getPropertyPriority") {
        return (name: string): string => (
          declarations.get(canonicalStyleProperty(name))?.priority ?? ""
        );
      }
      if (property === "getPropertyValue") {
        return (name: string): string => (
          declarations.get(canonicalStyleProperty(name))?.value ?? ""
        );
      }
      if (property === "setProperty") {
        return (name: string, value: string, priority = ""): void => {
          setDeclaration(name, value, priority);
        };
      }
      return typeof property === "string"
        ? declarations.get(canonicalStyleProperty(property))?.value
        : undefined;
    },
    set: (_target, property, value) => {
      if (typeof property !== "string" || typeof value !== "string") return false;
      setDeclaration(property, value);
      return true;
    },
  });
}

function canonicalStyleProperty(property: string): string {
  return property.includes("-")
    ? property.toLowerCase()
    : property.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

class AnimationScheduler {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  public requestCount = 0;
  public cancelCount = 0;

  public readonly requestAnimationFrame = (callback: FrameRequestCallback): number => {
    this.requestCount += 1;
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  public readonly cancelAnimationFrame = (id: number): void => {
    this.cancelCount += 1;
    this.callbacks.delete(id);
  };

  public flush(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(0);
  }

  public get pendingCount(): number {
    return this.callbacks.size;
  }
}

class FakeFrameRegistry {
  public readonly contexts = new Map<string, FrameContext>();
  public readonly toTopViewportCalls: Array<{
    readonly identity: FrameIdentity;
    readonly rect: ViewportRect;
  }> = [];
  public toTopViewportOverride:
    | ((identity: FrameIdentity, rect: ViewportRect) => TopViewportRect | undefined)
    | undefined;
  public onGetContext: (() => void) | undefined;
  private readonly offsets = new Map<string, { readonly x: number; readonly y: number }>();
  private nextFrame = 2;

  public constructor(topDocument: FakeDocument, public readonly identity: FrameIdentity) {
    this.contexts.set(identity.frameRef, Object.freeze({
      ...identity,
      document: topDocument as unknown as Document,
    }));
  }

  public getContext(frameRef: string): FrameContext | undefined {
    this.onGetContext?.();
    return this.contexts.get(frameRef);
  }

  public registerFrame(
    document: FakeDocument,
    offset: { readonly x: number; readonly y: number },
    parentFrameRef = this.identity.frameRef,
  ): FrameIdentity {
    const identity = Object.freeze({
      frameRef: `frame-${this.nextFrame}`,
      frameEpoch: 1,
      documentEpoch: this.identity.documentEpoch,
    });
    this.nextFrame += 1;
    this.contexts.set(identity.frameRef, Object.freeze({
      ...identity,
      document: document as unknown as Document,
      parentFrameRef,
    }));
    this.offsets.set(identity.frameRef, offset);
    return identity;
  }

  public invalidate(frameRef: string): void {
    const context = this.contexts.get(frameRef);
    if (!context) return;
    this.contexts.set(frameRef, Object.freeze({
      ...context,
      frameEpoch: context.frameEpoch + 1,
    }));
  }

  public toTopViewport(
    identity: FrameIdentity,
    rect: ViewportRect,
  ): TopViewportRect | undefined {
    this.toTopViewportCalls.push({ identity, rect: { ...rect } });
    if (this.toTopViewportOverride) {
      return this.toTopViewportOverride(identity, rect);
    }
    const context = this.contexts.get(identity.frameRef);
    if (
      !context ||
      context.frameEpoch !== identity.frameEpoch ||
      context.documentEpoch !== identity.documentEpoch
    ) {
      return undefined;
    }
    let x = rect.x;
    let y = rect.y;
    let current = context;
    const seen = new Set<string>();
    while (current.parentFrameRef) {
      if (seen.has(current.frameRef)) return undefined;
      seen.add(current.frameRef);
      const offset = this.offsets.get(current.frameRef);
      const parent = this.contexts.get(current.parentFrameRef);
      if (!offset || !parent) return undefined;
      x += offset.x;
      y += offset.y;
      current = parent;
    }
    return {
      x,
      y,
      left: x,
      top: y,
      right: x + rect.width,
      bottom: y + rect.height,
      width: rect.width,
      height: rect.height,
    };
  }
}

function createEnvironment(): {
  readonly document: FakeDocument;
  readonly identity: FrameIdentity;
  readonly animation: AnimationScheduler;
  readonly registry: FakeFrameRegistry;
  readonly createElement: (
    init: ElementInit,
    document?: FakeDocument,
  ) => FakeElement & Element;
  readonly createFrame: (init: {
    readonly x: number;
    readonly y: number;
    readonly parentFrameRef?: string;
  }) => { readonly document: FakeDocument; readonly identity: FrameIdentity };
  readonly createOverlay: (options?: Partial<PageOverlayOptions>) => PageOverlay;
} {
  const document = new FakeDocument();
  const identity = Object.freeze({
    frameRef: "frame-1",
    frameEpoch: 1,
    documentEpoch: 0,
  });
  const registry = new FakeFrameRegistry(document, identity);
  const animation = new AnimationScheduler();
  return {
    document,
    identity,
    animation,
    registry,
    createElement: (init, ownerDocument = document) => {
      const element = new FakeElement(init.tagName ?? "div", ownerDocument);
      element.id = init.id ?? "";
      element.classList = init.classes ?? [];
      element.parentElement = init.parentElement ?? null;
      element.rects = init.rects;
      element.boundingRect = init.boundingRect;
      element.clientRectsError = init.clientRectsError;
      element.boundingRectError = init.boundingRectError;
      element.computedStyleError = init.computedStyleError;
      element.onGetClientRects = init.onGetClientRects;
      element.onGetBoundingClientRect = init.onGetBoundingClientRect;
      element.onComputedStyle = init.onComputedStyle;
      element.onOwnerDocumentRead = init.onOwnerDocumentRead;
      element.computedStyle = Object.freeze({ ...DEFAULT_STYLE, ...init.style });
      return element as unknown as FakeElement & Element;
    },
    createFrame: (init) => {
      const frameDocument = new FakeDocument();
      return {
        document: frameDocument,
        identity: registry.registerFrame(
          frameDocument,
          { x: init.x, y: init.y },
          init.parentFrameRef,
        ),
      };
    },
    createOverlay: (options = {}) => new PageOverlay(
      document as unknown as Document,
      registry,
      {
        requestAnimationFrame: animation.requestAnimationFrame,
        cancelAnimationFrame: animation.cancelAnimationFrame,
        getComputedStyle: (element) => (
          (() => {
            const fakeElement = element as unknown as FakeElement;
            fakeElement.computedStyleReads += 1;
            fakeElement.onComputedStyle?.();
            if (fakeElement.computedStyleError) throw fakeElement.computedStyleError;
            return fakeElement.computedStyle as CSSStyleDeclaration;
          })()
        ),
        getViewportSize: () => ({ width: 1024, height: 768 }),
        getEventTarget: (frameDocument) => (
          (frameDocument as unknown as FakeDocument).defaultView as unknown as EventTarget
        ),
        ...options,
      },
    ),
  };
}

function readBoxGeometry(
  document: FakeDocument,
  box: "margin" | "border" | "padding" | "content",
): Record<string, string> | undefined {
  const layer = findElements(document).find(
    (element) => element.getAttribute("data-browser2ide-box") === box,
  );
  return layer
    ? {
        left: layer.style.left,
        top: layer.style.top,
        width: layer.style.width,
        height: layer.style.height,
      }
    : undefined;
}

function readAllBoxGeometry(
  document: FakeDocument,
  box: "margin" | "border" | "padding" | "content",
): Record<string, string>[] {
  return findElements(document)
    .filter((element) => element.getAttribute("data-browser2ide-box") === box)
    .map((element) => ({
      left: element.style.left,
      top: element.style.top,
      width: element.style.width,
      height: element.style.height,
    }));
}

function findElements(document: FakeDocument): FakeElement[] {
  const elements: FakeElement[] = [];
  const visit = (node: FakeNode): void => {
    if (node instanceof FakeElement) {
      elements.push(node);
      if (node.attachedShadowRoot) visit(node.attachedShadowRoot);
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(document.documentElement);
  return elements;
}

function findOverlayHost(document: FakeDocument): FakeElement {
  const host = findOverlayHosts(document)[0];
  if (!host) throw new Error("expected overlay host");
  return host;
}

function findOverlayHosts(document: FakeDocument): FakeElement[] {
  return findElements(document).filter(
    (element) => element.getAttribute("data-browser2ide-page-overlay") === "",
  );
}

function findElementsIn(root: FakeNode): FakeElement[] {
  const elements: FakeElement[] = [];
  const visit = (node: FakeNode): void => {
    if (node instanceof FakeElement) elements.push(node);
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  return elements;
}

function toDomRect(rect: RectInit): DOMRect {
  return {
    ...rect,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    toJSON: () => ({}),
  } as DOMRect;
}

function platformBoundingRect(rects: readonly RectInit[]): RectInit {
  const nonEmpty = rects.filter((rect) => rect.width !== 0 && rect.height !== 0);
  if (nonEmpty.length === 0) {
    const first = rects[0];
    return first
      ? { x: first.x, y: first.y, width: 0, height: 0 }
      : { x: 0, y: 0, width: 0, height: 0 };
  }
  const left = Math.min(...nonEmpty.map((rect) => rect.x));
  const top = Math.min(...nonEmpty.map((rect) => rect.y));
  const right = Math.max(...nonEmpty.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...nonEmpty.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function topViewportRect(rect: ViewportRect): TopViewportRect {
  return {
    x: rect.x,
    y: rect.y,
    left: rect.x,
    top: rect.y,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
    width: rect.width,
    height: rect.height,
  };
}
