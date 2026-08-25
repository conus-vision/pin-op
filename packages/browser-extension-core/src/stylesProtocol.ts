import { INSPECT_LIMITS, utf8ByteLength } from "@pin-op/protocol";
import type {
  GeneratedMatchedRuleSource,
  InheritedMatchedRules,
  MatchedDeclaration,
  MatchedDeclarationReason,
  MatchedDeclarationState,
  MatchedRule,
  MatchedStyles,
} from "./matchedStylesTypes.js";

export const STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES = 512 * 1024;
export const STYLES_PROTOCOL_MAX_RULES = INSPECT_LIMITS.cssRules;
export const STYLES_PROTOCOL_MAX_DECLARATIONS_PER_RULE =
  INSPECT_LIMITS.declarationsPerRule;
export const STYLES_PROTOCOL_MAX_INHERITED_GROUPS = 32;
export const STYLES_PROTOCOL_MAX_CONTEXTS = INSPECT_LIMITS.cssRuleDepth;
export const STYLES_PROTOCOL_MAX_MATCHING_SELECTOR_INDICES = 256;
export const STYLES_PROTOCOL_MAX_DIAGNOSTICS = 64;
export const STYLES_PROTOCOL_MAX_IDENTIFIER_LENGTH = 128;

export interface StylesGetMatchedRequest {
  readonly type: "styles.getMatched";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly manualRefresh?: true;
}

export interface StylesMatchedResponse {
  readonly type: "styles.matched";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
  readonly styles: MatchedStyles;
}

export type StylesErrorCode =
  | "invalid-request"
  | "stale-document"
  | "stale-selection"
  | "unknown-node"
  | "inaccessible"
  | "cancelled"
  | "internal-error";

export interface StylesErrorResponse {
  readonly type: "styles.error";
  readonly requestId: string;
  readonly code: StylesErrorCode;
}

export interface StylesInvalidatedEvent {
  readonly type: "styles.invalidated";
  readonly documentEpoch: number;
  readonly stylesRevision: number;
  readonly stylesheetRevision: number;
}

/** A content-only signal asking the background to renew current inspect evidence. */
export interface StylesInspectPublicationRenewedEvent {
  readonly type: "styles.inspectPublicationRenewed";
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly selectionRevision: number;
}

export type StylesRequest = StylesGetMatchedRequest;
export type StylesResponse = StylesMatchedResponse | StylesErrorResponse;
export type StylesEvent =
  | StylesInvalidatedEvent
  | StylesInspectPublicationRenewedEvent;

export class StylesProtocolError extends Error {
  public readonly code = "invalid-styles-protocol";

  public constructor() {
    super("Invalid styles protocol message");
    this.name = "StylesProtocolError";
  }
}

const ERROR_CODES = new Set<StylesErrorCode>([
  "invalid-request",
  "stale-document",
  "stale-selection",
  "unknown-node",
  "inaccessible",
  "cancelled",
  "internal-error",
]);

const DECLARATION_STATES = new Set<MatchedDeclarationState>([
  "winning-known-author",
  "overridden-known-author",
  "inactive",
  "unknown",
]);

const DECLARATION_REASONS = new Set<MatchedDeclarationReason>([
  "highest-precedence-known-author-declaration",
  "lower-precedence-author-declaration",
  "inactive-group-condition",
  "unsupported-cascade-layer",
  "unsupported-cascade-scope",
  "unsupported-container-query",
  "unsupported-starting-style",
  "unsupported-group-context",
  "unknown-group-applicability",
  "custom-property-cascade",
  "variable-dependent-value",
  "animation-or-transition-cascade",
  "unsupported-shorthand",
  "inherited-author-declaration",
  "unsupported-selector-specificity",
]);

const CONTEXT_KINDS = new Set([
  "media",
  "supports",
  "layer",
  "scope",
  "container",
  "starting-style",
  "unknown",
]);

