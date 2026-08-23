import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type {
  InspectorNodeSnapshot,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "../src/contracts.js";
import { ElementsTreeOutline } from "../src/chromium/dom/ElementsTreeOutline.js";
import { ElementsInspectorView } from "../src/elementsInspectorView.js";
import { elementsSession, withTextValue } from "./fixtures/elementsSession.js";
import { FakeDocument, type FakeElement } from "./support/fakeDocument.js";
import { FakeElementsBackend } from "./support/fakeElementsBackend.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

describe("ElementsTreeOutline", () => {
  it("renders Chromium DOM syntax for doctypes and structured node kinds", () => {
    const tree = presentation([
      nodeRow("simple-doctype", 0, {
        kind: "document-type",
        nodeType: 10,
        nodeName: "html",
        attributes: [],
        childCount: 0,
        relationship: "dom",
        selectable: false,
        expandable: false,
        branchRevision: 0,
      }),
      nodeRow("public-doctype", 0, {
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
      nodeRow("system-doctype", 0, {
        kind: "document-type",
        nodeType: 10,
        nodeName: "html",
        systemId: "about:legacy-compat",
        attributes: [],
        childCount: 0,
        relationship: "dom",
        selectable: false,
        expandable: false,
        branchRevision: 0,
      }),
      nodeRow("leading-comment", 0, displayNode("comment", "#comment", "before html")),
      nodeRow("html", 0, elementNode("HTML", [
        { name: "lang", value: "en" },
        { name: "data-page", value: "<unsafe>" },
      ]), { expanded: true, expandable: true }),
      nodeRow("text", 1, displayNode("text", "#text", "Hello <world>"), {
        parentRef: "html",
      }),
      nodeRow("shadow", 1, {
        kind: "shadow-root",
        nodeType: 11,
        nodeName: "#shadow-root",
        nodeValue: "hostile-mode",
        attributes: [],
        childCount: 1,
        relationship: "shadow-root",
        selectable: false,
        expandable: true,
        branchRevision: 2,
      }, { parentRef: "html", expanded: true, expandable: true }),
      nodeRow("frame-document", 1, {
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
      }, { parentRef: "html" }),
      nodeRow("trailing-comment", 0, displayNode("comment", "#comment", "after html")),
    ]);
    const harness = createOutline(tree);

    expect(tokenTexts(harness.root, ".webkit-html-doctype")).toEqual([
      "<!DOCTYPE html>",
      "<!DOCTYPE html PUBLIC \"-//W3C//DTD HTML 4.01//EN\" \"https://www.w3.org/TR/html4/strict.dtd\">",
      "<!DOCTYPE html SYSTEM \"about:legacy-compat\">",
    ]);
    expect(tokenTexts(harness.root, ".webkit-html-tag-name")).toContain("html");
    expect(tokenTexts(harness.root, ".webkit-html-attribute-name")).toEqual([
      "lang",
      "data-page",
    ]);
    expect(tokenTexts(harness.root, ".webkit-html-attribute-value")).toEqual([
      "en",
      "<unsafe>",
    ]);
    expect(tokenTexts(harness.root, ".webkit-html-text-node")).toEqual([
      "Hello <world>",
    ]);
    expect(row(harness.root, "text").textContent).toContain('"Hello <world>"');
    expect(tokenTexts(harness.root, ".webkit-html-comment")).toEqual([
      "<!--before html-->",
      "<!--after html-->",
    ]);
    expect(tokenTexts(harness.root, ".webkit-html-fragment")).toEqual([
      "#shadow-root (open)",
    ]);
    expect(tokenTexts(harness.root, ".webkit-html-frame-document")).toEqual([
      "#document (inaccessible)",
    ]);
    expect(harness.document.innerHTMLAssignments()).toBe(0);
    expect(harness.root.querySelector("script, style")).toBeNull();
  });

  it("interprets producer-realistic empty doctype identifiers", () => {
    const harness = createOutline(presentation([
      nodeRow("empty-identifiers", 0, doctypeNode("", "")),
      nodeRow("system-only", 0, doctypeNode("", "about:legacy-compat")),
      nodeRow("public-only", 0, doctypeNode("-//PIN-OP//DTD TEST//EN", "")),
      nodeRow("public-system", 0, doctypeNode(
        "-//PIN-OP//DTD TEST//EN",
        "https://example.test/test.dtd",
      )),
    ]));

    expect(tokenTexts(harness.root, ".webkit-html-doctype")).toEqual([
      "<!DOCTYPE html>",
      "<!DOCTYPE html SYSTEM \"about:legacy-compat\">",
      "<!DOCTYPE html PUBLIC \"-//PIN-OP//DTD TEST//EN\">",
      "<!DOCTYPE html PUBLIC \"-//PIN-OP//DTD TEST//EN\" \"https://example.test/test.dtd\">",
    ]);
  });

  it("does not fabricate closing tags for HTML void leaves", () => {
    const harness = createOutline(presentation([
      nodeRow("image", 0, elementNode("IMG", [{ name: "src", value: "safe.png" }])),
      nodeRow("input", 0, elementNode("INPUT", [{ name: "type", value: "text" }])),
    ]));

    expect(row(harness.root, "image").textContent).toBe('<img src="safe.png">');
    expect(row(harness.root, "input").textContent).toBe('<input type="text">');
    expect(harness.root.querySelectorAll(".webkit-html-close-tag-name")).toHaveLength(0);
  });

  it("integrates the Chromium-derived renderer into ElementsInspectorView", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(elementsSession.tree);
    document.body.append(mount);

    const view = new ElementsInspectorView(
      document.document,
      mount as unknown as HTMLElement,
      backend,
    );

    expect(view.domRoot.querySelector(".webkit-html-doctype")?.textContent).toContain(
      "<!DOCTYPE html PUBLIC",
    );
    expect(view.domRoot.querySelector(".webkit-html-tag-name")?.textContent).toBe("html");
    expect(view.domRoot.querySelector(".webkit-html-comment")?.textContent).toContain(
      "fixture comment",
    );
  });

  it("expands and collapses only through disclosure clicks", async () => {
    const harness = createOutline(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expandable: true,
        expanded: false,
        focused: true,
      }),
    ]));
    const disclosure = required(harness.root.querySelector('[data-action="toggle"]'));

    const expandEvent = harness.root.dispatch("click", { target: disclosure });
    await settle();
    expect(expandEvent.defaultPrevented).toBe(true);
    expect(harness.backend.focused).toEqual(["root"]);
    expect(harness.backend.expanded).toEqual(["root"]);
    expect(harness.backend.collapsed).toEqual([]);

    harness.backend.publish(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expandable: true,
        expanded: true,
        focused: true,
      }),
    ]));
    const updatedDisclosure = required(harness.root.querySelector('[data-action="toggle"]'));
    harness.root.dispatch("click", { target: updatedDisclosure });

    expect(harness.backend.collapsed).toEqual(["root"]);
  });

  it("implements Chromium tree keyboard navigation and expansion semantics", async () => {
    const harness = createOutline(navigationTree());

    expect(focusedRef(harness.root)).toBe("root");

    dispatchKey(harness.root, "ArrowDown");
    expect(focusedRef(harness.root)).toBe("first");
    expect(harness.backend.focused).toEqual(["first"]);
    expect(harness.document.activeElement() === row(harness.root, "first")).toBe(true);

    dispatchKey(harness.root, "ArrowRight");
    await settle();
    expect(harness.backend.expanded).toEqual(["first"]);

    harness.backend.publish(navigationTree({ firstExpanded: true, focusedRef: "first" }));
    dispatchKey(harness.root, "ArrowRight");
    expect(focusedRef(harness.root)).toBe("grandchild");
    expect(harness.backend.focused).toEqual(["first", "grandchild"]);
    expect(harness.document.activeElement() === row(harness.root, "grandchild")).toBe(true);

    dispatchKey(harness.root, "ArrowLeft");
    expect(focusedRef(harness.root)).toBe("first");
    expect(harness.backend.focused).toEqual(["first", "grandchild", "first"]);

    dispatchKey(harness.root, "ArrowLeft");
    expect(harness.backend.collapsed).toEqual(["first"]);

    dispatchKey(harness.root, "End");
    expect(focusedRef(harness.root)).toBe("last");
    expect(harness.backend.focused.at(-1)).toBe("last");

    dispatchKey(harness.root, "ArrowUp");
    expect(focusedRef(harness.root)).toBe("grandchild");
    expect(harness.backend.focused.at(-1)).toBe("grandchild");

    dispatchKey(harness.root, "Home");
    expect(focusedRef(harness.root)).toBe("root");
    expect(harness.backend.focused.at(-1)).toBe("root");
    expect(harness.document.activeElement() === row(harness.root, "root")).toBe(true);
  });

  it("selects inspectable rows with Enter and Space while deduplicating in-flight selection", async () => {
    const backend = new DeferredCommandBackend(presentation([
      nodeRow("button", 0, elementNode("BUTTON"), { focused: true }),
    ]));
    const harness = createOutlineWithBackend(backend);

    dispatchKey(harness.root, "Enter");
    dispatchKey(harness.root, "Space");
    expect(backend.selectAttempts).toBe(1);

    backend.settleAll();
    await settle();
    dispatchKey(harness.root, "Space");
    expect(backend.selectAttempts).toBe(2);
  });

  it("restores local focus across mutation rerenders and falls back deterministically", () => {
    const harness = createOutline(navigationTree());
    dispatchKey(harness.root, "ArrowDown");
    expect(focusedRef(harness.root)).toBe("first");

    harness.backend.publish(navigationTree({
      firstName: "SECTION",
      focusedRef: "first",
    }));
    expect(focusedRef(harness.root)).toBe("first");
    expect(harness.document.activeElement() === row(harness.root, "first")).toBe(true);
    expect(row(harness.root, "first").querySelector(".webkit-html-tag-name")?.textContent).toBe(
      "section",
    );

    harness.backend.publish(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expanded: true,
        expandable: true,
        focused: true,
      }),
      nodeRow("last", 1, elementNode("FOOTER"), { parentRef: "root" }),
    ]));
    expect(focusedRef(harness.root)).toBe("root");
    expect(harness.document.activeElement() === row(harness.root, "root")).toBe(true);
  });

  it("loads another bounded page from the lazy service row", async () => {
    const harness = createOutline(elementsSession.tree);
    const loadMore = row(harness.root, "load-more:lazy-main");

    expect(loadMore.textContent).toBe("Load more");
    const event = harness.root.dispatch("click", { target: loadMore });
    await settle();

    expect(event.defaultPrevented).toBe(true);
    expect(harness.backend.loadedMore).toEqual(["lazy-main"]);
    expect(harness.backend.focused).toEqual(["load-more:lazy-main"]);

    dispatchKey(harness.root, "Enter");
    await settle();
    dispatchKey(harness.root, "ArrowRight");
    await settle();
    expect(harness.backend.loadedMore).toEqual([
      "lazy-main",
      "lazy-main",
      "lazy-main",
    ]);
  });

  it("selects only selectable node rows", async () => {
    const harness = createOutline(elementsSession.tree);

    harness.root.dispatch("click", { target: row(harness.root, "body") });
    harness.root.dispatch("click", { target: row(harness.root, "intro-text") });
    harness.root.dispatch("click", { target: row(harness.root, "inaccessible-frame-document") });
    await settle();

    expect(harness.backend.selected).toEqual(["body"]);
    expect(harness.backend.focused).toEqual([
      "body",
      "intro-text",
      "inaccessible-frame-document",
    ]);
    expect(focusedRef(harness.root)).toBe("inaccessible-frame-document");
    expect(
      harness.document.activeElement() === row(harness.root, "inaccessible-frame-document"),
    ).toBe(true);
  });

  it("focuses document-type and comment rows without selecting them", async () => {
    const harness = createOutline(presentation([
      nodeRow("doctype", 0, doctypeNode("", ""), { focused: true }),
      nodeRow("comment", 0, displayNode("comment", "#comment", "display only")),
    ]));

    harness.root.dispatch("click", { target: row(harness.root, "doctype") });
    harness.root.dispatch("click", { target: row(harness.root, "comment") });
    await settle();

    expect(harness.backend.focused).toEqual(["doctype", "comment"]);
    expect(harness.backend.selected).toEqual([]);
  });

  it("forwards pointer hover and clear without making display rows authoritative", () => {
    const harness = createOutline(elementsSession.tree);

    harness.root.dispatch("pointermove", { target: row(harness.root, "body") });
    harness.root.dispatch("pointermove", { target: row(harness.root, "comment") });
    harness.root.dispatch("pointerleave");

    expect(harness.backend.hovered).toEqual(["body", undefined]);
  });

  it("never selects or hovers an inaccessible row even if its selectable bit is malformed", async () => {
    const inaccessible = nodeRow("inaccessible", 0, {
      kind: "frame-document",
      nodeType: 9,
      nodeName: "#document",
      attributes: [],
      childCount: 0,
      relationship: "frame-document",
      selectable: true,
      expandable: false,
      inaccessible: true,
      branchRevision: 0,
    }, { focused: true });
    const harness = createOutline(presentation([inaccessible]));

    harness.root.dispatch("click", { target: row(harness.root, "inaccessible") });
    harness.root.dispatch("pointermove", { target: row(harness.root, "inaccessible") });
    await settle();

    expect(harness.backend.selected).toEqual([]);
    expect(harness.backend.focused).toEqual(["inaccessible"]);
    expect(harness.backend.hovered).toEqual([]);
  });

  it("clears hover exactly once when its row disappears and once on disposal", () => {
    const harness = createOutline(elementsSession.tree);
    harness.root.dispatch("pointermove", { target: row(harness.root, "body") });

    harness.backend.publish(presentation([
      nodeRow("html", 0, elementNode("HTML"), { focused: true }),
    ]));

    expect(harness.backend.hovered).toEqual(["body", undefined]);

    harness.root.dispatch("pointermove", { target: row(harness.root, "html") });
    harness.outline.dispose();
    harness.outline.dispose();
    expect(harness.backend.hovered).toEqual(["body", undefined, "html", undefined]);
  });

  it("rerenders structured mutation data without evaluating page text", () => {
    const harness = createOutline(elementsSession.tree);

    harness.backend.publish(withTextValue("changed <img src=x onerror=alert(1)>"));

    expect(row(harness.root, "intro-text").querySelector(".webkit-html-text-node")?.textContent).toBe(
      "changed <img src=x onerror=alert(1)>",
    );
    expect(harness.root.querySelector("img")).toBeNull();
    expect(harness.document.createdTags()).not.toContain("img");
    expect(harness.document.innerHTMLAssignments()).toBe(0);
  });

  it("materializes no more than the configured virtual row bound", () => {
    const rows = Array.from({ length: 40 }, (_, index) => (
      nodeRow(`node-${index}`, 0, elementNode(`NODE-${index}`), {
        focused: index === 0,
      })
    ));
    const harness = createOutline(presentation(rows), { maxVisibleRows: 7 });

    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(7);
    expect(harness.root.querySelector('[data-node-ref="node-7"]')).toBeNull();
    expect(harness.root.getAttribute("aria-rowcount")).toBeNull();
    expect(harness.root.getAttribute("data-rendered-row-count")).toBe("7");
    expect(row(harness.root, "node-0").getAttribute("aria-posinset")).toBe("1");
    expect(row(harness.root, "node-0").getAttribute("aria-setsize")).toBe("40");
    expect(row(harness.root, "node-6").getAttribute("aria-posinset")).toBe("7");
    expect(row(harness.root, "node-6").getAttribute("aria-setsize")).toBe("40");
  });

  it("reports sibling-local ARIA positions for nodes and load-more rows", () => {
    const harness = createOutline(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expanded: true,
        expandable: true,
        focused: true,
      }),
      nodeRow("first", 1, elementNode("MAIN"), { parentRef: "root" }),
      nodeRow("second", 1, elementNode("ASIDE"), { parentRef: "root" }),
      {
        type: "load-more",
        nodeRef: "load-more:root",
        parentRef: "root",
        depth: 1,
        expanded: false,
        expandable: false,
        selected: false,
        focused: false,
        hovered: false,
      },
    ]));

    expect(row(harness.root, "root").getAttribute("aria-posinset")).toBe("1");
    expect(row(harness.root, "root").getAttribute("aria-setsize")).toBe("1");
    expect(row(harness.root, "first").getAttribute("aria-posinset")).toBe("1");
    expect(row(harness.root, "first").getAttribute("aria-setsize")).toBe("3");
    expect(row(harness.root, "second").getAttribute("aria-posinset")).toBe("2");
    expect(row(harness.root, "second").getAttribute("aria-setsize")).toBe("3");
    expect(row(harness.root, "load-more:root").getAttribute("aria-posinset")).toBe("3");
    expect(row(harness.root, "load-more:root").getAttribute("aria-setsize")).toBe("3");
  });

  it("navigates the full snapshot and shifts the bounded materialized window", () => {
    const rows = Array.from({ length: 40 }, (_, index) => (
      nodeRow(`node-${index}`, 0, elementNode(`NODE-${index}`), {
        focused: index === 0,
      })
    ));
    const harness = createOutline(presentation(rows), { maxVisibleRows: 7 });

    dispatchKey(harness.root, "End");
    expect(harness.backend.focused).toEqual(["node-39"]);
    expect(focusedRef(harness.root)).toBe("node-39");
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(7);
    expect(harness.root.querySelector('[data-node-ref="node-0"]')).toBeNull();

    dispatchKey(harness.root, "Home");
    expect(harness.backend.focused).toEqual(["node-39", "node-0"]);
    expect(focusedRef(harness.root)).toBe("node-0");

    const boundaryRows = Array.from({ length: 10 }, (_, index) => (
      nodeRow(`boundary-${index}`, 0, elementNode(`BOUNDARY-${index}`), {
        focused: index === 6,
      })
    ));
    harness.backend.publish(presentation(boundaryRows));
    dispatchKey(harness.root, "ArrowDown");
    expect(harness.backend.focused.at(-1)).toBe("boundary-7");
    expect(focusedRef(harness.root)).toBe("boundary-7");
    dispatchKey(harness.root, "ArrowUp");
    expect(harness.backend.focused.at(-1)).toBe("boundary-6");
  });

  it("virtualizes from a real scroll viewport and reaches rows beyond the hard window", async () => {
    const rows = [
      nodeRow("branch", 0, elementNode("HTML"), {
        expanded: true,
        expandable: true,
        focused: true,
      }),
      ...Array.from({ length: 1_000 }, (_, index) => (
        nodeRow(
          `node-${index}`,
          1,
          elementNode(`PAGE-${index};block-size:999999px`),
          { parentRef: "branch" },
        )
      )),
    ];
    const harness = createOutline(presentation(rows), { maxVisibleRows: 7 });
    harness.root.clientHeight = 100;
    harness.root.scrollTop = 12_020;

    harness.root.dispatch("scroll");

    const renderedRows = harness.root.querySelectorAll('[data-row-type="node"]');
    const spacers = harness.root.querySelectorAll('[data-part="virtual-spacer"]');
    expect(renderedRows.length).toBeGreaterThan(0);
    expect(renderedRows.length).toBeLessThanOrEqual(7);
    expect(row(harness.root, "node-600")).toBeDefined();
    expect(row(harness.root, "node-600").getAttribute("aria-posinset")).toBe("601");
    expect(row(harness.root, "node-600").getAttribute("aria-setsize")).toBe("1000");
    expect(focusedRef(harness.root)).toBe("node-600");
    expect(harness.backend.focused.at(-1)).toBe("node-600");
    expect(harness.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(spacers).toHaveLength(2);
    for (const spacer of spacers) {
      expect(spacer.getAttribute("aria-hidden")).toBe("true");
      expect(spacer.getAttribute("role")).toBeNull();
      expect(spacer.getAttribute("data-row-type")).toBeNull();
      expect(spacer.getAttribute("style")).toBeNull();
      expect(spacer.querySelector("[style]")).toBeNull();
    }
    expect(spacers.reduce((sum, spacer) => sum + virtualSpacerRows(spacer), 0)).toBe(
      rows.length - renderedRows.length,
    );

    harness.root.dispatch("click", { target: row(harness.root, "node-600") });
    await settle();
    expect(harness.backend.selected).toEqual(["node-600"]);

    dispatchKey(harness.root, "End");
    expect(focusedRef(harness.root)).toBe("node-999");
    expect(row(harness.root, "node-999")).toBeDefined();
    expect(harness.root.scrollTop).toBeGreaterThan(12_020);
    expect(harness.root.scrollTop).toBeLessThanOrEqual(19_920);

    dispatchKey(harness.root, "Home");
    expect(focusedRef(harness.root)).toBe("branch");
    expect(row(harness.root, "branch")).toBeDefined();
    expect(harness.root.scrollTop).toBe(0);
  });

  it("keeps zero-height and hostile viewport values inside bounded renderer fallbacks", () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => (
      nodeRow(`node-${index}`, 0, elementNode(`NODE-${index}`), {
        focused: index === 0,
      })
    ));
    const harness = createOutline(presentation(rows));
    harness.root.clientHeight = 0;
    harness.root.scrollTop = Number.POSITIVE_INFINITY;

    harness.root.dispatch("scroll");

    const renderedCount = harness.root.querySelectorAll('[data-row-type="node"]').length;
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThanOrEqual(32);
    expect(harness.root.scrollTop).toBeGreaterThanOrEqual(0);
    expect(harness.root.scrollTop).toBeLessThanOrEqual(20_000);
    const spacers = harness.root.querySelectorAll('[data-part="virtual-spacer"]');
    for (const spacer of spacers) {
      expect(spacer.getAttribute("style")).toBeNull();
      expect(spacer.querySelector("[style]")).toBeNull();
    }
    expect(spacers.reduce((sum, spacer) => sum + virtualSpacerRows(spacer), 0)).toBe(
      rows.length - renderedCount,
    );

    harness.root.clientHeight = -100;
    harness.root.scrollTop = Number.NaN;
    harness.root.dispatch("scroll");
    expect(harness.root.scrollTop).toBe(0);
    expect(harness.root.querySelectorAll('[data-row-type="node"]').length).toBeLessThanOrEqual(32);
    expect(harness.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
  });

  it("recomputes the bounded viewport after layout and disconnects resize observation", () => {
    const rows = Array.from({ length: 100 }, (_, index) => (
      nodeRow(`node-${index}`, 0, elementNode(`NODE-${index}`), {
        focused: index === 0,
      })
    ));
    const resize = new TestResizeBoundary();
    const harness = createOutline(presentation(rows), {
      maxVisibleRows: 20,
      resizeObserverFactory: resize.factory,
    });
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(20);
    expect(resize.observed).toHaveLength(1);
    expect(resize.observed[0] === harness.root).toBe(true);

    harness.root.clientHeight = 100;
    resize.notify();
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(9);

    harness.root.clientHeight = 40;
    resize.notify();
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(6);

    harness.root.clientHeight = 200;
    resize.notify();
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(14);
    expect(harness.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    harness.outline.dispose();
    expect(resize.disconnectCalls).toBe(1);
    resize.notify();
    expect(harness.root.children).toHaveLength(0);
    expect(resize.disconnectCalls).toBe(1);
  });

  it("disconnects a resize observer whose initial observe call aborts construction", () => {
    const document = new FakeDocument();
    const mount = document.createElement("main") as unknown as FakeElement;
    const backend = new FakeElementsBackend(presentation([
      nodeRow("root", 0, elementNode("HTML"), { focused: true }),
    ]));
    const resize = new TestResizeBoundary(new Error("observe failed"));
    document.body.append(mount);

    expect(() => new ElementsTreeOutline(
      document.document,
      mount as unknown as HTMLElement,
      backend,
      { resizeObserverFactory: resize.factory },
    )).toThrow("observe failed");
    expect(resize.disconnectCalls).toBe(1);
    expect(backend.listenerCount()).toBe(0);
    expect(document.totalListeners()).toBe(0);
    expect(mount.children).toHaveLength(0);
  });

  it("reveals an off-window child with ArrowRight", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, index) => (
        nodeRow(`before-${index}`, 0, elementNode(`BEFORE-${index}`))
      )),
      nodeRow("parent", 0, elementNode("MAIN"), {
        expanded: true,
        expandable: true,
        focused: true,
      }),
      nodeRow("off-window-child", 1, elementNode("BUTTON"), {
        parentRef: "parent",
      }),
    ];
    const harness = createOutline(presentation(rows), { maxVisibleRows: 7 });

    dispatchKey(harness.root, "ArrowRight");

    expect(harness.backend.focused).toEqual(["off-window-child"]);
    expect(focusedRef(harness.root)).toBe("off-window-child");
    expect(harness.root.querySelectorAll('[data-row-type="node"]')).toHaveLength(7);
  });

  it("contains synchronous throws and rejected commands so interactions remain retryable", async () => {
    const backend = new FailingCommandBackend(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expandable: true,
        focused: true,
      }),
      {
        type: "load-more",
        nodeRef: "load-more:root",
        parentRef: "root",
        depth: 1,
        expanded: false,
        expandable: false,
        selected: false,
        focused: false,
        hovered: false,
      },
      nodeRow("button", 0, elementNode("BUTTON")),
    ]));
    const harness = createOutlineWithBackend(backend);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(() => harness.root.dispatch("click", {
        target: required(harness.root.querySelector('[data-action="toggle"]')),
      })).not.toThrow();
      expect(() => harness.root.dispatch("click", {
        target: row(harness.root, "load-more:root"),
      })).not.toThrow();
      expect(() => harness.root.dispatch("click", {
        target: row(harness.root, "button"),
      })).not.toThrow();
    }
    await settle();

    expect(backend.expandAttempts).toBe(2);
    expect(backend.loadMoreAttempts).toBe(2);
    expect(backend.selectAttempts).toBe(2);
  });

  it("deduplicates each bounded in-flight command and permits a settled retry", async () => {
    const backend = new DeferredCommandBackend(presentation([
      nodeRow("root", 0, elementNode("HTML"), {
        expandable: true,
        focused: true,
      }),
      {
        type: "load-more",
        nodeRef: "load-more:root",
        parentRef: "root",
        depth: 1,
        expanded: false,
        expandable: false,
        selected: false,
        focused: false,
        hovered: false,
      },
      nodeRow("button", 0, elementNode("BUTTON")),
    ]));
    const harness = createOutlineWithBackend(backend);
    const disclosure = required(harness.root.querySelector('[data-action="toggle"]'));

    disclosureClick();
    disclosureClick();
    loadMoreClick();
    loadMoreClick();
    selectClick();
    selectClick();

    expect(backend.expandAttempts).toBe(1);
    expect(backend.loadMoreAttempts).toBe(1);
    expect(backend.selectAttempts).toBe(1);

    backend.settleAll();
    await settle();
    disclosureClick();
    loadMoreClick();
    selectClick();

    expect(backend.expandAttempts).toBe(2);
    expect(backend.loadMoreAttempts).toBe(2);
    expect(backend.selectAttempts).toBe(2);

    function disclosureClick(): void {
      harness.root.dispatch("click", { target: disclosure });
    }

    function loadMoreClick(): void {
      harness.root.dispatch("click", { target: row(harness.root, "load-more:root") });
    }

    function selectClick(): void {
      harness.root.dispatch("click", { target: row(harness.root, "button") });
    }
  });

  it("rejects detached rows and aborts actions invalidated by synchronous focus callbacks", async () => {
    const expandBackend = new ReentrantFocusBackend(presentation([
      nodeRow("expand", 0, elementNode("MAIN"), {
        expandable: true,
        focused: true,
      }),
    ]));
    const expandHarness = createOutlineWithBackend(expandBackend);
    expandBackend.beforeFocus = () => expandBackend.publish(presentation([]));
    expandHarness.root.dispatch("click", {
      target: required(expandHarness.root.querySelector('[data-action="toggle"]')),
    });
    await settle();
    expect(expandBackend.expanded).toEqual([]);

    const collapseBackend = new ReentrantFocusBackend(presentation([
      nodeRow("collapse", 0, elementNode("MAIN"), {
        expandable: true,
        expanded: true,
        focused: true,
      }),
    ]));
    const collapseHarness = createOutlineWithBackend(collapseBackend);
    collapseBackend.beforeFocus = () => collapseBackend.publish(presentation([]));
    collapseHarness.root.dispatch("click", {
      target: required(collapseHarness.root.querySelector('[data-action="toggle"]')),
    });
    expect(collapseBackend.collapsed).toEqual([]);

    const disposeBackend = new ReentrantFocusBackend(presentation([
      nodeRow("dispose", 0, elementNode("MAIN"), {
        expandable: true,
        expanded: true,
        focused: true,
      }),
    ]));
    const disposeHarness = createOutlineWithBackend(disposeBackend);
    disposeBackend.beforeFocus = () => disposeHarness.outline.dispose();
    disposeHarness.root.dispatch("click", {
      target: required(disposeHarness.root.querySelector('[data-action="toggle"]')),
    });
    expect(disposeBackend.collapsed).toEqual([]);
    expect(disposeHarness.mount.children).toHaveLength(0);

    const loadBackend = new ReentrantFocusBackend(presentation([
      {
        type: "load-more",
        nodeRef: "load-more:parent",
        parentRef: "parent",
        depth: 1,
        expanded: false,
        expandable: false,
        selected: false,
        focused: true,
        hovered: false,
      },
    ]));
    const loadHarness = createOutlineWithBackend(loadBackend);
    loadBackend.beforeFocus = () => loadBackend.publish(presentation([]));
    loadHarness.root.dispatch("click", {
      target: row(loadHarness.root, "load-more:parent"),
    });
    await settle();
    expect(loadBackend.loadedMore).toEqual([]);

    const selectBackend = new ReentrantFocusBackend(presentation([
      nodeRow("button", 0, elementNode("BUTTON"), { focused: true }),
    ]));
    const selectHarness = createOutlineWithBackend(selectBackend);
    selectBackend.beforeFocus = () => selectBackend.publish(presentation([
      nodeRow("button", 0, elementNode("SECTION"), { focused: true }),
    ]));
    selectHarness.root.dispatch("click", { target: row(selectHarness.root, "button") });
    await settle();
    expect(selectBackend.selected).toEqual([]);

    const detachedRow = row(selectHarness.root, "button");
    selectBackend.publish(presentation([
      nodeRow("button", 0, elementNode("ARTICLE"), { focused: true }),
    ]));
    selectHarness.root.dispatch("click", { target: detachedRow });
    await settle();
    expect(selectBackend.selected).toEqual([]);
    expect(selectBackend.focused).toEqual(["button"]);
  });

  it("continues actions across the controller's equivalent synchronous focus publication", async () => {
    const backend = new FocusPublishingBackend(presentation([
      nodeRow("root", 0, elementNode("MAIN"), {
        expandable: true,
        focused: true,
      }),
      {
        type: "load-more",
        nodeRef: "load-more:root",
        parentRef: "root",
        depth: 1,
        expanded: false,
        expandable: false,
        selected: false,
        focused: false,
        hovered: false,
      },
      nodeRow("button", 0, elementNode("BUTTON")),
    ]));
    const harness = createOutlineWithBackend(backend);

    harness.root.dispatch("click", {
      target: required(harness.root.querySelector('[data-action="toggle"]')),
    });
    harness.root.dispatch("click", { target: row(harness.root, "load-more:root") });
    harness.root.dispatch("click", { target: row(harness.root, "button") });
    await settle();

    expect(backend.expanded).toEqual(["root"]);
    expect(backend.loadedMore).toEqual(["root"]);
    expect(backend.selected).toEqual(["button"]);

    const keyboardBackend = new FocusPublishingBackend(presentation([
      nodeRow("first", 0, elementNode("MAIN"), { focused: true }),
      nodeRow("second", 0, elementNode("SECTION")),
    ]));
    const keyboardHarness = createOutlineWithBackend(keyboardBackend);
    dispatchKey(keyboardHarness.root, "ArrowDown");

    expect(keyboardBackend.focused).toEqual(["second"]);
    expect(focusedRef(keyboardHarness.root)).toBe("second");
    expect(
      keyboardHarness.document.activeElement() === row(keyboardHarness.root, "second"),
    ).toBe(true);
  });

  it("does not continue hover cleanup after focus restoration reentrantly disposes", () => {
    const backend = new ReentrantFocusBackend(elementsSession.tree);
    const harness = createOutlineWithBackend(backend);
    const clearWhileConnected: boolean[] = [];
    backend.afterHover = (nodeRef) => {
      if (nodeRef === undefined) {
        clearWhileConnected.push(harness.mount.contains(harness.root));
      }
    };
    harness.root.dispatch("pointermove", { target: row(harness.root, "body") });
    row(harness.root, "body").focus();
    harness.document.beforeFocus = () => harness.outline.dispose();

    backend.publish(presentation([
      nodeRow("html", 0, elementNode("HTML"), { focused: true }),
    ]));

    expect(backend.hovered).toEqual(["body", undefined]);
    expect(clearWhileConnected).toEqual([true]);
    expect(harness.mount.children).toHaveLength(0);
  });

  it("detaches owned rows and lets pending callbacks release the outline on dispose", async () => {
    const backend = new DeferredCommandBackend(presentation([
      nodeRow("button", 0, elementNode("BUTTON"), { focused: true }),
    ]));
    const harness = createOutlineWithBackend(backend);
    harness.root.dispatch("click", { target: row(harness.root, "button") });
    expect(backend.selectAttempts).toBe(1);

    harness.outline.dispose();
    expect(harness.root.children).toHaveLength(0);
    expect(harness.mount.children).toHaveLength(0);
    expect(harness.document.totalListeners()).toBe(0);

    backend.settleAll();
    await settle();
    expect(harness.mount.children).toHaveLength(0);

    const outlineSource = readFileSync(
      path.join(packageRoot, "src/chromium/dom/ElementsTreeOutline.ts"),
      "utf8",
    );
    expect(outlineSource).not.toMatch(/\(\)\s*=>\s*this\.pendingCommands\.delete/);
  });

  it("exposes core tree ARIA with exactly one roving tabindex target", () => {
    const harness = createOutline(elementsSession.tree);
    const rootRow = row(harness.root, "html");
    const selectedRow = row(harness.root, "body");
    const loadMore = row(harness.root, "load-more:lazy-main");

    expect(harness.root.getAttribute("role")).toBe("tree");
    expect(rootRow.getAttribute("role")).toBe("treeitem");
    expect(rootRow.getAttribute("aria-expanded")).toBe("true");
    expect(rootRow.getAttribute("aria-level")).toBe("1");
    expect(selectedRow.getAttribute("aria-selected")).toBe("true");
    expect(loadMore.getAttribute("role")).toBe("treeitem");
    expect(harness.root.querySelectorAll('[tabindex="0"]')).toHaveLength(1);
    expect(harness.root.querySelectorAll('[tabindex="0"]')[0]).toBe(selectedRow);
  });

  it("contains no editing affordance, mutation command, or unsafe DOM path", () => {
    const harness = createOutline(elementsSession.tree);
    const root = harness.root;

    for (const eventType of [
      "dblclick",
      "contextmenu",
      "beforeinput",
      "input",
      "change",
      "cut",
      "paste",
      "drop",
    ]) {
      root.dispatch(eventType, { target: row(root, "body") });
    }

    expect(root.querySelector("[contenteditable]")).toBeNull();
    expect(root.querySelector("input[type=checkbox]")).toBeNull();
    expect(root.querySelector("input, textarea, select")).toBeNull();
    expect(root.querySelector('[data-action="edit"]')).toBeNull();
    expect(root.querySelector('[data-action="remove"]')).toBeNull();
    expect(root.querySelector('[data-action="set"]')).toBeNull();
    expect(harness.backend.expanded).toEqual([]);
    expect(harness.backend.collapsed).toEqual([]);
    expect(harness.backend.loadedMore).toEqual([]);
    expect(harness.backend.selected).toEqual([]);
    expect(harness.backend.focused).toEqual([]);
    expect(harness.backend.hovered).toEqual([]);
    expect(harness.document.innerHTMLAssignments()).toBe(0);

    const sources = [
      "src/chromium/dom/ElementsTreeOutline.ts",
      "src/chromium/dom/ElementsTreeElement.ts",
    ].map((relativePath) => readFileSync(path.join(packageRoot, relativePath), "utf8"));
    expect(sources.join("\n")).not.toMatch(
      /contentEditable|\b(?:startEditing|removeNode|setNodeValue|toggleHideElement)\s*\(/,
    );
  });

  it("retains scoped Chromium provenance and mandatory display modes", () => {
    const elementSource = readFileSync(
      path.join(packageRoot, "src/chromium/dom/ElementsTreeElement.ts"),
      "utf8",
    );
    const outlineSource = readFileSync(
      path.join(packageRoot, "src/chromium/dom/ElementsTreeOutline.ts"),
      "utf8",
    );
    const css = readFileSync(
      path.join(packageRoot, "assets/devtools-elements.css"),
      "utf8",
    );
    const revision = "a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280";

    for (const [source, upstreamPath] of [
      [elementSource, "front_end/panels/elements/ElementsTreeElement.ts"],
      [outlineSource, "front_end/panels/elements/ElementsTreeOutline.ts"],
      [css, "front_end/panels/elements/elementsTreeOutline.css"],
    ] as const) {
      expect(source).toContain("Copyright");
      expect(source).toContain("BSD-style license");
      expect(source).toContain("Pin-op adaptation");
      expect(source).toContain(upstreamPath);
      expect(source).toContain(revision);
    }
    expect(css).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*320px\)/);
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__tree-row\s*\{[^}]*block-size:\s*20px;[^}]*line-height:\s*16px;/s,
    );
    expect(css).toMatch(
      /\.pin-op-elements-inspector \.pin-op-elements-inspector__tree\s*\{[^}]*padding-block:\s*0;/s,
    );
    for (const variable of [
      "--pin-op-elements-border",
      "--pin-op-elements-hover",
      "--pin-op-elements-token-attribute",
      "--pin-op-elements-token-comment",
      "--pin-op-elements-token-doctype",
      "--pin-op-elements-token-tag",
      "--pin-op-elements-token-text",
      "--pin-op-elements-token-value",
    ]) {
      expect(css).toContain(variable);
    }
  });

  it("removes subscriptions and delegated listeners on dispose", () => {
    const harness = createOutline(elementsSession.tree);
    expect(harness.backend.listenerCount()).toBe(1);
    expect(harness.document.totalListeners()).toBeGreaterThan(0);

    harness.outline.dispose();
    harness.outline.dispose();

    expect(harness.backend.listenerCount()).toBe(0);
    expect(harness.document.totalListeners()).toBe(0);
    expect(harness.mount.children).toHaveLength(0);
  });
});

