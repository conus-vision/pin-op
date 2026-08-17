const MAX_SNAPSHOT_DEPTH = 12;
const MAX_SNAPSHOT_NODES = 512;
const MAX_SNAPSHOT_ARRAY_LENGTH = 64;
const MAX_SNAPSHOT_OBJECT_KEYS = 64;
const MAX_SNAPSHOT_STRING_LENGTH = 256 * 1024;
const invalidSnapshot = Symbol("invalidSnapshot");

interface SafeParser<T> {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: T }
    | { readonly success: false };
}

export function parseProtocolData<T>(
  value: unknown,
  parser: SafeParser<T>,
): T | undefined {
  const snapshot = snapshotJsonData(value, { nodes: 0 }, 0);
  if (snapshot === invalidSnapshot) {
    return undefined;
  }
  const parsed = parser.safeParse(snapshot);
  return parsed.success ? parsed.data : undefined;
}

export function snapshotExactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  const snapshot = snapshotJsonData(value, { nodes: 0 }, 0);
  if (
    snapshot === invalidSnapshot ||
    !snapshot ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    return undefined;
  }
  const record = snapshot as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === expectedKeys.length &&
      expectedKeys.every((key) => Object.hasOwn(record, key))
    ? Object.freeze(record)
    : undefined;
}

function snapshotJsonData(
  value: unknown,
  budget: { nodes: number },
  depth: number,
): unknown | typeof invalidSnapshot {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= MAX_SNAPSHOT_STRING_LENGTH ? value : invalidSnapshot;
  }
  if (
    typeof value !== "object" ||
    depth > MAX_SNAPSHOT_DEPTH ||
    ++budget.nodes > MAX_SNAPSHOT_NODES
  ) {
    return invalidSnapshot;
  }

  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const lengthHolder = Reflect.getOwnPropertyDescriptor(
        descriptors,
        "length",
      );
      const lengthDescriptor = lengthHolder?.value as
        | PropertyDescriptor
        | undefined;
      if (
        !lengthDescriptor ||
        !Object.hasOwn(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_SNAPSHOT_ARRAY_LENGTH
      ) {
        return invalidSnapshot;
      }
      const length = lengthDescriptor.value as number;
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length !== length + 1) {
        return invalidSnapshot;
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (
          !descriptor ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          return invalidSnapshot;
        }
        const item = snapshotJsonData(descriptor.value, budget, depth + 1);
        if (item === invalidSnapshot) {
          return invalidSnapshot;
        }
        result.push(item);
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidSnapshot;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length > MAX_SNAPSHOT_OBJECT_KEYS ||
      keys.some((key) => typeof key !== "string")
    ) {
      return invalidSnapshot;
    }
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        return invalidSnapshot;
      }
      const item = snapshotJsonData(descriptor.value, budget, depth + 1);
      if (item === invalidSnapshot) {
        return invalidSnapshot;
      }
      result[key] = item;
    }
    return result;
  } catch {
    return invalidSnapshot;
  }
}
