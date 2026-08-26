/**
 * Captured extension-realm DOM/CSSOM authority.
 *
 * In a browser, every operation below goes through a method or accessor that
 * was captured from the extension realm at module evaluation time. A missing
 * intrinsic or a WebIDL brand failure is an error; callers must fail closed and
 * must never retry through a page-owned property. The direct structural path is
 * enabled only when the process has no DOM/CSSOM globals (the Vitest fake-DOM
 * environment), or when a test supplies an explicit authority object.
 */
export interface BrowserIntrinsicAccess {
  readonly read: (target: object, intrinsic: string) => unknown;
  readonly call: (
    target: object,
    intrinsic: string,
    args?: readonly unknown[],
  ) => unknown;
}

type IntrinsicFunction = (...args: unknown[]) => unknown;

const GLOBAL = globalThis as unknown as Record<string, unknown>;
const HAS_BROWSER_INTRINSICS = ["Node", "Document", "CSSStyleSheet"].some(
  (name) => typeof GLOBAL[name] === "function",
);

function prototypeFor(name: string): object | undefined {
  const constructor = GLOBAL[name] as { readonly prototype?: unknown } | undefined;
  return typeof constructor === "function" && isObject(constructor.prototype)
    ? constructor.prototype
    : undefined;
}

function descriptor(
  prototypeName: string,
  property: string,
): PropertyDescriptor | undefined {
  let prototype = prototypeFor(prototypeName);
  for (let depth = 0; prototype && depth < 8; depth += 1) {
    const found = Object.getOwnPropertyDescriptor(prototype, property);
    if (found) return found;
    prototype = Object.getPrototypeOf(prototype) as object | null ?? undefined;
  }
  return undefined;
}

function capturedGetter(
  prototypeName: string,
  property: string,
): IntrinsicFunction | undefined {
  return descriptor(prototypeName, property)?.get as IntrinsicFunction | undefined;
}

function capturedSetter(
  prototypeName: string,
  property: string,
): IntrinsicFunction | undefined {
  return descriptor(prototypeName, property)?.set as IntrinsicFunction | undefined;
}

function capturedMethod(
  prototypeName: string,
  property: string,
): IntrinsicFunction | undefined {
  const prototype = prototypeFor(prototypeName) as Record<string, unknown> | undefined;
  const method = prototype?.[property];
  return typeof method === "function" ? method as IntrinsicFunction : undefined;
}

const READER_ENTRIES: ReadonlyArray<readonly [
  string,
  readonly (IntrinsicFunction | undefined)[],
]> = [
  ["node.nodeType", [capturedGetter("Node", "nodeType")]],
  ["node.ownerDocument", [capturedGetter("Node", "ownerDocument")]],
  ["node.parentNode", [capturedGetter("Node", "parentNode")]],
  ["node.nextSibling", [capturedGetter("Node", "nextSibling")]],
  ["node.previousSibling", [capturedGetter("Node", "previousSibling")]],
  ["node.textContent", [capturedGetter("Node", "textContent")]],
  ["document.head", [capturedGetter("Document", "head")]],
  ["document.documentElement", [capturedGetter("Document", "documentElement")]],
  ["document.URL", [capturedGetter("Document", "URL")]],
  ["shadow.host", [capturedGetter("ShadowRoot", "host")]],
  ["shadow.mode", [capturedGetter("ShadowRoot", "mode")]],
  ["element.shadowRoot", [capturedGetter("Element", "shadowRoot")]],
  ["element.tagName", [capturedGetter("Element", "tagName")]],
  ["attr.ownerElement", [capturedGetter("Attr", "ownerElement")]],
  ["attr.name", [capturedGetter("Attr", "name")]],
  ["attr.value", [capturedGetter("Attr", "value")]],
  ["style.sheet", [capturedGetter("HTMLStyleElement", "sheet")]],
  ["owner.sheet", [
    capturedGetter("HTMLStyleElement", "sheet"),
    capturedGetter("HTMLLinkElement", "sheet"),
  ]],
  ["owner.disabled", [
    capturedGetter("HTMLStyleElement", "disabled"),
    capturedGetter("HTMLLinkElement", "disabled"),
  ]],
  ["stylesheet.ownerNode", [capturedGetter("StyleSheet", "ownerNode")]],
  ["stylesheet.disabled", [capturedGetter("StyleSheet", "disabled")]],
  ["stylesheet.href", [capturedGetter("StyleSheet", "href")]],
  ["stylesheet.media", [capturedGetter("StyleSheet", "media")]],
  ["stylesheet.cssRules", [capturedGetter("CSSStyleSheet", "cssRules")]],
  ["media.mediaText", [capturedGetter("MediaList", "mediaText")]],
  ["ruleList.length", [capturedGetter("CSSRuleList", "length")]],
  ["rule.type", [capturedGetter("CSSRule", "type")]],
  ["rule.cssText", [capturedGetter("CSSRule", "cssText")]],
  ["styleRule.selectorText", [capturedGetter("CSSStyleRule", "selectorText")]],
  ["styleRule.style", [capturedGetter("CSSStyleRule", "style")]],
  ["nestedDeclarations.style", [capturedGetter("CSSNestedDeclarations", "style")]],
  ["styleRule.cssRules", [
    capturedGetter("CSSStyleRule", "cssRules"),
    capturedGetter("CSSGroupingRule", "cssRules"),
  ]],
  ["grouping.cssRules", [capturedGetter("CSSGroupingRule", "cssRules")]],
  ["condition.conditionText", [capturedGetter("CSSConditionRule", "conditionText")]],
  ["import.styleSheet", [capturedGetter("CSSImportRule", "styleSheet")]],
  ["import.layerName", [capturedGetter("CSSImportRule", "layerName")]],
  ["import.supportsText", [capturedGetter("CSSImportRule", "supportsText")]],
  ["import.media", [capturedGetter("CSSImportRule", "media")]],
  ["declaration.length", [capturedGetter("CSSStyleDeclaration", "length")]],
  ["root.adoptedStyleSheets", [
    capturedGetter("Document", "adoptedStyleSheets"),
    capturedGetter("ShadowRoot", "adoptedStyleSheets"),
  ]],
];
const READERS = new Map<string, readonly IntrinsicFunction[]>(READER_ENTRIES.map(
  ([key, readers]) => [
  key,
  readers.filter(
    (reader): reader is IntrinsicFunction => typeof reader === "function",
  ),
] as const));

