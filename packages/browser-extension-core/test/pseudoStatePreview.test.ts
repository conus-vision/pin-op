import { describe, expect, it, vi } from "vitest";
import { INSPECT_LIMITS } from "@pin-op/protocol";
import postcss, { type ChildNode } from "postcss";
import selectorParser from "postcss-selector-parser";
import { PinOpRuntimeArtifacts } from "../src/pinOpRuntimeArtifacts.js";
import {
  PseudoStatePreview,
  type PseudoStatePreviewStylesheet,
} from "../src/pseudoStatePreview.js";
import { StylesheetRegistry } from "../src/stylesheetRegistry.js";

describe("PseudoStatePreview", () => {
  it("snapshots bounded requested states by index without invoking a hostile iterator", () => {
    const environment = createEnvironment();
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

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [],
      states,
    );

    expect(result.states).toEqual(["hover", "focus"]);
    expect(iteratorReads).toBe(0);
  });

  it("snapshots bounded import provenance arrays without invoking hostile iterators", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    let iteratorReads = 0;
    const hostileEmptyArray = <T,>(): readonly T[] => new Proxy<T[]>([], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          throw new Error("provenance iterator must not be used");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const entry = {
      ...environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ]),
      importChain: hostileEmptyArray(),
      importContexts: hostileEmptyArray(),
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(iteratorReads).toBe(0);
  });

  it("keeps requested state active with zero matching or readable mirror rules", () => {
    const empty = createEnvironment();
    const emptyResult = empty.preview.apply(
      empty.selected as unknown as Element,
      [],
      ["hover"],
    );
    expect(emptyResult).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(empty.selected.hasAttribute(empty.artifacts.markerNames.selection)).toBe(true);
    expect(empty.selected.hasAttribute(empty.artifacts.markerNames.hover)).toBe(true);

    const noTarget = createEnvironment();
    const noTargetOwner = noTarget.owner("style");
    expect(noTarget.preview.apply(
      noTarget.selected as unknown as Element,
      [noTarget.entry(noTargetOwner, [
        styleRule(".button", [["color", "green", ""]]),
      ])],
      ["focus"],
    )).toMatchObject({ states: ["focus"], mountedRuleCount: 0 });

    const allPartial = createEnvironment();
    const partialOwner = allPartial.owner("style");
    const partialEntry = allPartial.entry(partialOwner, []);
    Object.defineProperty(partialEntry.sheet, "cssRules", {
      configurable: true,
      get(): never {
        throw new Error("source unavailable");
      },
    });
    expect(allPartial.preview.apply(
      allPartial.selected as unknown as Element,
      [partialEntry],
      ["hover"],
    )).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
  });

  it("does not read declarations for unrelated or wholly unsupported selectors", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    let styleReads = 0;
    const unreadableStyle = (): never => {
      styleReads += 1;
      throw new Error("style must not be read");
    };
    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        { selectorText: ".unrelated", get style(): never { return unreadableStyle(); } },
        {
          selectorText: ".ancestor:hover .button",
          get style(): never { return unreadableStyle(); },
        },
      ])],
      ["hover"],
    );

    expect(styleReads).toBe(0);
    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 1,
    });
  });

  it("mounts guarded hover/focus mirrors after an owner with preserved declarations and groups", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover:focus", [
        ["color", "red", "important"],
        ["background-image", "url(./images/button.png)", ""],
      ]),
      groupRule("CSSMediaRule", "(min-width: 40rem)", [
        groupRule("CSSSupportsRule", "(display: grid)", [
          styleRule(":is(.button:hover, a)", [["display", "grid", ""]]),
        ]),
      ]),
    ], "https://cdn.example.test/css/app/main.css");

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["focus", "hover"],
    );
    expect(result).toMatchObject({
      states: ["hover", "focus"],
      mountedRuleCount: 2,
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 0,
      approximateRuleCount: 2,
    });
    expect(owner.parentNode?.children).toHaveLength(2);
    const mount = owner.parentNode?.children[1];
    const styleArtifactName = `data-pin-op-runtime-${"04".repeat(16)}`;
    expect(mount?.getAttribute(styleArtifactName)).toBe("");
    expect(mount?.getAttribute("data-pin-op-runtime-artifact")).toBeNull();
    expect(JSON.stringify(result)).not.toContain(styleArtifactName);
    expect(mount?.textContent).toBe([
      `.button[${environment.artifacts.markerNames.hover}][${environment.artifacts.markerNames.focus}]:where([${environment.artifacts.markerNames.selection}]){color:red !important;background-image:url(https://cdn.example.test/css/app/images/button.png);}`,
      `@media (min-width: 40rem){@supports (display: grid){:is(.button[${environment.artifacts.markerNames.hover}]):where([${environment.artifacts.markerNames.selection}]){display:grid;}}}`,
    ].join(""));
    expect(environment.selected.hasAttribute(environment.artifacts.markerNames.selection)).toBe(true);
    expect(environment.selected.hasAttribute(environment.artifacts.markerNames.hover)).toBe(true);
    expect(environment.selected.hasAttribute(environment.artifacts.markerNames.focus)).toBe(true);

    environment.preview.clear();
    expect(owner.parentNode?.children).toEqual([owner]);
    expect(environment.selected.attributes).toEqual([]);
  });

  it("preserves bounded vendor-prefixed declarations in supported pseudo rules", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [styleRule(".button:hover", [
        ["-webkit-user-select", "none", ""],
        ["-moz-appearance", "none", ""],
      ])])],
      ["hover"],
    );

    expect(result).toMatchObject({ mountedRuleCount: 1, unsupportedRuleCount: 0 });
    expect(owner.parentNode?.children[1]?.textContent).toContain(
      "-webkit-user-select:none;-moz-appearance:none;",
    );
  });

  it("preserves absolute tokens while rebasing path and network-path URLs", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    const entry = environment.entry(owner, [styleRule(".button:hover", [
      ["background", [
        "url('../a.png')",
        "url(https://assets.example/a.png)",
        "url(//assets.example/b.png)",
        "url(#mask)",
        "url(data:image/png;base64,AA)",
        "url(blob:https://example.test/id)",
      ].join(" "), ""],
    ])], "http://cdn.example.test/css/theme/app.css");

    environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    const css = owner.parentNode?.children[1]?.textContent ?? "";
    expect(css).toContain("url('http://cdn.example.test/css/a.png')");
    expect(css).toContain("url(https://assets.example/a.png)");
    expect(css).toContain("url(http://assets.example/b.png)");
    expect(css).toContain("url(#mask)");
    expect(css).toContain("url(data:image/png;base64,AA)");
    expect(css).toContain("url(blob:https://example.test/id)");
  });

  it("rejects ambiguous CSS-escaped URL tokens instead of rebasing them", () => {
    for (const value of [
      "url(\\2e\\2e/a.png)",
      "url(\\68 ttps://assets.example/a.png)",
      "url(\\2f\\2f assets.example/a.png)",
    ]) {
      const environment = createEnvironment();
      const owner = environment.owner("link");
      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [environment.entry(owner, [styleRule(".button:hover", [
          ["background-image", value, ""],
        ])], "https://cdn.example.test/css/app.css")],
        ["hover"],
      );

      expect(result).toMatchObject({
        states: ["hover"],
        mountedRuleCount: 0,
        unsupportedRuleCount: 1,
      });
      expect(owner.parentNode?.children).toEqual([owner]);
    }
  });

  it("rejects unsupported grouping and unprovable nesting without lifting declarations", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      ...[
        "CSSLayerBlockRule",
        "CSSScopeRule",
        "CSSContainerRule",
        "CSSStartingStyleRule",
        "CSSFutureRule",
      ].map((kind) => groupRule(kind, "unsafe", [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])),
      {
        selectorText: "&:hover",
        style: declaration([["color", "blue", ""]]),
      },
    ]);

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(0);
    expect(result.states).toEqual(["hover"]);
    expect(result.unsupportedRuleCount).toBe(6);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      "unsupported-group",
      "unproven-nesting",
    ]));
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("reports escaped targets and hidden child targets under unresolvable nesting", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    let styleReads = 0;
    const unreadableStyle = {
      get length(): never {
        styleReads += 1;
        throw new Error("unproven declarations must not be read");
      },
    };
    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        { selectorText: "&:\\68 over", style: unreadableStyle },
        {
          selectorText: "&",
          style: declaration([]),
          cssRules: [{ selectorText: "& .button:hover", style: unreadableStyle }],
        },
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 2,
    });
    expect(result.diagnostics).toContain("unproven-nesting");
    expect(styleReads).toBe(0);
  });

  it("keeps successful mounts after inaccessible, hostile, and rejected branches", () => {
    const environment = createEnvironment();
    const successfulOwner = environment.owner("style");
    const rejectedOwner = environment.owner("style");
    rejectedOwner.rejectNextInsert = true;
    const inaccessibleSheet = sheet([], "https://example.test/inaccessible.css");
    Object.defineProperty(inaccessibleSheet, "cssRules", {
      configurable: true,
      get(): never {
        throw new Error("cssom denied");
      },
    });
    const inaccessible = {
      scope: environment.document,
      kind: "external",
      sourceOrder: 2,
      sourceUrl: "https://example.test/inaccessible.css",
      sheet: inaccessibleSheet,
    } as unknown as PseudoStatePreviewStylesheet;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [
        environment.entry(successfulOwner, [
          styleRule(".button:hover", [["color", "green", ""]]),
        ]),
        environment.entry(rejectedOwner, [
          styleRule(".button:hover", [["color", "red", ""]]),
        ]),
        inaccessible,
      ],
      ["hover"],
    );

    expect(result).toMatchObject({
      mountedRuleCount: 1,
      inaccessibleStylesheetCount: 1,
      approximateRuleCount: 1,
    });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      "style-mount-rejected",
      "stylesheet-inaccessible",
    ]));
    expect(successfulOwner.parentNode?.children).toHaveLength(2);
    expect(rejectedOwner.parentNode?.children).toEqual([rejectedOwner]);
  });

  it("uses an adjacent constructable sheet for an adopted source and preserves concurrent entries on cleanup", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(".button:focus", [["outline", "2px solid", ""]])]);
    const before = sheet([]);
    const after = sheet([]);
    environment.document.adoptedStyleSheets = [before, source, after];
    const entry: PseudoStatePreviewStylesheet = {
      scope: environment.document as unknown as Document,
      sheet: source as unknown as CSSStyleSheet,
      kind: "adopted",
      sourceOrder: 1,
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["focus"],
    );
    const owned = environment.document.adoptedStyleSheets[2];
    expect(result.mountedRuleCount).toBe(1);
    expect(owned).not.toBe(source);
    expect((owned as FakeSheet).replacedText).toContain(
      `[${environment.artifacts.markerNames.focus}]`,
    );

    const concurrent = sheet([]);
    environment.document.adoptedStyleSheets = [
      concurrent,
      before,
      source,
      owned!,
      after,
    ];
    environment.preview.clear();
    expect(environment.document.adoptedStyleSheets).toEqual([
      concurrent,
      before,
      source,
      after,
    ]);
  });

  it("does not consult a page-owned root property while creating a realm stylesheet", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [source];
    let hostileReads = 0;
    Object.defineProperty(environment.document, "nodeType", {
      configurable: true,
      get() {
        hostileReads += 1;
        throw new Error("hostile root.nodeType");
      },
    });
    const records = new WeakMap<object, Readonly<Record<string, unknown>>>([[
      environment.document,
      { "node.nodeType": 9 },
    ]]);
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createStyleElement: () => {
        const style = new FakeElement("STYLE", environment.document);
        style.pendingSheet = sheet([]);
        return style as unknown as HTMLStyleElement;
      },
      resolveOpenShadowRootHost: (root) => environment.resolveShadowHost(root),
      testOnlyIntrinsics: structuralTestIntrinsics(records),
    } as unknown as ConstructorParameters<typeof PseudoStatePreview>[0]);

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(hostileReads).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
  });

  it("falls back inside the same open shadow root when adopted assignment fails", () => {
    const environment = createEnvironment();
    const shadow = new FakeRoot("shadow", environment.document);
    const selected = new FakeElement("button", environment.document);
    shadow.append(selected);
    const source = sheet([styleRule(".button:hover", [["color", "red", ""]])]);
    shadow.adoptedStyleSheets = [source];
    shadow.rejectAdoptedAssignment = true;

    const result = environment.preview.apply(
      selected as unknown as Element,
      [{
        scope: shadow as unknown as ShadowRoot,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(result.diagnostics).toContain("adopted-sheet-assignment-failed");
    expect(shadow.children.at(-1)?.tagName).toBe("STYLE");
    environment.preview.clear();
    expect(shadow.children).toEqual([selected]);
  });

  it("mounts an adopted fallback in the document head when Document rejects style children", () => {
    const environment = createEnvironment();
    const source = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.document.adoptedStyleSheets = [source];
    environment.document.rejectAdoptedAssignment = true;
    environment.document.rejectDocumentStyleAppend = true;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(result.diagnostics).toContain("adopted-sheet-assignment-failed");
    expect(environment.document.head?.children.at(-1)?.tagName).toBe("STYLE");
    expect(environment.document.children.every(({ tagName }) => tagName !== "STYLE"))
      .toBe(true);
    environment.preview.clear();
    expect(environment.document.head?.children).toEqual([]);
  });

  it("rejects a detached hostile document head even when ownerDocument is spoofed", () => {
    const environment = createEnvironment();
    const source = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.document.adoptedStyleSheets = [source];
    environment.document.rejectAdoptedAssignment = true;
    const detachedHead = new FakeRoot("fragment", environment.document);
    Object.defineProperty(environment.document, "head", {
      configurable: true,
      value: detachedHead,
    });

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 1,
      inaccessibleStylesheetCount: 0,
    });
    expect(result.diagnostics).toContain("style-mount-rejected");
    expect(detachedHead.children).toEqual([]);
  });

  it("is idempotent, replaces selections, and cleans exact nodes after reparenting", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const second = new FakeElement("button", environment.document);
    environment.document.append(second);

    environment.preview.apply(environment.selected as unknown as Element, [entry], ["hover"]);
    environment.preview.apply(environment.selected as unknown as Element, [entry], ["hover"]);
    expect(owner.parentNode?.children.filter(({ tagName }) => tagName === "STYLE"))
      .toHaveLength(2);

    const oldMount = owner.parentNode?.children[1]!;
    const foreignParent = new FakeRoot("document", environment.document);
    foreignParent.append(oldMount);
    environment.preview.apply(second as unknown as Element, [entry], ["hover"]);

    expect(foreignParent.children).toEqual([]);
    expect(environment.selected.attributes).toEqual([]);
    expect(second.hasAttribute(environment.artifacts.markerNames.selection)).toBe(true);
  });

  it("mounts a shared adopted source only in the selected root and never calls page input APIs", () => {
    const environment = createEnvironment();
    const otherRoot = new FakeRoot("shadow", environment.document);
    const source = sheet([styleRule(":where(.button:hover)", [["color", "red", ""]])]);
    environment.document.adoptedStyleSheets = [source];
    otherRoot.adoptedStyleSheets = [source];
    const focus = vi.fn();
    const blur = vi.fn();
    const dispatchEvent = vi.fn();
    Object.assign(environment.selected, { focus, blur, dispatchEvent });

    environment.preview.apply(
      environment.selected as unknown as Element,
      [
        {
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
        {
          scope: otherRoot as unknown as ShadowRoot,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
      ],
      ["hover"],
    );

    expect(environment.document.adoptedStyleSheets).toHaveLength(2);
    expect(otherRoot.adoptedStyleSheets).toEqual([source]);
    expect(focus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it("mounts an imported sheet beside its proven top-level owner", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    const importedSheet = sheet([
      styleRule(".button:hover", [["color", "purple", ""]]),
    ], "https://cdn.example.test/imported.css");
    const innerImport = { styleSheet: importedSheet };
    const middleSheet = sheet([innerImport]);
    const outerImport = { styleSheet: middleSheet };
    const topSheet = sheet([outerImport]);
    owner.sheet = topSheet;
    const entry: PseudoStatePreviewStylesheet = {
      scope: environment.document as unknown as Document,
      sheet: importedSheet as unknown as CSSStyleSheet,
      owner: owner as unknown as Element,
      ownerState: ownerState(owner),
      kind: "import",
      sourceOrder: 2,
      sourceUrl: "https://cdn.example.test/imported.css",
      rulePathPrefix: "0.0",
      origin: {
        kind: "owner",
        sheet: topSheet as unknown as CSSStyleSheet,
        owner: owner as unknown as Element,
      },
      importChain: [
        {
          parentSheet: topSheet as unknown as CSSStyleSheet,
          rule: outerImport,
          ruleIndex: 0,
          importedSheet: middleSheet as unknown as CSSStyleSheet,
          contexts: [],
          unsupported: false,
        },
        {
          parentSheet: middleSheet as unknown as CSSStyleSheet,
          rule: innerImport,
          ruleIndex: 0,
          importedSheet: importedSheet as unknown as CSSStyleSheet,
          contexts: [],
          unsupported: false,
        },
      ],
      importContexts: [],
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(owner.parentNode?.children[1]?.textContent).toContain("color:purple");
  });

  it("flattens a nested rule only after resolving it against a captured parent selector", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const nested = {
      selectorText: ".card",
      style: declaration([]),
      cssRules: [styleRule("&.button:hover", [["color", "blue", ""]])],
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [nested])],
      ["hover"],
    );

    expect(result).toMatchObject({ mountedRuleCount: 1, unsupportedRuleCount: 0 });
    expect(owner.parentNode?.children[1]?.textContent).toContain(
      `:is(.card).button[${environment.artifacts.markerNames.hover}]`,
    );
  });

  it("guards every direct, list, is, and where mirror and reports later-rule ordering as approximate", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
      styleRule(".button:hover, a", [["background", "red", ""]]),
      styleRule(":is(.button:hover, a)", [["border-color", "red", ""]]),
      styleRule(":where(.button:hover)", [["outline-color", "red", ""]]),
      styleRule(".button", [["color", "blue", ""]]),
    ]);

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );
    const css = owner.parentNode?.children[1]?.textContent ?? "";
    const guard = `:where([${environment.artifacts.markerNames.selection}])`;

    expect(result).toMatchObject({ mountedRuleCount: 4, approximateRuleCount: 4 });
    expect(css.split(guard)).toHaveLength(5);
    expect(css).not.toMatch(/(?:^|,|\{)\s*a\s*(?:,|\{)/u);
    const selectedComputed = previewComputedDeclarations(css, {
      classes: new Set(["button"]),
      attributes: new Set([
        environment.artifacts.markerNames.selection,
        environment.artifacts.markerNames.hover,
      ]),
    });
    const siblingComputed = previewComputedDeclarations(css, {
      classes: new Set(["button"]),
      attributes: new Set([environment.artifacts.markerNames.hover]),
    });
    expect(Object.fromEntries(selectedComputed)).toEqual({
      color: "red",
      background: "red",
      "border-color": "red",
      "outline-color": "red",
    });
    expect(Object.fromEntries(siblingComputed)).toEqual({});
    expect(result.diagnostics).toContain("source-order-approximation");
  });

  it("retains exact cleanup authority after partial and hostile CSSOM failures", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const rejectedOwner = environment.owner("style");
    rejectedOwner.rejectNextInsert = true;
    const hostileSheet = {
      href: null,
      get cssRules(): never {
        throw new Error("hostile cssRules");
      },
    };
    const hostileDeclaration = {
      selectorText: ".button:hover",
      style: {
        length: 1,
        item: () => "color",
        getPropertyValue: () => {
          throw new Error("hostile declaration");
        },
        getPropertyPriority: () => "",
      },
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [
        environment.entry(owner, [styleRule(".button:hover", [["color", "green", ""]])]),
        environment.entry(rejectedOwner, [styleRule(".button:hover", [["color", "red", ""]])]),
        {
          scope: environment.document as unknown as Document,
          sheet: hostileSheet as unknown as CSSStyleSheet,
          kind: "owner",
          sourceOrder: 2,
        },
        environment.entry(environment.owner("style"), [hostileDeclaration]),
      ],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      "style-mount-rejected",
      "stylesheet-inaccessible",
      "declaration-unavailable",
    ]));
    environment.preview.clear();
    expect(owner.parentNode?.children).toEqual([owner]);
    expect(environment.selected.attributes).toEqual([]);
  });

  it.each(["throw-after-insert", "no-op"] as const)(
    "rolls back a %s adopted assignment before falling back in the same root",
    (mode) => {
      const environment = createEnvironment();
      const source = sheet([styleRule(".button:hover", [["color", "red", ""]])]);
      environment.document.adoptedStyleSheets = [source];
      environment.document.adoptedAssignmentMode = mode;

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );

      expect(result.mountedRuleCount).toBe(1);
      expect(result.diagnostics).toContain("adopted-sheet-assignment-failed");
      expect(environment.document.adoptedStyleSheets).toEqual([source]);
      expect(environment.document.head?.children.at(-1)?.tagName).toBe("STYLE");
    },
  );

  it.each(["lossy", "reorder-preserve-adjacency"] as const)(
    "rejects a %s adopted setter result that is not the exact requested sequence",
    (mode) => {
      const environment = createEnvironment();
      const before = sheet([]);
      const source = sheet([styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )]);
      const after = sheet([]);
      environment.document.adoptedStyleSheets = [before, source, after];
      environment.document.adoptedAssignmentMode = mode;

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );

      expect(result.diagnostics).toContain("adopted-sheet-assignment-failed");
      expect(environment.document.head?.children.at(-1)?.tagName).toBe("STYLE");
      expect(environment.document.adoptedStyleSheets).toEqual([before, source, after]);
      expect(environment.document.adoptedStyleSheets).not.toContainEqual(
        expect.objectContaining({ replacedText: expect.stringContaining("color:red") }),
      );
    },
  );

  it.each(["persistent-lossy", "persistent-reorder"] as const)(
    "blocks fallback and retains authority after a %s adopted assignment",
    (mode) => {
      const environment = createEnvironment();
      const before = sheet([]);
      const source = sheet([styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )]);
      const after = sheet([]);
      environment.document.adoptedStyleSheets = [before, source, after];
      environment.document.adoptedAssignmentMode = mode;

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );

      expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        "adopted-sheet-assignment-failed",
        "cleanup-incomplete",
      ]));
      expect(environment.document.head?.children).toEqual([]);
      expect(environment.selected.attributes).toEqual([]);

      environment.document.adoptedAssignmentMode = "normal";
      expect(environment.preview.clear()).toEqual({ complete: true, failureCount: 0 });
      expect(environment.document.adoptedStyleSheets).toEqual([before, source, after]);
    },
  );

  it.each(["factory", "replaceSync"] as const)(
    "preserves concurrent adopted entries added during constructable %s work",
    (reentryPoint) => {
      const environment = createEnvironment();
      const before = sheet([]);
      const source = sheet([
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      const concurrent = sheet([]);
      const after = sheet([]);
      environment.document.adoptedStyleSheets = [before, source, after];
      const addConcurrent = (): void => {
        environment.document.adoptedStyleSheets = [before, source, concurrent, after];
      };
      if (reentryPoint === "factory") {
        environment.document.onConstructableStylesheetCreated = addConcurrent;
      } else {
        environment.document.onConstructableReplace = addConcurrent;
      }

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );

      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
      const mirror = environment.document.adoptedStyleSheets[2];
      expect(environment.document.adoptedStyleSheets).toEqual([
        before,
        source,
        mirror,
        concurrent,
        after,
      ]);
    },
  );

  it.each(["source", "existing-page-sheet"] as const)(
    "never mutates or removes a %s returned by the constructable-sheet factory",
    (variant) => {
      const environment = createEnvironment();
      const source = sheet([styleRule(".button:hover", [["color", "red", ""]])]);
      const existing = sheet([styleRule(".page", [["color", "blue", ""]])]);
      environment.document.adoptedStyleSheets = [source, existing];
      const candidate = variant === "source" ? source : existing;
      const preview = new PseudoStatePreview({
        artifacts: environment.artifacts,
        createConstructableStylesheet: () => candidate as unknown as CSSStyleSheet,
        createStyleElement: () => (
          environment.document.createElement("style") as unknown as HTMLStyleElement
        ),
      });
      const beforeRules = candidate.cssRules;

      const result = preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );
      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
      expect(candidate.replacedText).toBeUndefined();
      expect(candidate.cssRules).toBe(beforeRules);
      expect(environment.document.adoptedStyleSheets).toEqual([source, existing]);
    },
  );

  it("never uses another input origin sheet as a constructable mirror", () => {
    const environment = createEnvironment();
    const adoptedSource = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.document.adoptedStyleSheets = [adoptedSource];
    const otherOwner = environment.owner("style");
    const otherEntry = environment.entry(otherOwner, []);
    const otherSheet = otherEntry.sheet as unknown as FakeSheet;
    const originalRules = otherSheet.cssRules;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => otherSheet as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [
        {
          scope: environment.document as unknown as Document,
          sheet: adoptedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
        otherEntry,
      ],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(otherSheet.replacedText).toBeUndefined();
    expect(otherSheet.cssRules).toBe(originalRules);
    expect(environment.artifacts.isRuntimeStylesheet(otherSheet)).toBe(false);
  });

  it("quarantines source identities from valid entries in every root", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const foreignDocument = new FakeRoot("document");
    const foreignSource = sheet([]);
    foreignDocument.adoptedStyleSheets = [foreignSource];
    const originalRules = foreignSource.cssRules;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => foreignSource as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [
        {
          scope: environment.document as unknown as Document,
          sheet: selectedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
        {
          scope: foreignDocument as unknown as Document,
          sheet: foreignSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
      ],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(foreignSource.cssRules).toBe(originalRules);
    expect(foreignSource.replacedText).toBeUndefined();
    expect(foreignDocument.adoptedStyleSheets).toEqual([foreignSource]);
    expect(environment.artifacts.isRuntimeStylesheet(foreignSource)).toBe(false);
  });

  it("quarantines readable sheet identities from otherwise malformed entries", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const malformedAlias = sheet([]);
    const originalRules = malformedAlias.cssRules;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => malformedAlias as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });
    const malformed = {
      scope: environment.document as unknown as Document,
      sheet: malformedAlias as unknown as CSSStyleSheet,
      kind: "malformed",
      sourceOrder: 1,
    } as unknown as PseudoStatePreviewStylesheet;

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, malformed],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(malformedAlias.cssRules).toBe(originalRules);
    expect(malformedAlias.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(malformedAlias)).toBe(false);
  });

  it("quarantines a hidden origin sheet before rejecting malformed entry metadata", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const entrySheet = sheet([]);
    const hiddenOriginSheet = sheet([]);
    const originalRules = hiddenOriginSheet.cssRules;
    let originReads = 0;
    let originSheetReads = 0;
    const malformed = {
      scope: environment.document as unknown as Document,
      sheet: entrySheet as unknown as CSSStyleSheet,
      kind: "malformed",
      sourceOrder: 1,
      get origin() {
        originReads += 1;
        return {
          kind: "adopted" as const,
          get sheet() {
            originSheetReads += 1;
            return hiddenOriginSheet as unknown as CSSStyleSheet;
          },
        };
      },
    } as unknown as PseudoStatePreviewStylesheet;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => hiddenOriginSheet as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, malformed],
      ["hover"],
    );

    expect(originReads).toBe(1);
    expect(originSheetReads).toBe(1);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(hiddenOriginSheet.cssRules).toBe(originalRules);
    expect(hiddenOriginSheet.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(hiddenOriginSheet)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
    expect(environment.document.head?.children).toHaveLength(1);
  });

  it.each(["parent", "imported"] as const)(
    "quarantines a hidden import-chain %s sheet before rejecting later metadata",
    (hiddenPosition) => {
      const environment = createEnvironment();
      const selectedSource = sheet([styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )]);
      environment.document.adoptedStyleSheets = [selectedSource];
      const top = sheet([]);
      const leaf = sheet([]);
      const hiddenImportSheet = sheet([]);
      const originalRules = hiddenImportSheet.cssRules;
      let chainReads = 0;
      let parentReads = 0;
      let importedReads = 0;
      const malformed = {
        scope: environment.document as unknown as Document,
        sheet: leaf as unknown as CSSStyleSheet,
        kind: "import" as const,
        sourceOrder: 1,
        sourceUrl: 42,
        origin: {
          kind: "adopted" as const,
          sheet: top as unknown as CSSStyleSheet,
        },
        get importChain() {
          chainReads += 1;
          return [{
            get parentSheet() {
              parentReads += 1;
              return (hiddenPosition === "parent" ? hiddenImportSheet : top) as unknown as
                CSSStyleSheet;
            },
            rule: {},
            ruleIndex: 0,
            get importedSheet() {
              importedReads += 1;
              return (hiddenPosition === "imported" ? hiddenImportSheet : leaf) as unknown as
                CSSStyleSheet;
            },
            contexts: [],
            unsupported: false,
          }];
        },
      } as unknown as PseudoStatePreviewStylesheet;
      const preview = new PseudoStatePreview({
        artifacts: environment.artifacts,
        createConstructableStylesheet: () => hiddenImportSheet as unknown as CSSStyleSheet,
        createStyleElement: () => (
          environment.document.createElement("style") as unknown as HTMLStyleElement
        ),
      });

      const result = preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: selectedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }, malformed],
        ["hover"],
      );

      expect(chainReads).toBe(1);
      expect(parentReads).toBe(1);
      expect(importedReads).toBe(1);
      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
      expect(hiddenImportSheet.cssRules).toBe(originalRules);
      expect(hiddenImportSheet.replacedText).toBeUndefined();
      expect(environment.artifacts.isRuntimeStylesheet(hiddenImportSheet)).toBe(false);
      expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
      expect(environment.document.head?.children).toHaveLength(1);
    },
  );

  it.each(["unreadable-origin", "oversized-chain"] as const)(
    "disables constructable writes for an identity-incomplete %s entry but keeps valid branches",
    (variant) => {
      const environment = createEnvironment();
      const selectedSource = sheet([styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )]);
      environment.document.adoptedStyleSheets = [selectedSource];
      const unknownAlias = sheet([]);
      const originalRules = unknownAlias.cssRules;
      const foreignDocument = new FakeRoot("document");
      const leaf = sheet([]);
      const top = sheet([]);
      const identityIncomplete = variant === "unreadable-origin"
        ? {
            scope: foreignDocument as unknown as Document,
            sheet: leaf as unknown as CSSStyleSheet,
            kind: "import" as const,
            sourceOrder: 1,
            get origin(): never {
              throw new Error("origin identity unavailable");
            },
            importChain: [],
          }
        : {
            scope: foreignDocument as unknown as Document,
            sheet: leaf as unknown as CSSStyleSheet,
            kind: "import" as const,
            sourceOrder: 1,
            origin: {
              kind: "adopted" as const,
              sheet: top as unknown as CSSStyleSheet,
            },
            importChain: Array.from(
              { length: INSPECT_LIMITS.cssRuleDepth + 1 },
              (_, ruleIndex) => ({
                parentSheet: top as unknown as CSSStyleSheet,
                rule: {},
                ruleIndex,
                importedSheet: leaf as unknown as CSSStyleSheet,
                contexts: [],
                unsupported: false,
              }),
            ),
          };
      let factoryCalls = 0;
      const preview = new PseudoStatePreview({
        artifacts: environment.artifacts,
        createConstructableStylesheet: () => {
          factoryCalls += 1;
          return unknownAlias as unknown as CSSStyleSheet;
        },
        createStyleElement: () => (
          environment.document.createElement("style") as unknown as HTMLStyleElement
        ),
      });

      const result = preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: selectedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }, identityIncomplete as PseudoStatePreviewStylesheet],
        ["hover"],
      );

      expect(factoryCalls).toBe(0);
      expect(result).toMatchObject({
        states: ["hover"],
        mountedRuleCount: 1,
        inaccessibleStylesheetCount: 1,
      });
      expect(unknownAlias.cssRules).toBe(originalRules);
      expect(unknownAlias.replacedText).toBeUndefined();
      expect(environment.artifacts.isRuntimeStylesheet(unknownAlias)).toBe(false);
      expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
      expect(environment.document.head?.children).toHaveLength(1);
    },
  );

  it("disables constructable writes when import-chain identity classification throws", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const unknownAlias = sheet([]);
    const originalRules = unknownAlias.cssRules;
    const revoked = Proxy.revocable<readonly object[]>([], {});
    revoked.revoke();
    const foreignDocument = new FakeRoot("document");
    const identityIncomplete = {
      scope: foreignDocument as unknown as Document,
      sheet: sheet([]) as unknown as CSSStyleSheet,
      kind: "import" as const,
      sourceOrder: 1,
      origin: {
        kind: "adopted" as const,
        sheet: sheet([]) as unknown as CSSStyleSheet,
      },
      importChain: revoked.proxy,
    } as unknown as PseudoStatePreviewStylesheet;
    let factoryCalls = 0;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => {
        factoryCalls += 1;
        return unknownAlias as unknown as CSSStyleSheet;
      },
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, identityIncomplete],
      ["hover"],
    );

    expect(factoryCalls).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(unknownAlias.cssRules).toBe(originalRules);
    expect(unknownAlias.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(unknownAlias)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
    expect(environment.document.head?.children).toHaveLength(1);
  });

  it("disables constructable writes when the import-rule carrier is unreadable", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const unknownAlias = sheet([]);
    const originalRules = unknownAlias.cssRules;
    const top = sheet([]);
    const leaf = sheet([]);
    const foreignDocument = new FakeRoot("document");
    const identityIncomplete = {
      scope: foreignDocument as unknown as Document,
      sheet: leaf as unknown as CSSStyleSheet,
      kind: "import" as const,
      sourceOrder: 1,
      origin: {
        kind: "adopted" as const,
        sheet: top as unknown as CSSStyleSheet,
      },
      importChain: [{
        parentSheet: top as unknown as CSSStyleSheet,
        get rule(): never {
          throw new Error("import rule carrier unavailable");
        },
        ruleIndex: 0,
        importedSheet: leaf as unknown as CSSStyleSheet,
        contexts: [],
        unsupported: false,
      }],
    } as unknown as PseudoStatePreviewStylesheet;
    let factoryCalls = 0;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => {
        factoryCalls += 1;
        return unknownAlias as unknown as CSSStyleSheet;
      },
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, identityIncomplete],
      ["hover"],
    );

    expect(factoryCalls).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(unknownAlias.cssRules).toBe(originalRules);
    expect(unknownAlias.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(unknownAlias)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
    expect(environment.document.head?.children).toHaveLength(1);
  });

  it("quarantines later import identities even when an earlier chain step is malformed", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [selectedSource];
    const top = sheet([]);
    const leaf = sheet([]);
    const hiddenImportSheet = sheet([]);
    const originalRules = hiddenImportSheet.cssRules;
    let laterParentReads = 0;
    let laterImportedReads = 0;
    const malformed = {
      scope: environment.document as unknown as Document,
      sheet: leaf as unknown as CSSStyleSheet,
      kind: "import" as const,
      sourceOrder: 1,
      origin: {
        kind: "adopted" as const,
        sheet: top as unknown as CSSStyleSheet,
      },
      importChain: [
        {
          parentSheet: null,
          rule: {},
          ruleIndex: 0,
          importedSheet: null,
          contexts: [],
          unsupported: false,
        },
        {
          get parentSheet() {
            laterParentReads += 1;
            return hiddenImportSheet as unknown as CSSStyleSheet;
          },
          rule: {},
          ruleIndex: 1,
          get importedSheet() {
            laterImportedReads += 1;
            return hiddenImportSheet as unknown as CSSStyleSheet;
          },
          contexts: [],
          unsupported: false,
        },
      ],
    } as unknown as PseudoStatePreviewStylesheet;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => hiddenImportSheet as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, malformed],
      ["hover"],
    );

    expect(laterParentReads).toBe(1);
    expect(laterImportedReads).toBe(1);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(hiddenImportSheet.cssRules).toBe(originalRules);
    expect(hiddenImportSheet.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(hiddenImportSheet)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([selectedSource]);
    expect(environment.document.head?.children).toHaveLength(1);
  });

  it("quarantines the captured live import-rule sheet before rejecting mismatched metadata", () => {
    const environment = createEnvironment();
    const selectedSource = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    const metadataLeaf = sheet([]);
    const hiddenLiveSheet = sheet([]);
    const originalRules = hiddenLiveSheet.cssRules;
    let liveSheetReads = 0;
    const exactImportRule = {
      get styleSheet() {
        liveSheetReads += 1;
        return hiddenLiveSheet;
      },
    };
    const top = sheet([exactImportRule]);
    environment.document.adoptedStyleSheets = [selectedSource, top];
    const mismatchedImport: PseudoStatePreviewStylesheet = {
      scope: environment.document as unknown as Document,
      sheet: metadataLeaf as unknown as CSSStyleSheet,
      kind: "import",
      sourceOrder: 1,
      origin: {
        kind: "adopted",
        sheet: top as unknown as CSSStyleSheet,
      },
      importChain: [{
        parentSheet: top as unknown as CSSStyleSheet,
        rule: exactImportRule,
        ruleIndex: 0,
        importedSheet: metadataLeaf as unknown as CSSStyleSheet,
        contexts: [],
        unsupported: false,
      }],
    };
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => hiddenLiveSheet as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: selectedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }, mismatchedImport],
      ["hover"],
    );

    expect(liveSheetReads).toBe(1);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(hiddenLiveSheet.cssRules).toBe(originalRules);
    expect(hiddenLiveSheet.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(hiddenLiveSheet)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([selectedSource, top]);
    expect(environment.document.head?.children).toHaveLength(1);
  });

  it("revalidates adopted source authority immediately after constructable creation", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [source];
    const candidate = sheet([]);
    const originalRules = candidate.cssRules;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => {
        source.disabled = true;
        return candidate as unknown as CSSStyleSheet;
      },
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("source-provenance-changed");
    expect(candidate.cssRules).toBe(originalRules);
    expect(candidate.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(candidate)).toBe(false);
    expect(environment.document.adoptedStyleSheets).toEqual([source]);
  });

  it.each(["sheet-invalid", "origin-foreign", "import-foreign"] as const)(
    "reads and quarantines a flipping %s identity atomically",
    (variant) => {
      const environment = createEnvironment();
      const selectedSource = sheet([styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )]);
      environment.document.adoptedStyleSheets = [selectedSource];
      const foreignDocument = new FakeRoot("document");
      const first = sheet([]);
      const second = sheet([]);
      const firstRules = first.cssRules;
      const secondRules = second.cssRules;
      let reads = 0;
      let lastRead = first;
      const flipping = (): FakeSheet => {
        lastRead = reads++ === 0 ? first : second;
        return lastRead;
      };
      let hostile: PseudoStatePreviewStylesheet;
      if (variant === "sheet-invalid") {
        hostile = {
          scope: environment.document as unknown as Document,
          get sheet() {
            return flipping() as unknown as CSSStyleSheet;
          },
          kind: "invalid",
          sourceOrder: 1,
        } as unknown as PseudoStatePreviewStylesheet;
      } else if (variant === "origin-foreign") {
        const leaf = sheet([]);
        hostile = {
          scope: foreignDocument as unknown as Document,
          sheet: leaf as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 1,
          get origin() {
            return {
              kind: "adopted" as const,
              sheet: flipping() as unknown as CSSStyleSheet,
            };
          },
        };
      } else {
        const top = sheet([]);
        const leaf = sheet([]);
        hostile = {
          scope: foreignDocument as unknown as Document,
          sheet: leaf as unknown as CSSStyleSheet,
          kind: "import",
          sourceOrder: 1,
          origin: {
            kind: "adopted",
            sheet: top as unknown as CSSStyleSheet,
          },
          get importChain() {
            const imported = flipping();
            return [{
              parentSheet: top as unknown as CSSStyleSheet,
              rule: { styleSheet: imported },
              ruleIndex: 0,
              importedSheet: imported as unknown as CSSStyleSheet,
              contexts: [],
              unsupported: false,
            }];
          },
        };
      }
      const preview = new PseudoStatePreview({
        artifacts: environment.artifacts,
        createConstructableStylesheet: () => lastRead as unknown as CSSStyleSheet,
        createStyleElement: () => (
          environment.document.createElement("style") as unknown as HTMLStyleElement
        ),
      });

      const result = preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: selectedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }, hostile],
        ["hover"],
      );

      expect(reads).toBe(1);
      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
      expect(first.cssRules).toBe(firstRules);
      expect(second.cssRules).toBe(secondRules);
      expect(first.replacedText).toBeUndefined();
      expect(second.replacedText).toBeUndefined();
      expect(environment.artifacts.isRuntimeStylesheet(first)).toBe(false);
      expect(environment.artifacts.isRuntimeStylesheet(second)).toBe(false);
    },
  );

  it("skips an unreadable foreign identity while preserving a valid selected branch", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    let sheetReads = 0;
    const foreignDocument = new FakeRoot("document");
    const hostile = {
      scope: foreignDocument as unknown as Document,
      kind: "adopted",
      sourceOrder: 0,
      get sheet(): never {
        sheetReads += 1;
        throw new Error("sheet identity unavailable");
      },
    } as unknown as PseudoStatePreviewStylesheet;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry, hostile],
      ["hover"],
    );

    expect(sheetReads).toBe(1);
    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 1,
      inaccessibleStylesheetCount: 1,
    });
    expect(result.diagnostics).toContain("stylesheet-inaccessible");
    expect(environment.selected.attributes).toHaveLength(2);
    expect(owner.parentNode?.children).toHaveLength(2);
  });

  it("rejects another input origin sheet exposed as an attached style sheet", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const otherOwner = environment.owner("style");
    const otherEntry = environment.entry(otherOwner, []);
    const otherSheet = otherEntry.sheet as unknown as FakeSheet;
    const expectedCss = `.button[${environment.artifacts.markerNames.hover}]` +
      `:where([${environment.artifacts.markerNames.selection}]){color:red;}`;
    otherSheet.cssRules = previewCssomRules(expectedCss);
    const originalRules = otherSheet.cssRules;
    environment.document.createElement = () => {
      const created = new FakeElement("STYLE", environment.document);
      created.provenRoot = environment.document;
      created.attachStylesheetIfNeeded = () => {
        created.sheet = otherSheet;
      };
      return created;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry, otherEntry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(otherSheet.cssRules).toBe(originalRules);
    expect(otherSheet.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(otherSheet)).toBe(false);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("rejects an owner-backed sheet returned by the constructable factory", () => {
    const environment = createEnvironment();
    const source = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.document.adoptedStyleSheets = [source];
    const foreignOwner = environment.owner("style");
    const foreignSheet = sheet([]);
    foreignSheet.ownerNode = foreignOwner;
    foreignOwner.sheet = foreignSheet;
    const originalRules = foreignSheet.cssRules;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: () => foreignSheet as unknown as CSSStyleSheet,
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(foreignSheet.replacedText).toBeUndefined();
    expect(foreignSheet.cssRules).toBe(originalRules);
    expect(environment.artifacts.isRuntimeStylesheet(foreignSheet)).toBe(false);
  });

  it("rejects an owner-backed sheet exposed by an attached style element", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const foreignOwner = environment.owner("style");
    const expectedCss = `.button[${environment.artifacts.markerNames.hover}]` +
      `:where([${environment.artifacts.markerNames.selection}]){color:red;}`;
    const foreignSheet = sheet(previewCssomRules(expectedCss));
    foreignSheet.ownerNode = foreignOwner;
    foreignOwner.sheet = foreignSheet;
    const originalRules = foreignSheet.cssRules;
    environment.document.createElement = () => {
      const created = new FakeElement("STYLE", environment.document);
      created.provenRoot = environment.document;
      created.attachStylesheetIfNeeded = () => {
        created.sheet = foreignSheet;
      };
      return created;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(foreignSheet.cssRules).toBe(originalRules);
    expect(foreignSheet.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(foreignSheet)).toBe(false);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("fails closed before constructable work when adopted source authority is oversized", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(".button:hover", [["color", "red", ""]])]);
    const pageSheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets * 2 },
      () => sheet([]),
    );
    environment.document.adoptedStyleSheets = [source, ...pageSheets];
    let factoryCalls = 0;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet() {
        factoryCalls += 1;
        return sheet([]) as unknown as CSSStyleSheet;
      },
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
    expect(factoryCalls).toBe(0);
    expect(environment.document.adoptedStyleSheets).toEqual([source, ...pageSheets]);
  });

  it("reserves one runtime slot when the adopted list is exactly at its scan cap", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    const pageSheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets * 2 - 1 },
      () => sheet([]),
    );
    const original = [source, ...pageSheets];
    environment.document.adoptedStyleSheets = original;
    let factoryCalls = 0;
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet() {
        factoryCalls += 1;
        return sheet([]) as unknown as CSSStyleSheet;
      },
      createStyleElement: () => (
        environment.document.createElement("style") as unknown as HTMLStyleElement
      ),
    });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(factoryCalls).toBe(0);
    expect(environment.document.adoptedStyleSheets).toEqual(original);
    expect(environment.document.head?.children.at(-1)?.tagName).toBe("STYLE");
    expect(preview.clear()).toEqual({ complete: true, failureCount: 0 });
    expect(environment.document.adoptedStyleSheets).toEqual(original);
  });

  it.each(["source-owner", "attached-page-style"] as const)(
    "never mutates or removes a %s returned by document.createElement",
    (variant) => {
      const environment = createEnvironment();
      const owner = environment.owner("style");
      const entry = environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      const pageParent = new FakeRoot("document");
      pageParent.provenRoot = environment.document;
      const pageStyle = new FakeElement("STYLE", environment.document);
      pageStyle.provenRoot = environment.document;
      pageStyle.sheet = sheet([styleRule(".page", [["color", "blue", ""]])]);
      pageParent.append(pageStyle);
      const candidate = variant === "source-owner" ? owner : pageStyle;
      const originalParent = candidate.parentNode;
      const originalRules = candidate.sheet?.cssRules;
      environment.document.createElement = () => candidate;

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry],
        ["hover"],
      );

      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
      expect(candidate.parentNode).toBe(originalParent);
      expect(candidate.textContent).toBe("");
      expect(candidate.sheet?.cssRules).toBe(originalRules);
      expect(candidate.attributes).toEqual([]);
    },
  );

  it("never reuses a detached style node retained in runtime history", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const historical = new FakeElement("STYLE", environment.document);
    environment.artifacts.registerStyleNode(historical as unknown as HTMLStyleElement);
    expect(environment.artifacts.cleanup()).toMatchObject({ complete: true });
    environment.document.createElement = () => historical;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(historical.textContent).toBe("");
    expect(historical.attributes).toEqual([]);
  });

  it("never mutates an existing detached page style returned by createElement", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const pageStyle = new FakeElement("STYLE", environment.document);
    pageStyle.setAttribute("data-page-owner", "true");
    environment.document.createElement = () => pageStyle;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(pageStyle.parentNode).toBeNull();
    expect(pageStyle.textContent).toBe("");
    expect(pageStyle.attributes).toEqual([{
      name: "data-page-owner",
      value: "true",
      ownerElement: pageStyle,
    }]);
    expect(environment.artifacts.isRuntimeNode(pageStyle as unknown as Node)).toBe(false);
  });

  it("never calls a page-overridable createElement from the production style path", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    const retained = new FakeElement("STYLE", environment.document);
    let pageCreateCalls = 0;
    environment.document.createElement = () => {
      pageCreateCalls += 1;
      return retained;
    };
    const preview = new PseudoStatePreview({ artifacts: environment.artifacts });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(pageCreateCalls).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(retained.textContent).toBe("");
    expect(retained.attributes).toEqual([]);
    expect(environment.artifacts.isRuntimeNode(retained as unknown as Node)).toBe(false);
  });

  it("never calls a page-realm CSSStyleSheet constructor from the production path", () => {
    const environment = createEnvironment();
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    environment.document.adoptedStyleSheets = [source];
    const retained = sheet([]);
    const originalRules = retained.cssRules;
    let pageConstructorCalls = 0;
    environment.document.defaultView.CSSStyleSheet = class {
      public constructor() {
        pageConstructorCalls += 1;
        return retained;
      }
    } as unknown as new () => FakeSheet;
    const preview = new PseudoStatePreview({ artifacts: environment.artifacts });

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(pageConstructorCalls).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(environment.document.adoptedStyleSheets).toEqual([source]);
    expect(retained.cssRules).toBe(originalRules);
    expect(retained.replacedText).toBeUndefined();
    expect(environment.artifacts.isRuntimeStylesheet(retained)).toBe(false);
  });

  it("registers an attached mirror sheet before any hostile CSSOM verification read", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const createElement = environment.document.createElement.bind(environment.document);
    let excludedDuringFirstRead: boolean | undefined;
    environment.document.createElement = (tagName) => {
      const created = createElement(tagName);
      const pending = created.pendingSheet!;
      let rules = pending.cssRules;
      Object.defineProperty(pending, "cssRules", {
        configurable: true,
        get() {
          excludedDuringFirstRead ??= environment.artifacts.isRuntimeStylesheet(pending);
          return rules;
        },
        set(value: readonly object[]) {
          rules = value;
        },
      });
      return created;
    };

    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 1 });
    expect(excludedDuringFirstRead).toBe(true);
  });

  it("mounts a trusted STYLE whose stylesheet identity rotates on insertion", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    const detachedSheet = sheet([]);
    const mountedSheet = sheet([]);
    let createdStyle: FakeElement | undefined;
    environment.document.createElement = () => {
      const created = new FakeElement("STYLE", environment.document);
      created.provenRoot = environment.document;
      created.pendingSheet = null;
      created.attachStylesheetIfNeeded = () => {
        const selected = created.textContent === "" ? detachedSheet : mountedSheet;
        detachedSheet.ownerNode = selected === detachedSheet ? created : null;
        mountedSheet.ownerNode = selected === mountedSheet ? created : null;
        created.sheet = selected;
        selected.replaceSync(created.textContent);
      };
      created.onTextContentWrite = (value) => {
        if (!created.parentNode || value === "") return;
        detachedSheet.ownerNode = null;
        mountedSheet.ownerNode = created;
        mountedSheet.replaceSync(value);
        created.sheet = mountedSheet;
      };
      createdStyle = created;
      return created;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(createdStyle?.sheet).toBe(mountedSheet);
    expect(environment.artifacts.isRuntimeStylesheet(mountedSheet)).toBe(true);
    expect(detachedSheet.ownerNode).toBeNull();
    expect(environment.preview.clear()).toEqual({ complete: true, failureCount: 0 });
    expect(createdStyle?.textContent).toBe("");
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("rechecks exact marker authority after the last mounted CSSOM read", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const createElement = environment.document.createElement.bind(environment.document);
    environment.document.createElement = (tagName) => {
      const created = createElement(tagName);
      const pending = created.pendingSheet!;
      let rules = pending.cssRules;
      let reads = 0;
      Object.defineProperty(pending, "cssRules", {
        configurable: true,
        get() {
          reads += 1;
          if (reads === 2) {
            const marker = environment.selected.getAttributeNode(
              environment.artifacts.markerNames.hover,
            );
            if (marker) environment.selected.removeAttributeNode(marker);
          }
          return rules;
        },
        set(value: readonly object[]) {
          rules = value;
        },
      });
      return created;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("transaction-authority-lost");
    expect(environment.preview.activeStates).toEqual([]);
    expect(environment.selected.attributes).toEqual([]);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("removes a partially inserted style node and rejects a reparented source owner", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    owner.parentNode!.insertMode = "throw-after-insert";
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);

    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });
    expect(owner.parentNode?.children).toEqual([owner]);

    const foreignRoot = new FakeRoot("document");
    foreignRoot.append(owner);
    owner.provenRoot = foreignRoot;
    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });
    expect(foreignRoot.children).toEqual([owner]);
  });

  it("does not rewrite ampersands inside selector strings while resolving nesting", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const nested = {
      selectorText: ".card",
      style: declaration([]),
      cssRules: [styleRule(
        `[data-label="&"].button:hover`,
        [["color", "blue", ""]],
      )],
    };

    environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [nested])],
      ["hover"],
    );

    expect(owner.parentNode?.children[1]?.textContent).toContain(
      `:is(.card) [data-label="&"].button[${environment.artifacts.markerNames.hover}]`,
    );
  });

  it("preserves proven owner and sheet media while rejecting inactive sources", () => {
    const mediaEnvironment = createEnvironment();
    const mediaOwner = mediaEnvironment.owner("link");
    mediaOwner.setAttribute("media", "(min-width: 40rem)");
    const mediaEntry = mediaEnvironment.entry(mediaOwner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    (mediaEntry.sheet as unknown as FakeSheet).media.mediaText =
      "(prefers-color-scheme: dark)";

    expect(mediaEnvironment.preview.apply(
      mediaEnvironment.selected as unknown as Element,
      [mediaEntry],
      ["hover"],
    ).mountedRuleCount).toBe(1);
    const mediaCss = mediaOwner.parentNode?.children[1]?.textContent ?? "";
    expect(mediaCss).toContain("@media (min-width: 40rem)");
    expect(mediaCss).toContain("@media (prefers-color-scheme: dark)");

    for (const inactive of ["owner-disabled", "alternate", "sheet-disabled"] as const) {
      const environment = createEnvironment();
      const owner = environment.owner("link");
      if (inactive === "owner-disabled") owner.disabled = true;
      if (inactive === "alternate") owner.setAttribute("rel", "stylesheet alternate");
      const entry = environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      if (inactive === "sheet-disabled") {
        (entry.sheet as unknown as FakeSheet).disabled = true;
      }

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry],
        ["hover"],
      );
      expect(result.mountedRuleCount, inactive).toBe(0);
      expect(result.diagnostics, inactive).toContain("source-inapplicable");
      expect(owner.parentNode?.children, inactive).toEqual([owner]);
    }
  });

  it("revalidates exact owner, sheet, and adopted-source provenance at mount", () => {
    const changedEnvironment = createEnvironment();
    const changedOwner = changedEnvironment.owner("style");
    const changedEntry = changedEnvironment.entry(changedOwner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const changedSheet = changedEntry.sheet as unknown as FakeSheet;
    const rules = changedSheet.cssRules;
    Object.defineProperty(changedSheet, "cssRules", {
      configurable: true,
      get() {
        changedOwner.disabled = true;
        return rules;
      },
    });
    expect(changedEnvironment.preview.apply(
      changedEnvironment.selected as unknown as Element,
      [changedEntry],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });

    const swappedEnvironment = createEnvironment();
    const swappedOwner = swappedEnvironment.owner("style");
    const swappedEntry = swappedEnvironment.entry(swappedOwner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    swappedOwner.sheet = sheet([]);
    expect(swappedEnvironment.preview.apply(
      swappedEnvironment.selected as unknown as Element,
      [swappedEntry],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });

    const ownerlessEnvironment = createEnvironment();
    const ownerlessOwner = ownerlessEnvironment.owner("style");
    const ownerlessEntry = ownerlessEnvironment.entry(ownerlessOwner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    expect(ownerlessEnvironment.preview.apply(
      ownerlessEnvironment.selected as unknown as Element,
      [{ ...ownerlessEntry, owner: undefined, ownerState: undefined }],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });

    const adoptedEnvironment = createEnvironment();
    const adoptedSource = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    expect(adoptedEnvironment.preview.apply(
      adoptedEnvironment.selected as unknown as Element,
      [{
        scope: adoptedEnvironment.document as unknown as Document,
        sheet: adoptedSource as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });
  });

  it("rejects hostile owner applicability before reading source declarations", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    let declarationReads = 0;
    const entry = environment.entry(owner, [{
      selectorText: ".button:hover",
      style: {
        get length() {
          declarationReads += 1;
          return 1;
        },
        item: () => "color",
        getPropertyValue: () => "red",
        getPropertyPriority: () => "",
      },
    }]);
    Object.defineProperty(owner, "disabled", {
      configurable: true,
      get() {
        throw new Error("owner applicability unavailable");
      },
    });

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(declarationReads).toBe(0);
  });

  it("bounds raw iterable attempts and rejects malformed or truncated rule lists", () => {
    const iterableEnvironment = createEnvironment();
    const iterableOwner = iterableEnvironment.owner("style");
    let pulls = 0;
    const rules = {
      [Symbol.iterator]() {
        return {
          next(): IteratorResult<unknown> {
            pulls += 1;
            if (pulls <= INSPECT_LIMITS.cssRules + 100) {
              return { done: false, value: 1 };
            }
            if (pulls === INSPECT_LIMITS.cssRules + 101) {
              return {
                done: false,
                value: styleRule(".button:hover", [["color", "red", ""]]),
              };
            }
            return { done: true, value: undefined };
          },
        };
      },
    };
    const iterableEntry = iterableEnvironment.entry(iterableOwner, []);
    (iterableEntry.sheet as unknown as FakeSheet).cssRules =
      rules as unknown as readonly object[];

    const iterableResult = iterableEnvironment.preview.apply(
      iterableEnvironment.selected as unknown as Element,
      [iterableEntry],
      ["hover"],
    );

    expect(iterableResult).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(iterableResult.diagnostics).toContain("stylesheet-truncated");
    expect(pulls).toBeLessThanOrEqual(INSPECT_LIMITS.cssRules + 1);

    const malformedEnvironment = createEnvironment();
    const malformedOwner = malformedEnvironment.owner("style");
    const malformedEntry = malformedEnvironment.entry(malformedOwner, []);
    (malformedEntry.sheet as unknown as FakeSheet).cssRules = [
      1,
      styleRule(".button:hover", [["color", "red", ""]]),
    ] as unknown as readonly object[];
    const malformedResult = malformedEnvironment.preview.apply(
      malformedEnvironment.selected as unknown as Element,
      [malformedEntry],
      ["hover"],
    );
    expect(malformedResult).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(malformedResult.diagnostics).toContain("stylesheet-inaccessible");

    const truncatedEnvironment = createEnvironment();
    const truncatedOwner = truncatedEnvironment.owner("style");
    const truncatedEntry = truncatedEnvironment.entry(truncatedOwner, [
      styleRule(".button:hover", [["color", "red", ""]]),
      ...Array.from({ length: INSPECT_LIMITS.cssRules }, () => ({})),
    ]);
    const truncatedResult = truncatedEnvironment.preview.apply(
      truncatedEnvironment.selected as unknown as Element,
      [truncatedEntry],
      ["hover"],
    );
    expect(truncatedResult).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(truncatedResult.diagnostics).toContain("stylesheet-truncated");
  });

  it("fails closed when the outer stylesheet length is hostile", () => {
    const environment = createEnvironment();
    const stylesheets = new Proxy([] as PseudoStatePreviewStylesheet[], {
      get(target, property, receiver) {
        if (property === "length") throw new Error("stylesheet length unavailable");
        return Reflect.get(target, property, receiver);
      },
    });
    let result: ReturnType<PseudoStatePreview["apply"]> | undefined;

    expect(() => {
      result = environment.preview.apply(
        environment.selected as unknown as Element,
        stylesheets,
        ["hover"],
      );
    }).not.toThrow();
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(result?.diagnostics).toContain("stylesheet-inaccessible");
  });

  it("reports an outer stylesheet overflow instead of silently taking a prefix", () => {
    const environment = createEnvironment();
    const stylesheets = Array.from(
      { length: INSPECT_LIMITS.stylesheets + 1 },
      () => ({}) as PseudoStatePreviewStylesheet,
    );

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      stylesheets,
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 1,
    });
    expect(result.diagnostics).toContain("stylesheet-truncated");
  });

  it.each([
    "missing-disabled",
    "missing-media",
    "missing-href",
    "hostile-disabled",
    "hostile-media",
    "hostile-href",
  ] as const)("fails closed for %s stylesheet state", (variant) => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const target = entry.sheet as unknown as FakeSheet;
    const property = variant.endsWith("disabled")
      ? "disabled"
      : variant.endsWith("media") ? "media" : "href";
    if (variant.startsWith("missing")) {
      Reflect.deleteProperty(target, property);
    } else {
      Object.defineProperty(target, property, {
        configurable: true,
        get() {
          throw new Error("stylesheet state unavailable");
        },
      });
    }

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result, variant).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
    expect(result.diagnostics, variant).toContain("stylesheet-inaccessible");
    expect(owner.parentNode?.children, variant).toEqual([owner]);
  });

  it.each([
    "source-url",
    "rule-path",
    "owner-rel",
    "sheet-href",
    "sheet-media",
  ] as const)("rejects oversized %s before parsing or normalization", (variant) => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    if (variant === "owner-rel") {
      owner.setAttribute("rel", "x".repeat(INSPECT_LIMITS.valueLength + 1));
    }
    const base = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    const oversizedUrl = "https://example.test/" +
      "x".repeat(INSPECT_LIMITS.urlLength + 1);
    const entry: PseudoStatePreviewStylesheet = variant === "source-url"
      ? { ...base, sourceUrl: oversizedUrl }
      : variant === "rule-path"
        ? { ...base, rulePathPrefix: "0".repeat(INSPECT_LIMITS.valueLength + 1) }
        : base;
    if (variant === "sheet-href") {
      (base.sheet as unknown as FakeSheet).href = oversizedUrl;
    }
    if (variant === "sheet-media") {
      (base.sheet as unknown as FakeSheet).media.mediaText =
        "x".repeat(INSPECT_LIMITS.valueLength + 1);
    }

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(result, variant).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
  });

  it.each(["external-mismatch", "owner-injected", "adopted-injected"] as const)(
    "rejects unproven stylesheet source URL authority for %s",
    (variant) => {
      const environment = createEnvironment();
      const owner = environment.owner("style");
      let declarationReads = 0;
      const rules = [{
        selectorText: ".button:hover",
        get style() {
          declarationReads += 1;
          return declaration([["background", "url(./asset.png)", ""]]);
        },
      }];
      let entry: PseudoStatePreviewStylesheet;
      if (variant === "external-mismatch") {
        entry = {
          ...environment.entry(owner, rules, "https://a.example/app.css"),
          sourceUrl: "https://b.example/app.css",
        };
      } else if (variant === "owner-injected") {
        entry = {
          ...environment.entry(owner, rules),
          sourceUrl: "https://b.example/app.css",
        };
      } else {
        const source = sheet(rules);
        environment.document.adoptedStyleSheets = [source];
        entry = {
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
          sourceUrl: "https://b.example/app.css",
        };
      }

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry],
        ["hover"],
      );

      expect(result).toMatchObject({
        states: ["hover"],
        mountedRuleCount: 0,
        inaccessibleStylesheetCount: 1,
      });
      expect(declarationReads).toBe(0);
    },
  );

  it("reconstructs proven import media/supports and rejects layer provenance", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    const imported = sheet([
      styleRule(".button:hover", [["color", "purple", ""]]),
    ]);
    const importRule = {
      styleSheet: imported,
      supportsText: "(display: grid)",
      media: { mediaText: "(min-width: 40rem)" },
    };
    const top = sheet([importRule]);
    owner.sheet = top;
    const base = environment.entry(owner, []);
    owner.sheet = top;
    const entry = {
      ...base,
      sheet: imported as unknown as CSSStyleSheet,
      kind: "import" as const,
      rulePathPrefix: "0",
      origin: {
        kind: "owner" as const,
        sheet: top as unknown as CSSStyleSheet,
        owner: owner as unknown as Element,
      },
      importChain: [{
        parentSheet: top as unknown as CSSStyleSheet,
        rule: importRule,
        ruleIndex: 0,
        importedSheet: imported as unknown as CSSStyleSheet,
        contexts: [
          { kind: "supports" as const, text: "(display: grid)" },
          { kind: "media" as const, text: "(min-width: 40rem)" },
        ],
        unsupported: false,
      }],
      importContexts: [
        { kind: "supports" as const, text: "(display: grid)" },
        { kind: "media" as const, text: "(min-width: 40rem)" },
      ],
    };

    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    ).mountedRuleCount).toBe(1);
    const css = owner.parentNode?.children[1]?.textContent ?? "";
    expect(css).toContain("@supports (display: grid)");
    expect(css).toContain("@media (min-width: 40rem)");

    environment.preview.clear();
    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [{ ...entry, importContextUnsupported: true }],
      ["hover"],
    )).toMatchObject({
      mountedRuleCount: 0,
      unsupportedRuleCount: 1,
      inaccessibleStylesheetCount: 0,
    });
  });

  it("accepts a registry snapshot import entry as the exact preview provenance", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    const imported = sheet([
      styleRule(".button:hover", [["color", "purple", ""]]),
    ], "https://cdn.example.test/imported.css");
    const top = sheet([{
      styleSheet: imported,
      media: { mediaText: "(min-width: 40rem)" },
    }], "https://cdn.example.test/top.css");
    owner.sheet = top;
    Object.assign(top, { ownerNode: owner });
    const registry = new StylesheetRegistry({
      document: environment.document as unknown as Document,
      contentSessionId: "preview-registry-handoff",
      documentEpoch: 1,
    });
    const entry = registry.snapshot().entries.find(({ sheet: candidate }) => (
      candidate === imported as unknown as CSSStyleSheet
    ));

    expect(entry).toBeDefined();
    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry!],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(owner.parentNode?.children[1]?.textContent)
      .toContain("@media (min-width: 40rem)");
    registry.dispose();
  });

  it.each([
    "owner-sheet",
    "rule-object",
    "imported-sheet",
    "media",
    "layer",
  ] as const)(
    "rejects a changed exact import %s before reading leaf rules",
    (mutation) => {
      const environment = createEnvironment();
      const owner = environment.owner("link");
      const leafRules = [styleRule(".button:hover", [["color", "purple", ""]])];
      const leaf = sheet(leafRules, "https://cdn.example.test/leaf.css");
      let leafRuleReads = 0;
      Object.defineProperty(leaf, "cssRules", {
        configurable: true,
        get() {
          leafRuleReads += 1;
          return leafRules;
        },
      });
      const exactImport: Record<string, unknown> = { styleSheet: leaf };
      const rootRules: object[] = [exactImport];
      const top = sheet(rootRules, "https://cdn.example.test/top.css");
      owner.sheet = top;
      Object.assign(top, { ownerNode: owner });
      const registry = new StylesheetRegistry({
        document: environment.document as unknown as Document,
        contentSessionId: `preview-import-change-${mutation}`,
        documentEpoch: 1,
      });
      const entry = registry.snapshot().entries.find(({ sheet: candidate }) => (
        candidate === leaf as unknown as CSSStyleSheet
      ));
      expect(entry).toBeDefined();
      leafRuleReads = 0;

      if (mutation === "owner-sheet") owner.sheet = sheet([]);
      if (mutation === "rule-object") rootRules[0] = { styleSheet: leaf };
      if (mutation === "imported-sheet") exactImport.styleSheet = sheet([]);
      if (mutation === "media") exactImport.media = { mediaText: "print" };
      if (mutation === "layer") exactImport.layerName = "theme";

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry!],
        ["hover"],
      );

      expect(result).toMatchObject({
        states: ["hover"],
        mountedRuleCount: 0,
        unsupportedRuleCount: 0,
        inaccessibleStylesheetCount: 1,
      });
      expect(leafRuleReads).toBe(0);
      registry.dispose();
    },
  );

  it("mounts an imported registry entry beside its exact adopted top origin", () => {
    const environment = createEnvironment();
    const before = sheet([]);
    const leaf = sheet([
      styleRule(".button:hover", [["color", "purple", ""]]),
    ], "https://cdn.example.test/leaf.css");
    const exactImport = {
      styleSheet: leaf,
      media: { mediaText: "(min-width: 40rem)" },
    };
    const top = sheet([exactImport]);
    const after = sheet([]);
    environment.document.adoptedStyleSheets = [before, top, after];
    const registry = new StylesheetRegistry({
      document: environment.document as unknown as Document,
      contentSessionId: "preview-adopted-import",
      documentEpoch: 1,
    });
    const entry = registry.snapshot().entries.find(({ sheet: candidate }) => (
      candidate === leaf as unknown as CSSStyleSheet
    ));

    expect(entry?.origin).toEqual({ kind: "adopted", sheet: top });
    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry!],
      ["hover"],
    );

    expect(result.mountedRuleCount).toBe(1);
    expect(environment.document.adoptedStyleSheets[1]).toBe(top);
    expect(environment.document.adoptedStyleSheets[2]).not.toBe(leaf);
    expect((environment.document.adoptedStyleSheets[2] as FakeSheet).replacedText)
      .toContain("@media (min-width: 40rem)");
    expect(environment.document.children.every(({ tagName }) => tagName !== "STYLE"))
      .toBe(true);
    registry.dispose();
  });

  it("never falls back when an imported adopted top origin is no longer active", () => {
    const environment = createEnvironment();
    const leafRules = [styleRule(".button:hover", [["color", "purple", ""]])];
    const leaf = sheet(leafRules);
    const exactImport = { styleSheet: leaf };
    const top = sheet([exactImport]);
    environment.document.adoptedStyleSheets = [top];
    const registry = new StylesheetRegistry({
      document: environment.document as unknown as Document,
      contentSessionId: "preview-adopted-import-removed",
      documentEpoch: 1,
    });
    const entry = registry.snapshot().entries.find(({ sheet: candidate }) => (
      candidate === leaf as unknown as CSSStyleSheet
    ));
    environment.document.adoptedStyleSheets = [];

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry!],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
    expect(environment.document.children.every(({ tagName }) => tagName !== "STYLE"))
      .toBe(true);
    registry.dispose();
  });

  it("preserves CSSNestedDeclarations order and never descends from an unresolved parent", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const parent = {
      selectorText: ".button:hover",
      style: declaration([["color", "red", ""]]),
      cssRules: [
        styleRule("&.active:focus", [["outline", "1px solid", ""]]),
        {
          constructor: { name: "CSSNestedDeclarations" },
          style: declaration([["background", "blue", ""]]),
        },
      ],
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [parent])],
      ["hover", "focus"],
    );
    expect(result.mountedRuleCount).toBe(3);
    const css = owner.parentNode?.children[1]?.textContent ?? "";
    expect(css.indexOf("color:red")).toBeLessThan(css.indexOf("outline:1px solid"));
    expect(css.indexOf("outline:1px solid")).toBeLessThan(css.indexOf("background:blue"));

    environment.preview.clear();
    let childDeclarationReads = 0;
    const unresolved = {
      selectorText: "&:hover",
      style: declaration([]),
      cssRules: [{
        selectorText: "& .child:hover",
        style: {
          get length() {
            childDeclarationReads += 1;
            return 1;
          },
          item: () => "color",
          getPropertyValue: () => "red",
          getPropertyPriority: () => "",
        },
      }],
    };
    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [unresolved])],
      ["hover"],
    ).mountedRuleCount).toBe(0);
    expect(childDeclarationReads).toBe(0);
  });

  it("verifies committed CSSOM structure and exact immediate adjacency", () => {
    for (const replaceMode of ["no-op", "empty", "unexpected"] as const) {
      const environment = createEnvironment();
      const source = sheet([
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      environment.document.adoptedStyleSheets = [source];
      environment.document.nextConstructableSheetMode = replaceMode;

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [{
          scope: environment.document as unknown as Document,
          sheet: source as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        }],
        ["hover"],
      );
      expect(result.diagnostics, replaceMode).toContain(
        "adopted-sheet-assignment-failed",
      );
      expect(environment.document.adoptedStyleSheets, replaceMode).toEqual([source]);
      if (replaceMode === "unexpected") {
        expect(result, replaceMode).toMatchObject({ states: [], mountedRuleCount: 0 });
        expect(result.diagnostics, replaceMode).toContain("cleanup-incomplete");
        expect(environment.document.head?.children, replaceMode).toEqual([]);
      } else {
        expect(environment.document.head?.children.at(-1)?.tagName, replaceMode)
          .toBe("STYLE");
      }
    }

    const rejectedCssom = createEnvironment();
    const rejectedOwner = rejectedCssom.owner("style");
    rejectedCssom.document.nextStyleSheetMode = "empty";
    expect(rejectedCssom.preview.apply(
      rejectedCssom.selected as unknown as Element,
      [rejectedCssom.entry(rejectedOwner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });
    expect(rejectedOwner.parentNode?.children).toEqual([rejectedOwner]);

    const misplaced = createEnvironment();
    const misplacedOwner = misplaced.owner("style");
    const pageSibling = new FakeElement("META", misplaced.document);
    misplacedOwner.parentNode!.append(pageSibling);
    misplacedOwner.parentNode!.insertMode = "misplace";
    expect(misplaced.preview.apply(
      misplaced.selected as unknown as Element,
      [misplaced.entry(misplacedOwner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    )).toMatchObject({ mountedRuleCount: 0 });
    expect(misplacedOwner.parentNode?.children).toEqual([misplacedOwner, pageSibling]);
  });

  it("rejects same-count wrong CSSOM, uncommitted style text, and a foreign style root", () => {
    const wrongCssom = createEnvironment();
    const wrongCssomOwner = wrongCssom.owner("style");
    wrongCssom.document.nextStyleSheetMode = "same-count-wrong";
    expect(wrongCssom.preview.apply(
      wrongCssom.selected as unknown as Element,
      [wrongCssom.entry(wrongCssomOwner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    )).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(wrongCssomOwner.parentNode?.children).toEqual([wrongCssomOwner]);

    const uncommittedText = createEnvironment();
    const uncommittedTextOwner = uncommittedText.owner("style");
    uncommittedText.document.nextStyleTextMode = "no-op";
    expect(uncommittedText.preview.apply(
      uncommittedText.selected as unknown as Element,
      [uncommittedText.entry(uncommittedTextOwner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    )).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(uncommittedTextOwner.parentNode?.children).toEqual([uncommittedTextOwner]);

    const foreignRoot = createEnvironment();
    const foreignRootOwner = foreignRoot.owner("style");
    foreignRoot.document.nextStyleProvenRoot = new FakeRoot("document");
    expect(foreignRoot.preview.apply(
      foreignRoot.selected as unknown as Element,
      [foreignRoot.entry(foreignRootOwner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    )).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(foreignRootOwner.parentNode?.children).toEqual([foreignRootOwner]);
  });

  it("rolls back when selection, source, or mount authority changes during marker installation", () => {
    const mutations: Array<(environment: ReturnType<typeof createEnvironment>, owner: FakeElement) => void> = [
      (_environment, owner) => {
        owner.disabled = true;
      },
      (environment) => {
        environment.selected.provenRoot = new FakeRoot("document");
      },
      (_environment, owner) => {
        const mirror = owner.parentNode?.children[1];
        if (mirror) owner.parentNode?.remove(mirror);
      },
    ];

    for (const mutate of mutations) {
      const environment = createEnvironment();
      const owner = environment.owner("style");
      let markerWrites = 0;
      environment.selected.onAttributeNodeInsert = () => {
        markerWrites += 1;
        if (markerWrites === 2) mutate(environment, owner);
      };
      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [environment.entry(owner, [
          styleRule(".button:hover", [["color", "red", ""]]),
        ])],
        ["hover"],
      );

      expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
      expect(environment.preview.activeStates).toEqual([]);
      expect(environment.selected.attributes).toEqual([]);
      expect(owner.parentNode?.children).toEqual([owner]);
    }
  });

  it("revalidates frozen leaf semantics before mount and after marker installation", () => {
    const preMount = createEnvironment();
    const preMountOwner = preMount.owner("style");
    let preMountValue = "red";
    let preMountReads = 0;
    const mutatingDeclaration = {
      length: 1,
      item: () => "color",
      getPropertyValue: () => {
        preMountReads += 1;
        const value = preMountValue;
        if (preMountReads === 1) preMountValue = "blue";
        return value;
      },
      getPropertyPriority: () => "",
    };
    const preMountResult = preMount.preview.apply(
      preMount.selected as unknown as Element,
      [preMount.entry(preMountOwner, [{
        selectorText: ".button:hover",
        style: mutatingDeclaration,
      }])],
      ["hover"],
    );
    expect(preMountResult).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
    expect(preMountResult.diagnostics).toContain("source-provenance-changed");
    expect(preMountOwner.parentNode?.children).toEqual([preMountOwner]);

    const final = createEnvironment();
    const finalOwner = final.owner("style");
    let finalValue = "red";
    const finalDeclaration = {
      length: 1,
      item: () => "color",
      getPropertyValue: () => finalValue,
      getPropertyPriority: () => "",
    };
    let markerWrites = 0;
    final.selected.onAttributeNodeInsert = () => {
      markerWrites += 1;
      if (markerWrites === 2) finalValue = "blue";
    };
    const finalResult = final.preview.apply(
      final.selected as unknown as Element,
      [final.entry(finalOwner, [{
        selectorText: ".button:hover",
        style: finalDeclaration,
      }])],
      ["hover"],
    );
    expect(finalResult).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(finalResult.diagnostics).toContain("transaction-authority-lost");
    expect(final.preview.activeStates).toEqual([]);
    expect(final.selected.attributes).toEqual([]);
    expect(finalOwner.parentNode?.children).toEqual([finalOwner]);
  });

  it("revalidates a readable zero-match source after marker installation", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const changingRule = styleRule(".button", [["color", "red", ""]]);
    let markerWrites = 0;
    environment.selected.onAttributeNodeInsert = () => {
      markerWrites += 1;
      if (markerWrites === 2) changingRule.selectorText = ".button:hover";
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [changingRule])],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("transaction-authority-lost");
    expect(environment.preview.activeStates).toEqual([]);
    expect(environment.selected.attributes).toEqual([]);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("revalidates unsupported semantic outcomes for unchanged rule objects", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const changingRule = styleRule(".button", [["color", "red", ""]]);
    let markerWrites = 0;
    environment.selected.onAttributeNodeInsert = () => {
      markerWrites += 1;
      if (markerWrites === 2) changingRule.selectorText = ".ancestor:hover .button";
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [changingRule])],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("transaction-authority-lost");
    expect(environment.preview.activeStates).toEqual([]);
    expect(environment.selected.attributes).toEqual([]);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("rolls back when an inapplicable source becomes applicable during marker installation", () => {
    const cases = [
      {
        makeInapplicable(owner: FakeElement) {
          owner.disabled = true;
        },
        makeApplicable(owner: FakeElement) {
          owner.disabled = false;
        },
      },
      {
        makeInapplicable(owner: FakeElement) {
          owner.setAttribute("rel", "alternate stylesheet");
        },
        makeApplicable(owner: FakeElement) {
          owner.setAttribute("rel", "stylesheet");
        },
      },
    ];

    for (const testCase of cases) {
      const environment = createEnvironment();
      const owner = environment.owner("style");
      testCase.makeInapplicable(owner);
      const entry = environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      let markerWrites = 0;
      environment.selected.onAttributeNodeInsert = () => {
        markerWrites += 1;
        if (markerWrites === 2) testCase.makeApplicable(owner);
      };

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry],
        ["hover"],
      );

      expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
      expect(result.diagnostics).toContain("transaction-authority-lost");
      expect(environment.preview.activeStates).toEqual([]);
      expect(environment.selected.attributes).toEqual([]);
      expect(owner.parentNode?.children).toEqual([owner]);
    }
  });

  it("does not activate markers after a mixed mount failure with incomplete cleanup", () => {
    const environment = createEnvironment();
    const firstOwner = environment.owner("style");
    const failingOwner = environment.owner("style");
    failingOwner.parentNode!.insertMode = "throw-after-insert";
    failingOwner.parentNode!.rejectChildRemoval = true;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [
        environment.entry(firstOwner, [
          styleRule(".button:hover", [["color", "green", ""]]),
        ]),
        environment.entry(failingOwner, [
          styleRule(".button:hover", [["color", "red", ""]]),
        ]),
      ],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: [],
      mountedRuleCount: 0,
      diagnostics: expect.arrayContaining(["cleanup-incomplete"]),
    });
    expect(environment.selected.attributes).toEqual([]);
    expect(environment.preview.activeStates).toEqual([]);
    expect(firstOwner.parentNode?.children).toEqual([firstOwner]);
    expect(failingOwner.parentNode?.children).toHaveLength(2);

    failingOwner.parentNode!.rejectChildRemoval = false;
    expect(environment.preview.clear()).toEqual({ complete: true, failureCount: 0 });
    expect(failingOwner.parentNode?.children).toEqual([failingOwner]);
  });

  it("keeps successful mounts active when another source changes during its mount", () => {
    const environment = createEnvironment();
    const adoptedSource = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.document.adoptedStyleSheets = [adoptedSource];
    const owner = environment.owner("style");
    environment.document.onConstructableStylesheetCreated = () => {
      adoptedSource.disabled = true;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [
        {
          scope: environment.document as unknown as Document,
          sheet: adoptedSource as unknown as CSSStyleSheet,
          kind: "adopted",
          sourceOrder: 0,
        },
        environment.entry(owner, [
          styleRule(".button:hover", [["background", "blue", ""]]),
        ]),
      ],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 1,
      inaccessibleStylesheetCount: 1,
    });
    expect(result.diagnostics).not.toContain("transaction-authority-lost");
    expect(environment.preview.activeStates).toEqual(["hover"]);
    expect(owner.parentNode?.children).toHaveLength(2);
  });

  it("captures only requested pseudos and preserves safe native unrequested pseudos", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:focus", [["color", "red", ""]]),
      styleRule(".button:hover:focus", [["outline", "1px solid", ""]]),
      styleRule(".button:hover:not(:focus)", [["background", "blue", ""]]),
      styleRule(":is(#critical:focus, .button:hover)", [["border", "1px solid", ""]]),
    ]);

    const hover = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );
    const hoverCss = owner.parentNode?.children[1]?.textContent ?? "";
    expect(hover).toMatchObject({ mountedRuleCount: 2, unsupportedRuleCount: 1 });
    expect(hoverCss).not.toContain(environment.artifacts.markerNames.focus);
    expect(hoverCss).toContain(":focus");
    expect(hoverCss).toContain(":not(:focus)");
    expect(hoverCss).not.toContain("color:red");
    expect(hoverCss).not.toContain("border:1px solid");

    environment.preview.clear();
    const focus = environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["focus"],
    );
    const focusCss = owner.parentNode?.children[1]?.textContent ?? "";
    expect(focus).toMatchObject({ mountedRuleCount: 3, unsupportedRuleCount: 1 });
    expect(focusCss).not.toContain(environment.artifacts.markerNames.hover);
    expect(focusCss).toContain(":hover");
  });

  it("counts unsafe requested branches but not ordinary unaffected branches", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".ok:hover, .parent:hover .selected", [["color", "red", ""]]),
        styleRule(".ok:hover, a", [["background", "blue", ""]]),
        styleRule(":where(> .unsafe:hover, .ok:hover)", [["outline", "1px solid", ""]]),
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 3,
      unsupportedRuleCount: 2,
    });
  });

  it.each(["owner", "adopted"] as const)(
    "groups a full %s registry origin into one cascade-ordered mirror",
    (originKind) => {
      const environment = createEnvironment();
      const firstImport = sheet([
        styleRule(".button:hover", [["color", "red", ""]]),
      ]);
      const secondImport = sheet([
        styleRule(".button:hover", [["background", "blue", ""]]),
      ]);
      const top = sheet([
        { styleSheet: firstImport },
        { styleSheet: secondImport },
        styleRule(".button:hover", [["outline", "1px solid", ""]]),
      ]);
      let owner: FakeElement | undefined;
      const before = sheet([]);
      const after = sheet([]);
      if (originKind === "owner") {
        owner = environment.owner("style");
        owner.sheet = top;
        Object.assign(top, { ownerNode: owner });
      } else {
        environment.document.adoptedStyleSheets = [before, top, after];
      }
      const registry = new StylesheetRegistry({
        document: environment.document as unknown as Document,
        contentSessionId: `preview-group-${originKind}`,
        documentEpoch: 1,
      });
      const entries = registry.snapshot().entries.filter(({ origin }) => (
        origin.sheet === top as unknown as CSSStyleSheet
      ));
      expect(entries).toHaveLength(3);

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        entries,
        ["hover"],
      );

      expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 3 });
      const css = originKind === "owner"
        ? owner!.parentNode?.children[1]?.textContent ?? ""
        : (environment.document.adoptedStyleSheets[2] as FakeSheet).replacedText ?? "";
      expect(css.indexOf("color:red")).toBeLessThan(css.indexOf("background:blue"));
      expect(css.indexOf("background:blue")).toBeLessThan(css.indexOf("outline:1px solid"));
      if (originKind === "owner") {
        expect(owner!.parentNode?.children).toHaveLength(2);
      } else {
        expect(environment.document.adoptedStyleSheets).toHaveLength(4);
        expect(environment.document.adoptedStyleSheets).toEqual([
          before,
          top,
          environment.document.adoptedStyleSheets[2],
          after,
        ]);
      }
      registry.dispose();
    },
  );

  it("keeps stable same-origin parts when one imported leaf changes before mount", () => {
    const environment = createEnvironment();
    const stableImport = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    let changingValue = "blue";
    const changingImport = sheet([{
      selectorText: ".button:hover",
      style: {
        length: 1,
        item: () => "background",
        getPropertyValue: () => changingValue,
        getPropertyPriority: () => "",
      },
    }]);
    const topRule = styleRule(
      ".button:hover",
      [["outline", "1px solid", ""]],
    );
    const top = sheet([
      { styleSheet: stableImport },
      { styleSheet: changingImport },
      topRule,
    ]);
    const owner = environment.owner("style");
    owner.sheet = top;
    top.ownerNode = owner;
    const registry = new StylesheetRegistry({
      document: environment.document as unknown as Document,
      contentSessionId: "preview-group-partial-import",
      documentEpoch: 1,
    });
    const snapshot = registry.snapshot().entries;
    const stable = snapshot.find(({ sheet: candidate }) => (
      candidate === stableImport as unknown as CSSStyleSheet
    ))!;
    const changing = snapshot.find(({ sheet: candidate }) => (
      candidate === changingImport as unknown as CSSStyleSheet
    ))!;
    const root = snapshot.find(({ sheet: candidate }) => (
      candidate === top as unknown as CSSStyleSheet
    ))!;
    let topSelectorReads = 0;
    Object.defineProperty(topRule, "selectorText", {
      configurable: true,
      get() {
        topSelectorReads += 1;
        if (topSelectorReads === 1) changingValue = "purple";
        return ".button:hover";
      },
    });

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [stable, changing, root],
      ["hover"],
    );
    const css = owner.parentNode?.children[1]?.textContent ?? "";

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 2,
      inaccessibleStylesheetCount: 1,
    });
    expect(css).toContain("color:red");
    expect(css).toContain("outline:1px solid");
    expect(css).not.toContain("background:");
    expect(owner.parentNode?.children).toHaveLength(2);
    registry.dispose();
  });

  it("keeps stable rules from a sheet with a hostile later nested branch", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const hostileGroup = {
      constructor: { name: "CSSMediaRule" },
      conditionText: "screen",
      get cssRules(): never {
        throw new Error("nested rules unavailable");
      },
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [["color", "green", ""]]),
        hostileGroup,
      ])],
      ["hover"],
    );
    const css = owner.parentNode?.children[1]?.textContent ?? "";

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 1,
      inaccessibleStylesheetCount: 1,
    });
    expect(css).toContain("color:green");
    expect(result.diagnostics).toContain("stylesheet-inaccessible");
  });

  it("reports hostile nested rules and selector rules without a declaration object", () => {
    const hostileGroupEnvironment = createEnvironment();
    const hostileGroupOwner = hostileGroupEnvironment.owner("style");
    const hostileGroup = {
      constructor: { name: "CSSMediaRule" },
      conditionText: "screen",
      get cssRules(): never {
        throw new Error("nested rules unavailable");
      },
    };
    const hostileGroupResult = hostileGroupEnvironment.preview.apply(
      hostileGroupEnvironment.selected as unknown as Element,
      [hostileGroupEnvironment.entry(hostileGroupOwner, [hostileGroup])],
      ["hover"],
    );
    expect(hostileGroupResult).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 0,
      inaccessibleStylesheetCount: 1,
    });
    expect(hostileGroupResult.diagnostics).toContain("stylesheet-inaccessible");

    const missingStyleEnvironment = createEnvironment();
    const missingStyleOwner = missingStyleEnvironment.owner("style");
    const missingStyleResult = missingStyleEnvironment.preview.apply(
      missingStyleEnvironment.selected as unknown as Element,
      [missingStyleEnvironment.entry(missingStyleOwner, [
        { selectorText: ".button:hover", style: null },
        styleRule(".button:hover", [["color", "green", ""]]),
      ])],
      ["hover"],
    );
    expect(missingStyleResult).toMatchObject({
      mountedRuleCount: 1,
      unsupportedRuleCount: 1,
    });
    expect(missingStyleResult.diagnostics).toContain("declaration-unavailable");
  });

  it.each(["external", "import"] as const)(
    "rejects a relative URL from a %s sheet without a proven HTTP base",
    (kind) => {
      const environment = createEnvironment();
      const owner = environment.owner("link");
      const rules = [styleRule(".button:hover", [
        ["background-image", "url(./asset.png)", ""],
      ])];
      let entry: PseudoStatePreviewStylesheet;
      let registry: StylesheetRegistry | undefined;
      if (kind === "external") {
        entry = {
          ...environment.entry(owner, rules),
          kind: "external",
        };
      } else {
        const leaf = sheet(rules);
        const top = sheet([{ styleSheet: leaf }]);
        owner.sheet = top;
        Object.assign(top, { ownerNode: owner });
        registry = new StylesheetRegistry({
          document: environment.document as unknown as Document,
          contentSessionId: "preview-import-relative-no-base",
          documentEpoch: 1,
        });
        entry = registry.snapshot().entries.find(({ sheet: candidate }) => (
          candidate === leaf as unknown as CSSStyleSheet
        ))!;
      }

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        [entry],
        ["hover"],
      );

      expect(result).toMatchObject({
        states: ["hover"],
        mountedRuleCount: 0,
        unsupportedRuleCount: 1,
      });
      expect(result.diagnostics).toContain("declaration-unavailable");
      expect(owner.parentNode?.children).toEqual([owner]);
      registry?.dispose();
    },
  );

  it("rejects a same-count CSSOM commit with a case-changed custom property", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    environment.document.nextStyleSheetMode = "same-count-custom-case";

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [["--Theme", "red", ""]]),
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      unsupportedRuleCount: 1,
      inaccessibleStylesheetCount: 0,
    });
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("accepts a committed serialization the engine rewrote back into a shorthand", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    // The CSSOM enumerates `border-color` as four longhands, so that is what
    // the mirror asks for; the engine parses them and answers in the shorthand.
    environment.document.nextStyleSheetMode = "collapse-shorthand";
    environment.document.normalizationStylesheetMode = "collapse-shorthand";

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [
          ["border-top-color", "rgb(180, 35, 24)", ""],
          ["border-right-color", "rgb(180, 35, 24)", ""],
          ["border-bottom-color", "rgb(180, 35, 24)", ""],
          ["border-left-color", "rgb(180, 35, 24)", ""],
        ]),
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
    expect(result.diagnostics).not.toContain("style-mount-rejected");
  });

  it("still rejects a commit its own parser does not produce", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    // The mounted sheet rewrote the rule, but asking the same parser for the
    // mirror's text does not produce that rewrite, so it is not the engine's
    // own serialization and the mount stays rejected.
    environment.document.nextStyleSheetMode = "same-count-wrong";
    environment.document.normalizationStylesheetMode = "collapse-shorthand";

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("style-mount-rejected");
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("accepts an equivalent quoted URL serialization from committed CSSOM", () => {
    const environment = createEnvironment();
    const owner = environment.owner("link");
    environment.document.nextStyleSheetMode = "quote-urls";

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [["background-image", "url(./asset.png)", ""]]),
      ], "https://cdn.example.test/css/app.css")],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
  });

  it("charges source-context wrappers before retaining or aggregating CSS text", () => {
    const environment = createEnvironment();
    const condition = `(min-width:${"1".repeat(16_000)}px)`;
    const entries = Array.from({ length: 40 }, (_, index) => {
      const owner = environment.owner("style");
      owner.setAttribute("media", condition);
      return environment.entry(owner, [
        styleRule(`.button:hover`, [["z-index", String(index), ""]]),
      ]);
    });

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      entries,
      ["hover"],
    );

    expect(result.states).toEqual(["hover"]);
    expect(result.mountedRuleCount).toBeLessThan(entries.length);
    expect(result.unsupportedRuleCount).toBeGreaterThan(0);
    expect(result.diagnostics).toContain("stylesheet-truncated");
  });

  it("bounds declaration reads across a fixed number of verification passes", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const maximumValue = "x".repeat(INSPECT_LIMITS.valueLength);
    let valueReads = 0;
    const rules = Array.from({ length: 256 }, () => ({
      selectorText: ".button:hover",
      style: {
        length: 1,
        item: () => "--payload",
        getPropertyValue: () => {
          valueReads += 1;
          return maximumValue;
        },
        getPropertyPriority: () => "",
      },
    }));

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, rules)],
      ["hover"],
    );

    expect(valueReads).toBeLessThanOrEqual(128);
    expect(result.states).toEqual(["hover"]);
    expect(result.unsupportedRuleCount).toBeGreaterThan(0);
    expect(result.diagnostics).toContain("stylesheet-truncated");
  });

  it("charges invalid declaration property strings before validating them", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const oversizedProperty = "p".repeat(INSPECT_LIMITS.valueLength);
    let itemReads = 0;
    const rules = Array.from({ length: 256 }, () => ({
      selectorText: ".button:hover",
      style: {
        length: 1,
        item: () => {
          itemReads += 1;
          return oversizedProperty;
        },
        getPropertyValue: () => "red",
        getPropertyPriority: () => "",
      },
    }));

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, rules)],
      ["hover"],
    );

    expect(itemReads).toBeLessThan(64);
    expect(result.unsupportedRuleCount).toBeGreaterThan(0);
    expect(result.diagnostics).toContain("stylesheet-truncated");
  });

  it("rejects a plain DocumentFragment selection root", () => {
    const environment = createEnvironment();
    const fragment = new FakeRoot("fragment", environment.document);
    const selected = new FakeElement("BUTTON", environment.document);
    fragment.append(selected);
    const source = sheet([
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    fragment.adoptedStyleSheets = [source];

    const result = environment.preview.apply(
      selected as unknown as Element,
      [{
        scope: fragment as unknown as ShadowRoot,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("invalid-selection");
  });

  it("does not call an own getRootNode override on a detached selection", () => {
    const environment = createEnvironment();
    const detached = new FakeElement("BUTTON", environment.document);
    let hostileRootReads = 0;
    Object.defineProperty(detached, "getRootNode", {
      configurable: true,
      value: () => {
        hostileRootReads += 1;
        return environment.document;
      },
    });
    const owner = environment.owner("style");

    const result = environment.preview.apply(
      detached as unknown as Element,
      [environment.entry(owner, [styleRule(
        ".button:hover",
        [["color", "red", ""]],
      )])],
      ["hover"],
    );

    expect(hostileRootReads).toBe(0);
    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("invalid-selection");
    expect(detached.attributes).toEqual([]);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("rejects a Document root that is not the selected element ownerDocument", () => {
    const environment = createEnvironment();
    const foreignDocument = new FakeRoot("document");
    const selected = new FakeElement("BUTTON", environment.document);
    selected.provenRoot = foreignDocument;
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    foreignDocument.adoptedStyleSheets = [source];

    const result = environment.preview.apply(
      selected as unknown as Element,
      [{
        scope: foreignDocument as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("invalid-selection");
    expect(selected.attributes).toEqual([]);
    expect(foreignDocument.adoptedStyleSheets).toEqual([source]);
  });

  it("rejects a DocumentFragment spoofing open ShadowRoot fields", () => {
    const environment = createEnvironment();
    const fragment = new FakeRoot("fragment", environment.document);
    const host = {
      ownerDocument: environment.document,
      shadowRoot: fragment,
    };
    Object.defineProperties(fragment, {
      mode: { configurable: true, value: "open" },
      host: { configurable: true, value: host },
    });
    const selected = new FakeElement("BUTTON", environment.document);
    fragment.append(selected);
    const source = sheet([styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    fragment.adoptedStyleSheets = [source];

    const result = environment.preview.apply(
      selected as unknown as Element,
      [{
        scope: fragment as unknown as ShadowRoot,
        sheet: source as unknown as CSSStyleSheet,
        kind: "adopted",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("invalid-selection");
    expect(selected.attributes).toEqual([]);
    expect(fragment.adoptedStyleSheets).toEqual([source]);
  });

  it("keeps a stable near-boundary source within fixed verification budgets", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const largeValue = "x".repeat(INSPECT_LIMITS.valueLength);
    const rules = Array.from({ length: 11 }, (_, index) => styleRule(
      `.button:hover`,
      [[`--payload-${index}`, largeValue, ""]],
    ));

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, rules)],
      ["hover"],
    );

    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 11 });
    expect(result.diagnostics).not.toContain("transaction-authority-lost");
    expect(result.diagnostics).not.toContain("stylesheet-truncated");
  });

  it.each(["self", "earlier"] as const)(
    "rolls back when a final declaration read mutates %s source provenance",
    (variant) => {
      const environment = createEnvironment();
      const firstOwner = environment.owner("style");
      const lastOwner = variant === "earlier"
        ? environment.owner("style")
        : firstOwner;
      let reads = 0;
      const lastRule = {
        selectorText: ".button:hover",
        style: {
          length: 1,
          item: () => "color",
          getPropertyValue: () => {
            reads += 1;
            const value = "red";
            if (reads === 3) {
              (variant === "self" ? lastOwner : firstOwner).disabled = true;
            }
            return value;
          },
          getPropertyPriority: () => "",
        },
      };
      const entries = variant === "earlier"
        ? [
            environment.entry(firstOwner, [styleRule(
              ".button:hover",
              [["background", "blue", ""]],
            )]),
            environment.entry(lastOwner, [lastRule]),
          ]
        : [environment.entry(firstOwner, [lastRule])];

      const result = environment.preview.apply(
        environment.selected as unknown as Element,
        entries,
        ["hover"],
      );

      expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
      expect(result.diagnostics).toContain("transaction-authority-lost");
      expect(environment.selected.attributes).toEqual([]);
      expect(firstOwner.parentNode?.children).toEqual([firstOwner]);
      if (variant === "earlier") {
        expect(lastOwner.parentNode?.children).toEqual([lastOwner]);
      }
    },
  );

  it("rechecks earlier mirrors after a later mounted CSSOM getter mutates them", () => {
    const environment = createEnvironment();
    const firstOwner = environment.owner("style");
    const secondOwner = environment.owner("style");
    const nativeCreate = environment.document.createElement.bind(environment.document);
    let styleCreates = 0;
    let armed = false;
    environment.document.createElement = (tagName) => {
      const created = nativeCreate(tagName);
      styleCreates += 1;
      if (styleCreates === 2) {
        const pending = created.pendingSheet!;
        let rules = pending.cssRules;
        Object.defineProperty(pending, "cssRules", {
          configurable: true,
          get() {
            if (armed) {
              const firstMirror = firstOwner.parentNode?.children[1];
              if (firstMirror) firstOwner.parentNode?.remove(firstMirror);
              armed = false;
            }
            return rules;
          },
          set(value: readonly object[]) {
            rules = value;
          },
        });
      }
      return created;
    };
    environment.selected.onAttributeNodeInsert = () => {
      armed = true;
    };

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [
        environment.entry(firstOwner, [styleRule(
          ".button:hover",
          [["color", "red", ""]],
        )]),
        environment.entry(secondOwner, [styleRule(
          ".button:hover",
          [["background", "blue", ""]],
        )]),
      ],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("transaction-authority-lost");
    expect(firstOwner.parentNode?.children).toEqual([firstOwner]);
    expect(secondOwner.parentNode?.children).toEqual([secondOwner]);
  });

  it("uses trusted intrinsic reads instead of hostile own DOM and CSSOM accessors", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const declarationStyle = {};
    const rule = {};
    const source = sheet([]);
    source.ownerNode = owner;
    owner.sheet = source;
    let hostileReads = 0;
    for (const [target, names] of [
      [source, ["cssRules"]],
      [rule, ["selectorText", "style"]],
      [declarationStyle, ["length"]],
    ] as const) {
      for (const name of names) {
        Object.defineProperty(target, name, {
          configurable: true,
          get() {
            hostileReads += 1;
            throw new Error(`hostile own ${name}`);
          },
        });
      }
    }
    Object.defineProperty(environment.selected, "getRootNode", {
      configurable: true,
      value: () => {
        hostileReads += 1;
        return environment.document;
      },
    });
    const records = new WeakMap<object, Readonly<Record<string, unknown>>>([
      [source, { "stylesheet.cssRules": [rule] }],
      [rule, {
        "styleRule.selectorText": ".button:hover",
        "styleRule.style": declarationStyle,
      }],
      [declarationStyle, {
        "declaration.length": 1,
        "call:declaration.item": () => "color",
        "call:declaration.getPropertyValue": () => "red",
        "call:declaration.getPropertyPriority": () => "",
      }],
      [environment.selected, {
        "call:node.getRootNode": () => environment.document,
      }],
    ]);
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: (root) => environment.createConstructable(root),
      createStyleElement: (document) => (
        (document as unknown as FakeRoot).createElement("style") as unknown as
          HTMLStyleElement
      ),
      resolveOpenShadowRootHost: (root) => environment.resolveShadowHost(root),
      testOnlyIntrinsics: structuralTestIntrinsics(records),
    } as unknown as ConstructorParameters<typeof PseudoStatePreview>[0]);

    const result = preview.apply(
      environment.selected as unknown as Element,
      [{
        scope: environment.document as unknown as Document,
        sheet: source as unknown as CSSStyleSheet,
        owner: owner as unknown as Element,
        ownerState: ownerState(owner),
        kind: "owner",
        sourceOrder: 0,
      }],
      ["hover"],
    );

    expect(hostileReads).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 1 });
  });

  it("shares the trusted intrinsic authority with its default artifact owner", () => {
    const environment = createEnvironment();
    const createAttribute = FakeRoot.prototype.createAttribute;
    const setAttributeNode = FakeElement.prototype.setAttributeNode;
    const getAttributeNode = FakeElement.prototype.getAttributeNode;
    let hostileCalls = 0;
    Object.defineProperty(environment.document, "createAttribute", {
      configurable: true,
      value() {
        hostileCalls += 1;
        throw new Error("hostile document.createAttribute");
      },
    });
    Object.defineProperties(environment.selected, {
      setAttributeNode: {
        configurable: true,
        value() {
          hostileCalls += 1;
          throw new Error("hostile element.setAttributeNode");
        },
      },
      getAttributeNode: {
        configurable: true,
        value() {
          hostileCalls += 1;
          throw new Error("hostile element.getAttributeNode");
        },
      },
    });
    const base = structuralTestIntrinsics();
    const authority: TestIntrinsicAccess = {
      read: base.read,
      call(target, intrinsic, args = []) {
        if (intrinsic === "set:attr.value") {
          return Reflect.set(target, "value", args[0]);
        }
        if (intrinsic === "document.createAttribute") {
          return Reflect.apply(createAttribute, target, args);
        }
        if (intrinsic === "element.setAttributeNode") {
          return Reflect.apply(setAttributeNode, target, args);
        }
        if (intrinsic === "element.getAttributeNode") {
          return Reflect.apply(getAttributeNode, target, args);
        }
        return base.call(target, intrinsic, args);
      },
    };
    const preview = new PseudoStatePreview({
      createConstructableStylesheet: (root) => environment.createConstructable(root),
      createStyleElement: (document) => (
        (document as unknown as FakeRoot).createElement("style") as unknown as
          HTMLStyleElement
      ),
      resolveOpenShadowRootHost: (root) => environment.resolveShadowHost(root),
      testOnlyIntrinsics: authority,
    } as unknown as ConstructorParameters<typeof PseudoStatePreview>[0]);

    const result = preview.apply(
      environment.selected as unknown as Element,
      [],
      ["hover"],
    );

    expect(hostileCalls).toBe(0);
    expect(result).toMatchObject({ states: ["hover"], mountedRuleCount: 0 });
  });

  it("rolls back when a trusted fourth stylesheet read mutates source authority", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [styleRule(
      ".button:hover",
      [["color", "red", ""]],
    )]);
    const source = entry.sheet as unknown as FakeSheet;
    let ruleReads = 0;
    const base = structuralTestIntrinsics();
    const authority: TestIntrinsicAccess = {
      read(target, intrinsic) {
        if (target === source && intrinsic === "stylesheet.cssRules") {
          ruleReads += 1;
          const rules = source.cssRules;
          if (ruleReads === 4) owner.disabled = true;
          return rules;
        }
        return base.read(target, intrinsic);
      },
      call: base.call,
    };
    const preview = new PseudoStatePreview({
      artifacts: environment.artifacts,
      createConstructableStylesheet: (root) => environment.createConstructable(root),
      createStyleElement: (document) => (
        (document as unknown as FakeRoot).createElement("style") as unknown as
          HTMLStyleElement
      ),
      resolveOpenShadowRootHost: (root) => environment.resolveShadowHost(root),
      testOnlyIntrinsics: authority,
    } as unknown as ConstructorParameters<typeof PseudoStatePreview>[0]);

    const result = preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );

    expect(ruleReads).toBeGreaterThanOrEqual(4);
    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toContain("transaction-authority-lost");
    expect(environment.selected.attributes).toEqual([]);
    expect(owner.parentNode?.children).toEqual([owner]);
  });

  it("preserves active authority until incomplete cleanup succeeds", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    const entry = environment.entry(owner, [
      styleRule(".button:hover", [["color", "red", ""]]),
    ]);
    environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["hover"],
    );
    environment.selected.rejectAttributeRemoval = true;

    expect(environment.preview.clear()).toMatchObject({ complete: false });
    expect(environment.preview.activeStates).toEqual(["hover"]);
    expect(environment.preview.apply(
      environment.selected as unknown as Element,
      [entry],
      ["focus"],
    )).toMatchObject({
      states: ["hover"],
      mountedRuleCount: 0,
      diagnostics: expect.arrayContaining(["cleanup-incomplete"]),
    });
    expect(environment.preview.activeStates).toEqual(["hover"]);

    environment.selected.rejectAttributeRemoval = false;
    expect(environment.preview.clear()).toEqual({ complete: true, failureCount: 0 });
    expect(environment.preview.activeStates).toEqual([]);
  });

  it("reports incomplete rollback after a hostile marker insertion", () => {
    const environment = createEnvironment();
    const owner = environment.owner("style");
    environment.selected.throwAfterAttributeNodeInsert = true;
    environment.selected.rejectAttributeRemoval = true;

    const result = environment.preview.apply(
      environment.selected as unknown as Element,
      [environment.entry(owner, [
        styleRule(".button:hover", [["color", "red", ""]]),
      ])],
      ["hover"],
    );

    expect(result).toMatchObject({ states: [], mountedRuleCount: 0 });
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      "marker-application-failed",
      "cleanup-incomplete",
    ]));
    environment.selected.rejectAttributeRemoval = false;
    expect(environment.preview.clear()).toMatchObject({ complete: true });
  });
});

