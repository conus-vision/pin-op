// Copyright 2018 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Pin-op adaptation of
 * front_end/panels/elements/StylePropertyTreeElement.ts at Chromium DevTools
 * revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains declaration token layout and cascade-state presentation. The
 * derived tree element has no mutation command or interactive value surface.
 */

import type { MatchedDeclarationSnapshot } from "../../contracts.js";
import { PropertyRenderer } from "./PropertyRenderer.js";
import {
  containsFilter,
  createRulesElement,
} from "./StylePropertyUtils.js";

export class StylePropertyTreeElement {
  public readonly element: HTMLElement;

  public constructor(
    document: Document,
    public readonly declaration: MatchedDeclarationSnapshot,
    inherited: boolean,
  ) {
    const stateClass = declarationStateClass(declaration.state);
    this.element = createRulesElement(document, "li", {
      className: [
        "rules-declaration",
        stateClass,
        inherited ? "inherited" : "",
      ].filter(Boolean).join(" "),
      attributes: {
        "aria-label": declarationAriaLabel(declaration),
        "data-declaration-ref": declaration.declarationRef,
        "data-declaration-state": declaration.state,
        "data-part": "rule-declaration",
        title: declarationTitle(declaration),
      },
    });
    const separator = createRulesElement(document, "span", {
      className: "styles-name-value-separator",
      text: ": ",
    });
    const semicolon = createRulesElement(document, "span", {
      className: "styles-semicolon",
      text: ";",
    });
    const important = PropertyRenderer.renderImportant(document, declaration);
    this.element.append(
      PropertyRenderer.renderName(document, declaration),
      separator,
      PropertyRenderer.renderValue(document, declaration),
      ...(important ? [important] : []),
      semicolon,
    );
  }

  public matches(normalizedQuery: string): boolean {
    return containsFilter(this.declaration.name, normalizedQuery) ||
      containsFilter(this.declaration.value, normalizedQuery) ||
      containsFilter(this.declaration.stateReason ?? "", normalizedQuery);
  }

  public setHidden(hidden: boolean): void {
    this.element.hidden = hidden;
  }
}

function declarationStateClass(
  state: MatchedDeclarationSnapshot["state"],
): string {
  switch (state) {
    case "overridden-known-author":
      return "overloaded";
    case "inactive":
      return "rules-declaration-inactive";
    case "unknown":
      return "rules-declaration-unknown";
    default:
      return "rules-declaration-winning";
  }
}

function declarationTitle(declaration: MatchedDeclarationSnapshot): string {
  if (declaration.stateReason) return declaration.stateReason;
  switch (declaration.state) {
    case "winning-known-author":
      return "Highest known author declaration; unavailable origins may still apply";
    case "overridden-known-author":
      return "Overridden by another known author declaration";
    case "inactive":
      return "Declaration is inactive in the current known context";
    case "unknown":
      return "Cascade result is unknown";
  }
}

function declarationAriaLabel(
  declaration: MatchedDeclarationSnapshot,
): string {
  return `${declaration.name}: ${declaration.value}${
    declaration.important ? " !important" : ""
  }; ${declarationTitle(declaration)}`;
}
