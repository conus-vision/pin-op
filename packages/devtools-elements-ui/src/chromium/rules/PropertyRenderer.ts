// Copyright 2024 The Chromium Authors
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/*
 * Pin-op adaptation of front_end/panels/elements/PropertyRenderer.ts at
 * Chromium DevTools revision a092f2943b68ef9aa7c1d2c2a8b7e71aa4087280.
 *
 * Retains the property name/value token boundary while rendering immutable
 * strings only. Interactive value tooling and backend model dependencies are
 * intentionally outside this derived module.
 */

import type { MatchedDeclarationSnapshot } from "../../contracts.js";
import { createRulesElement } from "./StylePropertyUtils.js";

export class PropertyRenderer {
  public static renderName(
    document: Document,
    declaration: MatchedDeclarationSnapshot,
  ): HTMLElement {
    return createRulesElement(document, "span", {
      className: "webkit-css-property",
      text: declaration.name,
      attributes: { "data-part": "property-name" },
    });
  }

  public static renderValue(
    document: Document,
    declaration: MatchedDeclarationSnapshot,
  ): HTMLElement {
    return createRulesElement(document, "span", {
      className: "value",
      text: declaration.value,
      attributes: { "data-part": "property-value" },
    });
  }

  public static renderImportant(
    document: Document,
    declaration: MatchedDeclarationSnapshot,
  ): HTMLElement | undefined {
    return declaration.important
      ? createRulesElement(document, "span", {
        className: "important",
        text: " !important",
        attributes: { "data-part": "property-important" },
      })
      : undefined;
  }
}