export function parseStylesRequest(value: unknown): StylesRequest {
  try {
    const record = exactRecord(value, [
      "type",
      "requestId",
      "documentEpoch",
      "nodeRef",
      "selectionRevision",
      "manualRefresh",
    ], ["manualRefresh"]);
    if (read(record, "type") !== "styles.getMatched") fail();
    if (has(record, "manualRefresh") && read(record, "manualRefresh") !== true) {
      fail();
    }
    return Object.freeze({
      type: "styles.getMatched",
      requestId: identifier(read(record, "requestId")),
      documentEpoch: revision(read(record, "documentEpoch")),
      nodeRef: identifier(read(record, "nodeRef")),
      selectionRevision: revision(read(record, "selectionRevision")),
      ...(has(record, "manualRefresh") ? { manualRefresh: true as const } : {}),
    });
  } catch (error) {
    throw asProtocolError(error);
  }
}

export function parseStylesResponse(value: unknown): StylesResponse {
  try {
    const type = recordType(value);
    if (type === "styles.error") {
      const record = exactRecord(value, ["type", "requestId", "code"]);
      const code = read(record, "code");
      if (typeof code !== "string" || !ERROR_CODES.has(code as StylesErrorCode)) {
        fail();
      }
      return Object.freeze({
        type,
        requestId: identifier(read(record, "requestId")),
        code: code as StylesErrorCode,
      });
    }
    if (type !== "styles.matched") fail();
    const record = exactRecord(value, [
      "type",
      "requestId",
      "documentEpoch",
      "nodeRef",
      "selectionRevision",
      "stylesRevision",
      "stylesheetRevision",
      "styles",
    ]);
    const response = Object.freeze({
      type,
      requestId: identifier(read(record, "requestId")),
      documentEpoch: revision(read(record, "documentEpoch")),
      nodeRef: identifier(read(record, "nodeRef")),
      selectionRevision: revision(read(record, "selectionRevision")),
      stylesRevision: revision(read(record, "stylesRevision")),
      stylesheetRevision: revision(read(record, "stylesheetRevision")),
      styles: parseMatchedStyles(read(record, "styles")),
    });
    assertRevisionPair(response.stylesRevision, response.stylesheetRevision);
    if (
      response.styles.documentEpoch !== response.documentEpoch ||
      response.styles.nodeRef !== response.nodeRef ||
      response.styles.selectionRevision !== response.selectionRevision ||
      response.styles.stylesRevision !== response.stylesRevision ||
      response.styles.stylesheetRevision !== response.stylesheetRevision ||
      !stylesProtocolEnvelopeWithinBudget(response)
    ) {
      fail();
    }
    return response;
  } catch (error) {
    throw asProtocolError(error);
  }
}

export function parseStylesEvent(value: unknown): StylesEvent {
  try {
    const type = recordType(value);
    if (type === "styles.invalidated") {
      const record = exactRecord(value, [
        "type",
        "documentEpoch",
        "stylesRevision",
        "stylesheetRevision",
      ]);
      const event = Object.freeze({
        type,
        documentEpoch: revision(read(record, "documentEpoch")),
        stylesRevision: revision(read(record, "stylesRevision")),
        stylesheetRevision: revision(read(record, "stylesheetRevision")),
      });
      assertRevisionPair(event.stylesRevision, event.stylesheetRevision);
      return event;
    }
    if (type !== "styles.inspectPublicationRenewed") fail();
    const record = exactRecord(value, [
      "type",
      "documentEpoch",
      "nodeRef",
      "selectionRevision",
    ]);
    return Object.freeze({
      type,
      documentEpoch: revision(read(record, "documentEpoch")),
      nodeRef: identifier(read(record, "nodeRef")),
      selectionRevision: revision(read(record, "selectionRevision")),
    });
  } catch (error) {
    throw asProtocolError(error);
  }
}

export function isStylesResponseForRequest(
  requestValue: unknown,
  responseValue: unknown,
): boolean {
  try {
    const request = parseStylesRequest(requestValue);
    const response = parseStylesResponse(responseValue);
    if (response.requestId !== request.requestId) return false;
    return response.type === "styles.error" || (
      response.documentEpoch === request.documentEpoch &&
      response.nodeRef === request.nodeRef &&
      response.selectionRevision === request.selectionRevision
    );
  } catch {
    return false;
  }
}