interface OutlineOptions {
  readonly maxVisibleRows?: number;
  readonly resizeObserverFactory?: (
    callback: () => void,
  ) => {
    observe(target: Element): void;
    disconnect(): void;
  };
}

function createOutline(
  tree: TreePresentationSnapshot,
  options: OutlineOptions = {},
) {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  const backend = new FakeElementsBackend(tree);
  document.body.append(mount);
  const outline = new ElementsTreeOutline(
    document.document,
    mount as unknown as HTMLElement,
    backend,
    options,
  );
  const root = outline.element as unknown as FakeElement;
  return { document, mount, backend, outline, root };
}

function createOutlineWithBackend(backend: FakeElementsBackend) {
  const document = new FakeDocument();
  const mount = document.createElement("main") as unknown as FakeElement;
  document.body.append(mount);
  const outline = new ElementsTreeOutline(
    document.document,
    mount as unknown as HTMLElement,
    backend,
  );
  const root = outline.element as unknown as FakeElement;
  return { document, mount, backend, outline, root };
}

class FailingCommandBackend extends FakeElementsBackend {
  public expandAttempts = 0;
  public loadMoreAttempts = 0;
  public selectAttempts = 0;

  public override expand(_nodeRef: string): Promise<void> {
    this.expandAttempts += 1;
    if (this.expandAttempts === 1) throw new Error("expand sync failure");
    return Promise.reject(new Error("expand async failure"));
  }

