import { describe, expect, it } from "vitest";
import { adaptSourceDocument } from "../src/sourcePlugins/sourceDocument.js";

describe("adaptSourceDocument", () => {
  it("adapts a VS Code text document without exposing vscode types", () => {
    const text = ".card {}";
    const adapted = adaptSourceDocument({
      uri: { toString: () => "file:///workspace/src/card.scss" },
      languageId: "scss",
      version: 7,
      getText: () => text,
      positionAt: (offset) => ({ line: 0, character: offset }),
      offsetAt: (position) => position.character,
    });

    expect(adapted).toMatchObject({
      uri: "file:///workspace/src/card.scss",
      languageId: "scss",
      version: 7,
    });
    expect(adapted.getText()).toBe(text);
    expect(adapted.positionAt(6)).toEqual({ line: 0, character: 6 });
    expect(adapted.offsetAt({ line: 0, character: 5 })).toBe(5);
  });

  it("does not pass plain source positions to a strict host document", () => {
    const text = [".card {", "  color: red;", "}"].join("\r\n");
    let hostOffsetCalls = 0;
    const adapted = adaptSourceDocument({
      uri: { toString: () => "file:///workspace/src/card.scss" },
      languageId: "scss",
      version: 1,
      getText: () => text,
      positionAt: () => ({ line: 0, character: 0 }),
      offsetAt: () => {
        hostOffsetCalls += 1;
        throw new TypeError("Invalid argument");
      },
    });

    expect(adapted.offsetAt({ line: 1, character: 2 })).toBe(11);
    expect(adapted.offsetAt({ line: 99, character: 99 })).toBe(text.length);
    expect(hostOffsetCalls).toBe(0);
  });
});
