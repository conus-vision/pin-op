import { describe, expect, it } from "vitest";
import { INSPECT_LIMITS } from "@pin-op/protocol";
import { PinOpRuntimeArtifacts } from "../src/pinOpRuntimeArtifacts.js";

describe("PinOpRuntimeArtifacts", () => {
  it("creates independent session-scoped marker names from injected randomness", () => {
    let seed = 0;
    const artifacts = new PinOpRuntimeArtifacts({
      getRandomValues(bytes) {
        bytes.fill(++seed);
        return bytes;
      },
    });

    expect(artifacts.markerNames).toEqual({
      selection: `data-pin-op-preview-selected-${"01".repeat(16)}`,
      hover: `data-pin-op-preview-hover-${"02".repeat(16)}`,
      focus: `data-pin-op-preview-focus-${"03".repeat(16)}`,
    });
    expect(new Set(Object.values(artifacts.markerNames))).toHaveLength(3);
  });

  it("keeps the observable style marker name private even when page code copies it", () => {
    const artifacts = deterministicArtifacts();
    const runtimeStyle = new FakeElement("style");
    artifacts.registerDetachedStyleNode(runtimeStyle as unknown as HTMLStyleElement);

    expect(artifacts.markStyleNode(runtimeStyle as unknown as HTMLStyleElement))
      .toBe(true);
    const observedName = runtimeStyle.attributes[0]?.name;
    expect(observedName).toMatch(/^data-pin-op-runtime-[0-9a-f]+$/);

    const pageElement = new FakeElement("article");
    pageElement.setAttribute(observedName!, "copied-by-page");

    expect(artifacts.isRuntimeAttributeName(observedName!)).toBe(true);
    expect(artifacts.containsRuntimeMarker(`copied:${observedName!}`)).toBe(true);
    expect(artifacts.containsRuntimeMarker(
      `copied:${artifacts.markerNames.hover}`,
    )).toBe(true);
    expect(artifacts.containsRuntimeMarker("data-page-state")).toBe(false);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(pageElement.getAttribute(observedName!)).toBe("copied-by-page");
    expect(artifacts.isRuntimeAttributeName(observedName!)).toBe(true);
  });

  it("rejects oversized pseudo-state input before scanning duplicate entries", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");
    const oversized = Array.from({ length: 3 }, () => "hover" as const);

    expect(artifacts.setStateMarkers(
      element as unknown as Element,
      oversized,
    )).toBe(false);
    expect(element.attributes).toEqual([]);
  });

  it("snapshots bounded state arrays by index without invoking a hostile iterator", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");
    let iteratorReads = 0;
    const states = new Proxy<Array<"hover" | "focus">>(["hover", "focus"], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error("state iterator must not be used");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(artifacts.setStateMarkers(element as unknown as Element, states))
      .toBe(true);
    expect(iteratorReads).toBe(0);
    expect(element.hasAttribute(artifacts.markerNames.hover)).toBe(true);
    expect(element.hasAttribute(artifacts.markerNames.focus)).toBe(true);
  });

  it("uses trusted attribute intrinsics instead of hostile element own APIs", () => {
    const element = new FakeElement("button");
    const ownerDocument = element.ownerDocument;
    let hostileCalls = 0;
    for (const property of [
      "ownerDocument",
      "getAttributeNode",
      "setAttributeNode",
      "removeAttributeNode",
    ]) {
      Object.defineProperty(element, property, {
        configurable: true,
        get(): never {
          hostileCalls += 1;
          throw new Error(`hostile own ${property}`);
        },
      });
    }
    let seed = 0;
    const artifacts = new PinOpRuntimeArtifacts({
      getRandomValues(bytes) {
        bytes.fill(++seed);
        return bytes;
      },
      testOnlyIntrinsics: {
        read(target, intrinsic) {
          if (intrinsic === "node.ownerDocument") return ownerDocument;
          const property = intrinsic.slice(intrinsic.lastIndexOf(".") + 1);
          return Reflect.get(target, property);
        },
        call(target, intrinsic, args = []) {
          if (intrinsic === "set:attr.value") {
            return Reflect.set(target, "value", args[0]);
          }
          if (intrinsic === "document.createAttribute") {
            return Reflect.apply(ownerDocument.createAttribute, ownerDocument, args);
          }
          const method = intrinsic === "element.getAttributeNode"
            ? FakeElement.prototype.getAttributeNode
            : intrinsic === "element.setAttributeNode"
              ? FakeElement.prototype.setAttributeNode
              : intrinsic === "element.removeAttributeNode"
                ? FakeElement.prototype.removeAttributeNode
                : undefined;
          if (!method) throw new TypeError(`${intrinsic} unavailable`);
          return Reflect.apply(method, target, args as never[]);
        },
      },
    });

    expect(artifacts.setStateMarkers(element as unknown as Element, ["hover"]))
      .toBe(true);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(hostileCalls).toBe(0);
    expect(element.attributes).toEqual([]);
  });

  it("owns exact marker attribute objects and never removes a page replacement", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");

    expect(artifacts.setStateMarkers(
      element as unknown as Element,
      ["hover", "focus"],
    )).toBe(true);
    const ownedHover = element.getAttributeNode(artifacts.markerNames.hover);
    expect(ownedHover).toBeDefined();
    expect(artifacts.ownsAttribute(
      element as unknown as Element,
      artifacts.markerNames.hover,
    )).toBe(true);

    const pageReplacement = element.replaceAttribute(
      artifacts.markerNames.hover,
      "page-owned",
    );
    expect(pageReplacement).not.toBe(ownedHover);

    const cleanup = artifacts.cleanup();

    expect(cleanup.complete).toBe(true);
    expect(element.hasAttribute(artifacts.markerNames.selection)).toBe(false);
    expect(element.hasAttribute(artifacts.markerNames.focus)).toBe(false);
    expect(element.getAttribute(artifacts.markerNames.hover)).toBe("page-owned");
    expect(artifacts.ownsAttribute(
      element as unknown as Element,
      artifacts.markerNames.hover,
    )).toBe(false);
    expect(artifacts.isRuntimeAttributeName(artifacts.markerNames.hover)).toBe(true);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(element.getAttribute(artifacts.markerNames.hover)).toBe("page-owned");
  });

  it("cleans exact state and style marker Attr objects from their current owners", () => {
    const artifacts = deterministicArtifacts();
    const original = new FakeElement("button");
    const currentOwner = new FakeElement("article");
    expect(artifacts.setStateMarkers(
      original as unknown as Element,
      ["hover", "focus"],
    )).toBe(true);
    const movedStateMarkers = [...original.attributes];
    for (const marker of movedStateMarkers) {
      original.removeAttributeNode(marker);
      currentOwner.setAttributeNode(marker);
      original.setAttribute(marker.name, "page-replacement");
    }

    const runtimeStyle = new FakeElement("style");
    artifacts.registerDetachedStyleNode(runtimeStyle as unknown as HTMLStyleElement);
    expect(artifacts.markStyleNode(runtimeStyle as unknown as HTMLStyleElement))
      .toBe(true);
    const styleMarker = runtimeStyle.attributes[0]!;
    runtimeStyle.removeAttributeNode(styleMarker);
    currentOwner.setAttributeNode(styleMarker);

    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(currentOwner.attributes).toEqual([]);
    expect(original.attributes).toEqual(movedStateMarkers.map(({ name }) => ({
      name,
      value: "page-replacement",
      ownerElement: original,
    })));
    expect(runtimeStyle.attributes).toEqual([]);
  });

  it("removes only exact owned nodes and sheets from their current locations", () => {
    const artifacts = deterministicArtifacts();
    const firstParent = new FakeParent();
    const currentParent = new FakeParent();
    const style = new FakeElement("style");
    const attachedSheet = Object.assign(constructableSheet("style-sheet", [{}]), {
      ownerNode: style,
    });
    style.sheet = attachedSheet;
    style.textContent = ".preview { color: red; }";
    firstParent.append(style);
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);
    currentParent.append(style);

    const before = { name: "before" } as unknown as CSSStyleSheet;
    const owned = constructableSheet("owned");
    const after = { name: "after" } as unknown as CSSStyleSheet;
    const concurrent = { name: "concurrent" } as unknown as CSSStyleSheet;
    const root = {
      adoptedStyleSheets: [before, owned, after],
    } as unknown as Document;
    artifacts.registerAdoptedStylesheet(
      root,
      owned,
      [before, after],
    );
    (root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets = [concurrent, before, owned, after];

    const tokenSpoof = new FakeElement("style");
    tokenSpoof.setAttribute("data-pin-op-runtime-artifact", "");
    currentParent.append(tokenSpoof);

    expect(artifacts.isRuntimeNode(style as unknown as Node)).toBe(true);
    expect(artifacts.isRuntimeStylesheet(attachedSheet)).toBe(true);
    expect(artifacts.isRuntimeNode(tokenSpoof as unknown as Node)).toBe(false);
    expect(artifacts.isRuntimeStylesheet(owned)).toBe(true);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(currentParent.children).toEqual([tokenSpoof]);
    expect(style.textContent).toBe("");
    expect((attachedSheet as unknown as { cssRules: readonly object[] }).cssRules)
      .toEqual([]);
    expect((root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual([concurrent, before, after]);
  });

  it("classifies a replacement sheet by exact historical runtime owner identity", () => {
    const artifacts = deterministicArtifacts();
    const style = new FakeElement("style");
    const firstSheet = { ownerNode: style } as unknown as CSSStyleSheet;
    style.sheet = firstSheet;
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);

    const replacementSheet = { ownerNode: style } as unknown as CSSStyleSheet;
    style.sheet = replacementSheet;

    expect(artifacts.isRuntimeStylesheet(replacementSheet)).toBe(true);
    expect(artifacts.isRuntimeStylesheet({ ownerNode: new FakeElement("style") }))
      .toBe(false);
  });

  it("neutralizes an exact adopted mirror before removing it from its owned root", () => {
    const artifacts = deterministicArtifacts();
    const owned = constructableSheet("owned", [{}]);
    const page = constructableSheet("page");
    const ownedRoot = { adoptedStyleSheets: [owned] } as unknown as Document;
    const concurrentRoot = {
      adoptedStyleSheets: [page, owned],
    } as unknown as ShadowRoot;
    artifacts.registerAdoptedStylesheet(ownedRoot, owned, []);

    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect((ownedRoot as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual([]);
    expect((concurrentRoot as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual([page, owned]);
    expect((owned as unknown as { cssRules: readonly object[] }).cssRules)
      .toEqual([]);
  });

  it("retains adopted cleanup authority when exact mirror neutralization is a no-op", () => {
    const artifacts = deterministicArtifacts();
    const owned = constructableSheet("owned", [{}], true);
    const root = { adoptedStyleSheets: [owned] } as unknown as Document;
    artifacts.registerAdoptedStylesheet(root, owned, []);

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect((root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual([owned]);

    (owned as unknown as { noOpReplace: boolean }).noOpReplace = false;
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect((root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual([]);
  });

  it.each(["lossy", "reordered"] as const)(
    "requires an exact adopted cleanup result from a %s setter",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      let current = [before, owned, after];
      let setterMode: "normal" | typeof mode = mode;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          current = setterMode === "lossy"
            ? value.slice(1)
            : setterMode === "reordered"
              ? [...value].reverse()
              : [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
      expect((owned as unknown as { cssRules: readonly object[] }).cssRules)
        .toEqual([]);

      setterMode = "normal";
      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    },
  );

  it.each(["lossy", "reordered"] as const)(
    "retries a one-shot %s adopted cleanup setter and restores the exact page order",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      let current = [before, owned, after];
      let writes = 0;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          writes += 1;
          if (writes === 1) {
            current = mode === "lossy" ? value.slice(1) : [...value].reverse();
            return;
          }
          current = [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
      expect(writes).toBe(2);
      expect(current).toEqual([before, after]);
      expect((owned as unknown as { cssRules: readonly object[] }).cssRules)
        .toEqual([]);
    },
  );

  it.each(["lossy", "reordered"] as const)(
    "retains cleanup authority across a persistent %s adopted setter",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      let current = [before, owned, after];
      let persistent = true;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          current = persistent
            ? mode === "lossy" ? value.slice(1) : [...value].reverse()
            : [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
      persistent = false;
      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
      expect(current).toEqual([before, after]);
    },
  );

  it.each(["lossy", "reordered"] as const)(
    "preserves concurrent adopted changes before retrying a %s cleanup",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      const concurrent = constructableSheet("concurrent");
      let current = [before, owned, after];
      let persistent = true;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          current = persistent
            ? mode === "lossy" ? value.slice(1) : [...value].reverse()
            : [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
      current = mode === "lossy"
        ? [after, concurrent]
        : [before, concurrent, after];
      const concurrentState = [...current];
      persistent = false;

      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
      expect(current).toEqual(concurrentState);
      expect(current).not.toContain(owned);
    },
  );

  it.each(["lossy", "reordered"] as const)(
    "does not stale-restore a %s rollback across concurrent adopted changes",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      const concurrent = constructableSheet("concurrent");
      let current = [before, owned, after];
      let persistent = true;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          current = persistent
            ? mode === "lossy" ? value.slice(1) : [...value].reverse()
            : [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.rollbackAdoptedStylesheet(
        root,
        owned,
        [before, after],
      )).toBe(false);
      current = mode === "lossy"
        ? [after, concurrent]
        : [after, before, concurrent];
      const concurrentState = [...current];
      persistent = false;

      expect(artifacts.rollbackAdoptedStylesheet(
        root,
        owned,
        [before, after],
      )).toBe(false);
      expect(current).toEqual(concurrentState);
      expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
      expect(current).toEqual(concurrentState);
      expect(current).not.toContain(owned);

      current = [before, after];
      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
      expect(current).toEqual([before, after]);
    },
  );

  it("does not retry an unobserved failed rollback after page state changes", () => {
    const artifacts = deterministicArtifacts();
    const before = constructableSheet("before");
    const owned = constructableSheet("owned", [{}]);
    const after = constructableSheet("after");
    const concurrent = constructableSheet("concurrent");
    let current = [before, owned, after];
    let readable = true;
    let normalWrites = false;
    let writes = 0;
    const root = {} as Document;
    Object.defineProperty(root, "adoptedStyleSheets", {
      configurable: true,
      get() {
        if (!readable) throw new Error("post-write list unavailable");
        return current;
      },
      set(value: CSSStyleSheet[]) {
        writes += 1;
        current = normalWrites ? [...value] : value.slice(1);
        if (!normalWrites) readable = false;
      },
    });
    artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

    expect(artifacts.rollbackAdoptedStylesheet(
      root,
      owned,
      [before, after],
    )).toBe(false);
    current = [after, concurrent];
    readable = true;
    normalWrites = true;
    const writesAfterFailure = writes;

    expect(artifacts.rollbackAdoptedStylesheet(
      root,
      owned,
      [before, after],
    )).toBe(false);
    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect(writes).toBe(writesAfterFailure);
    expect(current).toEqual([after, concurrent]);

    current = [before, after];
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
  });

  it.each(["unique", "duplicate"] as const)(
    "preserves a %s page occurrence injected by a failed cleanup setter",
    (mode) => {
      const artifacts = deterministicArtifacts();
      const before = constructableSheet("before");
      const owned = constructableSheet("owned", [{}]);
      const after = constructableSheet("after");
      const concurrent = constructableSheet("concurrent");
      let current = [before, owned, after];
      let writes = 0;
      const root = {} as Document;
      Object.defineProperty(root, "adoptedStyleSheets", {
        configurable: true,
        get: () => current,
        set(value: CSSStyleSheet[]) {
          writes += 1;
          current = writes === 1
            ? [...value, mode === "unique" ? concurrent : after]
            : [...value];
        },
      });
      artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

      expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
      expect(writes).toBe(1);
      expect(current).toEqual([
        before,
        after,
        mode === "unique" ? concurrent : after,
      ]);
      expect(current).not.toContain(owned);
    },
  );

  it("stops a rollback when its failed setter injects a concurrent sheet", () => {
    const artifacts = deterministicArtifacts();
    const before = constructableSheet("before");
    const owned = constructableSheet("owned", [{}]);
    const after = constructableSheet("after");
    const concurrent = constructableSheet("concurrent");
    let current = [before, owned, after];
    let writes = 0;
    const root = {} as Document;
    Object.defineProperty(root, "adoptedStyleSheets", {
      configurable: true,
      get: () => current,
      set(value: CSSStyleSheet[]) {
        writes += 1;
        current = writes === 1 ? [...value, concurrent] : [...value];
      },
    });
    artifacts.registerAdoptedStylesheet(root, owned, [before, after]);

    expect(artifacts.rollbackAdoptedStylesheet(
      root,
      owned,
      [before, after],
    )).toBe(false);
    expect(writes).toBe(1);
    expect(current).toEqual([before, after, concurrent]);
    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect(writes).toBe(1);
    expect(current).toEqual([before, after, concurrent]);

    current = [before, after];
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
  });

  it("retains adopted cleanup authority when the current list exceeds its exact scan cap", () => {
    const artifacts = deterministicArtifacts();
    const owned = constructableSheet("owned");
    const pageSheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets * 2 },
      () => ({}) as CSSStyleSheet,
    );
    const root = {
      adoptedStyleSheets: [owned, ...pageSheets],
    } as unknown as Document;
    artifacts.registerAdoptedStylesheet(root, owned, pageSheets);

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect((root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets[0]).toBe(owned);

    (root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets = [owned, ...pageSheets.slice(0, 2)];
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect((root as unknown as { adoptedStyleSheets: CSSStyleSheet[] })
      .adoptedStyleSheets).toEqual(pageSheets.slice(0, 2));
  });

  it("snapshots the public adopted previous-list boundary without using its iterator", () => {
    const artifacts = deterministicArtifacts();
    const owned = constructableSheet("owned");
    const root = { adoptedStyleSheets: [owned] } as unknown as Document;
    let iteratorReads = 0;
    const previous = new Proxy<CSSStyleSheet[]>([], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error("previous-list iterator must not be used");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });

    expect(() => artifacts.registerAdoptedStylesheet(root, owned, previous))
      .not.toThrow();
    expect(iteratorReads).toBe(0);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });

    const oversized = Array.from(
      { length: INSPECT_LIMITS.stylesheets * 2 + 1 },
      () => ({}) as CSSStyleSheet,
    );
    const rejected = {} as CSSStyleSheet;
    expect(() => artifacts.registerAdoptedStylesheet(root, rejected, oversized))
      .toThrow();
    expect(artifacts.isRuntimeStylesheet(rejected)).toBe(false);
  });

  it("fails closed around hostile predicates and retains failed cleanup ownership", () => {
    const artifacts = deterministicArtifacts();
    const hostile = new Proxy({}, {
      get() {
        throw new Error("hostile page object");
      },
    });
    expect(artifacts.isRuntimeNode(hostile as Node)).toBe(false);
    expect(() => artifacts.isRuntimeStylesheet(hostile as CSSStyleSheet)).toThrow();

    const owned = constructableSheet("owned");
    const root = {} as Document;
    Object.defineProperty(root, "adoptedStyleSheets", {
      configurable: true,
      get: () => [owned],
      set: () => {
        throw new Error("assignment rejected");
      },
    });
    artifacts.registerAdoptedStylesheet(root, owned, []);

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect(artifacts.isRuntimeStylesheet(owned)).toBe(true);
  });

  it("retains an exact marker attribute when cleanup throws and removes it on retry", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");
    expect(artifacts.setStateMarkers(element as unknown as Element, ["hover"]))
      .toBe(true);
    element.rejectAttributeRemoval = true;

    expect(artifacts.cleanup()).toMatchObject({ complete: false, failureCount: 2 });
    expect(artifacts.ownsAttribute(
      element as unknown as Element,
      artifacts.markerNames.selection,
    )).toBe(true);

    element.rejectAttributeRemoval = false;
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(element.attributes).toEqual([]);
  });

  it("retains exact marker attributes when removeAttributeNode is a no-op", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");
    expect(artifacts.setStateMarkers(element as unknown as Element, ["hover"]))
      .toBe(true);
    element.noOpAttributeRemoval = true;

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 2 });
    expect(element.attributes).toHaveLength(2);
    expect(artifacts.ownsAttribute(
      element as unknown as Element,
      artifacts.markerNames.selection,
    )).toBe(true);

    element.noOpAttributeRemoval = false;
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(element.attributes).toEqual([]);
  });

  it("retains exact marker cleanup authority while its current owner is unreadable", () => {
    const artifacts = deterministicArtifacts();
    const element = new FakeElement("button");
    expect(artifacts.setStateMarkers(element as unknown as Element, ["hover"]))
      .toBe(true);
    element.rejectFutureAttributeReads();

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 2 });
    expect(element.attributes).toHaveLength(2);

    element.allowAttributeReads();
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
  });

  it("retains an exact style node when a hostile remove method is a no-op", () => {
    const artifacts = deterministicArtifacts();
    const parent = new FakeParent();
    const style = new FakeElement("style");
    const ownedSheet = Object.assign(constructableSheet("style", [{}]), {
      ownerNode: style,
    });
    style.sheet = ownedSheet;
    style.textContent = ".preview { color: red; }";
    style.noOpRemove = true;
    parent.append(style);
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect(parent.children).toEqual([style]);
    expect(style.textContent).toBe("");
    expect((ownedSheet as unknown as { cssRules: readonly object[] }).cssRules)
      .toEqual([]);

    style.noOpRemove = false;
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(parent.children).toEqual([]);
  });

  it("leaves a retained exact style reference inert after successful cleanup and reattach", () => {
    const artifacts = deterministicArtifacts();
    const parent = new FakeParent();
    const reattachParent = new FakeParent();
    const style = new FakeElement("style");
    const ownedSheet = Object.assign(constructableSheet("style", [{}]), {
      ownerNode: style,
    });
    style.sheet = ownedSheet;
    style.textContent = ".preview { color: red; }";
    parent.append(style);
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);

    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    reattachParent.append(style);

    expect(style.textContent).toBe("");
    expect((ownedSheet as unknown as { cssRules: readonly object[] }).cssRules)
      .toEqual([]);
    expect(reattachParent.children).toEqual([style]);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(reattachParent.children).toEqual([style]);
  });

  it("cleans the current owner-backed sheet after STYLE sheet identity rotation", () => {
    const artifacts = deterministicArtifacts();
    const parent = new FakeParent();
    const reattachParent = new FakeParent();
    const style = new FakeElement("style");
    const oldRules = [{}];
    const oldSheet = {
      ownerNode: style,
      cssRules: oldRules,
      replaceSync(): never {
        throw new Error("owner-backed old sheet cannot be replaced directly");
      },
    } as unknown as CSSStyleSheet;
    const currentSheet = {
      ownerNode: style,
      cssRules: [] as readonly object[],
    } as unknown as CSSStyleSheet;
    let text = ".preview { color: red; }";
    style.sheet = oldSheet;
    Object.defineProperty(style, "textContent", {
      configurable: true,
      get: () => text,
      set(value: string) {
        text = value;
        if (value === "") {
          (oldSheet as unknown as { ownerNode: FakeElement | null }).ownerNode = null;
          style.sheet = currentSheet;
        }
      },
    });
    parent.append(style);
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);

    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(parent.children).toEqual([]);
    expect(style.textContent).toBe("");
    expect(style.sheet).toBe(currentSheet);
    expect((currentSheet as unknown as { cssRules: readonly object[] }).cssRules)
      .toEqual([]);
    expect((oldSheet as unknown as { cssRules: readonly object[] }).cssRules)
      .toBe(oldRules);
    expect((oldSheet as unknown as { ownerNode: unknown }).ownerNode).toBeNull();

    reattachParent.append(style);
    expect(style.textContent).toBe("");
    expect(reattachParent.children).toEqual([style]);
  });

  it("does not treat a hostile parentNode getter as an already detached style", () => {
    const artifacts = deterministicArtifacts();
    const parent = new FakeParent();
    const target = new FakeElement("style");
    let rejectParentRead = false;
    const style = new Proxy(target, {
      get(object, property, receiver) {
        if (property === "parentNode" && rejectParentRead) {
          throw new Error("parent identity unavailable");
        }
        return Reflect.get(object, property, receiver);
      },
    });
    parent.append(style);
    artifacts.registerStyleNode(style as unknown as HTMLStyleElement);
    rejectParentRead = true;

    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    expect(parent.children).toEqual([style]);

    rejectParentRead = false;
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
    expect(parent.children).toEqual([]);
  });

  it("stages exact Attr ownership before hostile marker insertion and verification", () => {
    const artifacts = deterministicArtifacts();
    const throwAfterInsert = new FakeElement("button");
    throwAfterInsert.throwAfterAttributeNodeInsert = true;

    expect(artifacts.setStateMarkers(
      throwAfterInsert as unknown as Element,
      ["hover"],
    )).toBe(false);
    expect(throwAfterInsert.attributes).toEqual([]);
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });

    const hostileVerification = new FakeElement("button");
    hostileVerification.throwGetAttributeNodeAfter = 1;
    expect(artifacts.setStateMarkers(
      hostileVerification as unknown as Element,
      ["hover"],
    )).toBe(false);
    expect(hostileVerification.attributes).toHaveLength(1);
    expect(artifacts.cleanup()).toEqual({ complete: false, failureCount: 1 });
    hostileVerification.allowAttributeReads();
    expect(artifacts.cleanup()).toEqual({ complete: true, failureCount: 0 });
  });
});