  public override loadMore(_parentRef: string): Promise<void> {
    this.loadMoreAttempts += 1;
    if (this.loadMoreAttempts === 1) throw new Error("load sync failure");
    return Promise.reject(new Error("load async failure"));
  }

  public override select(_nodeRef: string): Promise<void> {
    this.selectAttempts += 1;
    if (this.selectAttempts === 1) throw new Error("select sync failure");
    return Promise.reject(new Error("select async failure"));
  }
}

class DeferredCommandBackend extends FakeElementsBackend {
  public expandAttempts = 0;
  public loadMoreAttempts = 0;
  public selectAttempts = 0;
  private pending: Array<() => void> = [];

  public override expand(_nodeRef: string): Promise<void> {
    this.expandAttempts += 1;
    return this.defer();
  }

  public override loadMore(_parentRef: string): Promise<void> {
    this.loadMoreAttempts += 1;
    return this.defer();
  }

  public override select(_nodeRef: string): Promise<void> {
    this.selectAttempts += 1;
    return this.defer();
  }

  public settleAll(): void {
    const pending = this.pending;
    this.pending = [];
    for (const settle of pending) settle();
  }

  private defer(): Promise<void> {
    return new Promise((resolve) => this.pending.push(resolve));
  }
}

class ReentrantFocusBackend extends FakeElementsBackend {
  public beforeFocus: (() => void) | undefined;
  public afterHover: ((nodeRef: string | undefined) => void) | undefined;

