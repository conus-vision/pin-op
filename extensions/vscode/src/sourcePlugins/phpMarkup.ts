import type { SourceDocument } from "@pin-op/plugin-api";
import { BoundedLruCache } from "./boundedLruCache.js";

/**
 * A deliberately small PHP-aware markup scanner. It reads only what a template
 * resolver needs - element start/end offsets and literal attribute text - and
 * treats every `<?php ... ?>` block as opaque so generated values never look
 * like markup. It is not an HTML parser and never rewrites the document.
 */
export const PHP_MARKUP_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  maxElements: 20_000,
  maxAttributesPerElement: 64,
  maxOpenDepth: 256,
} as const;

const DOCUMENT_CACHE_LIMIT = 8;

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "textarea",
  "title",
]);

export class PhpMarkupLimitError extends Error {
  public constructor(public readonly limit: "bytes") {
    super(`PHP markup exceeds the supported ${limit} limit`);
    this.name = "PhpMarkupLimitError";
  }
}

export interface PhpMarkupAttribute {
  /** Lowercased attribute name. */
  readonly name: string;
  /** Attribute text with every PHP block removed. */
  readonly literalValue: string;
  /** True when a `<?php ... ?>` block contributed part of the value. */
  readonly dynamic: boolean;
}

export interface PhpMarkupElement {
  /** Lowercased tag name. */
  readonly tag: string;
  readonly attributes: readonly PhpMarkupAttribute[];
  /** Offset of the opening `<`. */
  readonly startOffset: number;
  /** Offset just past the opening tag's `>`. */
  readonly openEndOffset: number;
  /** Offset just past the matching close tag, or `openEndOffset`. */
  readonly endOffset: number;
}

export interface ParsedPhpMarkup {
  readonly elements: readonly PhpMarkupElement[];
  /** True when an element limit stopped the scan before the end of the file. */
  readonly truncated: boolean;
}

interface MutableElement {
  readonly tag: string;
  readonly attributes: readonly PhpMarkupAttribute[];
  readonly startOffset: number;
  readonly openEndOffset: number;
  endOffset: number;
}

export class PhpMarkupCache {
  private readonly documents = new BoundedLruCache<
    string,
    { readonly version: number; readonly text: string; readonly parsed: ParsedPhpMarkup }
  >(DOCUMENT_CACHE_LIMIT);

  public parseDocument(document: SourceDocument): ParsedPhpMarkup {
    const text = document.getText();
    const cached = this.documents.get(document.uri);
    if (cached?.version === document.version && cached.text === text) {
      return cached.parsed;
    }
    const parsed = parsePhpMarkup(text);
    this.documents.set(document.uri, {
      version: document.version,
      text,
      parsed,
    });
    return parsed;
  }
}

export function parsePhpMarkup(text: string): ParsedPhpMarkup {
  if (text.length > PHP_MARKUP_LIMITS.maxBytes) {
    throw new PhpMarkupLimitError("bytes");
  }
  const elements: MutableElement[] = [];
  const open: MutableElement[] = [];
  let truncated = false;
  let index = 0;

  while (index < text.length) {
    const next = text.indexOf("<", index);
    if (next < 0) break;
    index = next;

    if (startsWith(text, index, "<?")) {
      index = skipPhpBlock(text, index);
      continue;
    }
    if (startsWith(text, index, "<!--")) {
      const end = text.indexOf("-->", index + 4);
      index = end < 0 ? text.length : end + 3;
      continue;
    }
    if (startsWith(text, index, "<!")) {
      index = skipToTagEnd(text, index + 2);
      continue;
    }
    if (startsWith(text, index, "</")) {
      const name = readTagName(text, index + 2);
      index = skipToTagEnd(text, index + 2 + name.length);
      closeElement(open, name.toLowerCase(), index);
      continue;
    }
    if (!isTagNameStart(text.charCodeAt(index + 1))) {
      index += 1;
      continue;
    }
    if (elements.length >= PHP_MARKUP_LIMITS.maxElements) {
      truncated = true;
      break;
    }

    const tagName = readTagName(text, index + 1).toLowerCase();
    const openTag = readOpenTag(text, index, index + 1 + tagName.length, tagName);
    const element: MutableElement = {
      tag: tagName,
      attributes: openTag.attributes,
      startOffset: index,
      openEndOffset: openTag.endOffset,
      endOffset: openTag.endOffset,
    };
    elements.push(element);
    index = openTag.endOffset;

    if (RAW_TEXT_ELEMENTS.has(tagName)) {
      const closed = skipRawText(text, index, tagName);
      element.endOffset = closed;
      index = closed;
      continue;
    }
    if (openTag.selfClosing || VOID_ELEMENTS.has(tagName)) {
      continue;
    }
    if (open.length < PHP_MARKUP_LIMITS.maxOpenDepth) {
      open.push(element);
    }
  }

  return {
    elements: elements.map((element) => ({
      tag: element.tag,
      attributes: element.attributes,
      startOffset: element.startOffset,
      openEndOffset: element.openEndOffset,
      endOffset: element.endOffset,
    })),
    truncated,
  };
}

/** Splits a literal `class` attribute into the tokens a browser would see. */
export function classTokens(value: string): readonly string[] {
  return value.split(/\s+/u).filter((token) => token.length > 0);
}