function deterministicArtifacts(): PinOpRuntimeArtifacts {
  let seed = 0;
  return new PinOpRuntimeArtifacts({
    getRandomValues(bytes) {
      bytes.fill(++seed);
      return bytes;
    },
  });
}

function constructableSheet(
  name: string,
  initialRules: readonly object[] = [],
  noOpReplace = false,
): CSSStyleSheet {
  return {
    name,
    ownerNode: null,
    cssRules: [...initialRules],
    noOpReplace,
    replaceSync(this: { cssRules: object[]; noOpReplace: boolean }, text: string) {
      if (text !== "" || this.noOpReplace) return;
      this.cssRules = [];
    },
  } as unknown as CSSStyleSheet;
}

interface FakeAttribute {
  readonly name: string;
  value: string;
  ownerElement: FakeElement | null;
}

class FakeElement {
  public parentNode: FakeParent | null = null;
  public readonly childNodes: FakeElement[] = [];
  public sheet: CSSStyleSheet | null = null;
  public textContent = "";
  public rejectAttributeRemoval = false;
  public noOpAttributeRemoval = false;
  public noOpRemove = false;
  public throwAfterAttributeNodeInsert = false;
  public throwGetAttributeNodeAfter = Number.POSITIVE_INFINITY;
  public readonly ownerDocument = {
    createAttribute: (name: string): FakeAttribute => ({
      name,
      value: "",
      ownerElement: null,
    }),
  };
  private readonly attributesByName = new Map<string, FakeAttribute>();
  private getAttributeNodeReads = 0;