export function stylesProtocolEnvelopeWithinBudget(
  value: unknown,
  maximumBytes = STYLES_PROTOCOL_MAX_SERIALIZED_RESPONSE_BYTES,
): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" &&
      utf8ByteLength(serialized) <= maximumBytes;
  } catch {
    return false;
  }
}

function parseMatchedStyles(value: unknown): MatchedStyles {
  const budget: NestedParseBudget = {
    rules: 0,
    declarations: 0,
    contexts: 0,
    matchingSelectorIndices: 0,
  };
  const record = exactRecord(value, [
    "documentEpoch",
    "selectionRevision",
    "stylesRevision",
    "stylesheetRevision",
    "nodeRef",
    "inline",
    "rules",
    "inherited",
    "inaccessibleStylesheetCount",
    "partial",
    "diagnostics",
  ], ["inline"]);
  const stylesRevision = revision(read(record, "stylesRevision"));
  const stylesheetRevision = revision(read(record, "stylesheetRevision"));
  assertRevisionPair(stylesRevision, stylesheetRevision);
  const result: MatchedStyles = {
    documentEpoch: revision(read(record, "documentEpoch")),
    selectionRevision: revision(read(record, "selectionRevision")),
    stylesRevision,
    stylesheetRevision,
    nodeRef: identifier(read(record, "nodeRef")),
    ...(has(record, "inline")
      ? { inline: parseMatchedRule(read(record, "inline"), budget) }
      : {}),
    rules: boundedArray(
      read(record, "rules"),
      STYLES_PROTOCOL_MAX_RULES,
      (item) => parseMatchedRule(item, budget),
    ),
    inherited: boundedArray(
      read(record, "inherited"),
      STYLES_PROTOCOL_MAX_INHERITED_GROUPS,
      (item) => parseInherited(item, budget),
    ),
    inaccessibleStylesheetCount: boundedRevision(
      read(record, "inaccessibleStylesheetCount"),
      INSPECT_LIMITS.stylesheets,
    ),
    partial: boolean(read(record, "partial")),
    diagnostics: boundedArray(
      read(record, "diagnostics"),
      STYLES_PROTOCOL_MAX_DIAGNOSTICS,
      (item) => string(item, 256),
    ),
  };
  return Object.freeze(result);
}

interface NestedParseBudget {
  rules: number;
  declarations: number;
  contexts: number;
  matchingSelectorIndices: number;
}

function countNested<T>(
  budget: NestedParseBudget,
  key: "contexts" | "matchingSelectorIndices",
  values: readonly T[],
  maximum: number,
): readonly T[] {
  budget[key] += values.length;
  if (budget[key] > maximum) fail();
  return values;
}

function parseInherited(
  value: unknown,
  budget: NestedParseBudget,
): InheritedMatchedRules {
  const record = exactRecord(value, ["ancestorIndex", "elementName", "rules"]);
  const ancestorIndex = revision(read(record, "ancestorIndex"));
  if (ancestorIndex < 1) fail();
  return Object.freeze({
    ancestorIndex,
    elementName: string(read(record, "elementName"), 256),
    rules: boundedArray(
      read(record, "rules"),
      STYLES_PROTOCOL_MAX_RULES,
      (item) => parseMatchedRule(item, budget),
    ),
  });
}

