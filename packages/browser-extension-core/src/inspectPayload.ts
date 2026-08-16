import {
  INSPECT_LIMITS,
  type InspectTarget,
} from "@pin-op/protocol";
import type { InspectPayload } from "./bridgeClient.js";
import {
  collectCssFacts,
  type CssDocumentSource,
  type InaccessibleStylesheet,
} from "./collectCssFacts.js";
import { createElementSnapshot } from "./elementSnapshot.js";
import type { InspectableElement } from "./inspectMode.js";
import {
  boundedPageUrl,
  createInspectByteBudget,
  joinBounded,
  type InspectByteBudget,
} from "./inspectBounds.js";

export interface LocationSource {
  readonly href: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

export type InspectPayloadWithDiagnostics = InspectPayload & {
  readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[];
};

interface CollectedTarget extends InspectTarget {
  readonly inaccessibleStylesheets: readonly InaccessibleStylesheet[];
}

export function createInspectPayload(
  element: InspectableElement,
  document: CssDocumentSource,
  location: LocationSource,
): InspectPayloadWithDiagnostics {
  const pageUrl = boundedPageUrl(location.href);
  const budget = createInspectByteBudget();
  const selected = collectTarget(
    "selected",
    0,
    element,
    document,
    pageUrl,
    budget,
  );
  const parent = element.parentElement
    ? collectTarget(
        "parent",
        1,
        element.parentElement,
        document,
        pageUrl,
        budget,
      )
    : undefined;
  const collected = parent ? [selected, parent] : [selected];
  const inaccessibleStylesheets = deduplicateInaccessible(
    collected.flatMap((target) => target.inaccessibleStylesheets),
  );
  const targets = collected.map(
    ({ inaccessibleStylesheets: _ignored, ...target }) => target,
  );

  return {
    targets,
    context: {
      url: pageUrl,
      route: joinBounded(
        [location.pathname, location.search, location.hash],
        INSPECT_LIMITS.routeLength,
      ),
      metadata: {
        inaccessibleStylesheetCount: inaccessibleStylesheets.length,
      },
    },
    metadata: {},
    inaccessibleStylesheets,
  };
}

function collectTarget(
  role: "selected" | "parent",
  depth: 0 | 1,
  element: InspectableElement,
  document: CssDocumentSource,
  pageUrl: string,
  budget: InspectByteBudget,
): CollectedTarget {
  const subject = createElementSnapshot(element, pageUrl, budget);
  const collection = collectCssFacts(
    element,
    {
      pageUrl,
      styleSheets: document.styleSheets,
    },
    budget,
  );
  return {
    role,
    depth,
    subject,
    facts: collection.facts,
    metadata: {},
    inaccessibleStylesheets: collection.inaccessibleStylesheets,
  };
}

function deduplicateInaccessible(
  entries: readonly InaccessibleStylesheet[],
): InaccessibleStylesheet[] {
  const unique = new Map<string, InaccessibleStylesheet>();
  for (const entry of entries) {
    if (unique.size >= INSPECT_LIMITS.inaccessibleStylesheets) {
      break;
    }
    const key = JSON.stringify([entry.sourceUrl, entry.reason]);
    if (!unique.has(key)) unique.set(key, entry);
  }
  return [...unique.values()];
}
