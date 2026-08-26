import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  InspectSubjectSchema,
} from "@pin-op/protocol";
import { createElementSnapshot } from "../src/elementSnapshot.js";

describe("createElementSnapshot", () => {
  it("serializes identity and safe attributes without page text", () => {
    const subject = createElementSnapshot(
      {
        tagName: "DIV",
        id: "hero",
        classList: ["card", "featured"],
        attributes: [
          { name: "id", value: "hero" },
          { name: "class", value: "card featured" },
          { name: "data-state", value: "ready" },
          { name: "aria-label", value: "Featured card" },
          { name: "role", value: "region" },
          { name: "onclick", value: "dangerous()" },
          { name: "style", value: "display:none" },
        ],
      },
      "http://localhost:3000/page",
    );

    expect(subject).toEqual({
      selector: "div#hero.card.featured",
      nodeId: "hero",
      attributes: [
        { name: "data-state", value: "ready", metadata: {} },
        { name: "aria-label", value: "Featured card", metadata: {} },
        { name: "role", value: "region", metadata: {} },
      ],
      metadata: {
        tag: "div",
        id: "hero",
        classes: ["card", "featured"],
        pageUrl: "http://localhost:3000/page",
      },
    });
    expect(subject.text).toBeUndefined();
    expect(InspectSubjectSchema.parse(JSON.parse(JSON.stringify(subject)))).toEqual(
      subject,
    );
  });

  it("escapes selector identifiers and falls back to the tag", () => {
    expect(
      createElementSnapshot(
        {
          tagName: "ARTICLE",
          id: "",
          classList: ["card:wide"],
          attributes: [],
        },
        "http://localhost",
      ).selector,
    ).toBe("article.card\\:wide");
    expect(
      createElementSnapshot(
        { tagName: "MAIN", id: "", classList: [], attributes: [] },
        "http://localhost",
      ).selector,
    ).toBe("main");
    expect(
      createElementSnapshot(
        { tagName: "DIV", id: "", classList: ["-"], attributes: [] },
        "http://localhost",
      ).selector,
    ).toBe("div.\\-");
  });

  it("bounds page-controlled snapshot strings and arrays", () => {
    const subject = createElementSnapshot(
      {
        tagName: "DIV",
        id: "i".repeat(INSPECT_LIMITS.nodeIdLength + 1),
        classList: [
          "c".repeat(INSPECT_LIMITS.attributeNameLength + 1),
          ...Array.from(
            { length: INSPECT_LIMITS.classNames },
            (_, index) => `class-${index}`,
          ),
        ],
        attributes: [
          {
            name: `data-${"n".repeat(INSPECT_LIMITS.attributeNameLength)}`,
            value: "v".repeat(INSPECT_LIMITS.valueLength + 1),
          },
          ...Array.from(
            { length: INSPECT_LIMITS.subjectAttributes },
            (_, index) => ({
              name: `data-${index}`,
              value: "v".repeat(INSPECT_LIMITS.valueLength + 1),
            }),
          ),
        ],
      },
      "u".repeat(INSPECT_LIMITS.urlLength + 1),
    );

    expect(subject.selector?.length).toBeLessThanOrEqual(
      INSPECT_LIMITS.selectorLength,
    );
    expect(subject.nodeId).toHaveLength(INSPECT_LIMITS.nodeIdLength);
    expect(subject.attributes?.length).toBeLessThan(
      INSPECT_LIMITS.subjectAttributes,
    );
    expect(subject.attributes?.[0]?.name.length).toBeLessThanOrEqual(
      INSPECT_LIMITS.attributeNameLength,
    );
    expect(subject.attributes?.[0]?.value).toHaveLength(
      INSPECT_LIMITS.valueLength,
    );
    expect(subject.metadata.classes).toHaveLength(INSPECT_LIMITS.classNames);
    expect(subject.metadata.pageUrl).toBe("about:blank");
    expect(() => decodeURIComponent(String(subject.metadata.pageUrl))).not.toThrow();
    expect(InspectSubjectSchema.parse(subject)).toEqual(subject);
  });

  it("omits every session marker name even when page code copies it", () => {
    const stateMarker = "data-pin-op-preview-hover-0123456789abcdef";
    const styleMarker = "data-pin-op-runtime-fedcba9876543210";
    const element = {
      tagName: "BUTTON",
      id: "target",
      classList: ["button"],
      attributes: [
        { name: stateMarker, value: "" },
        { name: styleMarker, value: "copied-by-page" },
        { name: "data-page-state", value: "ready" },
      ],
    };
    const exact = createElementSnapshot(
      element,
      "https://example.test",
      undefined,
      {
        isRuntimeAttributeName: (name) => (
          name === stateMarker || name === styleMarker
        ),
      },
    );
    const copied = createElementSnapshot(
      { ...element },
      "https://example.test",
      undefined,
      {
        isRuntimeAttributeName: (name) => (
          name === stateMarker || name === styleMarker
        ),
      },
    );

    expect(exact.attributes).toEqual([
      { name: "data-page-state", value: "ready", metadata: {} },
    ]);
    expect(copied.attributes).toEqual(exact.attributes);
  });

  it("excludes runtime attributes before applying the author attribute budget", () => {
    const runtimeAttributes = Array.from({ length: 64 }, (_, index) => ({
      name: `data-pin-op-preview-runtime-${index}`,
      value: "",
    }));
    const subject = createElementSnapshot(
      {
        tagName: "BUTTON",
        id: "target",
        classList: [],
        attributes: [
          ...runtimeAttributes,
          { name: "data-page-state", value: "ready" },
        ],
      },
      "https://example.test",
      undefined,
      {
        isRuntimeAttributeName: (name) => (
          name.startsWith("data-pin-op-preview-runtime-")
        ),
      },
    );

    expect(subject.attributes).toEqual([
      { name: "data-page-state", value: "ready", metadata: {} },
    ]);
  });

  it("fails closed when the runtime-attribute predicate throws", () => {
    const subject = createElementSnapshot(
      {
        tagName: "BUTTON",
        id: "target",
        classList: [],
        attributes: [
          { name: "data-pin-op-preview-hostile", value: "secret" },
          { name: "data-page-state", value: "ready" },
        ],
      },
      "https://example.test",
      undefined,
      {
        isRuntimeAttributeName: (name) => {
          if (name === "data-pin-op-preview-hostile") {
            throw new Error("hostile predicate");
          }
          return false;
        },
      },
    );

    expect(subject.attributes).toEqual([
      { name: "data-page-state", value: "ready", metadata: {} },
    ]);
  });
});