type DeclarationTuple = readonly [string, string, "" | "important"];

function declaration(values: readonly DeclarationTuple[]) {
  return {
    length: values.length,
    item: (index: number) => values[index]?.[0] ?? "",
    getPropertyValue: (name: string) => values.find(([property]) => property === name)?.[1] ?? "",
    getPropertyPriority: (name: string) => values.find(([property]) => property === name)?.[2] ?? "",
  };
}

interface PreviewMatchable {
  readonly classes: ReadonlySet<string>;
  readonly attributes: ReadonlySet<string>;
}

interface PreviewMatchNode {
  readonly type: string;
  readonly value?: string;
  readonly attribute?: string;
  readonly nodes?: readonly PreviewMatchNode[];
}

function previewComputedDeclarations(
  cssText: string,
  element: PreviewMatchable,
): ReadonlyMap<string, string> {
  const computed = new Map<string, string>();
  for (const node of postcss.parse(cssText).nodes) {
    if (node.type !== "rule" || !previewMatches(node.selector, element)) continue;
    for (const child of node.nodes) {
      if (child.type === "decl") computed.set(child.prop, child.value);
    }
  }
  return computed;
}

function previewMatches(selectorText: string, element: PreviewMatchable): boolean {
  const root = selectorParser().astSync(selectorText, { lossless: false });
  return root.nodes.some((selector) => previewMatchesNodes(
    selector.nodes as readonly PreviewMatchNode[],
    element,
  ));
}