  public override focus(nodeRef: string): void {
    super.focus(nodeRef);
    const beforeFocus = this.beforeFocus;
    this.beforeFocus = undefined;
    beforeFocus?.();
  }

  public override hover(nodeRef?: string): void {
    super.hover(nodeRef);
    this.afterHover?.(nodeRef);
  }
}

class FocusPublishingBackend extends FakeElementsBackend {
  private currentSnapshot: TreePresentationSnapshot;

  public constructor(snapshot: TreePresentationSnapshot) {
    super(snapshot);
    this.currentSnapshot = snapshot;
  }

  public override focus(nodeRef: string): void {
    super.focus(nodeRef);
    this.publish(presentation(this.currentSnapshot.rows.map((row) => ({
      ...row,
      focused: row.nodeRef === nodeRef,
    }))));
  }

  public override publish(snapshot: TreePresentationSnapshot): void {
    this.currentSnapshot = snapshot;
    super.publish(snapshot);
  }
}

class TestResizeBoundary {
  public readonly observed: FakeElement[] = [];
  public disconnectCalls = 0;
  private callback: (() => void) | undefined;

  public constructor(private readonly observeError?: Error) {}

  public readonly factory = (callback: () => void) => {
    this.callback = callback;
    return {
      observe: (target: Element): void => {
        if (this.observeError) throw this.observeError;
        this.observed.push(target as unknown as FakeElement);
      },
      disconnect: (): void => {
        this.disconnectCalls += 1;
      },
    };
  };

