import { utf8ByteLength } from "@pin-op/protocol";
import {
  parseDomStableLocator,
  type DomStableLocator,
} from "./domStableLocator.js";

export const DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH = 128;
export const DOM_PROTOCOL_MAX_LABEL_LENGTH = 512;
export const DOM_PROTOCOL_MAX_SUMMARY_LENGTH = 512;
export const DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH = 100;
export const DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH = 64;
export const DOM_PROTOCOL_MAX_ATTRIBUTES = 64;
export const DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH = 256;
export const DOM_PROTOCOL_MAX_ATTRIBUTE_VALUE_LENGTH = 16_384;
export const DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES = 128;
export const DOM_PROTOCOL_MAX_NODE_VALUE_LENGTH = 16_384;
export const DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH = 4_096;
export const DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS = 32;
export const DOM_PROTOCOL_MAX_ROOT_CHILDREN_SCANNED = 128;
export const DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES = 64 * 1024;

export type DomErrorCode =
  | "invalid-request"
  | "stale-document"
  | "unknown-node"
  | "stale-branch"
  | "invalid-cursor"
  | "session-disposed"
  | "node-unavailable"
  | "internal-error";

export interface InspectorAttribute {
  readonly name: string;
  readonly value: string;
}

export interface DomNodeView {
  readonly nodeRef: string;
  readonly kind:
    | "document-type"
    | "element"
    | "text"
    | "comment"
    | "shadow-root"
    | "frame-document";
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue?: string;
  readonly publicId?: string;
  readonly systemId?: string;
  readonly attributes: readonly InspectorAttribute[];
  readonly childCount: number;
  readonly relationship: "dom" | "shadow-root" | "frame-document";
  readonly selectable: boolean;
  readonly label: string;
  readonly expandable: boolean;
  readonly inaccessible?: boolean;
  readonly branchRevision: number;
  readonly locator?: DomStableLocator;
}

export interface DomInvalidationBranch {
  readonly nodeRef: string;
  readonly branchRevision: number;
}

export interface DomGetRootRequest {
  readonly type: "dom.getRoot";
  readonly requestId: string;
  readonly documentEpoch?: number;
}

export interface DomGetChildrenRequest {
  readonly type: "dom.getChildren";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly branchRevision: number;
  readonly cursor?: string;
}

export interface DomResolveLocatorRequest {
  readonly type: "dom.resolveLocator";
  readonly requestId: string;
  readonly locator: DomStableLocator;
}

export interface DomSelectRequest {
  readonly type: "dom.select";
  readonly documentEpoch: number;
  readonly nodeRef: string;
}

export interface DomHoverRequest {
  readonly type: "dom.hover";
  readonly documentEpoch: number;
  readonly nodeRef: string;
}

export interface DomClearHoverRequest {
  readonly type: "dom.clearHover";
  readonly documentEpoch: number;
}

export type DomRequest =
  | DomGetRootRequest
  | DomGetChildrenRequest
  | DomResolveLocatorRequest
  | DomSelectRequest
  | DomHoverRequest
  | DomClearHoverRequest;

export interface DomRootResponse {
  readonly type: "dom.root";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly node: DomNodeView;
  readonly prologue: readonly DomNodeView[];
  readonly epilogue: readonly DomNodeView[];
}

export interface DomChildrenResponse {
  readonly type: "dom.children";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly nodeRef: string;
  readonly branchRevision: number;
  readonly nodes: readonly DomNodeView[];
  readonly nextCursor?: string;
}

export interface DomLocatorResponse {
  readonly type: "dom.locator";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly node: DomNodeView;
  readonly ancestorPath: readonly DomNodeView[];
}

export interface DomErrorResponse {
  readonly type: "dom.error";
  readonly requestId?: string;
  readonly documentEpoch?: number;
  readonly code: DomErrorCode;
}

export type DomResponse =
  | DomRootResponse
  | DomChildrenResponse
  | DomLocatorResponse
  | DomErrorResponse;

export interface DomHoverChangedEvent {
  readonly type: "dom.hoverChanged";
  readonly documentEpoch: number;
  readonly nodeRef?: string;
  readonly summary?: string;
}