function parseMatchedRule(value: unknown, budget: NestedParseBudget): MatchedRule {
  budget.rules += 1;
  if (budget.rules > STYLES_PROTOCOL_MAX_RULES) fail();
  const record = exactRecord(value, [
    "ruleRef",
    "selectorText",
    "matchingSelectorIndices",
    "declarations",
    "declarationsTruncated",
    "contexts",
    "contextsTruncated",
    "mediaTruncated",
    "source",
  ], [
    "declarationsTruncated",
    "contextsTruncated",
    "mediaTruncated",
    "source",
  ]);
  const ruleRef = identifier(read(record, "ruleRef"));
  const declarations = boundedArray(
    read(record, "declarations"),
    STYLES_PROTOCOL_MAX_DECLARATIONS_PER_RULE,
    parseDeclaration,
  );
  budget.declarations += declarations.length;
  if (budget.declarations > STYLES_PROTOCOL_MAX_RULES) fail();
  if (declarations.some((declaration) => declaration.ruleRef !== ruleRef)) fail();
  return Object.freeze({
    ruleRef,
    selectorText: string(read(record, "selectorText"), INSPECT_LIMITS.selectorLength),
    matchingSelectorIndices: countNested(
      budget,
      "matchingSelectorIndices",
      boundedArray(
        read(record, "matchingSelectorIndices"),
        STYLES_PROTOCOL_MAX_MATCHING_SELECTOR_INDICES,
        revision,
      ),
      STYLES_PROTOCOL_MAX_RULES * 2,
    ),
    declarations,
    ...(has(record, "declarationsTruncated")
      ? {
          declarationsTruncated: boolean(
            read(record, "declarationsTruncated"),
          ),
        }
      : {}),
    contexts: countNested(
      budget,
      "contexts",
      boundedArray(
        read(record, "contexts"),
        STYLES_PROTOCOL_MAX_CONTEXTS,
        parseContext,
      ),
      STYLES_PROTOCOL_MAX_RULES,
    ),
    ...(has(record, "contextsTruncated")
      ? { contextsTruncated: boolean(read(record, "contextsTruncated")) }
      : {}),
    ...(has(record, "mediaTruncated")
      ? { mediaTruncated: boolean(read(record, "mediaTruncated")) }
      : {}),
    ...(has(record, "source")
      ? { source: parseSource(read(record, "source")) }
      : {}),
  });
}

function parseDeclaration(value: unknown): MatchedDeclaration {
  const record = exactRecord(value, [
    "ruleRef",
    "property",
    "value",
    "important",
    "valueTruncated",
    "state",
    "reason",
  ]);
  const state = read(record, "state");
  const reason = read(record, "reason");
  if (
    typeof state !== "string" ||
    !DECLARATION_STATES.has(state as MatchedDeclarationState) ||
    typeof reason !== "string" ||
    !DECLARATION_REASONS.has(reason as MatchedDeclarationReason)
  ) fail();
  return Object.freeze({
    ruleRef: identifier(read(record, "ruleRef")),
    property: string(read(record, "property"), INSPECT_LIMITS.propertyNameLength),
    value: string(read(record, "value"), INSPECT_LIMITS.valueLength),
    important: boolean(read(record, "important")),
    valueTruncated: boolean(read(record, "valueTruncated")),
    state: state as MatchedDeclarationState,
    reason: reason as MatchedDeclarationReason,
  });
}

function parseContext(value: unknown) {
  const record = exactRecord(value, ["kind", "text"]);
  const kind = read(record, "kind");
  if (typeof kind !== "string" || !CONTEXT_KINDS.has(kind)) fail();
  return Object.freeze({
    kind: kind as "media" | "supports" | "layer" | "scope" | "container" |
      "starting-style" | "unknown",
    text: string(read(record, "text"), INSPECT_LIMITS.selectorLength),
  });
}

function parseSource(value: unknown): GeneratedMatchedRuleSource {
  const record = exactRecord(value, [
    "sourceUrl",
    "startLine",
    "startColumn",
    "endLine",
    "endColumn",
    "rulePath",
  ], ["sourceUrl", "startLine", "startColumn", "endLine", "endColumn"]);
  const startLine = optionalPositive(record, "startLine");
  const startColumn = optionalPositive(record, "startColumn");
  const endLine = optionalPositive(record, "endLine");
  const endColumn = optionalPositive(record, "endColumn");
  if (
    (startLine === undefined) !== (startColumn === undefined) ||
    (endLine === undefined) !== (endColumn === undefined) ||
    (endLine !== undefined && startLine === undefined) ||
    (endLine !== undefined && startLine !== undefined && (
      endLine < startLine ||
      (endLine === startLine && endColumn! <= startColumn!)
    ))
  ) fail();
  return Object.freeze({
    ...(has(record, "sourceUrl")
      ? { sourceUrl: publicUrl(read(record, "sourceUrl")) }
      : {}),
    ...(startLine === undefined ? {} : { startLine, startColumn }),
    ...(endLine === undefined ? {} : { endLine, endColumn }),
    rulePath: rulePath(read(record, "rulePath")),
  });
}