const METHOD_ENTRIES: ReadonlyArray<readonly [
  string,
  readonly (IntrinsicFunction | undefined)[],
]> = [
  ["node.getRootNode", [capturedMethod("Node", "getRootNode")]],
  ["node.insertBefore", [capturedMethod("Node", "insertBefore")]],
  ["node.appendChild", [capturedMethod("Node", "appendChild")]],
  ["node.removeChild", [capturedMethod("Node", "removeChild")]],
  ["node.hasChildNodes", [capturedMethod("Node", "hasChildNodes")]],
  ["element.hasAttributes", [capturedMethod("Element", "hasAttributes")]],
  ["element.getAttribute", [capturedMethod("Element", "getAttribute")]],
  ["element.getAttributeNode", [capturedMethod("Element", "getAttributeNode")]],
  ["element.setAttributeNode", [capturedMethod("Element", "setAttributeNode")]],
  ["element.removeAttributeNode", [capturedMethod("Element", "removeAttributeNode")]],
  ["document.createAttribute", [capturedMethod("Document", "createAttribute")]],
  ["document.createElement", [capturedMethod("Document", "createElement")]],
  ["stylesheet.replaceSync", [capturedMethod("CSSStyleSheet", "replaceSync")]],
  ["ruleList.item", [capturedMethod("CSSRuleList", "item")]],
  ["declaration.item", [capturedMethod("CSSStyleDeclaration", "item")]],
  ["declaration.getPropertyValue", [
    capturedMethod("CSSStyleDeclaration", "getPropertyValue"),
  ]],
  ["declaration.getPropertyPriority", [
    capturedMethod("CSSStyleDeclaration", "getPropertyPriority"),
  ]],
  ["set:node.textContent", [capturedSetter("Node", "textContent")]],
  ["set:attr.value", [capturedSetter("Attr", "value")]],
  ["set:root.adoptedStyleSheets", [
    capturedSetter("Document", "adoptedStyleSheets"),
    capturedSetter("ShadowRoot", "adoptedStyleSheets"),
  ]],
];
const METHODS = new Map<string, readonly IntrinsicFunction[]>(METHOD_ENTRIES.map(
  ([key, methods]) => [
  key,
  methods.filter(
    (method): method is IntrinsicFunction => typeof method === "function",
  ),
] as const));

function invokeFirst(
  candidates: readonly IntrinsicFunction[] | undefined,
  target: object,
  args: readonly unknown[],
  intrinsic: string,
): unknown {
  if (!candidates || candidates.length === 0) {
    throw new TypeError(`browser intrinsic unavailable: ${intrinsic}`);
  }
  let firstError: unknown;
  for (const candidate of candidates) {
    try {
      return Reflect.apply(candidate, target, args);
    } catch (error) {
      firstError ??= error;
    }
  }
  throw firstError;
}

const CAPTURED_ACCESS: BrowserIntrinsicAccess = Object.freeze({
  read(target: object, intrinsic: string): unknown {
    if (!isObject(target)) throw new TypeError("intrinsic receiver must be an object");
    return invokeFirst(READERS.get(intrinsic), target, [], intrinsic);
  },
  call(target: object, intrinsic: string, args: readonly unknown[] = []): unknown {
    if (!isObject(target)) throw new TypeError("intrinsic receiver must be an object");
    return invokeFirst(METHODS.get(intrinsic), target, args, intrinsic);
  },
});