export interface DomSelectionChangedEvent {
  readonly type: "dom.selectionChanged";
  readonly documentEpoch: number;
  readonly selectionRevision: number;
  readonly nodeRef: string;
  readonly ancestorPath: readonly DomNodeView[];
}

export interface DomInvalidatedEvent {
  readonly type: "dom.invalidated";
  readonly documentEpoch: number;
  readonly branches: readonly DomInvalidationBranch[];
}

export type DomEvent =
  | DomHoverChangedEvent
  | DomSelectionChangedEvent
  | DomInvalidatedEvent;

export class DomProtocolError extends Error {
  public readonly code = "invalid-dom-protocol";

  public constructor() {
    super("Invalid DOM protocol message");
    this.name = "DomProtocolError";
  }
}

const DOM_NODE_KINDS = new Set<DomNodeView["kind"]>([
  "document-type",
  "element",
  "text",
  "comment",
  "shadow-root",
  "frame-document",
]);

const DOM_RECOVERABLE_NODE_KINDS = new Set<DomNodeView["kind"]>([
  "element",
  "shadow-root",
  "frame-document",
]);

const DOM_ERROR_CODES = new Set<DomErrorCode>([
  "invalid-request",
  "stale-document",
  "unknown-node",
  "stale-branch",
  "invalid-cursor",
  "session-disposed",
  "node-unavailable",
  "internal-error",
]);

const DOM_REQUEST_KEYS = [
  "type",
  "requestId",
  "documentEpoch",
  "nodeRef",
  "branchRevision",
  "cursor",
  "locator",
] as const;

const DOM_RESPONSE_KEYS = [
  "type",
  "requestId",
  "documentEpoch",
  "nodeRef",
  "branchRevision",
  "node",
  "nodes",
  "nextCursor",
  "ancestorPath",
  "code",
  "prologue",
  "epilogue",
] as const;

const DOM_EVENT_KEYS = [
  "type",
  "documentEpoch",
  "selectionRevision",
  "nodeRef",
  "summary",
  "ancestorPath",
  "branches",
] as const;

const DOM_NODE_VIEW_KEYS = [
  "nodeRef",
  "kind",
  "nodeType",
  "nodeName",
  "nodeValue",
  "publicId",
  "systemId",
  "attributes",
  "childCount",
  "relationship",
  "selectable",
  "label",
  "expandable",
  "inaccessible",
  "branchRevision",
  "locator",
] as const;

const DOM_INSPECTOR_ATTRIBUTE_KEYS = ["name", "value"] as const;

const DOM_INVALIDATION_BRANCH_KEYS = [
  "nodeRef",
  "branchRevision",
] as const;

export function parseDomRequest(value: unknown): DomRequest {
  const record = snapshotRecord(value, DOM_REQUEST_KEYS);
  switch (record.type) {
    case "dom.getRoot":
      assertKeys(record, ["type", "requestId", "documentEpoch"], [
        "type",
        "requestId",
      ]);
      return freeze({
        type: "dom.getRoot",
        requestId: assertIdentifier(record.requestId),
        ...(hasOwn(record, "documentEpoch")
          ? { documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch) }
          : {}),
      });
    case "dom.getChildren":
      assertKeys(record, [
        "type",
        "requestId",
        "documentEpoch",
        "nodeRef",
        "branchRevision",
        "cursor",
      ], ["type", "requestId", "documentEpoch", "nodeRef", "branchRevision"]);
      return freeze({
        type: "dom.getChildren",
        requestId: assertIdentifier(record.requestId),
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        nodeRef: assertIdentifier(record.nodeRef),
        branchRevision: assertSafeNonnegativeInteger(record.branchRevision),
        ...(hasOwn(record, "cursor")
          ? { cursor: assertIdentifier(record.cursor) }
          : {}),
      });
    case "dom.resolveLocator":
      assertKeys(record, ["type", "requestId", "locator"], [
        "type",
        "requestId",
        "locator",
      ]);
      return freeze({
        type: "dom.resolveLocator",
        requestId: assertIdentifier(record.requestId),
        locator: parseStableLocator(record.locator),
      });
    case "dom.select":
    case "dom.hover":
      assertKeys(record, ["type", "documentEpoch", "nodeRef"], [
        "type",
        "documentEpoch",
        "nodeRef",
      ]);
      return freeze({
        type: record.type,
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        nodeRef: assertIdentifier(record.nodeRef),
      });
    case "dom.clearHover":
      assertKeys(record, ["type", "documentEpoch"], [
        "type",
        "documentEpoch",
      ]);
      return freeze({
        type: "dom.clearHover",
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
      });
    default:
      throw invalidMessage();
  }
}