function previewMatchesNodes(
  nodes: readonly PreviewMatchNode[],
  element: PreviewMatchable,
): boolean {
  return nodes.every((node) => {
    if (node.type === "class") return element.classes.has(node.value ?? "");
    if (node.type === "attribute") {
      return element.attributes.has(node.attribute ?? "");
    }
    if (node.type === "pseudo" && [":is", ":where"].includes(node.value ?? "")) {
      return node.nodes?.some((selector) => previewMatchesNodes(
        selector.nodes ?? [],
        element,
      )) ?? false;
    }
    return node.type === "comment";
  });
}

function styleRule(selectorText: string, values: readonly DeclarationTuple[]) {
  return { selectorText, style: declaration(values) };
}

function groupRule(kind: string, conditionText: string, cssRules: readonly object[]) {
  return { constructor: { name: kind }, conditionText, cssRules };
}

interface FakeSheet {
  ownerNode: FakeElement | null;
  href: string | null;
  cssRules: readonly object[];
  disabled: boolean;
  media: { mediaText: string };
  replacedText?: string;
  replaceMode?: "normal" | "no-op" | "empty" | "unexpected" | "same-count-wrong" |
    "same-count-custom-case" | "quote-urls" | "collapse-shorthand" | "throw";
  onReplaceSync?: () => void;
  replaceSync(text: string): void;
}

