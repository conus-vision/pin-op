export const DOM_STABLE_LOCATOR_VERSION = 1;
export const DOM_STABLE_LOCATOR_MAX_DEPTH = 64;
export const DOM_STABLE_LOCATOR_MAX_BOUNDARIES = 16;
export const DOM_STABLE_LOCATOR_MAX_CLASSES = 8;
export const DOM_STABLE_LOCATOR_MAX_ATTRIBUTES = 8;
export const DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH = 128;
export const DOM_TREE_RECOVERY_MAX_EXPANDED = 64;

export interface DomStableLocator {
  readonly version: 1;
  readonly targetKind: "element" | "shadow-root" | "frame-document";
  readonly boundaries: readonly DomBoundaryLocator[];
  readonly path: readonly DomPathSegment[];
}

export interface DomBoundaryLocator {
  readonly kind: "shadow-root" | "frame-document";
  readonly hostPath: readonly DomPathSegment[];
}

export interface DomPathSegment {
  readonly tagName: string;
  readonly siblingIndex: number;
  readonly id?: string;
  readonly classes?: readonly string[];
  readonly attributes?: readonly DomLocatorAttribute[];
}

export interface DomLocatorAttribute {
  readonly name: string;
  readonly value: string;
}

const LOCATOR_KEYS = [
  "version",
  "targetKind",
  "boundaries",
  "path",
] as const;

const BOUNDARY_KEYS = ["kind", "hostPath"] as const;

const PATH_SEGMENT_KEYS = [
  "tagName",
  "siblingIndex",
  "id",
  "classes",
  "attributes",
] as const;

const ATTRIBUTE_KEYS = ["name", "value"] as const;

const TARGET_KINDS = new Set<DomStableLocator["targetKind"]>([
  "element",
  "shadow-root",
  "frame-document",
]);

const BOUNDARY_KINDS = new Set<DomBoundaryLocator["kind"]>([
  "shadow-root",
  "frame-document",
]);

export function parseDomStableLocator(value: unknown): DomStableLocator {
  const record = snapshotRecord(value, LOCATOR_KEYS);
  assertKeys(record, LOCATOR_KEYS, LOCATOR_KEYS);
  if (record.version !== DOM_STABLE_LOCATOR_VERSION) {
    throw invalidLocator();
  }
  if (
    typeof record.targetKind !== "string" ||
    !TARGET_KINDS.has(record.targetKind as DomStableLocator["targetKind"])
  ) {
    throw invalidLocator();
  }

  let totalSegments = 0;
  const boundaries = parseBoundedArray(
    record.boundaries,
    DOM_STABLE_LOCATOR_MAX_BOUNDARIES,
    (boundary) => {
      const parsed = parseBoundary(boundary);
      totalSegments += parsed.hostPath.length;
      assertTotalDepth(totalSegments);
      return parsed;
    },
  );
  const path = parsePath(record.path);
  totalSegments += path.length;
  assertTotalDepth(totalSegments);

  return Object.freeze({
    version: DOM_STABLE_LOCATOR_VERSION,
    targetKind: record.targetKind as DomStableLocator["targetKind"],
    boundaries,
    path,
  });
}

function parseBoundary(value: unknown): DomBoundaryLocator {
  const record = snapshotRecord(value, BOUNDARY_KEYS);
  assertKeys(record, BOUNDARY_KEYS, BOUNDARY_KEYS);
  if (
    typeof record.kind !== "string" ||
    !BOUNDARY_KINDS.has(record.kind as DomBoundaryLocator["kind"])
  ) {
    throw invalidLocator();
  }
  return Object.freeze({
    kind: record.kind as DomBoundaryLocator["kind"],
    hostPath: parsePath(record.hostPath),
  });
}

function parsePath(value: unknown): readonly DomPathSegment[] {
  return parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_DEPTH,
    parsePathSegment,
  );
}