  public constructor(public readonly tagName: string) {}

  public get attributes(): readonly FakeAttribute[] {
    return [...this.attributesByName.values()];
  }

  public setAttribute(name: string, value: string): void {
    const current = this.attributesByName.get(name);
    if (current) current.value = value;
    else this.attributesByName.set(name, { name, value, ownerElement: this });
  }

  public replaceAttribute(name: string, value: string): FakeAttribute {
    const attribute = { name, value, ownerElement: this };
    const previous = this.attributesByName.get(name);
    if (previous) previous.ownerElement = null;
    this.attributesByName.set(name, attribute);
    return attribute;
  }

  public removePageAttribute(name: string): void {
    const current = this.attributesByName.get(name);
    if (current) current.ownerElement = null;
    this.attributesByName.delete(name);
  }

  public rejectFutureAttributeReads(): void {
    this.throwGetAttributeNodeAfter = this.getAttributeNodeReads;
  }

  public allowAttributeReads(): void {
    this.throwGetAttributeNodeAfter = Number.POSITIVE_INFINITY;
  }

  public getAttributeNode(name: string): FakeAttribute | null {
    this.getAttributeNodeReads += 1;
    if (this.getAttributeNodeReads > this.throwGetAttributeNodeAfter) {
      throw new Error("attribute verification blocked");
    }
    return this.attributesByName.get(name) ?? null;
  }