function sheet(cssRules: readonly object[], href: string | null = null): FakeSheet {
  return {
    ownerNode: null,
    href,
    cssRules,
    disabled: false,
    media: { mediaText: "" },
    replaceSync(text: string) {
      this.onReplaceSync?.();
      if (this.replaceMode === "throw") throw new Error("replace rejected");
      if (this.replaceMode === "no-op") return;
      this.replacedText = text;
      this.cssRules = this.replaceMode === "empty"
        ? []
        : previewCssomRules(text, this.replaceMode);
    },
  };
}

interface FakeAttribute {
  readonly name: string;
  value: string;
  ownerElement: FakeElement | null;
}

class FakeElement {
  public parentNode: FakeRoot | null = null;
  public readonly childNodes: FakeElement[] = [];
  private text = "";
  public sheet: FakeSheet | null = null;
  public pendingSheet: FakeSheet | null = null;
  public disabled = false;
  public rejectNextInsert = false;
  public rejectAttributeRemoval = false;
  public throwAfterAttributeNodeInsert = false;
  public noOpRemove = false;
  public provenRoot: FakeRoot | undefined;
  public textWriteMode: "normal" | "no-op" = "normal";
  public onTextContentWrite: ((value: string) => void) | undefined;
  public onAttributeNodeInsert: ((attribute: FakeAttribute) => void) | undefined;
  private readonly attributesByName = new Map<string, FakeAttribute>();

