import {
  PinOpMessageSchema,
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  InspectContextSchema,
  InspectTargetSchema,
  PROTOCOL_VERSION,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { INSPECT_COLLECTION_MAX_BYTES } from "../src/inspectBounds.js";
import { createInspectPayload } from "../src/inspectPayload.js";
import type { InspectableElement } from "../src/inspectMode.js";

describe("createInspectPayload", () => {
  it("collects selected and immediate-parent targets independently", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card", "featured"], parent);
    const payload = createInspectPayload(
      selected,
      fakeDocument([
        rule(".layout", parent, "display", "grid"),
        rule(".card", selected, "display", "block"),
      ]),
      locationSource(),
    );

    expect(payload.targets.map((target) => [target.role, target.depth])).toEqual([
      ["selected", 0],
      ["parent", 1],
    ]);
    expect(payload.targets[0]?.facts.map((fact) => fact.type)).toContain(
      "css-rule",
    );
    expect(payload.targets[1]?.subject.selector).toBe("main.layout");
  });

  it("omits parent for a root element", () => {
    const payload = createInspectPayload(
      element("html", "", [], null),
      fakeDocument([]),
      locationSource(),
    );

    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0]?.role).toBe("selected");
  });

  it("keeps shared rules in both targets and deduplicates browser errors", () => {
    const parent = element("main", "", ["shared"], null);
    const selected = element("article", "", ["shared"], parent);
    const inaccessible = {
      href: "https://cdn.example/vendor.css",
      get cssRules(): never {
        throw new Error("Permission denied");
      },
    };
    const payload = createInspectPayload(
      selected,
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          { href: "/dist/app.css", cssRules: [rule(".shared", null, "color", "red")] },
          inaccessible,
        ],
      },
      locationSource(),
    );

    expect(payload.targets.map((target) => target.facts.length)).toEqual([1, 1]);
    expect(payload.inaccessibleStylesheets).toEqual([
      {
        code: "browser.stylesheetInaccessible",
        sourceUrl: "https://cdn.example/vendor.css",
        reason: "Permission denied",
      },
    ]);
  });

  it("bounds inspect context and browser diagnostics while preserving both targets", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card"], parent);
    const inaccessible = Array.from(
      { length: INSPECT_LIMITS.inaccessibleStylesheets + 1 },
      (_, index) => ({
        href: exactLengthUrl(index),
        get cssRules(): never {
          throw new Error("r".repeat(INSPECT_LIMITS.valueLength + 1));
        },
      }),
    );
    const location = {
      href: "http://localhost:3000/page",
      pathname: `/${"p".repeat(INSPECT_LIMITS.routeLength)}`,
      search: "?overflow=true",
      hash: "#target",
    };
    const payload = createInspectPayload(
      selected,
      { pageUrl: location.href, styleSheets: inaccessible },
      location,
    );

    expect(payload.targets.map((target) => target.role)).toEqual([
      "selected",
      "parent",
    ]);
    expect(payload.inaccessibleStylesheets).toHaveLength(
      INSPECT_LIMITS.inaccessibleStylesheets,
    );
    expect(payload.context.metadata).toEqual({
      inaccessibleStylesheetCount: INSPECT_LIMITS.inaccessibleStylesheets,
    });
    expect(payload.context.route).toHaveLength(INSPECT_LIMITS.routeLength);
    for (const target of payload.targets) {
      expect(InspectTargetSchema.parse(target)).toEqual(target);
    }
    expect(InspectContextSchema.parse(payload.context)).toEqual(payload.context);

    const message = fullInspectMessage(payload);
    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
  });

  it("keeps worst-case selected and parent CSS output within the wire budget", () => {
    expect(INSPECT_COLLECTION_MAX_BYTES).toBe(512 * 1024);
    expect(INSPECT_COLLECTION_MAX_BYTES).toBeLessThan(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
    let valueReads = 0;
    const parent = element("main", "", ["shared"], null);
    const selected = element("article", "", ["shared"], parent);
    const declarationCount = INSPECT_LIMITS.declarationsPerRule;
    const names = Array.from(
      { length: declarationCount },
      (_, index) => `--property-${index}`,
    );
    let cssRule: unknown = {
      selectorText: ".shared",
      cssText: "x".repeat(INSPECT_LIMITS.valueLength),
      style: {
        length: declarationCount,
        item: (index: number) => names[index] ?? "",
        getPropertyValue() {
          valueReads += 1;
          return "v".repeat(INSPECT_LIMITS.valueLength);
        },
        getPropertyPriority: () =>
          "p".repeat(INSPECT_LIMITS.propertyNameLength),
      },
    };
    for (let index = 0; index < INSPECT_LIMITS.mediaConditions; index += 1) {
      const conditionText = `media-${index}-${"m".repeat(
        INSPECT_LIMITS.valueLength,
      )}`;
      cssRule = {
        conditionText,
        media: { mediaText: conditionText },
        cssRules: [cssRule],
      };
    }
    const payload = createInspectPayload(
      selected,
      {
        pageUrl: "http://localhost:3000/page",
        styleSheets: [
          {
            href: exactLengthUrl(0),
            cssRules: [cssRule],
          },
        ],
      },
      locationSource(),
    );

    const facts = payload.targets.flatMap((target) => target.facts);
    expect(facts.length).toBeLessThan(declarationCount * 2);
    expect(valueReads).toBeLessThan(declarationCount * 2);
    for (const fact of facts) {
      expect(fact.metadata).not.toHaveProperty("cssText");
      expect(fact.metadata).not.toHaveProperty("declarationNames");
      expect(fact.metadata).not.toHaveProperty("priority");
      expect(fact.metadata.sourceUrl).toBe(exactLengthUrl(0));
      expect(fact.metadata.rulePath).toMatch(/^0(?:\.0)+$/);
      expect(fact.metadata.media).toHaveLength(INSPECT_LIMITS.mediaConditions);
    }

    const message = fullInspectMessage(payload);
    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
  });

  it("shares the wire budget across maximal selected and parent attributes", () => {
    const attributes = Array.from(
      { length: INSPECT_LIMITS.subjectAttributes },
      (_, index) => ({
        name: `data-boundary-${index}`,
        value: "v".repeat(INSPECT_LIMITS.valueLength),
      }),
    );
    const parent = {
      ...element("main", "", ["layout"], null),
      attributes,
    };
    const selected = {
      ...element("article", "", ["card"], parent),
      attributes,
    };
    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
    );

    expect(payload.targets).toHaveLength(2);
    const collectedAttributes = payload.targets.flatMap(
      (target) => target.subject.attributes ?? [],
    );
    expect(collectedAttributes.length).toBeGreaterThan(0);
    expect(collectedAttributes.length).toBeLessThan(
      INSPECT_LIMITS.subjectAttributes * 2,
    );

    const message = fullInspectMessage(payload);
    expect(PinOpMessageSchema.parse(message)).toEqual(message);
    expect(Buffer.byteLength(JSON.stringify(message), "utf8")).toBeLessThanOrEqual(
      INSPECT_ENVELOPE_MAX_BYTES,
    );
  });
});