const STRUCTURAL_PROPERTIES: Readonly<Record<string, string>> = Object.freeze({
  "node.nodeType": "nodeType",
  "node.ownerDocument": "ownerDocument",
  "node.parentNode": "parentNode",
  "node.nextSibling": "nextSibling",
  "node.previousSibling": "previousSibling",
  "node.textContent": "textContent",
  "document.head": "head",
  "document.documentElement": "documentElement",
  "document.URL": "URL",
  "shadow.host": "host",
  "shadow.mode": "mode",
  "element.shadowRoot": "shadowRoot",
  "element.tagName": "tagName",
  "attr.ownerElement": "ownerElement",
  "attr.name": "name",
  "attr.value": "value",
  "style.sheet": "sheet",
  "owner.sheet": "sheet",
  "owner.disabled": "disabled",
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
  "nestedDeclarations.style": "style",
  "styleRule.cssRules": "cssRules",
  "grouping.cssRules": "cssRules",
  "condition.conditionText": "conditionText",
  "import.styleSheet": "styleSheet",
  "import.layerName": "layerName",
  "import.supportsText": "supportsText",
  "import.media": "media",
  "declaration.length": "length",
  "root.adoptedStyleSheets": "adoptedStyleSheets",
});

const STRUCTURAL_METHODS: Readonly<Record<string, string>> = Object.freeze({
  "node.getRootNode": "getRootNode",
  "node.insertBefore": "insertBefore",
  "node.appendChild": "appendChild",
  "node.removeChild": "removeChild",
  "node.hasChildNodes": "hasChildNodes",
  "element.hasAttributes": "hasAttributes",
  "element.getAttribute": "getAttribute",
  "element.getAttributeNode": "getAttributeNode",
  "element.setAttributeNode": "setAttributeNode",
  "element.removeAttributeNode": "removeAttributeNode",
  "document.createAttribute": "createAttribute",
  "document.createElement": "createElement",
  "stylesheet.replaceSync": "replaceSync",
  "ruleList.item": "item",
  "declaration.item": "item",
  "declaration.getPropertyValue": "getPropertyValue",
  "declaration.getPropertyPriority": "getPropertyPriority",
});

const STRUCTURAL_TEST_ACCESS: BrowserIntrinsicAccess = Object.freeze({
  read(target: object, intrinsic: string): unknown {
    const property = STRUCTURAL_PROPERTIES[intrinsic];
    if (!property) throw new TypeError(`test intrinsic unavailable: ${intrinsic}`);
    return (target as Record<string, unknown>)[property];
  },
  call(target: object, intrinsic: string, args: readonly unknown[] = []): unknown {
    if (intrinsic === "set:node.textContent") {
      (target as { textContent?: unknown }).textContent = args[0];
      return undefined;
    }
    if (intrinsic === "set:attr.value") {
      (target as { value?: unknown }).value = args[0];
      return undefined;
    }
    if (intrinsic === "set:root.adoptedStyleSheets") {
      (target as { adoptedStyleSheets?: unknown }).adoptedStyleSheets = args[0];
      return undefined;
    }
    if (intrinsic === "ruleList.item") {
      const item = (target as { readonly item?: unknown }).item;
      return typeof item === "function"
        ? Reflect.apply(item as IntrinsicFunction, target, [...args])
        : (target as Record<string, unknown>)[String(args[0])];
    }
    if (intrinsic === "node.hasChildNodes") {
      const method = (target as { readonly hasChildNodes?: unknown }).hasChildNodes;
      if (typeof method === "function") {
        return Reflect.apply(method as IntrinsicFunction, target, [...args]);
      }
      return ((target as { readonly childNodes?: { readonly length?: number } })
        .childNodes?.length ?? 0) > 0;
    }
    if (intrinsic === "element.hasAttributes") {
      const method = (target as { readonly hasAttributes?: unknown }).hasAttributes;
      if (typeof method === "function") {
        return Reflect.apply(method as IntrinsicFunction, target, [...args]);
      }
      return ((target as { readonly attributes?: { readonly length?: number } })
        .attributes?.length ?? 0) > 0;
    }
    if (intrinsic === "node.removeChild") {
      const method = (target as { readonly removeChild?: unknown }).removeChild;
      if (typeof method === "function") {
        return Reflect.apply(method as IntrinsicFunction, target, [...args]);
      }
      const child = args[0] as { readonly remove?: unknown } | undefined;
      if (typeof child?.remove !== "function") {
        throw new TypeError("test intrinsic unavailable: node.removeChild");
      }
      return Reflect.apply(child.remove as IntrinsicFunction, child, []);
    }
    const property = STRUCTURAL_METHODS[intrinsic];
    const method = property
      ? (target as Record<string, unknown>)[property]
      : undefined;
    if (typeof method !== "function") {
      throw new TypeError(`test intrinsic unavailable: ${intrinsic}`);
    }
    return Reflect.apply(method as IntrinsicFunction, target, [...args]);
  },
});

/** The production authority, or an explicit fake-DOM structural authority in Node. */
export const DEFAULT_BROWSER_INTRINSICS: BrowserIntrinsicAccess = HAS_BROWSER_INTRINSICS
  ? CAPTURED_ACCESS
  : STRUCTURAL_TEST_ACCESS;

/** True only in the DOM-free test process; never true in extension content. */
export const STRUCTURAL_TEST_MODE = !HAS_BROWSER_INTRINSICS;

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