  public constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeRoot,
  ) {}

  public get attributes(): readonly FakeAttribute[] {
    return [...this.attributesByName.values()];
  }

  public get textContent(): string {
    return this.text;
  }

  public set textContent(value: string) {
    if (this.textWriteMode === "normal") this.text = value;
    if (this.sheet) this.sheet.replaceSync(value);
    this.onTextContentWrite?.(value);
  }

  public get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index >= 0 ? this.parentNode.children[index + 1] ?? null : null;
  }

  public get previousSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.children.indexOf(this);
    return index > 0 ? this.parentNode.children[index - 1] ?? null : null;
  }

  public getRootNode(): FakeRoot | FakeElement {
    if (this.provenRoot) return this.provenRoot;
    let current: FakeElement | FakeRoot = this;
    while (current instanceof FakeElement && current.parentNode) current = current.parentNode;
    return current instanceof FakeRoot ? current.getRootNode() : this;
  }

  public setAttribute(name: string, value: string): void {
    const current = this.attributesByName.get(name);
    if (current) current.value = value;
    else this.attributesByName.set(name, { name, value, ownerElement: this });
  }

  public getAttribute(name: string): string | null {
    return this.attributesByName.get(name)?.value ?? null;
  }

  public getAttributeNode(name: string): FakeAttribute | null {
    return this.attributesByName.get(name) ?? null;
  }

  public setAttributeNode(attribute: FakeAttribute): FakeAttribute | null {
    const previous = this.attributesByName.get(attribute.name) ?? null;
    if (previous) previous.ownerElement = null;
    this.attributesByName.set(attribute.name, attribute);
    attribute.ownerElement = this;
    this.onAttributeNodeInsert?.(attribute);
    if (this.throwAfterAttributeNodeInsert) {
      this.throwAfterAttributeNodeInsert = false;
      throw new Error("attribute insertion failed after mutation");
    }
    return previous;
  }

  public removeAttributeNode(attribute: FakeAttribute): FakeAttribute {
    if (this.rejectAttributeRemoval) throw new Error("removal rejected");
    if (this.attributesByName.get(attribute.name) !== attribute) throw new Error("not owned");
    this.attributesByName.delete(attribute.name);
    attribute.ownerElement = null;
    return attribute;
  }

  public hasAttribute(name: string): boolean {
    return this.attributesByName.has(name);
  }

  public remove(): void {
    if (this.noOpRemove) return;
    this.parentNode?.remove(this);
  }

  public attachStylesheetIfNeeded(): void {
    if (!this.pendingSheet || this.sheet) return;
    this.sheet = this.pendingSheet;
    this.pendingSheet = null;
    this.sheet.ownerNode = this;
    this.sheet.replaceSync(this.text);
  }
}

