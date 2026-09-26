import type {
  SourceDocument,
  SourcePosition,
  SourceRange,
} from "@pin-op/plugin-api";
import type { RulesOpenDeclaration } from "@pin-op/protocol";

/**
 * Where the value of one declaration a rule writes directly begins.
 *
 * The rule is the private range the IDE already holds for the clicked origin;
 * only its own block is read, so a declaration of a nested rule, a mixin body
 * or a comment never answers for it. A browser keeps only the last of two equal
 * declarations -- `height: 100vh; height: 100dvh` shows `100dvh` -- so the
 * occurrence is counted from the end of the rule, and occurrence 0 is the last
 * one written. A property the rule does not write itself -- one an `@include`
 * put there -- has no position, and the caller stays on the rule.
 */
export function declarationValuePosition(
  document: SourceDocument,
  range: SourceRange,
  declaration: RulesOpenDeclaration,
): SourcePosition | undefined {
  let text: string;
  let start: number;
  let end: number;
  try {
    text = document.getText();
    start = document.offsetAt(range.start);
    end = Math.min(text.length, document.offsetAt(range.end));
  } catch {
    return undefined;
  }
  if (!(start >= 0 && end > start)) return undefined;
  const bodyStart = blockBodyStart(text, start, end);
  if (bodyStart === undefined) return undefined;

  const wanted = declaration.property.toLowerCase();
  const offsets = directDeclarationValueOffsets(text, bodyStart, end)
    .filter((entry) => entry.property === wanted)
    .map((entry) => entry.valueOffset);
  // Counted from the end: the browser shows the last of equal declarations,
  // so occurrence 0 is the last one the rule writes.
  const offset = offsets[offsets.length - 1 - declaration.occurrence] ??
    offsets[0];
  return offset === undefined ? undefined : document.positionAt(offset);
}

interface DirectDeclaration {
  readonly property: string;
  readonly valueOffset: number;
}

/** The offset just after the rule's own opening brace. */
function blockBodyStart(
  text: string,
  start: number,
  end: number,
): number | undefined {
  let parens = 0;
  for (let index = start; index < end; index += 1) {
    const skipped = skipQuotedOrComment(text, index, end);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const character = text[index];
    if (character === "(") parens += 1;
    else if (character === ")") parens = Math.max(0, parens - 1);
    else if (character === "#" && text[index + 1] === "{") {
      index = skipInterpolation(text, index, end) - 1;
    } else if (character === "{" && parens === 0) return index + 1;
  }
  return undefined;
}

/**
 * Every `property: value` statement written directly in the block, in order.
 * A statement is a declaration only when it ends at `;` or at the block's end
 * rather than opening a block of its own, which is what separates `color: red`
 * from a nested `a:hover { ... }`.
 */
function directDeclarationValueOffsets(
  text: string,
  bodyStart: number,
  end: number,
): readonly DirectDeclaration[] {
  const declarations: DirectDeclaration[] = [];
  let statementStart = bodyStart;
  let colon: number | undefined;
  let parens = 0;
  for (let index = bodyStart; index < end; index += 1) {
    const skipped = skipQuotedOrComment(text, index, end);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    const character = text[index];
    if (character === "#" && text[index + 1] === "{") {
      index = skipInterpolation(text, index, end) - 1;
      continue;
    }
    if (character === "(") {
      parens += 1;
    } else if (character === ")") {
      parens = Math.max(0, parens - 1);
    } else if (parens > 0) {
      continue;
    } else if (character === ":" && colon === undefined) {
      colon = index;
    } else if (character === ";" || character === "}") {
      const declaration = colon === undefined
        ? undefined
        : readDeclaration(text, statementStart, colon);
      if (declaration) declarations.push(declaration);
      if (character === "}") break;
      statementStart = index + 1;
      colon = undefined;
    } else if (character === "{") {
      index = skipBlock(text, index, end) - 1;
      statementStart = index + 1;
      colon = undefined;
    }
  }
  return declarations;
}

function readDeclaration(
  text: string,
  statementStart: number,
  colon: number,
): DirectDeclaration | undefined {
  let nameStart = statementStart;
  for (;;) {
    while (nameStart < colon && /\s/u.test(text[nameStart]!)) nameStart += 1;
    const afterComment = skipQuotedOrComment(text, nameStart, colon);
    if (afterComment === nameStart) break;
    nameStart = afterComment;
  }
  const name = text.slice(nameStart, colon).trimEnd();
  if (!/^-{0,2}[A-Za-z_][A-Za-z0-9_-]*$/u.test(name)) return undefined;
  let valueOffset = colon + 1;
  while (valueOffset < text.length && /[ \t]/u.test(text[valueOffset]!)) {
    valueOffset += 1;
  }
  return { property: name.toLowerCase(), valueOffset };
}

function skipBlock(text: string, open: number, end: number): number {
  let depth = 0;
  for (let index = open; index < end; index += 1) {
    const skipped = skipQuotedOrComment(text, index, end);
    if (skipped !== index) {
      index = skipped - 1;
      continue;
    }
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}" && --depth === 0) return index + 1;
  }
  return end;
}

function skipInterpolation(text: string, hash: number, end: number): number {
  return skipBlock(text, hash + 1, end);
}

/** The offset after a string or comment starting at `index`, else `index`. */
function skipQuotedOrComment(text: string, index: number, end: number): number {
  const character = text[index];
  if (character === "/" && text[index + 1] === "*") {
    const close = text.indexOf("*/", index + 2);
    return close === -1 || close + 2 > end ? end : close + 2;
  }
  if (character === "/" && text[index + 1] === "/" && isLineCommentStart(text, index)) {
    const close = text.indexOf("\n", index + 2);
    return close === -1 || close > end ? end : close;
  }
  if (character === "\"" || character === "'") {
    for (let cursor = index + 1; cursor < end; cursor += 1) {
      if (text[cursor] === "\\") {
        cursor += 1;
      } else if (text[cursor] === character || text[cursor] === "\n") {
        return cursor + 1;
      }
    }
    return end;
  }
  return index;
}

/** `//` opens a SCSS comment only where a statement could start, never in `url(//...)`. */
function isLineCommentStart(text: string, index: number): boolean {
  const previous = text[index - 1];
  return previous === undefined || /[\s;{}]/u.test(previous);
}
