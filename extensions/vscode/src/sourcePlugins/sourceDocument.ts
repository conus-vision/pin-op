import type { SourceDocument } from "@browser2ide/plugin-api";

export interface TextDocumentLike {
  readonly uri: { toString(): string };
  readonly languageId: string;
  readonly version: number;
  getText(): string;
  positionAt(offset: number): { line: number; character: number };
  offsetAt(position: { line: number; character: number }): number;
}

export function adaptSourceDocument(
  document: TextDocumentLike,
): SourceDocument {
  const text = document.getText();
  const index = new TextOffsetIndex(text);
  return {
    uri: document.uri.toString(),
    languageId: document.languageId,
    version: document.version,
    getText: () => text,
    positionAt: (offset) => index.positionAt(offset),
    offsetAt: (position) => index.offsetAt(position),
  };
}

class TextOffsetIndex {
  private readonly lineStarts = [0];

  public constructor(private readonly text: string) {
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  public positionAt(offset: number): { line: number; character: number } {
    const boundedOffset = clampInteger(offset, 0, this.text.length);
    let low = 0;
    let high = this.lineStarts.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.lineStarts[middle]! <= boundedOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const line = Math.max(0, low - 1);
    const lineStart = this.lineStarts[line]!;
    return {
      line,
      character: Math.min(boundedOffset, this.lineContentEnd(line)) - lineStart,
    };
  }

  public offsetAt(position: { line: number; character: number }): number {
    const line = clampInteger(position.line, 0, this.lineStarts.length);
    if (line >= this.lineStarts.length) return this.text.length;
    const lineStart = this.lineStarts[line]!;
    const character = clampInteger(
      position.character,
      0,
      this.lineContentEnd(line) - lineStart,
    );
    return lineStart + character;
  }

  private lineContentEnd(line: number): number {
    const nextLineStart = this.lineStarts[line + 1];
    if (nextLineStart === undefined) return this.text.length;
    const lineFeed = nextLineStart - 1;
    return this.text[lineFeed - 1] === "\r" ? lineFeed - 1 : lineFeed;
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(Math.max(Math.floor(value), minimum), maximum);
}
