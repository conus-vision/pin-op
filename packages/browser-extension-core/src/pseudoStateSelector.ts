import selectorParser from "postcss-selector-parser";
import { utf8ByteLength } from "@pin-op/protocol";

export type PseudoState = "hover" | "focus";

export interface PseudoStateMarkerNames {
  readonly selection: string;
  readonly hover: string;
  readonly focus: string;
}

export type PseudoSelectorUnsupportedReason =
  | "invalid-marker-name"
  | "selector-byte-limit"
  | "selector-branch-limit"
  | "selector-depth-limit"
  | "malformed-selector"
  | "no-target-pseudo"
  | "unsupported-target-position"
  | "multiple-target-compounds"
  | "target-under-negation"
  | "target-inside-has"
  | "unsupported-functional-target"
  | "specificity-change"
  | "unsafe-selector";

export type SelectorTransformResult =
  | {
      readonly kind: "supported";
      readonly selectorText: string;
      readonly transformedBranches: number;
      readonly omittedBranches: number;
      readonly unsupportedOmittedBranches: number;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: PseudoSelectorUnsupportedReason;
    };

export const PSEUDO_STATE_SELECTOR_LIMITS = Object.freeze({
  selectorBytes: 16 * 1024,
  branches: 128,
  functionalDepth: 16,
});

const MARKER_NAME = /^data-pin-op-preview-[a-z0-9-]{16,64}$/u;
const ALL_PSEUDO_STATES = Object.freeze(["hover", "focus"] as const);

type Selector = selectorParser.Selector;
type Pseudo = selectorParser.Pseudo;
type Specificity = readonly [number, number, number];

type BranchTransform =
  | {
      readonly kind: "supported";
      readonly omittedBranches: number;
      readonly unsupportedOmittedBranches: number;
    }
  | {
      readonly kind: "unsupported";
      readonly reason: PseudoSelectorUnsupportedReason;
    };

/**
 * Rewrites the supported positive pseudo-state subset into caller-owned marker
 * attributes. Every emitted top-level selector is anchored to the selection
 * marker without increasing specificity.
 */
export function transformPseudoStateSelector(
  selectorText: string,
  markerNames: PseudoStateMarkerNames,
  requestedStates: readonly PseudoState[] = ALL_PSEUDO_STATES,
): SelectorTransformResult {
  const markers = readMarkerNames(markerNames);
  if (!markers) return unsupported("invalid-marker-name");
  const requested = readRequestedStates(requestedStates);
  if (!requested) return unsupported("malformed-selector");
  if (typeof selectorText !== "string") return unsupported("malformed-selector");

  let selectorBytes: number;
  try {
    selectorBytes = selectorText.length > PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes
      ? selectorText.length
      : utf8ByteLength(selectorText);
  } catch {
    return unsupported("malformed-selector");
  }
  if (selectorBytes > PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes) {
    return unsupported("selector-byte-limit");
  }

  let root: selectorParser.Root;
  try {
    root = selectorParser().astSync(selectorText, { lossless: false });
  } catch {
    return unsupported("malformed-selector");
  }

  const measured = measureSelectors(root.nodes);
  if (measured.branches > PSEUDO_STATE_SELECTOR_LIMITS.branches) {
    return unsupported("selector-branch-limit");
  }
  if (measured.depth > PSEUDO_STATE_SELECTOR_LIMITS.functionalDepth) {
    return unsupported("selector-depth-limit");
  }

  const emitted: Selector[] = [];
  let omittedBranches = 0;
  let unsupportedOmittedBranches = 0;
  let failure: PseudoSelectorUnsupportedReason | undefined;
  for (const source of root.nodes) {
    const selector = source.clone();
    const transformed = transformBranch(selector, markers, requested, true);
    if (transformed.kind === "supported") {
      emitted.push(selector);
      omittedBranches += transformed.omittedBranches;
      unsupportedOmittedBranches += transformed.unsupportedOmittedBranches;
    } else {
      omittedBranches += 1;
      if (transformed.reason !== "no-target-pseudo") {
        unsupportedOmittedBranches += 1;
      }
      failure = preferReason(failure, transformed.reason);
    }
  }

  if (emitted.length === 0) {
    return unsupported(failure ?? "no-target-pseudo");
  }

  root.removeAll();
  for (const selector of emitted) root.append(selector);
  const output = root.toString();
  try {
    if (utf8ByteLength(output) > PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes) {
      return unsupported("selector-byte-limit");
    }
  } catch {
    return unsupported("malformed-selector");
  }
  return Object.freeze({
    kind: "supported",
    selectorText: output,
    transformedBranches: emitted.length,
    omittedBranches,
    unsupportedOmittedBranches,
  });
}