function closeElement(
  open: MutableElement[],
  tag: string,
  endOffset: number,
): void {
  for (let depth = open.length - 1; depth >= 0; depth -= 1) {
    if (open[depth]!.tag !== tag) continue;
    for (let unwound = open.length - 1; unwound > depth; unwound -= 1) {
      open.pop();
    }
    const element = open.pop();
    if (element) element.endOffset = endOffset;
    return;
  }
}

function readOpenTag(
  text: string,
  _startOffset: number,
  attributesOffset: number,
  _tag: string,
): {
  readonly attributes: readonly PhpMarkupAttribute[];
  readonly endOffset: number;
  readonly selfClosing: boolean;
} {
  const attributes: PhpMarkupAttribute[] = [];
  let index = attributesOffset;
  let selfClosing = false;

  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (isWhitespace(code)) {
      index += 1;
      continue;
    }
    if (startsWith(text, index, "<?")) {
      index = skipPhpBlock(text, index);
      continue;
    }
    if (startsWith(text, index, "/>")) {
      selfClosing = true;
      index += 2;
      break;
    }
    if (code === 0x3e /* > */) {
      index += 1;
      break;
    }
    if (code === 0x2f /* / */) {
      index += 1;
      continue;
    }

    const name = readAttributeName(text, index);
    if (name.length === 0) {
      index += 1;
      continue;
    }
    index += name.length;
    index = skipWhitespace(text, index);
    if (text.charCodeAt(index) !== 0x3d /* = */) {
      if (attributes.length < PHP_MARKUP_LIMITS.maxAttributesPerElement) {
        attributes.push({
          name: name.toLowerCase(),
          literalValue: "",
          dynamic: false,
        });
      }
      continue;
    }
    index = skipWhitespace(text, index + 1);
    const value = readAttributeValue(text, index);
    index = value.endOffset;
    if (attributes.length < PHP_MARKUP_LIMITS.maxAttributesPerElement) {
      attributes.push({
        name: name.toLowerCase(),
        literalValue: value.literalValue,
        dynamic: value.dynamic,
      });
    }
  }

  return { attributes, endOffset: index, selfClosing };
}

function readAttributeValue(
  text: string,
  startOffset: number,
): {
  readonly literalValue: string;
  readonly dynamic: boolean;
  readonly endOffset: number;
} {
  const quote = text.charCodeAt(startOffset);
  const quoted = quote === 0x22 /* " */ || quote === 0x27 /* ' */;
  let index = quoted ? startOffset + 1 : startOffset;
  let literalValue = "";
  let dynamic = false;

  while (index < text.length) {
    if (startsWith(text, index, "<?")) {
      const end = skipPhpBlock(text, index);
      dynamic = true;
      index = end;
      continue;
    }
    const code = text.charCodeAt(index);
    if (quoted ? code === quote : isWhitespace(code) || code === 0x3e) {
      break;
    }
    if (!quoted && code === 0x2f && text.charCodeAt(index + 1) === 0x3e) {
      break;
    }
    literalValue += text[index];
    index += 1;
  }

  return {
    literalValue: literalValue.trim(),
    dynamic,
    endOffset: quoted && index < text.length ? index + 1 : index,
  };
}

function skipRawText(text: string, startOffset: number, tag: string): number {
  const needle = `</${tag}`;
  const lowered = text.toLowerCase();
  const found = lowered.indexOf(needle, startOffset);
  if (found < 0) return text.length;
  return skipToTagEnd(text, found + needle.length);
}

function skipPhpBlock(text: string, startOffset: number): number {
  const end = text.indexOf("?>", startOffset + 2);
  return end < 0 ? text.length : end + 2;
}

function skipToTagEnd(text: string, startOffset: number): number {
  let index = startOffset;
  while (index < text.length) {
    if (startsWith(text, index, "<?")) {
      index = skipPhpBlock(text, index);
      continue;
    }
    if (text.charCodeAt(index) === 0x3e /* > */) return index + 1;
    index += 1;
  }
  return text.length;
}

function readTagName(text: string, startOffset: number): string {
  let index = startOffset;
  while (index < text.length && isTagNameCharacter(text.charCodeAt(index))) {
    index += 1;
  }
  return text.slice(startOffset, index);
}

function readAttributeName(text: string, startOffset: number): string {
  let index = startOffset;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (
      isWhitespace(code) ||
      code === 0x3d /* = */ ||
      code === 0x3e /* > */ ||
      code === 0x2f /* / */ ||
      code === 0x3c /* < */
    ) {
      break;
    }
    index += 1;
  }
  return text.slice(startOffset, index);
}

function skipWhitespace(text: string, startOffset: number): number {
  let index = startOffset;
  while (index < text.length && isWhitespace(text.charCodeAt(index))) {
    index += 1;
  }
  return index;
}

function startsWith(text: string, index: number, value: string): boolean {
  return text.startsWith(value, index);
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a ||
    code === 0x0c || code === 0x0d;
}

function isTagNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isTagNameCharacter(code: number): boolean {
  return isTagNameStart(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2d /* - */ ||
    code === 0x5f /* _ */ ||
    code === 0x3a /* : */;
}
