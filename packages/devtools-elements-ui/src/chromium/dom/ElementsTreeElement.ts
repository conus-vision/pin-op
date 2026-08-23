// Copyright 2021 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Copyright (C) 2007, 2008 Apple Inc.  All rights reserved.
 * Copyright (C) 2008 Matt Lilek <webkit@mattlilek.com>
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
 * front_end/panels/elements/ElementsTreeElement.ts at Chromium DevTools
 * revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains the structured DOM syntax presentation. Chromium SDK nodes, Lit,
 * editing, context menus, host services, and mutation commands are omitted.
 */

import type {
  InspectorAttributeSnapshot,
  InspectorNodeSnapshot,
  TreeRowSnapshot,
} from "../../contracts.js";

const MAX_RENDERED_DEPTH = 64;
const HTML_VOID_ELEMENTS = new Set([
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

export interface TreeItemPosition {
  readonly positionInSet: number;
  readonly setSize: number;
}

export class ElementsTreeElement {
  public readonly element: HTMLElement;

  public constructor(
    document: Document,
    public readonly row: TreeRowSnapshot,
    position?: TreeItemPosition,
  ) {
    this.element = row.type === "load-more"
      ? renderLoadMoreRow(document, row, position)
      : renderNodeRow(document, row, position);
  }

  public setFocused(focused: boolean): void {
    this.element.setAttribute("tabindex", focused ? "0" : "-1");
    if (focused) {
      this.element.setAttribute("data-focused", "true");
    } else {
      this.element.removeAttribute("data-focused");
    }
  }
}

function renderLoadMoreRow(
  document: Document,
  row: TreeRowSnapshot,
  position: TreeItemPosition | undefined,
): HTMLElement {
  const element = createElement(document, "button", {
    className: "pin-op-elements-inspector__tree-row elements-tree-row elements-tree-load-more",
    attributes: rowAttributes(row, position, {
      "aria-label": "Load more DOM children",
      "data-action": "load-more",
      role: "treeitem",
      type: "button",
    }),
  });
  appendIndentation(document, element, row.depth);
  element.append(createElement(document, "span", {
    className: "elements-tree-load-more-label",
    text: "Load more",
  }));
  return element;
}

function renderNodeRow(
  document: Document,
  row: TreeRowSnapshot,
  position: TreeItemPosition | undefined,
): HTMLElement {
  const node = row.node;
  if (!node) {
    throw new Error("A DOM node tree row requires a structured node snapshot");
  }

  const element = createElement(document, "div", {
    className: "pin-op-elements-inspector__tree-row elements-tree-row",
    attributes: rowAttributes(row, position, {
      "aria-selected": String(row.selected),
      role: "treeitem",
    }),
  });
  if (row.expandable) {
    element.setAttribute("aria-expanded", String(row.expanded));
  }
  if (row.selected) element.setAttribute("data-selected", "true");
  if (row.hovered) element.setAttribute("data-hovered", "true");
  if (!isInspectableNode(node)) element.setAttribute("data-selectable", "false");
  if (node.inaccessible) element.setAttribute("data-inaccessible", "true");

  appendIndentation(document, element, row.depth);
  element.append(renderDisclosure(document, row));

  const highlight = createElement(document, "span", {
    className: "highlight",
    attributes: { "data-part": "node-title" },
  });
  renderNodeTitle(document, highlight, node, row);
  element.append(highlight);
  return element;
}

function rowAttributes(
  row: TreeRowSnapshot,
  position: TreeItemPosition | undefined,
  extra: Readonly<Record<string, string>>,
): Record<string, string> {
  const attributes: Record<string, string> = {
    "aria-level": String(row.depth + 1),
    "data-depth": String(row.depth),
    "data-node-ref": row.nodeRef,
    "data-row-type": row.type,
    tabindex: row.focused ? "0" : "-1",
    ...extra,
  };
  if (row.parentRef !== undefined) {
    attributes["data-parent-ref"] = row.parentRef;
  }
  if (position !== undefined) {
    attributes["aria-posinset"] = String(position.positionInSet);
    attributes["aria-setsize"] = String(position.setSize);
  }
  if (row.focused) attributes["data-focused"] = "true";
  return attributes;
}

function appendIndentation(document: Document, target: HTMLElement, depth: number): void {
  const safeDepth = Math.min(MAX_RENDERED_DEPTH, Math.max(0, depth));
  const indentation = createElement(document, "span", {
    className: "elements-tree-indentation",
    attributes: { "aria-hidden": "true" },
  });
  for (let index = 0; index < safeDepth; index += 1) {
    indentation.append(createElement(document, "span", {
      className: "elements-tree-indent-guide",
    }));
  }
  target.append(indentation);
}

function renderDisclosure(document: Document, row: TreeRowSnapshot): HTMLElement {
  if (!row.expandable) {
    return createElement(document, "span", {
      className: "elements-tree-disclosure-placeholder",
      attributes: { "aria-hidden": "true" },
    });
  }
  return createElement(document, "button", {
    className: "elements-tree-disclosure",
    attributes: {
      "aria-label": row.expanded ? "Collapse node" : "Expand node",
      "data-action": "toggle",
      tabindex: "-1",
      type: "button",
    },
  });
}

function renderNodeTitle(
  document: Document,
  target: HTMLElement,
  node: InspectorNodeSnapshot,
  row: TreeRowSnapshot,
): void {
  switch (node.kind) {
    case "document-type":
      target.append(token(document, "webkit-html-doctype", doctypeText(node)));
      return;
    case "element":
      renderElementTitle(document, target, node, row);
      return;
    case "text":
      target.append(token(document, "webkit-html-punctuation", "\""));
      target.append(token(document, "webkit-html-text-node", node.nodeValue ?? ""));
      target.append(token(document, "webkit-html-punctuation", "\""));
      return;
    case "comment":
      target.append(token(
        document,
        "webkit-html-comment",
        `<!--${node.nodeValue ?? ""}-->`,
      ));
      return;
    case "shadow-root": {
      target.append(token(document, "webkit-html-fragment", "#shadow-root (open)"));
      return;
    }
    case "frame-document": {
      const accessibility = node.inaccessible ? " (inaccessible)" : "";
      target.append(token(
        document,
        "webkit-html-frame-document",
        `${node.nodeName}${accessibility}`,
      ));
    }
  }
}

function isInspectableNode(node: InspectorNodeSnapshot): boolean {
  return node.kind === "element" && node.selectable && !node.inaccessible;
}

function renderElementTitle(
  document: Document,
  target: HTMLElement,
  node: InspectorNodeSnapshot,
  row: TreeRowSnapshot,
): void {
  const tagName = node.nodeName.toLowerCase();
  target.append(renderTag(document, tagName, node.attributes, false));
  if (HTML_VOID_ELEMENTS.has(tagName)) return;
  if (row.expandable && row.expanded) return;
  if (row.expandable) {
    target.append(token(document, "webkit-html-text-node elements-tree-ellipsis", "…"));
  }
  target.append(renderTag(document, tagName, [], true));
}

function renderTag(
  document: Document,
  tagName: string,
  attributes: readonly InspectorAttributeSnapshot[],
  closing: boolean,
): HTMLElement {
  const tag = createElement(document, "span", {
    className: closing ? "webkit-html-tag close" : "webkit-html-tag",
  });
  tag.append(token(document, "webkit-html-punctuation", "<"));
  tag.append(token(
    document,
    closing ? "webkit-html-close-tag-name" : "webkit-html-tag-name",
    closing ? `/${tagName}` : tagName,
  ));
  if (!closing) {
    for (const attribute of attributes) {
      tag.append(token(document, "webkit-html-punctuation", " "));
      tag.append(renderAttribute(document, attribute));
    }
  }
  tag.append(token(document, "webkit-html-punctuation", ">"));
  return tag;
}

function renderAttribute(
  document: Document,
  attribute: InspectorAttributeSnapshot,
): HTMLElement {
  const wrapper = createElement(document, "span", {
    className: "webkit-html-attribute",
  });
  wrapper.append(token(document, "webkit-html-attribute-name", attribute.name));
  wrapper.append(token(document, "webkit-html-punctuation", "=\""));
  wrapper.append(token(document, "webkit-html-attribute-value", attribute.value));
  wrapper.append(token(document, "webkit-html-punctuation", "\""));
  return wrapper;
}

function doctypeText(node: InspectorNodeSnapshot): string {
  let value = `<!DOCTYPE ${node.nodeName}`;
  if (node.publicId) {
    value += ` PUBLIC "${node.publicId}"`;
    if (node.systemId) value += ` "${node.systemId}"`;
  } else if (node.systemId) {
    value += ` SYSTEM "${node.systemId}"`;
  }
  return `${value}>`;
}

function token(document: Document, className: string, text: string): HTMLElement {
  return createElement(document, "span", { className, text });
}

function createElement(
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