  public notify(): void {
    this.callback?.();
  }
}

function navigationTree(
  options: {
    readonly firstExpanded?: boolean;
    readonly firstName?: string;
    readonly focusedRef?: string;
  } = {},
): TreePresentationSnapshot {
  const firstExpanded = options.firstExpanded ?? false;
  const focusedRef = options.focusedRef ?? "root";
  return presentation([
    nodeRow("root", 0, elementNode("HTML"), {
      expanded: true,
      expandable: true,
      focused: focusedRef === "root",
    }),
    nodeRow("first", 1, elementNode(options.firstName ?? "MAIN"), {
      parentRef: "root",
      expanded: firstExpanded,
      expandable: true,
      focused: focusedRef === "first",
    }),
    ...(firstExpanded ? [
      nodeRow("grandchild", 2, elementNode("BUTTON"), {
        parentRef: "first",
        focused: focusedRef === "grandchild",
      }),
    ] : []),
    nodeRow("last", 1, elementNode("FOOTER"), {
      parentRef: "root",
      focused: focusedRef === "last",
    }),
  ]);
}

function dispatchKey(root: FakeElement, key: string): void {
  const focused = required(root.querySelector('[data-focused="true"]'));
  const event = root.dispatch("keydown", { key, target: focused });
  expect(event.defaultPrevented).toBe(true);
}