class FakeRoot {
  public readonly children: FakeElement[] = [];
  public readonly nodeType: number;
  public readonly defaultView: { CSSStyleSheet: new () => FakeSheet };
  public readonly mode: "open" | undefined;
  public readonly host: {
    readonly ownerDocument: FakeRoot;
    readonly shadowRoot: FakeRoot;
  } | undefined;
  public rejectAdoptedAssignment = false;
  public rejectDocumentStyleAppend = false;
  public rejectChildRemoval = false;
  public adoptedAssignmentMode:
    | "normal"
    | "throw-after-insert"
    | "no-op"
    | "lossy"
    | "reorder-preserve-adjacency"
    | "persistent-lossy"
    | "persistent-reorder" = "normal";
  public insertMode: "normal" | "throw-after-insert" | "no-op" | "misplace" = "normal";
  public nextStyleSheetMode: FakeSheet["replaceMode"] = "normal";
  public normalizationStylesheetMode: FakeSheet["replaceMode"] = "normal";
  public nextConstructableSheetMode: FakeSheet["replaceMode"] = "normal";
  public nextStyleTextMode: FakeElement["textWriteMode"] = "normal";
  public nextStyleProvenRoot: FakeRoot | undefined;
  public onConstructableStylesheetCreated: (() => void) | undefined;
  public onConstructableReplace: (() => void) | undefined;
  private adopted: FakeSheet[] = [];
  private readonly registryOwners: FakeElement[] = [];
  public readonly head: FakeRoot | null;
  public provenRoot: FakeRoot | undefined;

