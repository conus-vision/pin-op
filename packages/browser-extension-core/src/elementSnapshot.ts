import {
  INSPECT_LIMITS,
  type InspectSubject,
} from "@pinop/protocol";
import {
  boundedPageUrl,
  consumeJsonBudget,
  createInspectByteBudget,
  iterateBounded,
  takeBounded,
  type InspectByteBudget,
  truncate,
} from "./inspectBounds.js";

export interface ElementSnapshotSource {
  readonly tagName: string;
  readonly id: string;
  readonly classList: Iterable<string>;
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>;
}

export function createElementSnapshot(
  element: ElementSnapshotSource,
  pageUrl: string,
  budget: InspectByteBudget = createInspectByteBudget(),
): InspectSubject {
  const tag = truncate(
    element.tagName.toLowerCase(),
    INSPECT_LIMITS.attributeNameLength,
  );
  const classes = takeBounded(
    element.classList,
    INSPECT_LIMITS.classNames,
  )
    .filter(Boolean)
    .map((className) =>
      truncate(className, INSPECT_LIMITS.attributeNameLength),
    );
  const id = truncate(element.id, INSPECT_LIMITS.nodeIdLength);
  const attributes: NonNullable<InspectSubject["attributes"]> = [];
  for (const { name, value } of iterateBounded(
    element.attributes,
    INSPECT_LIMITS.subjectAttributes,
  )) {
    if (!isSafeAttribute(name)) {
      continue;
    }
    const attribute = {
      name: truncate(name.toLowerCase(), INSPECT_LIMITS.attributeNameLength),
      value: truncate(value, INSPECT_LIMITS.valueLength),
      metadata: {},
    };
    if (!consumeJsonBudget(budget, attribute)) {
      break;
    }
    attributes.push(attribute);
  }

  return {
    selector: selectorFor(tag, id, classes),
    ...(id ? { nodeId: id } : {}),
    ...(attributes.length > 0 ? { attributes } : {}),
    metadata: {
      tag,
      id,
      classes,
      pageUrl: boundedPageUrl(pageUrl),
    },
  };
}

function selectorFor(tag: string, id: string, classes: readonly string[]): string {
  let selector = tag || "*";
  const segments = [
    ...(id ? [`#${escapeCssIdentifier(id)}`] : []),
    ...classes.map((className) => `.${escapeCssIdentifier(className)}`),
  ];
  for (const segment of segments) {
    if (selector.length + segment.length <= INSPECT_LIMITS.selectorLength) {
      selector += segment;
    }
  }
  return truncate(selector, INSPECT_LIMITS.selectorLength);
}

function isSafeAttribute(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "role" ||
    normalized.startsWith("data-") ||
    normalized.startsWith("aria-")
  );
}

function escapeCssIdentifier(value: string): string {
  let escaped = "";
  for (const [index, character] of [...value].entries()) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0) {
      escaped += "\uFFFD";
    } else if (value.length === 1 && character === "-") {
      escaped += "\\-";
    } else if (
      (code >= 1 && code <= 31) ||
      code === 127 ||
      (index === 0 && code >= 48 && code <= 57) ||
      (index === 1 && code >= 48 && code <= 57 && value[0] === "-")
    ) {
      escaped += `\\${code.toString(16)} `;
    } else if (
      code >= 128 ||
      character === "-" ||
      character === "_" ||
      /[a-zA-Z0-9]/.test(character)
    ) {
      escaped += character;
    } else {
      escaped += `\\${character}`;
    }
  }
  return escaped;
}