export function parseDomResponse(value: unknown): DomResponse {
  const record = snapshotRecord(value, DOM_RESPONSE_KEYS);
  switch (record.type) {
    case "dom.root":
      assertKeys(record, [
        "type",
        "requestId",
        "documentEpoch",
        "node",
        "prologue",
        "epilogue",
      ], [
        "type",
        "requestId",
        "documentEpoch",
        "node",
        "prologue",
        "epilogue",
      ]);
      const node = parseNodeView(record.node);
      if (node.kind !== "element") throw invalidMessage();
      const prologue = parseRootAuxiliaryViews(record.prologue, "prologue");
      const epilogue = parseRootAuxiliaryViews(record.epilogue, "epilogue");
      if (prologue.length + epilogue.length > DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS) {
        throw invalidMessage();
      }
      return freeze({
        type: "dom.root",
        requestId: assertIdentifier(record.requestId),
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        node,
        prologue,
        epilogue,
      });
    case "dom.children":
      assertKeys(record, [
        "type",
        "requestId",
        "documentEpoch",
        "nodeRef",
        "branchRevision",
        "nodes",
        "nextCursor",
      ], [
        "type",
        "requestId",
        "documentEpoch",
        "nodeRef",
        "branchRevision",
        "nodes",
      ]);
      return freeze({
        type: "dom.children",
        requestId: assertIdentifier(record.requestId),
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        nodeRef: assertIdentifier(record.nodeRef),
        branchRevision: assertSafeNonnegativeInteger(record.branchRevision),
        nodes: parseNodeViews(record.nodes),
        ...(hasOwn(record, "nextCursor")
          ? { nextCursor: assertIdentifier(record.nextCursor) }
          : {}),
      });
    case "dom.locator":
      assertKeys(record, [
        "type",
        "requestId",
        "documentEpoch",
        "node",
        "ancestorPath",
      ], [
        "type",
        "requestId",
        "documentEpoch",
        "node",
        "ancestorPath",
      ]);
      return freeze({
        type: "dom.locator",
        requestId: assertIdentifier(record.requestId),
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        node: parseNodeView(record.node),
        ancestorPath: parseAncestorPath(record.ancestorPath),
      });
    case "dom.error":
      assertKeys(record, ["type", "requestId", "documentEpoch", "code"], [
        "type",
        "code",
      ]);
      return freeze({
        type: "dom.error",
        ...(hasOwn(record, "requestId")
          ? { requestId: assertIdentifier(record.requestId) }
          : {}),
        ...(hasOwn(record, "documentEpoch")
          ? { documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch) }
          : {}),
        code: assertDomErrorCode(record.code),
      });
    default:
      throw invalidMessage();
  }
}