function fullInspectMessage(
  payload: ReturnType<typeof createInspectPayload>,
) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect" as const,
    messageId: "inspect-max",
    sessionId: "session-1",
    source: { role: "browser" as const, id: "firefox-test", metadata: {} },
    ideHighlightEnabled: payload.ideHighlightEnabled,
    targets: payload.targets,
    context: payload.context,
    metadata: payload.metadata,
  };
}

function exactLengthUrl(index: number): string {
  const prefix = `https://cdn.example/${index}/`;
  return `${prefix}${"u".repeat(INSPECT_LIMITS.urlLength - prefix.length)}`;
}

function element(
  tagName: string,
  id: string,
  classes: readonly string[],
  parentElement: InspectableElement | null,
): InspectableElement {
  const value = {
    tagName,
    id,
    classList: classes,
    attributes: [],
    parentElement,
    matches(selector: string) {
      return selector === ".shared" ||
        (selector === ".layout" && classes.includes("layout")) ||
        (selector === ".card" && classes.includes("card"));
    },
  };
  return value;
}

function fakeDocument(rules: readonly unknown[]) {
  return {
    pageUrl: "http://localhost:3000/page",
    styleSheets: [{ href: "/dist/app.css", cssRules: rules }],
  };
}

function rule(
  selectorText: string,
  _element: InspectableElement | null,
  property: string,
  value: string,
) {
  return {
    selectorText,
    cssText: `${selectorText} { ${property}: ${value}; }`,
    style: {
      length: 1,
      item: () => property,
      getPropertyValue: () => value,
      getPropertyPriority: () => "",
    },
  };
}

function locationSource() {
  return {
    href: "http://localhost:3000/page?mode=dev#card",
    pathname: "/page",
    search: "?mode=dev",
    hash: "#card",
  };
}