  public constructor(
    public readonly kind: "document" | "shadow" | "fragment",
    private readonly documentOwner: FakeRoot = undefined as unknown as FakeRoot,
  ) {
    this.nodeType = kind === "document" ? 9 : 11;
    this.mode = kind === "shadow" ? "open" : undefined;
    this.host = kind === "shadow"
      ? { ownerDocument: this.ownerDocument, shadowRoot: this }
      : undefined;
    this.head = kind === "document" ? new FakeRoot("fragment", this) : null;
    if (this.head) this.head.provenRoot = this;
    this.defaultView = {
      CSSStyleSheet: class {
        public ownerNode: FakeElement | null = null;
        public href = null;
        public cssRules: readonly object[] = [];
        public disabled = false;
        public media = { mediaText: "" };
        public replacedText?: string;
        public replaceMode: FakeSheet["replaceMode"] = "normal";
        public onReplaceSync: (() => void) | undefined;
        public replaceSync(text: string): void {
          this.onReplaceSync?.();
          if (this.replaceMode === "throw") throw new Error("replace rejected");
          if (this.replaceMode === "no-op") return;
          this.replacedText = text;
          this.cssRules = this.replaceMode === "empty"
            ? []
            : previewCssomRules(text, this.replaceMode);
        }
      },
    };
  }

