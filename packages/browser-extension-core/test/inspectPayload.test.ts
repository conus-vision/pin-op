import {
  PinOpMessageSchema,
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  RULE_EVIDENCE_LIMITS,
  InspectContextSchema,
  InspectTargetSchema,
  PROTOCOL_VERSION,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { INSPECT_COLLECTION_MAX_BYTES } from "../src/inspectBounds.js";
import { createInspectPayload } from "../src/inspectPayload.js";
import type { InspectableElement } from "../src/inspectMode.js";
import type {
  MatchedRule,
  MatchedStyles,
} from "../src/matchedStylesTypes.js";

describe("createInspectPayload", () => {
  it("fails closed instead of synthesizing rule references without MatchedStyles", () => {
    const selected = element("article", "", ["card"], null);

    expect(() => (createInspectPayload as unknown as (
      element: InspectableElement,
      document: ReturnType<typeof fakeDocument>,
      location: ReturnType<typeof locationSource>,
    ) => unknown)(selected, fakeDocument([]), locationSource())).toThrow(
      "MatchedStyles is required",
    );
  });

  it("collects selected and immediate-parent targets independently", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card", "featured"], parent);
    const fixture = matchedStylesFixture();
    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
      { ...fixture, inherited: fixture.inherited.slice(0, 1) },
    );

    expect(payload.targets.map((target) => [target.role, target.depth])).toEqual([
      ["selected", 0],
      ["parent", 1],
    ]);
    expect(payload.targets[0]?.facts.map((fact) => fact.type)).toContain(
      "css-rule",
    );
    expect(payload.ruleEvidence.rules).toHaveLength(2);
    expect(new Set(payload.ruleEvidence.rules.map(({ ruleRef }) => ruleRef))).toEqual(
      new Set(payload.targets.flatMap((target) => target.facts)
        .filter((fact) => fact.type === "css-rule")
        .map((fact) => fact.ruleRef)),
    );
    expect(payload.targets[1]?.subject.selector).toBe("main.layout");
  });

  it("omits parent for a root element", () => {
    const payload = createInspectPayload(
      element("html", "", [], null),
      fakeDocument([]),
      locationSource(),
      emptyMatchedStyles("node-root"),
    );

    expect(payload.targets).toHaveLength(1);
    expect(payload.targets[0]?.role).toBe("selected");
  });

  it("omits session marker names from selected and parent inspect subjects", () => {
    const marker = "data-pin-op-preview-hover-0123456789abcdef";
    const styleMarker = "data-pin-op-runtime-fedcba9876543210";
    const parent = {
      ...element("main", "", ["layout"], null),
      attributes: [
        { name: marker, value: "" },
        { name: styleMarker, value: "copied-by-page" },
        { name: "data-page", value: "parent" },
      ],
    } as InspectableElement;
    const selected = {
      ...element("article", "", ["card"], parent),
      attributes: [
        { name: marker, value: "" },
        { name: styleMarker, value: "copied-by-page" },
        { name: "data-page", value: "selected" },
      ],
    } as InspectableElement;

    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
      emptyMatchedStyles(),
      {
        isRuntimeAttributeName: (name) => (
          name === marker || name === styleMarker
        ),
      },
    );

    expect(payload.targets.map(({ subject }) => subject.attributes)).toEqual([
      [{ name: "data-page", value: "selected", metadata: {} }],
      [{ name: "data-page", value: "parent", metadata: {} }],
    ]);
  });

  it("rejects copied runtime markers in subject strings and author rule evidence", () => {
    const marker = "data-pin-op-preview-hover-0123456789abcdef";
    const containsRuntimeMarker = (value: string): boolean => value.includes(marker);
    const copiedSubject = element(
      "article",
      `target-${marker}`,
      ["card"],
      null,
    );

    expect(() => createInspectPayload(
      copiedSubject,
      fakeDocument([]),
      locationSource(),
      emptyMatchedStyles(),
      { containsRuntimeMarker },
    )).toThrow(/runtime marker/iu);

    const matched = {
      ...emptyMatchedStyles(),
      rules: [matchedRule(
        "rule-runtime-copy",
        `.card[${marker}]`,
        "color",
      )],
    };
    expect(() => createInspectPayload(
      element("article", "target", ["card"], null),
      fakeDocument([]),
      locationSource(),
      matched,
      { containsRuntimeMarker },
    )).toThrow(/runtime marker/iu);
  });

  it("projects facts for targets and evidence for every displayed inherited rule", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card"], parent);
    const matched = matchedStylesFixture();
    const hostileDocument = {
      pageUrl: "http://localhost:3000/page",
      get styleSheets(): never {
        throw new Error("inspect payload must not re-walk CSSOM");
      },
    };

    const payload = createInspectPayload(
      selected,
      hostileDocument,
      locationSource(),
      matched,
    );

    expect(payload.targets[0]?.facts[0]).toMatchObject({ ruleRef: "rule-selected" });
    expect(payload.targets[1]?.facts[0]).toMatchObject({ ruleRef: "rule-parent" });
    expect(payload.ruleEvidence.rules.map(({ ruleRef }) => ruleRef)).toEqual([
      "rule-selected",
      "rule-parent",
      "rule-grandparent",
    ]);
    expect(payload.targets.flatMap(({ facts }) => facts).map((fact) =>
      fact.type === "css-rule" ? fact.ruleRef : undefined
    )).not.toContain("rule-grandparent");
    expect(payload.context.metadata).toEqual({ inaccessibleStylesheetCount: 3 });
  });

  it("does not label assigned-slot rules as light-DOM-parent facts", () => {
    const lightDomParent = element("main", "", ["layout"], null);
    const slot = element("slot", "", ["slot"], null);
    const selected = {
      ...element("article", "", ["card"], lightDomParent),
      assignedSlot: slot,
    } as InspectableElement;
    const slotRule = matchedRule("rule-slot", ".slot", "color");

    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
      {
        ...emptyMatchedStyles(),
        inherited: [{
          ancestorIndex: 1,
          elementName: "slot",
          rules: [slotRule],
        }],
      },
    );

    expect(payload.targets[1]?.subject.selector).toBe("main.layout");
    expect(payload.targets[1]?.facts).toEqual([]);
    expect(payload.ruleEvidence.rules.map(({ ruleRef }) => ruleRef)).toEqual([
      "rule-slot",
    ]);
  });

  it("keeps one shared Rules authority in both targets", () => {
    const parent = element("main", "", ["shared"], null);
    const selected = element("article", "", ["shared"], parent);
    const sharedRule = matchedRule("rule-shared", ".shared", "color");
    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
      {
        ...emptyMatchedStyles(),
        domParentAncestorIndex: 1,
        rules: [sharedRule],
        inherited: [{
          ancestorIndex: 1,
          elementName: "main",
          rules: [sharedRule],
        }],
        inaccessibleStylesheetCount: 1,
      },
    );

    expect(payload.targets.map((target) => target.facts.length)).toEqual([1, 1]);
    expect(payload.ruleEvidence.rules.map(({ ruleRef }) => ruleRef)).toEqual([
      "rule-shared",
    ]);
    expect(payload.inaccessibleStylesheets).toEqual([]);
    expect(payload.context.metadata).toEqual({ inaccessibleStylesheetCount: 1 });
  });

  it("bounds inspect context and browser diagnostics while preserving both targets", () => {
    const parent = element("main", "", ["layout"], null);
    const selected = element("article", "", ["card"], parent);
    const location = {
      href: "http://localhost:3000/page",
      pathname: `/${"p".repeat(INSPECT_LIMITS.routeLength)}`,
      search: "?overflow=true",
      hash: "#target",
    };
    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      location,
      {
        ...emptyMatchedStyles(),
        inaccessibleStylesheetCount: INSPECT_LIMITS.inaccessibleStylesheets,
      },
    );

    expect(payload.targets.map((target) => target.role)).toEqual([
      "selected",
      "parent",
    ]);
    expect(payload.inaccessibleStylesheets).toEqual([]);
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
    const parent = element("main", "", ["shared"], null);
    const selected = element("article", "", ["shared"], parent);
    const declarations = Array.from(
      { length: RULE_EVIDENCE_LIMITS.declarationsPerRule },
      (_, index) => ({
        ruleRef: "placeholder",
        property: `--property-${index}`,
        value: "v".repeat(INSPECT_LIMITS.valueLength),
        important: false,
        valueTruncated: false,
        state: "winning-known-author" as const,
        reason: "highest-precedence-known-author-declaration" as const,
      }),
    );
    const maximalRules = Array.from(
      { length: RULE_EVIDENCE_LIMITS.rules },
      (_, index): MatchedRule => {
        const ruleRef = `rule-${index}`;
        return {
          ruleRef,
          selectorText: `.shared:nth-child(${index + 1})`,
          matchingSelectorIndices: [0],
          declarations: declarations.map((declaration) => ({
            ...declaration,
            ruleRef,
          })),
          contexts: Array.from(
            { length: RULE_EVIDENCE_LIMITS.contextsPerRule },
            (__, contextIndex) => ({
              kind: "media" as const,
              text: `media-${contextIndex}-${"m".repeat(
                RULE_EVIDENCE_LIMITS.contextTextLength - 16,
              )}`,
            }),
          ),
          source: {
            sourceUrl: "https://example.test/app.css",
            rulePath: `${index}`,
          },
        };
      },
    );
    const payload = createInspectPayload(
      selected,
      fakeDocument([]),
      locationSource(),
      {
        ...emptyMatchedStyles(),
        domParentAncestorIndex: 1,
        rules: maximalRules,
        inherited: [{
          ancestorIndex: 1,
          elementName: "main",
          rules: maximalRules,
        }],
      },
    );

    const facts = payload.targets.flatMap((target) => target.facts);
    expect(payload.ruleEvidence.omittedRuleCount).toBeGreaterThan(0);
    expect(facts.length).toBeLessThan(
      RULE_EVIDENCE_LIMITS.declarationsPerRule * RULE_EVIDENCE_LIMITS.rules * 2,
    );
    for (const fact of facts) {
      expect(fact.metadata).toEqual({});
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
      emptyMatchedStyles(),
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
    ruleEvidence: payload.ruleEvidence,
    context: payload.context,
    metadata: payload.metadata,
  };
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

function locationSource() {
  return {
    href: "http://localhost:3000/page?mode=dev#card",
    pathname: "/page",
    search: "?mode=dev",
    hash: "#card",
  };
}

function matchedStylesFixture(): MatchedStyles {
  return {
    documentEpoch: 1,
    selectionRevision: 1,
    stylesRevision: 1,
    stylesheetRevision: 1,
    nodeRef: "node-selected",
    domParentAncestorIndex: 1,
    rules: [matchedRule("rule-selected", ".card", "color")],
    inherited: [
      {
        ancestorIndex: 1,
        elementName: "main",
        rules: [matchedRule("rule-parent", ".layout", "color")],
      },
      {
        ancestorIndex: 2,
        elementName: "body",
        rules: [matchedRule("rule-grandparent", "body", "font-size")],
      },
    ],
    inaccessibleStylesheetCount: 3,
    partial: true,
    diagnostics: ["stylesheet-inaccessible"],
  };
}

function emptyMatchedStyles(nodeRef = "node-selected"): MatchedStyles {
  return {
    documentEpoch: 1,
    selectionRevision: 1,
    stylesRevision: 1,
    stylesheetRevision: 1,
    nodeRef,
    rules: [],
    inherited: [],
    inaccessibleStylesheetCount: 0,
    partial: false,
    diagnostics: [],
  };
}

function matchedRule(
  ruleRef: string,
  selectorText: string,
  property: string,
): MatchedRule {
  return {
    ruleRef,
    selectorText,
    matchingSelectorIndices: [0],
    declarations: [{
      ruleRef,
      property,
      value: "red",
      important: false,
      valueTruncated: false,
      state: "winning-known-author",
      reason: "highest-precedence-known-author-declaration",
    }],
    contexts: [],
    source: { sourceUrl: "/dist/app.css", rulePath: "0.0" },
  };
}