export function parseDomEvent(value: unknown): DomEvent {
  const record = snapshotRecord(value, DOM_EVENT_KEYS);
  switch (record.type) {
    case "dom.hoverChanged":
      assertKeys(record, ["type", "documentEpoch", "nodeRef", "summary"], [
        "type",
        "documentEpoch",
      ]);
      return freeze({
        type: "dom.hoverChanged",
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        ...(hasOwn(record, "nodeRef")
          ? { nodeRef: assertIdentifier(record.nodeRef) }
          : {}),
        ...(hasOwn(record, "summary")
          ? {
              summary: assertBoundedText(
                record.summary,
                DOM_PROTOCOL_MAX_SUMMARY_LENGTH,
                true,
              ),
            }
          : {}),
      });
    case "dom.selectionChanged":
      assertKeys(record, [
        "type",
        "documentEpoch",
        "selectionRevision",
        "nodeRef",
        "ancestorPath",
      ], [
        "type",
        "documentEpoch",
        "selectionRevision",
        "nodeRef",
        "ancestorPath",
      ]);
      return freeze({
        type: "dom.selectionChanged",
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        selectionRevision: assertSafeNonnegativeInteger(
          record.selectionRevision,
        ),
        nodeRef: assertIdentifier(record.nodeRef),
        ancestorPath: parseAncestorPath(record.ancestorPath),
      });
    case "dom.invalidated":
      assertKeys(record, ["type", "documentEpoch", "branches"], [
        "type",
        "documentEpoch",
        "branches",
      ]);
      return freeze({
        type: "dom.invalidated",
        documentEpoch: assertSafeNonnegativeInteger(record.documentEpoch),
        branches: parseInvalidationBranches(record.branches),
      });
    default:
      throw invalidMessage();
  }
}

export function isSelectionRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isDomResponseForRequest(
  request: DomRequest,
  response: DomResponse,
): boolean {
  if (!("requestId" in request) || response.requestId !== request.requestId) {
    return false;
  }
  if (response.type === "dom.error") {
    return !("documentEpoch" in request) ||
      response.documentEpoch === undefined ||
      response.documentEpoch === request.documentEpoch;
  }
  switch (request.type) {
    case "dom.getRoot":
      return response.type === "dom.root" &&
        (request.documentEpoch === undefined ||
          response.documentEpoch === request.documentEpoch);
    case "dom.getChildren":
      return response.type === "dom.children" &&
        response.documentEpoch === request.documentEpoch &&
        response.nodeRef === request.nodeRef &&
        response.branchRevision === request.branchRevision;
    case "dom.resolveLocator":
      return response.type === "dom.locator";
    default:
      return false;
  }
}

function parseNodeView(value: unknown): DomNodeView {
  const record = snapshotRecord(value, DOM_NODE_VIEW_KEYS);
  assertKeys(record, [
    "nodeRef",
    "kind",
    "nodeType",
    "nodeName",
    "nodeValue",
    "publicId",
    "systemId",
    "attributes",
    "childCount",
    "relationship",
    "selectable",
    "label",
    "expandable",
    "inaccessible",
    "branchRevision",
    "locator",
  ], [
    "nodeRef",
    "kind",
    "nodeType",
    "nodeName",
    "attributes",
    "childCount",
    "relationship",
    "selectable",
    "label",
    "expandable",
    "branchRevision",
  ]);
  if (typeof record.kind !== "string" || !DOM_NODE_KINDS.has(record.kind as DomNodeView["kind"])) {
    throw invalidMessage();
  }
  const kind = record.kind as DomNodeView["kind"];
  const expectedNodeType = nodeTypeForKind(kind);
  const expectedRelationship = relationshipForKind(kind);
  if (
    record.nodeType !== expectedNodeType ||
    record.relationship !== expectedRelationship ||
    typeof record.selectable !== "boolean" ||
    (kind !== "element" && record.selectable) ||
    (hasOwn(record, "inaccessible") && kind !== "element") ||
    (record.inaccessible === true && record.selectable) ||
    ((kind === "document-type" || kind === "text" || kind === "comment") &&
      record.expandable !== false)
  ) {
    throw invalidMessage();
  }
  if (typeof record.expandable !== "boolean") {
    throw invalidMessage();
  }
  const recoverable = DOM_RECOVERABLE_NODE_KINDS.has(kind);
  if (recoverable !== hasOwn(record, "locator")) throw invalidMessage();
  const locator = recoverable ? parseStableLocator(record.locator) : undefined;
  if (locator && locator.targetKind !== kind) throw invalidMessage();
  if (kind !== "document-type" && (hasOwn(record, "publicId") || hasOwn(record, "systemId"))) {
    throw invalidMessage();
  }
  const characterData = kind === "text" || kind === "comment";
  if (!characterData && hasOwn(record, "nodeValue")) throw invalidMessage();
  const attributes = parseInspectorAttributes(record.attributes);
  if (kind !== "element" && attributes.length > 0) throw invalidMessage();
  return freeze({
    nodeRef: assertIdentifier(record.nodeRef),
    kind,
    nodeType: expectedNodeType,
    nodeName: assertBoundedText(
      record.nodeName,
      DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
      true,
    ),
    ...(hasOwn(record, "nodeValue")
      ? {
          nodeValue: assertBoundedText(
            record.nodeValue,
            DOM_PROTOCOL_MAX_NODE_VALUE_LENGTH,
          ),
        }
      : {}),
    ...(hasOwn(record, "publicId")
      ? {
          publicId: assertBoundedText(
            record.publicId,
            DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH,
          ),
        }
      : {}),
    ...(hasOwn(record, "systemId")
      ? {
          systemId: assertBoundedText(
            record.systemId,
            DOM_PROTOCOL_MAX_DOCTYPE_ID_LENGTH,
          ),
        }
      : {}),
    attributes,
    childCount: assertSafeNonnegativeInteger(record.childCount),
    relationship: expectedRelationship,
    selectable: record.selectable,
    label: assertBoundedText(record.label, DOM_PROTOCOL_MAX_LABEL_LENGTH, true),
    expandable: record.expandable,
    ...(hasOwn(record, "inaccessible")
      ? { inaccessible: assertBoolean(record.inaccessible) }
      : {}),
    branchRevision: assertSafeNonnegativeInteger(record.branchRevision),
    ...(locator ? { locator } : {}),
  });
}