/**
 * Marker names for the display-only probe below. The transform only validates
 * their shape and writes them into a selector it then throws away, so these are
 * never the page's own markers and never leave the panel.
 */
const PROBE_MARKER_NAMES: PseudoStateMarkerNames = Object.freeze({
  selection: "data-pin-op-preview-probe-selection-display",
  hover: "data-pin-op-preview-probe-hover-display",
  focus: "data-pin-op-preview-probe-focus-display",
});

/**
 * Whether the preview is what makes this selector match: it carries a supported
 * positive target for one of the active states. A negated target, a target
 * inside `:has()`, or any other shape the transform refuses answers false,
 * because the preview cannot force those either.
 */
export function selectorPreviewsPseudoState(
  selectorText: string,
  requestedStates: readonly PseudoState[],
): boolean {
  if (requestedStates.length === 0) return false;
  return transformPseudoStateSelector(
    selectorText,
    PROBE_MARKER_NAMES,
    requestedStates,
  ).kind === "supported";
}

/** Bounded semantic probe used when nesting cannot be resolved safely. */
export function selectorContainsRequestedPseudoState(
  selectorText: string,
  requestedStates: readonly PseudoState[],
): boolean | undefined {
  const requested = readRequestedStates(requestedStates);
  if (!requested || typeof selectorText !== "string") return undefined;
  try {
    if (
      selectorText.length > PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes ||
      utf8ByteLength(selectorText) > PSEUDO_STATE_SELECTOR_LIMITS.selectorBytes
    ) return undefined;
    const root = selectorParser().astSync(selectorText, { lossless: false });
    const measured = measureSelectors(root.nodes);
    if (
      measured.branches > PSEUDO_STATE_SELECTOR_LIMITS.branches ||
      measured.depth > PSEUDO_STATE_SELECTOR_LIMITS.functionalDepth
    ) return undefined;
    let found = false;
    root.walkPseudos((pseudo) => {
      const state = targetState(pseudo.value);
      if (state && requested.has(state)) {
        found = true;
        return false;
      }
      return undefined;
    });
    return found;
  } catch {
    return undefined;
  }
}

function transformBranch(
  selector: Selector,
  markers: PseudoStateMarkerNames,
  requested: ReadonlySet<PseudoState>,
  appendSelectionGuard: boolean,
): BranchTransform {
  if (
    selector.nodes.some(({ type }) => type === "nesting") ||
    !isMountableSelectorStructure(selector)
  ) {
    return unsupported("unsafe-selector");
  }

  let compound = 0;
  let pseudoElementCompound: number | undefined;
  const targetCompounds = new Set<number>();
  let omittedBranches = 0;
  let unsupportedOmittedBranches = 0;
  for (const node of [...selector.nodes]) {
    if (node.type === "combinator") {
      compound += 1;
      pseudoElementCompound = undefined;
      continue;
    }
    if (node.type !== "pseudo") continue;

    const pseudo = node as Pseudo;
    const value = pseudo.value.toLowerCase();
    if (isPseudoElement(pseudo)) {
      if (containsTargetPseudo(pseudo, requested)) {
        return unsupported("unsupported-functional-target");
      }
      pseudoElementCompound = compound;
      continue;
    }
    const state = targetState(pseudo.value);
    if (state) {
      if (!requested.has(state)) {
        if (pseudo.nodes && pseudo.nodes.length > 0) {
          return unsupported("unsupported-functional-target");
        }
        continue;
      }
      if (pseudoElementCompound === compound) {
        return unsupported("unsupported-target-position");
      }
      if (pseudo.nodes && pseudo.nodes.length > 0) {
        return unsupported("unsupported-functional-target");
      }
      pseudo.replaceWith(markerAttribute(markers[state]));
      targetCompounds.add(compound);
      continue;
    }

    if (!containsTargetPseudo(pseudo, requested)) continue;
    if (pseudoElementCompound === compound) {
      return unsupported("unsupported-target-position");
    }
    if (value === ":not") return unsupported("target-under-negation");
    if (value === ":has") return unsupported("target-inside-has");
    if (value !== ":is" && value !== ":where") {
      return unsupported("unsupported-functional-target");
    }

    const transformed = transformPositiveFunction(pseudo, markers, requested, value);
    if (transformed.kind === "unsupported") return transformed;
    omittedBranches += transformed.omittedBranches;
    unsupportedOmittedBranches += transformed.unsupportedOmittedBranches;
    targetCompounds.add(compound);
  }

  if (targetCompounds.size === 0) return unsupported("no-target-pseudo");
  if (targetCompounds.size > 1) return unsupported("multiple-target-compounds");
  if (!targetCompounds.has(compound)) {
    return unsupported("unsupported-target-position");
  }
  if (appendSelectionGuard) appendGuard(selector, markers.selection);
  if (!isMountableSelectorStructure(selector)) return unsupported("unsafe-selector");
  return { kind: "supported", omittedBranches, unsupportedOmittedBranches };
}