function focusedRef(root: FakeElement): string | null {
  return root.querySelector('[data-focused="true"]')?.getAttribute("data-node-ref") ?? null;
}

function row(root: FakeElement, nodeRef: string): FakeElement {
  return required(root.querySelector(`[data-node-ref="${nodeRef}"]`));
}

function tokenTexts(root: FakeElement, selector: string): string[] {
  return root.querySelectorAll(selector).map((token) => token.textContent);
}

function presentation(rows: readonly TreeRowSnapshot[]): TreePresentationSnapshot {
  return { rows };
}

function elementNode(
  nodeName: string,
  attributes: InspectorNodeSnapshot["attributes"] = [],
): Omit<InspectorNodeSnapshot, "nodeRef"> {
  return {
    kind: "element",
    nodeType: 1,
    nodeName,
    attributes,
    childCount: 1,
    relationship: "dom",
    selectable: true,
    expandable: true,
    branchRevision: 1,
  };
}

function doctypeNode(
  publicId: string,
  systemId: string,
): Omit<InspectorNodeSnapshot, "nodeRef"> {
  return {
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
    branchRevision: 0,
  };
}

function displayNode(
  kind: "text" | "comment",
  nodeName: string,
  nodeValue: string,
): Omit<InspectorNodeSnapshot, "nodeRef"> {
  return {
    kind,
    nodeType: kind === "text" ? 3 : 8,
    nodeName,
    nodeValue,
    attributes: [],
    childCount: 0,
    relationship: "dom",
    selectable: false,
    expandable: false,
    branchRevision: 0,
  };
}

function nodeRow(
  nodeRef: string,
  depth: number,
  node: Omit<InspectorNodeSnapshot, "nodeRef">,
  overrides: Partial<TreeRowSnapshot> = {},
): TreeRowSnapshot {
  return {
    type: "node",
    nodeRef,
    depth,
    expanded: false,
    expandable: false,
    selected: false,
    focused: false,
    hovered: false,
    node: { ...node, nodeRef },
    ...overrides,
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("Missing expected rendered element");
  }
  return value;
}

function virtualSpacerRows(spacer: FakeElement): number {
  return spacer.querySelectorAll("[data-row-span]").reduce((total, chunk) => {
    const span = Number(chunk.getAttribute("data-row-span"));
    expect(Number.isSafeInteger(span)).toBe(true);
    expect(span).toBeGreaterThan(0);
    expect(chunk.className).toContain(`elements-tree-virtual-spacer-chunk--${span}`);
    return total + span;
  }, 0);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
