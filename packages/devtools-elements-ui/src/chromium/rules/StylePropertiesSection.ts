// Copyright 2022 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Copyright (C) 2007 Apple Inc.  All rights reserved.
 * Copyright (C) 2009 Joseph Pecoraro
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1.  Redistributions of source code must retain the above copyright
 *     notice, this list of conditions and the following disclaimer.
 * 2.  Redistributions in binary form must reproduce the above copyright
 *     notice, this list of conditions and the following disclaimer in the
 *     documentation and/or other materials provided with the distribution.
 * 3.  Neither the name of Apple Computer, Inc. ("Apple") nor the names of
 *     its contributors may be used to endorse or promote products derived
 *     from this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY APPLE AND ITS CONTRIBUTORS "AS IS" AND ANY
 * EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
 * WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL APPLE OR ITS CONTRIBUTORS BE LIABLE FOR ANY
 * DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
 * LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
 * ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 * (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 * THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

/*
 * Pin-op adaptation of
 * front_end/panels/elements/StylePropertiesSection.ts at Chromium DevTools
 * revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains selector matching, group ancestry, origin placement, declaration
 * layout, and filter behavior over immutable read-only snapshots.
 */

import type {
  MatchedRuleSnapshot,
  SourceLinkDelegate,
} from "../../contracts.js";
import { StylePropertyTreeElement } from "./StylePropertyTreeElement.js";
import {
  containsFilter,
  contextLabel,
  createRulesElement,
  generatedOriginLabel,
  splitSelectorList,
} from "./StylePropertyUtils.js";

export type RulesSectionKind = "inline" | "matched" | "inherited";

export interface StylePropertiesSectionOptions {
  readonly kind: RulesSectionKind;
  readonly inheritedFrom?: string;
  readonly sourceLinkDelegate?: SourceLinkDelegate;
}

export class StylePropertiesSection {
  public readonly element: HTMLElement;
  private readonly declarations: readonly StylePropertyTreeElement[];
  private readonly filterText: string;

  public constructor(
    document: Document,
    public readonly rule: MatchedRuleSnapshot,
    options: StylePropertiesSectionOptions,
  ) {
    this.element = createRulesElement(document, "section", {
      className: "styles-section matched-styles read-only",
      attributes: {
        "aria-label": sectionAriaLabel(rule, options),
        "aria-readonly": "true",
        "data-part": "rules-section",
        "data-rule-ref": rule.ruleRef,
        "data-section-kind": options.kind,
        ...(options.inheritedFrom
          ? { "data-inherited-from": options.inheritedFrom }
          : {}),
        role: "listitem",
        tabindex: "-1",
      },
    });

    const contexts = createRulesElement(document, "div", {
      className: "ancestor-rule-list",
      attributes: { "data-part": "rule-contexts" },
    });
    for (const context of rule.contexts) {
      contexts.append(createRulesElement(document, "span", {
        className: "rule-context",
        text: contextLabel(context),
        attributes: {
          "data-context-kind": context.kind,
          "data-part": "rule-context",
        },
      }));
    }

    const title = createRulesElement(document, "div", {
      className: "styles-section-title",
      attributes: { "data-part": "rule-title" },
    });
    const selectorContainer = createRulesElement(document, "span", {
      className: "styles-selector selector",
      attributes: { "data-part": "rule-selectors" },
    });
    const selectors = splitSelectorList(rule.selectorText);
    const matching = new Set(rule.matchingSelectorIndices);
    selectors.forEach((selector, index) => {
      if (index > 0) {
        selectorContainer.append(createRulesElement(document, "span", {
          className: "selector-separator",
          text: ", ",
        }));
      }
      const hasMatchAuthority = rule.matchingSelectorIndices.length > 0;
      const selectorMatches = matching.has(index);
      selectorContainer.append(createRulesElement(document, "span", {
        className: `simple-selector${selectorMatches ? " selector-matches" : ""}`,
        text: selector,
        attributes: {
          "data-part": "rule-selector",
          ...(hasMatchAuthority
            ? { "data-selector-matches": String(selectorMatches) }
            : {}),
        },
      }));
    });
    title.append(selectorContainer);

    const exactOrigin = options.sourceLinkDelegate?.originFor(rule.ruleRef);
    const exactOriginLabel = exactOrigin?.clickable
      ? `${exactOrigin.label}:${exactOrigin.startLine}`
      : undefined;
    if (exactOriginLabel !== undefined) {
      const origin = createRulesElement(document, "button", {
        className: "styles-section-subtitle rule-origin",
        text: exactOriginLabel,
        attributes: {
          "data-rule-origin": rule.ruleRef,
          "data-source-link-status": "ready",
          type: "button",
        },
      });
      origin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        options.sourceLinkDelegate?.openRuleOrigin(rule.ruleRef);
      });
      title.append(origin);
    } else if (rule.generatedSource) {
      const origin = createRulesElement(document, "span", {
        className: "styles-section-subtitle rule-origin",
        text: generatedOriginLabel(rule.generatedSource),
        attributes: {
          "data-rule-origin": rule.ruleRef,
          "data-source-link-status": exactOrigin?.state ?? (
            options.sourceLinkDelegate ? "unresolved" : "unavailable"
          ),
        },
      });
      title.append(origin);
    }

    const openingBrace = createRulesElement(document, "span", {
      className: "sidebar-pane-open-brace",
      text: " {",
    });
    title.append(openingBrace);

    const declarationList = createRulesElement(document, "ol", {
      className: "tree-outline style-properties expanded",
      attributes: {
        "aria-label": `Declarations for ${rule.selectorText}`,
        "data-part": "rule-declarations",
        role: "list",
      },
    });
    this.declarations = Object.freeze(rule.declarations.map((declaration) => (
      new StylePropertyTreeElement(
        document,
        declaration,
        options.kind === "inherited",
      )
    )));
    declarationList.append(...this.declarations.map(({ element }) => element));
    const closingBrace = createRulesElement(document, "div", {
      className: "sidebar-pane-closing-brace",
      text: "}",
    });
    this.element.append(contexts, title, declarationList, closingBrace);
    this.filterText = [
      rule.selectorText,
      ...rule.contexts.map(contextLabel),
      exactOriginLabel ?? (
        rule.generatedSource ? generatedOriginLabel(rule.generatedSource) : ""
      ),
      options.inheritedFrom ?? "",
    ].join("\n");
  }

  public applyFilter(normalizedQuery: string): boolean {
    const ruleMatches = containsFilter(this.filterText, normalizedQuery);
    let declarationMatches = false;
    for (const declaration of this.declarations) {
      const matches = ruleMatches || declaration.matches(normalizedQuery);
      declaration.setHidden(!matches);
      declarationMatches ||= matches;
    }
    const visible = normalizedQuery.length === 0 || ruleMatches || declarationMatches;
    this.element.hidden = !visible;
    return visible;
  }

  public setTabStop(active: boolean): void {
    this.element.setAttribute("tabindex", active ? "0" : "-1");
  }

  public focus(): void {
    try {
      this.element.focus({ preventScroll: true });
    } catch {
      this.element.focus();
    }
  }
}

function sectionAriaLabel(
  rule: MatchedRuleSnapshot,
  options: StylePropertiesSectionOptions,
): string {
  return options.kind === "inherited"
    ? `Inherited styles from ${options.inheritedFrom ?? "ancestor"}: ${rule.selectorText}`
    : `${options.kind === "inline" ? "Inline" : "Matched"} styles: ${rule.selectorText}`;
}