function nodeTypeForKind(kind: DomNodeView["kind"]): number {
  switch (kind) {
    case "element": return 1;
    case "text": return 3;
    case "comment": return 8;
    case "frame-document": return 9;
    case "document-type": return 10;
    case "shadow-root": return 11;
  }
}

function relationshipForKind(
  kind: DomNodeView["kind"],
): DomNodeView["relationship"] {
  if (kind === "shadow-root") return "shadow-root";
  if (kind === "frame-document") return "frame-document";
  return "dom";
}

function parseInspectorAttributes(value: unknown): readonly InspectorAttribute[] {
  return parseBoundedArray(
    value,
    DOM_PROTOCOL_MAX_ATTRIBUTES,
    parseInspectorAttribute,
  );
}

function parseInspectorAttribute(value: unknown): InspectorAttribute {
  const record = snapshotRecord(value, DOM_INSPECTOR_ATTRIBUTE_KEYS);
  assertKeys(record, ["name", "value"], ["name", "value"]);
  return freeze({
    name: assertBoundedText(
      record.name,
      DOM_PROTOCOL_MAX_ATTRIBUTE_NAME_LENGTH,
      true,
    ),
    value: assertBoundedText(
      record.value,
      DOM_PROTOCOL_MAX_ATTRIBUTE_VALUE_LENGTH,
    ),
  });
}

function parseRootAuxiliaryViews(
  value: unknown,
  position: "prologue" | "epilogue",
): readonly DomNodeView[] {
  const views = parseBoundedArray(
    value,
    DOM_PROTOCOL_MAX_ROOT_AUXILIARY_ROWS,
    parseNodeView,
  );
  if (views.some((view) => (
    position === "prologue"
      ? view.kind !== "document-type" && view.kind !== "comment"
      : view.kind !== "comment"
  ))) {
    throw invalidMessage();
  }
  return views;
}

function parseStableLocator(value: unknown): DomStableLocator {
  try {
    return parseDomStableLocator(value);
  } catch {
    throw invalidMessage();
  }
}

function parseNodeViews(value: unknown): readonly DomNodeView[] {
  return parseBoundedArray(
    value,
    DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
    parseNodeView,
  );
}

function parseAncestorPath(value: unknown): readonly DomNodeView[] {
  return parseBoundedArray(
    value,
    DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
    parseNodeView,
  );
}

function parseInvalidationBranches(
  value: unknown,
): readonly DomInvalidationBranch[] {
  return parseBoundedArray(
    value,
    DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
    parseInvalidationBranch,
  );
}

