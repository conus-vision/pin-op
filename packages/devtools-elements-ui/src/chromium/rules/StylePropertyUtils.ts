// Copyright 2021 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Pin-op adaptation of
 * front_end/panels/elements/StylePropertyUtils.ts at Chromium DevTools
 * revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Provides bounded display helpers for immutable rule snapshots. All
 * page-controlled strings are assigned through textContent.
 */

import type {
  GeneratedRuleSourceSnapshot,
  RuleContextSnapshot,
} from "../../contracts.js";

export function createRulesElement(
  document: Document,
  tagName: string,
  options: {
    readonly attributes?: Readonly<Record<string, string>>;
    readonly className?: string;
    readonly text?: string;
  } = {},
): HTMLElement {
  const element = document.createElement(tagName);
  if (options.className) element.className = options.className;
  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (options.text !== undefined) element.textContent = options.text;
  return element;
}

export function splitSelectorList(selectorText: string): readonly string[] {
  const selectors: string[] = [];
  let start = 0;
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  let roundDepth = 0;
  let squareDepth = 0;

  for (let index = 0; index < selectorText.length; index += 1) {
    const character = selectorText[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") roundDepth += 1;
    else if (character === ")") roundDepth = Math.max(0, roundDepth - 1);
    else if (character === "[") squareDepth += 1;
    else if (character === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (character === "," && roundDepth === 0 && squareDepth === 0) {
      selectors.push(selectorText.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(selectorText.slice(start).trim());
  return Object.freeze(selectors.filter((selector) => selector.length > 0));
}

export function contextLabel(context: RuleContextSnapshot): string {
  const prefix = context.kind === "starting-style"
    ? "@starting-style"
    : `@${context.kind}`;
  return context.text.length > 0 ? `${prefix} ${context.text}` : prefix;
}

export function generatedOriginLabel(
  source: GeneratedRuleSourceSnapshot,
): string {
  if (source.lineNumber === undefined) return source.label;
  const line = `${source.label}:${source.lineNumber}`;
  return source.columnNumber === undefined ? line : `${line}:${source.columnNumber}`;
}

export function containsFilter(value: string, normalizedQuery: string): boolean {
  return normalizedQuery.length === 0 || value.toLocaleLowerCase().includes(normalizedQuery);
}

export function normalizedFilter(query: string): string {
  return query.trim().toLocaleLowerCase();
}
