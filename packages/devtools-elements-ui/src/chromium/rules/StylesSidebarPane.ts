// Copyright 2021 The Chromium Authors
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
 * Pin-op adaptation of front_end/panels/elements/StylesSidebarPane.ts at
 * Chromium DevTools revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains section ordering, filtering, roving focus, partial diagnostics, and
 * familiar Rules presentation over a neutral immutable data source.
 */

import type {
  MatchedStylesSnapshot,
  PseudoStateDataSource,
  RulesDataSource,
  SourceLinkDelegate,
} from "../../contracts.js";
import { PseudoStateController } from "../../pseudoStateController.js";
import {
  StylePropertiesSection,
  type RulesSectionKind,
} from "./StylePropertiesSection.js";
import {
  createRulesElement,
  normalizedFilter,
} from "./StylePropertyUtils.js";

const nextInheritedHeadingId = new WeakMap<Document, number>();

export class StylesSidebarPane {
  public readonly element: HTMLElement;
  private readonly filterInput: HTMLInputElement;
  private readonly sectionsRoot: HTMLElement;
  private readonly diagnosticsRoot: HTMLElement;
  private readonly pseudoStateController: PseudoStateController | undefined;
  private sections: readonly StylePropertiesSection[] = [];
  private inheritedGroups: readonly RenderedInheritedGroup[] = [];
  private renderRevision = 0;
  private query = "";
  private disposed = false;
  private readonly onFilterInputListener = (): void => this.onFilterInput();
  private readonly onKeyDownListener = (event: Event): void => this.onKeyDown(event);

  public constructor(
    private readonly document: Document,
    private readonly dataSource: RulesDataSource,
    private readonly sourceLinkDelegate?: SourceLinkDelegate,
    pseudoStateDataSource?: PseudoStateDataSource,
  ) {
    this.element = createRulesElement(document, "div", {
      className: "styles-pane matched-styles read-only",
      attributes: {
        "aria-label": "Matched styles",
        "aria-readonly": "true",
        "data-part": "styles-sidebar-pane",
      },
    });
    const toolbar = createRulesElement(document, "div", {
      className: "styles-sidebar-pane-toolbar-container",
      attributes: { "data-part": "rules-toolbar" },
    });
    this.filterInput = createRulesElement(document, "input", {
      className: "styles-filter-input",
      attributes: {
        "aria-label": "Filter styles",
        "data-part": "rules-filter",
        placeholder: "Filter",
        spellcheck: "false",
        type: "search",
      },
    }) as HTMLInputElement;
    this.pseudoStateController = pseudoStateDataSource
      ? new PseudoStateController(document, pseudoStateDataSource)
      : undefined;
    toolbar.append(
      this.filterInput,
      ...(this.pseudoStateController
        ? [this.pseudoStateController.element]
        : []),
    );
    this.sectionsRoot = createRulesElement(document, "div", {
      className: "styles-sections",
      attributes: {
        "data-part": "rules-sections",
      },
    });
    this.diagnosticsRoot = createRulesElement(document, "div", {
      className: "rules-diagnostics",
      attributes: {
        "aria-live": "polite",
        "data-part": "rules-diagnostics",
      },
    });
    this.element.append(toolbar, this.sectionsRoot, this.diagnosticsRoot);
    this.filterInput.addEventListener("input", this.onFilterInputListener);
    this.sectionsRoot.addEventListener("keydown", this.onKeyDownListener);
  }