  public setAttributeNode(attribute: FakeAttribute): FakeAttribute | null {
    const previous = this.attributesByName.get(attribute.name) ?? null;
    if (previous) previous.ownerElement = null;
    this.attributesByName.set(attribute.name, attribute);
    attribute.ownerElement = this;
    if (this.throwAfterAttributeNodeInsert) {
      this.throwAfterAttributeNodeInsert = false;
      throw new Error("attribute insertion failed after mutation");
    }
    return previous;
  }

  public removeAttributeNode(attribute: FakeAttribute): FakeAttribute {
    if (this.rejectAttributeRemoval) throw new Error("removal rejected");
    if (this.attributesByName.get(attribute.name) !== attribute) {
      throw new Error("not owned");
    }
    if (!this.noOpAttributeRemoval) {
      this.attributesByName.delete(attribute.name);
      attribute.ownerElement = null;
    }
    return attribute;
  }

  public hasAttribute(name: string): boolean {
    return this.attributesByName.has(name);
  }

  public getAttribute(name: string): string | null {
    return this.attributesByName.get(name)?.value ?? null;
  }

  public remove(): void {
    if (this.noOpRemove) return;
    this.parentNode?.remove(this);
  }
}

class FakeParent {
  public readonly children: FakeElement[] = [];

  public append(child: FakeElement): void {
    child.parentNode?.remove(child);
    this.children.push(child);
    child.parentNode = this;
  }

  public remove(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
  }
}