function parsePathSegment(value: unknown): DomPathSegment {
  const record = snapshotRecord(value, PATH_SEGMENT_KEYS);
  assertKeys(record, PATH_SEGMENT_KEYS, ["tagName", "siblingIndex"]);
  const tagName = assertCanonicalTagName(record.tagName);
  const siblingIndex = assertSafeNonnegativeInteger(record.siblingIndex);
  const id = hasOwn(record, "id")
    ? assertBoundedToken(record.id, true)
    : undefined;
  const classes = hasOwn(record, "classes")
    ? parseClasses(record.classes)
    : undefined;
  const attributes = hasOwn(record, "attributes")
    ? parseAttributes(record.attributes)
    : undefined;

  return Object.freeze({
    tagName,
    siblingIndex,
    ...(id === undefined ? {} : { id }),
    ...(classes === undefined ? {} : { classes }),
    ...(attributes === undefined ? {} : { attributes }),
  });
}

function parseClasses(value: unknown): readonly string[] {
  const classes = parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_CLASSES,
    (item) => assertClassToken(item),
  );
  assertStrictlySorted(classes, (item) => item);
  return classes;
}

function parseAttributes(value: unknown): readonly DomLocatorAttribute[] {
  const attributes = parseBoundedArray(
    value,
    DOM_STABLE_LOCATOR_MAX_ATTRIBUTES,
    parseAttribute,
  );
  assertStrictlySorted(attributes, (attribute) => attribute.name);
  return attributes;
}

function parseAttribute(value: unknown): DomLocatorAttribute {
  const record = snapshotRecord(value, ATTRIBUTE_KEYS);
  assertKeys(record, ATTRIBUTE_KEYS, ATTRIBUTE_KEYS);
  const name = assertApprovedAttributeName(record.name);
  const attributeValue = assertBoundedText(record.value, false);
  return Object.freeze({ name, value: attributeValue });
}

function assertCanonicalTagName(value: unknown): string {
  const tagName = assertBoundedText(value, true);
  if (!/^[a-z][a-z0-9._:-]*$/.test(tagName)) {
    throw invalidLocator();
  }
  return tagName;
}

function assertApprovedAttributeName(value: unknown): string {
  const name = assertBoundedText(value, true);
  if (
    name !== "role" &&
    !/^(?:aria|data)-[a-z0-9_.:-]+$/.test(name)
  ) {
    throw invalidLocator();
  }
  return name;
}

function assertClassToken(value: unknown): string {
  const token = assertBoundedText(value, true);
  if (/[\t\n\f\r ]/.test(token)) {
    throw invalidLocator();
  }
  return token;
}

function assertBoundedToken(value: unknown, nonEmpty: boolean): string {
  return assertBoundedText(value, nonEmpty);
}

function assertBoundedText(value: unknown, nonEmpty: boolean): string {
  if (
    typeof value !== "string" ||
    value.length > DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH ||
    (nonEmpty && value.length === 0)
  ) {
    throw invalidLocator();
  }
  return value;
}

function assertSafeNonnegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidLocator();
  }
  return value;
}

function assertTotalDepth(totalSegments: number): void {
  if (totalSegments > DOM_STABLE_LOCATOR_MAX_DEPTH) {
    throw invalidLocator();
  }
}

function assertStrictlySorted<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (keyOf(values[index - 1]!) >= keyOf(values[index]!)) {
      throw invalidLocator();
    }
  }
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
    throw invalidLocator();
  }

  const values: unknown[] = new Array(length);
  for (const { key, value: item } of properties) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isCanonicalArrayIndex(key, length)) {
      throw invalidLocator();
    }
    values[Number(key)] = item;
  }
  const snapshot = Object.freeze(values);
  const parsed: T[] = [];
  for (let index = 0; index < length; index += 1) {
    if (!hasOwn(snapshot, String(index))) {
      throw invalidLocator();
    }
    parsed.push(parseItem(snapshot[index]));
  }
  return Object.freeze(parsed);
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
      throw invalidLocator();
    }
    const isArray = Array.isArray(value);
    if ((expectedKind === "array") !== isArray) {
      throw invalidLocator();
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
        throw invalidLocator();
      }
      properties.push(Object.freeze({ key, value: descriptor.value }));
    }
    return Object.freeze(properties);
  } catch {
    throw invalidLocator();
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
      throw invalidLocator();
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
    throw invalidLocator();
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalidLocator(): TypeError {
  return new TypeError("Invalid stable DOM locator");
}