  public render(snapshot: MatchedStylesSnapshot): void {
    if (this.disposed) return;
    const revision = ++this.renderRevision;
    const sections: StylePropertiesSection[] = [];
    const children: HTMLElement[] = [];
    const inheritedGroups: RenderedInheritedGroup[] = [];
    const directRuleChildren: HTMLElement[] = [];
    if (snapshot.inlineStyle) {
      this.appendSection(
        sections,
        directRuleChildren,
        snapshot.inlineStyle,
        "inline",
      );
    }
    for (const rule of snapshot.matchedRules) {
      this.appendSection(sections, directRuleChildren, rule, "matched");
    }
    if (directRuleChildren.length > 0) {
      const directRulesList = this.createRuleList("Matched style rules", "matched");
      directRulesList.append(...directRuleChildren);
      children.push(directRulesList);
    }
    for (const inherited of snapshot.inherited) {
      const headingId = allocateInheritedHeadingId(this.document);
      const groupHeading = createRulesElement(this.document, "div", {
        className: "sidebar-separator inherited-separator",
        text: `Inherited from ${inherited.displayLabel}`,
        attributes: {
          "aria-level": "3",
          "data-part": "inherited-group-heading",
          id: headingId,
          role: "heading",
        },
      });
      const groupSections: StylePropertiesSection[] = [];
      const groupRuleChildren: HTMLElement[] = [];
      if (inherited.inlineStyle) {
        groupSections.push(this.appendSection(
          sections,
          groupRuleChildren,
          inherited.inlineStyle,
          "inherited",
          inherited.displayLabel,
        ));
      }
      for (const rule of inherited.matchedRules) {
        groupSections.push(this.appendSection(
          sections,
          groupRuleChildren,
          rule,
          "inherited",
          inherited.displayLabel,
        ));
      }
      if (groupSections.length === 0) continue;
      const groupRulesList = this.createRuleList(
        `Style rules inherited from ${inherited.displayLabel}`,
        "inherited",
      );
      groupRulesList.append(...groupRuleChildren);
      const group = createRulesElement(this.document, "section", {
        className: "inherited-styles-group",
        attributes: {
          "aria-labelledby": headingId,
          "data-inherited-ancestor-index": String(inherited.ancestorIndex),
          "data-part": "inherited-group",
          role: "group",
        },
      });
      group.append(groupHeading, groupRulesList);
      children.push(group);
      inheritedGroups.push(Object.freeze({
        element: group,
        sections: Object.freeze(groupSections),
      }));
    }
    if (sections.length === 0) {
      children.push(createRulesElement(this.document, "p", {
        className: "gray-info-message",
        text: "No matching styles",
        attributes: { role: "status" },
      }));
    }
    if (this.disposed || revision !== this.renderRevision) return;
    this.sections = Object.freeze(sections);
    this.inheritedGroups = Object.freeze(inheritedGroups);
    this.sectionsRoot.replaceChildren(...children);
    this.renderDiagnostics(snapshot);
    this.applyFilter();
  }

  public clear(): void {
    if (this.disposed) return;
    this.renderRevision += 1;
    this.sections = [];
    this.inheritedGroups = [];
    this.sectionsRoot.replaceChildren();
    this.diagnosticsRoot.replaceChildren();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderRevision += 1;
    let disposeError: unknown;
    this.filterInput.removeEventListener("input", this.onFilterInputListener);
    this.sectionsRoot.removeEventListener("keydown", this.onKeyDownListener);
    try {
      this.pseudoStateController?.dispose();
    } catch (error) {
      disposeError = error;
    }
    this.sections = [];
    this.inheritedGroups = [];
    this.element.replaceChildren();
    this.element.remove();
    if (disposeError !== undefined) throw disposeError;
  }

  private appendSection(
    sections: StylePropertiesSection[],
    children: HTMLElement[],
    rule: MatchedStylesSnapshot["matchedRules"][number],
    kind: RulesSectionKind,
    inheritedFrom?: string,
  ): StylePropertiesSection {
    const section = new StylePropertiesSection(this.document, rule, {
      kind,
      ...(inheritedFrom ? { inheritedFrom } : {}),
      ...(this.sourceLinkDelegate
        ? { sourceLinkDelegate: this.sourceLinkDelegate }
        : {}),
    });
    sections.push(section);
    children.push(section.element);
    return section;
  }