interface ExactRecord {
  readonly descriptors: Readonly<Record<PropertyKey, PropertyDescriptor>>;
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): ExactRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Readonly<
      Record<PropertyKey, PropertyDescriptor>
    >;
    const keys = Reflect.ownKeys(descriptors);
    const required = allowed.filter((key) => !optional.includes(key));
    if (
      keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !Object.hasOwn(descriptors, key)) ||
      keys.length < required.length ||
      keys.length > allowed.length
    ) fail();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    }
    return { descriptors };
  } catch (error) {
    if (error instanceof StylesProtocolError) throw error;
    fail();
  }
}

function read(record: ExactRecord, key: string): unknown {
  return record.descriptors[key]!.value;
}

function has(record: ExactRecord, key: string): boolean {
  return Object.hasOwn(record.descriptors, key);
}

function recordType(value: unknown): unknown {
  const record = exactRecordWithType(value);
  return read(record, "type");
}

function exactRecordWithType(value: unknown): ExactRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value) as Readonly<
      Record<PropertyKey, PropertyDescriptor>
    >;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string") || !Object.hasOwn(descriptors, "type")) {
      fail();
    }
    const descriptor = descriptors.type;
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
    return { descriptors };
  } catch (error) {
    if (error instanceof StylesProtocolError) throw error;
    fail();
  }
}

function boundedArray<T>(
  value: unknown,
  maximum: number,
  parse: (value: unknown) => T,
): readonly T[] {
  if (!Array.isArray(value)) fail();
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Readonly<
      Record<PropertyKey, PropertyDescriptor>
    >;
    const lengthDescriptor = descriptors.length;
    if (
      !lengthDescriptor ||
      !Object.hasOwn(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0 ||
      lengthDescriptor.value > maximum
    ) fail();
    const length = lengthDescriptor.value as number;
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length !== length + 1) fail();
    const result: T[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
      result.push(parse(descriptor.value));
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof StylesProtocolError) throw error;
    fail();
  }
}

function identifier(value: unknown): string {
  return string(value, STYLES_PROTOCOL_MAX_IDENTIFIER_LENGTH, true);
}

function string(value: unknown, maximum: number, requireNonempty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    (requireNonempty && value.length === 0) ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) fail();
  return value;
}

function publicUrl(value: unknown): string {
  const candidate = string(value, INSPECT_LIMITS.urlLength, true);
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.hash
    ) fail();
    return url.href;
  } catch (error) {
    if (error instanceof StylesProtocolError) throw error;
    fail();
  }
}

function rulePath(value: unknown): string {
  const candidate = string(value, INSPECT_LIMITS.selectorLength, true);
  if (!/^\d+(?:\.\d+)*$/.test(candidate)) fail();
  return candidate;
}

function revision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}

function boundedRevision(value: unknown, maximum: number): number {
  const parsed = revision(value);
  if (parsed > maximum) fail();
  return parsed;
}

function optionalPositive(record: ExactRecord, key: string): number | undefined {
  if (!has(record, key)) return undefined;
  const value = revision(read(record, key));
  if (value < 1) fail();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail();
  return value;
}

function assertRevisionPair(stylesRevision: number, stylesheetRevision: number): void {
  if (stylesheetRevision > stylesRevision) fail();
}

function fail(): never {
  throw new StylesProtocolError();
}

function asProtocolError(error: unknown): StylesProtocolError {
  return error instanceof StylesProtocolError ? error : new StylesProtocolError();
}