  public get ownerDocument(): FakeRoot {
    return this.nodeType === 9 ? this : this.documentOwner;
  }

  public getRootNode(): FakeRoot {
    return this.provenRoot ?? this;
  }

  public get adoptedStyleSheets(): FakeSheet[] {
    return this.adopted;
  }

  public get styleSheets(): readonly FakeSheet[] {
    return this.registryOwners.flatMap(({ sheet }) => sheet ? [sheet] : []);
  }

  public querySelectorAll(selector: string): readonly FakeElement[] {
    return selector === "*" || selector === "style,link[rel~='stylesheet']"
      ? [...this.registryOwners]
      : [];
  }

  public registerStylesheetOwner(owner: FakeElement): void {
    this.registryOwners.push(owner);
  }

  public set adoptedStyleSheets(value: FakeSheet[]) {
    if (this.rejectAdoptedAssignment) throw new Error("adopted assignment rejected");
    if (this.adoptedAssignmentMode === "no-op") return;
    if (this.adoptedAssignmentMode === "lossy") {
      this.adoptedAssignmentMode = "normal";
      this.adopted = [...value.slice(1)];
      return;
    }
    if (this.adoptedAssignmentMode === "reorder-preserve-adjacency") {
      this.adoptedAssignmentMode = "normal";
      this.adopted = value.length > 0
        ? [value[value.length - 1]!, ...value.slice(0, -1)]
        : [];
      return;
    }
    if (this.adoptedAssignmentMode === "persistent-lossy") {
      this.adopted = [...value.slice(1)];
      return;
    }
    if (this.adoptedAssignmentMode === "persistent-reorder") {
      this.adopted = [...value].reverse();
      return;
    }
    this.adopted = [...value];
    if (this.adoptedAssignmentMode === "throw-after-insert") {
      this.adoptedAssignmentMode = "normal";
      throw new Error("adopted assignment failed after insertion");
    }
  }

  public createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName.toUpperCase(), this.ownerDocument);
    if (tagName.toLowerCase() === "style") {
      element.pendingSheet = sheet([]);
      element.pendingSheet.replaceMode = this.nextStyleSheetMode;
      element.textWriteMode = this.nextStyleTextMode;
      element.provenRoot = this.nextStyleProvenRoot;
      this.nextStyleSheetMode = "normal";
      this.nextStyleTextMode = "normal";
      this.nextStyleProvenRoot = undefined;
    }
    return element;
  }

  public createAttribute(name: string): FakeAttribute {
    return { name, value: "", ownerElement: null };
  }

  public append(child: FakeElement): void {
    if (
      this.nodeType === 9 &&
      this.rejectDocumentStyleAppend &&
      child.tagName === "STYLE"
    ) throw new Error("Document rejects style children");
    if (child.parentNode?.rejectNextInsert) {
      child.parentNode.rejectNextInsert = false;
      throw new Error("mount rejected");
    }
    child.parentNode?.remove(child);
    this.children.push(child);
    child.parentNode = this;
    child.attachStylesheetIfNeeded();
  }

  public appendChild(child: FakeElement): FakeElement {
    this.append(child);
    return child;
  }

  public insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    const rejectingOwner = this.children.find(({ rejectNextInsert }) => rejectNextInsert);
    if (rejectingOwner) {
      rejectingOwner.rejectNextInsert = false;
      throw new Error("mount rejected");
    }
    if (this.insertMode === "no-op") return child;
    child.parentNode?.remove(child);
    const index = this.insertMode === "misplace"
      ? -1
      : reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    child.parentNode = this;
    child.attachStylesheetIfNeeded();
    if (this.insertMode === "throw-after-insert") {
      this.insertMode = "normal";
      throw new Error("insert failed after mutation");
    }
    return child;
  }

  public remove(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
    if (child.tagName === "STYLE" && child.sheet) {
      if (child.sheet.ownerNode === child) child.sheet.ownerNode = null;
      child.sheet = null;
    }
  }

  public removeChild(child: FakeElement): FakeElement {
    if (this.rejectChildRemoval) throw new Error("child removal rejected");
    this.remove(child);
    return child;
  }
}

function previewCssomRules(
  text: string,
  mode: FakeSheet["replaceMode"] = "normal",
): readonly object[] {
  const parsed = postcss.parse(text);
  if (mode === "same-count-custom-case") {
    parsed.walkDecls("--Theme", (declaration) => {
      declaration.prop = "--theme";
    });
  }
  if (mode === "collapse-shorthand") {
    // What a real engine does with the longhands the CSSOM enumerates for a
    // shorthand: it gives the shorthand back.
    parsed.walkRules((rule) => {
      const sides = ["top", "right", "bottom", "left"]
        .map((side) => rule.nodes.find((child) => (
          child.type === "decl" && child.prop === `border-${side}-color`
        )));
      const [first] = sides;
      if (
        first?.type !== "decl" ||
        sides.some((side) => side?.type !== "decl" || side.value !== first.value)
      ) return;
      first.prop = "border-color";
      for (const side of sides.slice(1)) side?.remove();
    });
  }
  if (mode === "quote-urls") {
    parsed.walkDecls((declaration) => {
      declaration.value = declaration.value.replace(
        /url\((https?:\/\/[^)'"\s]+)\)/giu,
        "url(\"$1\")",
      );
    });
  }
  const rules = parsed.nodes.map(fakeCssomRule);
  if (mode === "unexpected") {
    rules.push(fakeCssomRule(postcss.parse(".unexpected { color: magenta; }").nodes[0]!));
  }
  if (mode === "same-count-wrong" && rules[0]) {
    rules[0] = fakeCssomRule(postcss.parse(".wrong { color: magenta; }").nodes[0]!);
  }
  return rules;
}

function fakeCssomRule(node: ChildNode): Record<string, unknown> {
  if (node.type === "rule") {
    const declarations = node.nodes
      .filter((child): child is Extract<ChildNode, { readonly type: "decl" }> => child.type === "decl")
      .map(({ prop, value, important }) => [prop, value, important ? "important" : ""] as const);
    return {
      selectorText: node.selector,
      style: declaration(declarations),
      cssText: node.toString(),
    };
  }
  if (node.type === "atrule" && node.nodes) {
    return {
      constructor: {
        name: node.name.toLowerCase() === "media" ? "CSSMediaRule" : "CSSSupportsRule",
      },
      conditionText: node.params,
      cssRules: node.nodes.map(fakeCssomRule),
      cssText: node.toString(),
    };
  }
  return { cssText: node.toString() };
}

interface TestIntrinsicAccess {
  read(target: object, intrinsic: string): unknown;
  call(target: object, intrinsic: string, args?: readonly unknown[]): unknown;
}

function structuralTestIntrinsics(
  records = new WeakMap<object, Readonly<Record<string, unknown>>>(),
): TestIntrinsicAccess {
  const propertyFor = (intrinsic: string): string => {
    const names: Readonly<Record<string, string>> = {
      "style.sheet": "sheet",
      "stylesheet.ownerNode": "ownerNode",
      "stylesheet.disabled": "disabled",
      "stylesheet.href": "href",
      "stylesheet.media": "media",
      "stylesheet.cssRules": "cssRules",
      "media.mediaText": "mediaText",
      "ruleList.length": "length",
      "rule.type": "type",
      "rule.cssText": "cssText",
      "styleRule.selectorText": "selectorText",
      "styleRule.style": "style",
      "styleRule.cssRules": "cssRules",
      "nestedDeclarations.style": "style",
      "grouping.cssRules": "cssRules",
      "condition.conditionText": "conditionText",
      "import.styleSheet": "styleSheet",
      "import.layerName": "layerName",
      "import.supportsText": "supportsText",
      "import.media": "media",
      "declaration.length": "length",
      "node.nodeType": "nodeType",
      "node.ownerDocument": "ownerDocument",
      "node.parentNode": "parentNode",
      "node.nextSibling": "nextSibling",
      "node.previousSibling": "previousSibling",
      "node.textContent": "textContent",
      "document.head": "head",
      "document.documentElement": "documentElement",
      "document.URL": "URL",
      "owner.sheet": "sheet",
      "owner.disabled": "disabled",
    };
    return names[intrinsic] ?? intrinsic.slice(intrinsic.lastIndexOf(".") + 1);
  };
  return {
    read(target, intrinsic) {
      const record = records.get(target);
      if (record && Object.prototype.hasOwnProperty.call(record, intrinsic)) {
        return record[intrinsic];
      }
      return Reflect.get(target, propertyFor(intrinsic));
    },
    call(target, intrinsic, args = []) {
      const record = records.get(target);
      const override = record?.[`call:${intrinsic}`];
      if (typeof override === "function") return Reflect.apply(override, target, args);
      if (intrinsic === "set:node.textContent") {
        return Reflect.set(target, "textContent", args[0]);
      }
      if (intrinsic === "set:root.adoptedStyleSheets") {
        return Reflect.set(target, "adoptedStyleSheets", args[0]);
      }
      if (intrinsic === "node.getRootNode") {
        const prototype = Object.getPrototypeOf(target) as {
          readonly getRootNode?: unknown;
        } | null;
        if (typeof prototype?.getRootNode !== "function") {
          throw new TypeError("node.getRootNode unavailable");
        }
        return Reflect.apply(prototype.getRootNode, target, args);
      }
      if (intrinsic === "ruleList.item") {
        const item = Reflect.get(target, "item");
        return typeof item === "function"
          ? Reflect.apply(item, target, args)
          : Reflect.get(target, String(args[0]));
      }
      if (intrinsic === "node.hasChildNodes") {
        const method = Reflect.get(target, "hasChildNodes");
        return typeof method === "function"
          ? Reflect.apply(method, target, args)
          : ((Reflect.get(target, "childNodes") as { readonly length?: number } | undefined)
            ?.length ?? 0) > 0;
      }
      if (intrinsic === "element.hasAttributes") {
        const method = Reflect.get(target, "hasAttributes");
        return typeof method === "function"
          ? Reflect.apply(method, target, args)
          : ((Reflect.get(target, "attributes") as { readonly length?: number } | undefined)
            ?.length ?? 0) > 0;
      }
      const methodName = intrinsic.slice(intrinsic.lastIndexOf(".") + 1);
      const method = Reflect.get(target, methodName);
      if (typeof method !== "function") throw new TypeError(`${intrinsic} unavailable`);
      return Reflect.apply(method, target, args);
    },
  };
}

function createEnvironment() {
  const document = new FakeRoot("document");
  const selected = new FakeElement("BUTTON", document);
  document.append(selected);
  let seed = 0;
  const artifacts = new PinOpRuntimeArtifacts({
    getRandomValues(bytes) {
      bytes.fill(++seed);
      return bytes;
    },
  });
  const createConstructable = (root: Document | ShadowRoot): CSSStyleSheet => {
    const fakeRoot = root as unknown as FakeRoot;
    const ctor = fakeRoot.ownerDocument.defaultView.CSSStyleSheet;
    const created = new ctor();
    created.replaceMode = fakeRoot.nextConstructableSheetMode;
    created.onReplaceSync = fakeRoot.onConstructableReplace;
    fakeRoot.nextConstructableSheetMode = "normal";
    fakeRoot.onConstructableStylesheetCreated?.();
    return created as unknown as CSSStyleSheet;
  };
  const resolveShadowHost = (root: object): Element | undefined => {
    if (!(root instanceof FakeRoot) || root.kind !== "shadow" || root.mode !== "open") {
      return undefined;
    }
    return root.host?.shadowRoot === root
      ? root.host as unknown as Element
      : undefined;
  };
  const preview = new PseudoStatePreview({
    artifacts,
    createConstructableStylesheet: createConstructable,
    createStyleElement(rootDocument) {
      return (rootDocument as unknown as FakeRoot).createElement("style") as unknown as
        HTMLStyleElement;
    },
    createNormalizationStylesheet() {
      const created = sheet([]);
      created.replaceMode = document.normalizationStylesheetMode;
      return created as unknown as CSSStyleSheet;
    },
    resolveOpenShadowRootHost: resolveShadowHost,
    testOnlyIntrinsics: structuralTestIntrinsics(),
  } as unknown as ConstructorParameters<typeof PseudoStatePreview>[0]);
  return {
    document,
    selected,
    artifacts,
    preview,
    createConstructable,
    resolveShadowHost,
    owner(tag: "style" | "link") {
      const parent = new FakeRoot("document");
      parent.provenRoot = document;
      const owner = new FakeElement(tag.toUpperCase(), document);
      owner.provenRoot = document;
      parent.append(owner);
      document.registerStylesheetOwner(owner);
      return owner;
    },
    entry(owner: FakeElement, rules: readonly object[], sourceUrl?: string): PseudoStatePreviewStylesheet {
      const ownedSheet = sheet(rules, sourceUrl ?? null);
      ownedSheet.ownerNode = owner;
      owner.sheet = ownedSheet;
      return {
        scope: document as unknown as Document,
        sheet: ownedSheet as unknown as CSSStyleSheet,
        owner: owner as unknown as Element,
        ownerState: ownerState(owner),
        kind: sourceUrl ? "external" : "owner",
        sourceOrder: 0,
        ...(sourceUrl ? { sourceUrl } : {}),
      };
    },
  };
}

function ownerState(owner: FakeElement) {
  const rel = owner.getAttribute("rel") ?? "";
  return {
    media: owner.getAttribute("media") ?? "",
    disabled: owner.disabled || owner.hasAttribute("disabled"),
    rel,
    href: owner.getAttribute("href") ?? "",
    title: owner.getAttribute("title") ?? "",
    alternate: rel.toLowerCase().split(/\s+/).includes("alternate"),
  };
}
