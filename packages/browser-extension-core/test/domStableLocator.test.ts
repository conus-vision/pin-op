import { describe, expect, it } from "vitest";
import { DomStableLocatorService } from "../src/domStableLocator.js";

describe("DomStableLocatorService runtime-artifact exclusion", () => {
  it("uses one exact-artifact predicate for capture, resolution, and uniqueness scans", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const artifact = new FakeElement("style", document);
    const target = new FakeElement("button", document);
    target.id = "selected";
    target.setAttribute("data-pin-op-preview-hover-0123456789abcdef", "");
    document.append(html);
    html.append(body);
    body.append(artifact);
    body.append(target);
    artifact.id = target.id;

    const service = createService(document, artifact, target);
    const locator = service.capture(target as unknown as Node, "element");

    expect(locator.path.at(-1)).toMatchObject({
      tagName: "button",
      siblingIndex: 0,
      id: "selected",
    });
    expect(locator.path.at(-1)?.attributes).toBeUndefined();

    body.remove(artifact);
    expect(service.resolve(locator)?.node).toBe(target);
  });

  it("does not treat a copied marker-name node as an exact runtime artifact", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const copied = new FakeElement("style", document);
    copied.setAttribute("data-pin-op-runtime-artifact", "");
    const target = new FakeElement("button", document);
    document.append(html);
    html.append(body);
    body.append(copied);
    body.append(target);

    const service = createService(document, undefined, target);
    expect(service.capture(target as unknown as Node, "element").path.at(-1)?.siblingIndex)
      .toBe(1);
  });

  it("resolves a locator captured before an exact runtime sibling is inserted", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const artifact = new FakeElement("style", document);
    const target = new FakeElement("button", document);
    target.id = "selected";
    artifact.id = target.id;
    document.append(html);
    html.append(body);
    body.append(target);

    const service = createService(document, artifact, target);
    const locator = service.capture(target as unknown as Node, "element");
    body.prepend(artifact);

    expect(service.resolve(locator)?.node).toBe(target);
  });

  it("excludes runtime attributes before the author evidence budget", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const target = new FakeElement("button", document);
    target.attributes.push(
      ...Array.from({ length: 256 }, (_, index) => ({
        name: `data-pin-op-preview-runtime-${index}`,
        value: "",
      })),
      { name: "data-author-state", value: "ready" },
    );
    document.append(html);
    html.append(body);
    body.append(target);

    const locator = createService(document, undefined, target).capture(
      target as unknown as Node,
      "element",
    );

    expect(locator.path.at(-1)?.attributes).toEqual([
      { name: "data-author-state", value: "ready" },
    ]);
  });

  it("excludes exact runtime siblings from child and unique-ID budgets", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const runtimeNodes = Array.from({ length: 4_096 }, () => {
      const artifact = new FakeElement("style", document);
      artifact.id = "selected";
      return artifact;
    });
    const target = new FakeElement("button", document);
    target.id = "selected";
    document.append(html);
    html.append(body);
    for (const artifact of runtimeNodes) body.append(artifact);
    body.append(target);

    const locator = createService(
      document,
      runtimeNodes,
      target,
    ).capture(target as unknown as Node, "element");

    expect(locator.path.at(-1)).toMatchObject({
      siblingIndex: 0,
      id: "selected",
    });
  });

  it("fails closed when an off-path parent exceeds the author child cap", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const offPath = new FakeElement("section", document);
    const target = new FakeElement("button", document);
    target.id = "selected";
    document.append(html);
    html.append(body);
    body.append(offPath);
    body.append(target);
    for (let index = 0; index < 257; index += 1) {
      offPath.append(new FakeElement("span", document));
    }

    const service = createService(document, undefined, target);

    expect(() => service.capture(target as unknown as Node, "element")).toThrow();
  });

  it("allows the per-parent author cap alongside exact runtime children", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const offPath = new FakeElement("section", document);
    const target = new FakeElement("button", document);
    const runtimeNodes = Array.from(
      { length: 8 },
      () => new FakeElement("style", document),
    );
    target.id = "selected";
    document.append(html);
    html.append(body);
    body.append(offPath);
    body.append(target);
    for (let index = 0; index < 256; index += 1) {
      offPath.append(new FakeElement("span", document));
    }
    for (const runtimeNode of runtimeNodes) offPath.append(runtimeNode);

    const locator = createService(document, runtimeNodes, target).capture(
      target as unknown as Node,
      "element",
    );

    expect(locator.path.at(-1)?.id).toBe("selected");
  });

  it("fails closed when the off-path child predicate throws", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const offPath = new FakeElement("section", document);
    const artifact = new FakeElement("style", document);
    const target = new FakeElement("button", document);
    target.id = "selected";
    document.append(html);
    html.append(body);
    body.append(offPath);
    body.append(target);
    offPath.append(artifact);
    const service = createService(document, artifact, target, {
      throwForRuntimeNode: true,
    });

    expect(() => service.capture(target as unknown as Node, "element")).toThrow();
  });

  it("fails closed when an exact-artifact predicate throws", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const artifact = new FakeElement("style", document);
    const target = new FakeElement("button", document);
    document.append(html);
    html.append(body);
    body.append(artifact);
    body.append(target);
    const service = createService(document, artifact, target, {
      throwForRuntimeNode: true,
    });

    expect(() => service.capture(target as unknown as Node, "element")).toThrow();
  });
});