function transformPositiveFunction(
  pseudo: Pseudo,
  markers: PseudoStateMarkerNames,
  requested: ReadonlySet<PseudoState>,
  value: ":is" | ":where",
): BranchTransform {
  const originalSpecificity = value === ":is"
    ? maximumSpecificity(pseudo.nodes)
    : undefined;
  const emitted: Selector[] = [];
  let omittedBranches = 0;
  let unsupportedOmittedBranches = 0;
  let failure: PseudoSelectorUnsupportedReason | undefined;
  for (const source of pseudo.nodes) {
    const selector = source.clone();
    const transformed = transformBranch(selector, markers, requested, false);
    if (transformed.kind === "supported") {
      emitted.push(selector);
      omittedBranches += transformed.omittedBranches;
      unsupportedOmittedBranches += transformed.unsupportedOmittedBranches;
    } else {
      omittedBranches += 1;
      if (transformed.reason !== "no-target-pseudo") {
        unsupportedOmittedBranches += 1;
      }
      failure = preferReason(failure, transformed.reason);
    }
  }
  if (emitted.length === 0) {
    return unsupported(failure ?? "no-target-pseudo");
  }

  if (value === ":is") {
    const transformedSpecificity = maximumSpecificity(emitted);
    if (
      !originalSpecificity ||
      !transformedSpecificity ||
      compareSpecificity(originalSpecificity, transformedSpecificity) !== 0
    ) {
      return unsupported("specificity-change");
    }
  }

  pseudo.removeAll();
  for (const selector of emitted) pseudo.append(selector);
  return { kind: "supported", omittedBranches, unsupportedOmittedBranches };
}

function appendGuard(selector: Selector, selectionMarker: string): void {
  const guard = selectorParser.pseudo({
    value: ":where",
    nodes: [selectorParser.selector({
      value: "",
      nodes: [markerAttribute(selectionMarker)],
    })],
  });
  const pseudoElement = selector.nodes.find((node) => (
    node.type === "pseudo" && isPseudoElement(node)
  ));
  if (pseudoElement) selector.insertBefore(pseudoElement, guard);
  else selector.append(guard);
}

function markerAttribute(name: string): selectorParser.Attribute {
  return selectorParser.attribute({
    attribute: name,
    value: undefined,
    raws: {},
  });
}

function readMarkerNames(
  markerNames: PseudoStateMarkerNames,
): PseudoStateMarkerNames | undefined {
  try {
    const selection = markerNames.selection;
    const hover = markerNames.hover;
    const focus = markerNames.focus;
    if (![selection, hover, focus].every((name) => (
      typeof name === "string" && MARKER_NAME.test(name)
    )) || new Set([selection, hover, focus]).size !== 3) {
      return undefined;
    }
    return Object.freeze({ selection, hover, focus });
  } catch {
    return undefined;
  }
}

function readRequestedStates(
  states: readonly PseudoState[],
): ReadonlySet<PseudoState> | undefined {
  try {
    if (!Array.isArray(states)) {
      return undefined;
    }
    const length = states.length;
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > ALL_PSEUDO_STATES.length
    ) {
      return undefined;
    }
    const requested = new Set<PseudoState>();
    for (let index = 0; index < length; index += 1) {
      const state = states[index];
      if (state !== "hover" && state !== "focus") return undefined;
      requested.add(state);
    }
    return requested;
  } catch {
    return undefined;
  }
}

function targetState(pseudoValue: string): PseudoState | undefined {
  if (!pseudoValue.startsWith(":") || pseudoValue.startsWith("::")) {
    return undefined;
  }
  const value = decodeCssIdentifier(pseudoValue.slice(1))?.toLowerCase();
  if (value === "hover") return "hover";
  if (value === "focus") return "focus";
  return undefined;
}

function decodeCssIdentifier(value: string): string | undefined {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= value.length) return undefined;
    const escaped = value[index]!;
    if (escaped === "\n" || escaped === "\r" || escaped === "\f") {
      return undefined;
    }
    if (!/[0-9a-f]/iu.test(escaped)) {
      decoded += escaped;
      continue;
    }

    let hex = escaped;
    while (hex.length < 6 && /[0-9a-f]/iu.test(value[index + 1] ?? "")) {
      index += 1;
      hex += value[index]!;
    }
    const codePoint = Number.parseInt(hex, 16);
    decoded += codePoint === 0 ||
      codePoint > 0x10ffff ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "\uFFFD"
      : String.fromCodePoint(codePoint);
    if (isCssWhitespace(value[index + 1])) {
      index += 1;
      if (value[index] === "\r" && value[index + 1] === "\n") index += 1;
    }
  }
  return decoded;
}

