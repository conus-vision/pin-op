import { describe, expect, it } from "vitest";
import {
  INSPECT_LIMITS,
  InspectSubjectSchema,
} from "@pinop/protocol";
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
});