describe("DomStableLocatorService captured segments", () => {
  it("reuses an ancestor's segment until the moment it was captured in ends", () => {
    const document = new FakeDocument();
    const html = new FakeElement("html", document);
    const body = new FakeElement("body", document);
    const first = new FakeElement("div", document);
    const second = new FakeElement("div", document);
    const target = new FakeElement("button", document);
    document.append(html);
    html.append(body);
    body.append(first);
    body.append(second);
    second.append(target);
    const service = createService(document, undefined, target);

    const captured = service.capture(target as unknown as Node, "element");
    expect(captured.path.at(-2)).toMatchObject({ tagName: "div", siblingIndex: 1 });

    body.remove(first);
    // The moment has not ended, so the ancestor reads as it did when captured.
    expect(service.capture(target as unknown as Node, "element").path.at(-2))
      .toMatchObject({ siblingIndex: 1 });

    service.forgetCapturedSegments();
    expect(service.capture(target as unknown as Node, "element").path.at(-2))
      .toMatchObject({ siblingIndex: 0 });
  });
});

function createService(
  document: FakeDocument,
  runtimeNode: FakeElement | readonly FakeElement[] | undefined,
  markerOwner: FakeElement,
  options: { readonly throwForRuntimeNode?: boolean } = {},
): DomStableLocatorService {
  const runtimeNodes = new Set(
    runtimeNode === undefined
      ? []
      : Array.isArray(runtimeNode) ? runtimeNode : [runtimeNode],
  );
  return new DomStableLocatorService({
    topDocument: document as unknown as Document,
    frameRegistry: {
      getContextForDocument: (candidate) => candidate === document as unknown as Document
        ? { document: candidate, frameRef: "top" }
        : undefined,
      getContext: (frameRef) => frameRef === "top"
        ? { document: document as unknown as Document, frameRef }
        : undefined,
      getContextForFrameElement: () => undefined,
      hasExactFrameElementRegistration: () => false,
      authorizeExactFrameElement: () => undefined,
      unregisterFrame: () => [],
    },
    isExcludedNode: () => false,
    isRuntimeArtifactNode: (node) => {
      const runtime = runtimeNodes.has(node as unknown as FakeElement);
      if (runtime && options.throwForRuntimeNode) {
        throw new Error("hostile predicate");
      }
      return runtime;
    },
    isRuntimeArtifactAttributeName: (name) => (
      name === "data-pin-op-preview-hover-0123456789abcdef" ||
      name.startsWith("data-pin-op-preview-runtime-")
    ),
  });
}

interface FakeAttribute {
  readonly name: string;
  readonly value: string;
}

class FakeDocument {
  public readonly nodeType = 9;
  public readonly childNodes: FakeElement[] = [];
  public parentNode: null = null;

  public append(child: FakeElement): void {
    child.parentNode = this;
    this.childNodes.push(child);
  }
}

class FakeElement {
  public readonly nodeType = 1;
  public id = "";
  public parentNode: FakeElement | FakeDocument | null = null;
  public readonly childNodes: FakeElement[] = [];
  public readonly classList: string[] = [];
  public readonly attributes: FakeAttribute[] = [];

  public constructor(
    public readonly tagName: string,
    public readonly ownerDocument: FakeDocument,
  ) {}

  public get previousElementSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    return index > 0 ? siblings[index - 1]! : null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.push({ name, value });
  }

  public append(child: FakeElement): void {
    child.parentNode?.remove?.(child);
    child.parentNode = this;
    this.childNodes.push(child);
  }

  public prepend(child: FakeElement): void {
    child.parentNode?.remove?.(child);
    child.parentNode = this;
    this.childNodes.unshift(child);
  }

  public remove(child: FakeElement): void {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    if (child.parentNode === this) child.parentNode = null;
  }
}