function parseInvalidationBranch(value: unknown): DomInvalidationBranch {
  const record = snapshotRecord(value, DOM_INVALIDATION_BRANCH_KEYS);
  assertKeys(record, ["nodeRef", "branchRevision"], [
    "nodeRef",
    "branchRevision",
  ]);
  return freeze({
    nodeRef: assertIdentifier(record.nodeRef),
    branchRevision: assertSafeNonnegativeInteger(record.branchRevision),
  });
}

function parseBoundedArray<T>(
  value: unknown,
  maximumLength: number,
  parseItem: (item: unknown) => T,
): readonly T[] {
  const properties = snapshotOwnDataProperties(value, "array");
  const lengthProperty = properties.find(({ key }) => key === "length");
  const length = lengthProperty?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > maximumLength ||
    properties.length !== length + 1
  ) {
    throw invalidMessage();
  }
  const values: unknown[] = new Array(length);
  for (const { key, value: item } of properties) {
    if (key === "length") {
      continue;
    }
    if (
      typeof key !== "string" ||
      !isCanonicalArrayIndex(key, length)
    ) {
      throw invalidMessage();
    }
    values[Number(key)] = item;
  }
  const snapshot = Object.freeze(values);
  const parsed: T[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(snapshot, String(index))) {
      throw invalidMessage();
    }
    parsed.push(parseItem(snapshot[index]));
  }
  return freeze(parsed);
}

function isCanonicalArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function assertSerializedMessageBudget(value: unknown): void {
  let serialized: string | undefined;
  try {
    const result = JSON.stringify(value);
    serialized = typeof result === "string" ? result : undefined;
  } catch {
    throw invalidMessage();
  }
  if (
    serialized === undefined ||
    utf8ByteLength(serialized) > DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES
  ) {
    throw invalidMessage();
  }
}

interface OwnDataProperty {
  readonly key: PropertyKey;
  readonly value: unknown;
}

function snapshotOwnDataProperties(
  value: unknown,
  expectedKind: "record" | "array",
): readonly OwnDataProperty[] {
  try {
    if (value === null || typeof value !== "object") {
      throw invalidMessage();
    }
    const isArray = Array.isArray(value);
    if ((expectedKind === "array") !== isArray) {
      throw invalidMessage();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const properties: OwnDataProperty[] = [];
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptorHolder = Reflect.getOwnPropertyDescriptor(
        descriptors,
        key,
      );
      const descriptor = descriptorHolder?.value as
        | PropertyDescriptor
        | undefined;
      if (!descriptor || !hasOwn(descriptor, "value")) {
        throw invalidMessage();
      }
      properties.push(Object.freeze({ key, value: descriptor.value }));
    }
    return Object.freeze(properties);
  } catch {
    throw invalidMessage();
  }
}

function snapshotRecord(
  value: unknown,
  allowedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const properties = snapshotOwnDataProperties(value, "record");
  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const { key, value: propertyValue } of properties) {
    if (typeof key !== "string" || !allowedKeys.includes(key)) {
      throw invalidMessage();
    }
    snapshot[key] = propertyValue;
  }
  return Object.freeze(snapshot);
}

function assertKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !hasOwn(value, key))
  ) {
    throw invalidMessage();
  }
}

function assertIdentifier(value: unknown): string {
  return assertBoundedText(value, DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH, true);
}

function assertBoundedText(
  value: unknown,
  maximumLength: number,
  nonEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    value.length > maximumLength ||
    (nonEmpty && value.length === 0)
  ) {
    throw invalidMessage();
  }
  return value;
}

function assertSafeNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidMessage();
  }
  return value;
}

function assertBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw invalidMessage();
  }
  return value;
}

function assertDomErrorCode(value: unknown): DomErrorCode {
  if (typeof value !== "string" || !DOM_ERROR_CODES.has(value as DomErrorCode)) {
    throw invalidMessage();
  }
  return value as DomErrorCode;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function freeze<T>(value: T): T {
  const frozen = Object.freeze(value);
  assertSerializedMessageBudget(frozen);
  return frozen;
}

function invalidMessage(): DomProtocolError {
  return new DomProtocolError();
}