  private createRuleList(
    label: string,
    kind: "matched" | "inherited",
  ): HTMLElement {
    return createRulesElement(this.document, "div", {
      className: "rules-list",
      attributes: {
        "aria-label": label,
        "data-list-kind": kind,
        "data-part": "rules-list",
        role: "list",
      },
    });
  }

  private renderDiagnostics(snapshot: MatchedStylesSnapshot): void {
    const diagnostics: HTMLElement[] = [];
    if (snapshot.inaccessibleStylesheetCount > 0) {
      const count = snapshot.inaccessibleStylesheetCount;
      diagnostics.push(this.notice(
        `${count} stylesheet${count === 1 ? "" : "s"} inaccessible`,
        "warning",
      ));
    }
    if (snapshot.omittedRuleCount > 0) {
      const count = snapshot.omittedRuleCount;
      diagnostics.push(this.notice(
        `${count} matching rule${count === 1 ? "" : "s"} omitted`,
        "warning",
      ));
    }
    for (const diagnostic of snapshot.diagnostics) {
      diagnostics.push(createRulesElement(this.document, "p", {
        className: `rules-diagnostic rules-diagnostic--${diagnostic.severity}`,
        text: diagnostic.message,
        attributes: {
          "data-diagnostic-code": diagnostic.code,
          "data-diagnostic-severity": diagnostic.severity,
          role: diagnostic.severity === "error" ? "alert" : "status",
        },
      }));
    }
    this.diagnosticsRoot.replaceChildren(...diagnostics);
  }

  private notice(text: string, severity: "warning"): HTMLElement {
    return createRulesElement(this.document, "p", {
      className: "rules-diagnostic rules-diagnostic--warning",
      text,
      attributes: {
        "data-diagnostic-severity": severity,
        role: "status",
      },
    });
  }

  private onFilterInput(): void {
    if (this.disposed) return;
    this.query = this.filterInput.value;
    try {
      this.dataSource.filter(this.query);
    } catch {
      // Presentation filtering remains local and cannot change model authority.
    }
    this.applyFilter();
  }

  private applyFilter(): void {
    const query = normalizedFilter(this.query);
    const activeElement = this.document.activeElement;
    const visible = this.sections.filter((section) => section.applyFilter(query));
    for (const group of this.inheritedGroups) {
      group.element.hidden = group.sections.every((section) => section.element.hidden);
    }
    const activeSection = visible.find((section) => (
      section.element === activeElement || section.element.contains(activeElement)
    ));
    const tabStop = activeSection ?? visible[0];
    for (const section of this.sections) {
      section.setTabStop(section === tabStop);
    }
  }

  private onKeyDown(event: Event): void {
    if (this.disposed) return;
    const key = (event as KeyboardEvent).key;
    const visible = this.sections.filter((section) => !section.element.hidden);
    if (visible.length === 0) return;
    const current = visible.findIndex((section) => (
      section.element === event.target || section.element.contains(event.target as Node)
    ));
    if (current < 0) return;
    let next = current;
    if (key === "ArrowDown" || key === "ArrowRight") {
      next = (current + 1) % visible.length;
    } else if (key === "ArrowUp" || key === "ArrowLeft") {
      next = (current - 1 + visible.length) % visible.length;
    } else if (key === "Home") {
      next = 0;
    } else if (key === "End") {
      next = visible.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    for (const section of this.sections) section.setTabStop(false);
    visible[next]?.setTabStop(true);
    visible[next]?.focus();
  }
}

interface RenderedInheritedGroup {
  readonly element: HTMLElement;
  readonly sections: readonly StylePropertiesSection[];
}

function allocateInheritedHeadingId(document: Document): string {
  let sequence = nextInheritedHeadingId.get(document) ?? 1;
  while (document.getElementById(`pin-op-rules-inherited-${sequence}`)) {
    sequence += 1;
  }
  nextInheritedHeadingId.set(document, sequence + 1);
  return `pin-op-rules-inherited-${sequence}`;
}