function isCssWhitespace(value: string | undefined): boolean {
  return value === " " || value === "\t" || value === "\n" ||
    value === "\r" || value === "\f";
}

function containsTargetPseudo(
  node: Pseudo,
  requested: ReadonlySet<PseudoState>,
): boolean {
  let found = false;
  node.walkPseudos((nested) => {
    const state = targetState(nested.value);
    if (state && requested.has(state)) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function measureSelectors(selectors: readonly Selector[]): {
  readonly branches: number;
  readonly depth: number;
} {
  let branches = 0;
  let maximumDepth = 0;
  const stack = selectors.map((selector) => ({ selector, depth: 0 }));
  while (stack.length > 0) {
    const current = stack.pop()!;
    const { selector, depth } = current;
    branches += 1;
    maximumDepth = Math.max(maximumDepth, depth);
    if (
      branches > PSEUDO_STATE_SELECTOR_LIMITS.branches ||
      maximumDepth > PSEUDO_STATE_SELECTOR_LIMITS.functionalDepth
    ) break;
    for (const node of selector.nodes) {
      if (node.type !== "pseudo" || !node.nodes || node.nodes.length === 0) continue;
      for (let index = node.nodes.length - 1; index >= 0; index -= 1) {
        stack.push({ selector: node.nodes[index]!, depth: depth + 1 });
      }
    }
  }
  return { branches, depth: maximumDepth };
}

function isMountableSelectorStructure(selector: Selector): boolean {
  let expectingCompound = true;
  let sawCompound = false;
  let sawPseudoElement = false;
  for (const node of selector.nodes) {
    if (node.type === "comment") continue;
    if (sawPseudoElement) return false;
    if (node.type === "combinator") {
      if (expectingCompound || !isStandardCombinator(node.value)) return false;
      expectingCompound = true;
      continue;
    }
    sawCompound = true;
    expectingCompound = false;
    if (node.type === "pseudo" && isPseudoElement(node)) {
      sawPseudoElement = true;
    }
  }
  return sawCompound && !expectingCompound;
}

function isStandardCombinator(value: string): boolean {
  const normalized = value.trim();
  return normalized === "" || normalized === ">" || normalized === "+" ||
    normalized === "~" || normalized === "||";
}

function maximumSpecificity(selectors: readonly Selector[]): Specificity | undefined {
  let maximum: Specificity | undefined;
  for (const selector of selectors) {
    const specificity = specificityForNodes(selector.nodes);
    if (!specificity) return undefined;
    if (!maximum || compareSpecificity(specificity, maximum) > 0) {
      maximum = specificity;
    }
  }
  return maximum;
}

function specificityForNodes(
  nodes: readonly selectorParser.Node[],
): Specificity | undefined {
  let ids = 0;
  let classes = 0;
  let types = 0;
  for (const node of nodes) {
    switch (node.type) {
      case "id":
        ids += 1;
        break;
      case "class":
      case "attribute":
        classes += 1;
        break;
      case "tag":
        types += 1;
        break;
      case "pseudo": {
        const value = node.value.toLowerCase();
        if (isPseudoElement(node)) {
          types += 1;
          break;
        }
        if (!node.nodes || node.nodes.length === 0) {
          classes += 1;
          break;
        }
        if (value === ":where") break;
        if (value !== ":is" && value !== ":not" && value !== ":has") {
          return undefined;
        }
        const nested = maximumSpecificity(node.nodes);
        if (!nested) return undefined;
        ids += nested[0];
        classes += nested[1];
        types += nested[2];
        break;
      }
      case "universal":
      case "combinator":
      case "comment":
        break;
      default:
        return undefined;
    }
  }
  return [ids, classes, types];
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

function isPseudoElement(node: Pseudo): boolean {
  return selectorParser.isPseudoElement(node);
}

function preferReason(
  current: PseudoSelectorUnsupportedReason | undefined,
  candidate: PseudoSelectorUnsupportedReason,
): PseudoSelectorUnsupportedReason {
  if (!current || current === "no-target-pseudo") return candidate;
  return current;
}

function unsupported(
  reason: PseudoSelectorUnsupportedReason,
): Extract<SelectorTransformResult, { readonly kind: "unsupported" }> {
  return Object.freeze({ kind: "unsupported", reason });
}
