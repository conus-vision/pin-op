const trustedIdePeerContextBrand: unique symbol = Symbol(
  "trustedIdePeerContext",
);
const trustedIdePeerContexts = new WeakSet<object>();

export interface TrustedIdePeerContext {
  readonly windowId: number;
  readonly sessionId: string;
  readonly source: {
    readonly role: "ide";
    readonly id: string;
  };
  readonly [trustedIdePeerContextBrand]: true;
}

export function createTransportTrustedIdePeerContext(
  windowId: number,
  sessionId: string,
  sourceId: string,
): TrustedIdePeerContext {
  if (
    !isBrowserId(windowId) ||
    !isOpaqueId(sessionId) ||
    !isOpaqueId(sourceId)
  ) {
    throw new TypeError("Invalid trusted IDE peer context");
  }
  const context = Object.freeze({
    windowId,
    sessionId,
    source: Object.freeze({ role: "ide" as const, id: sourceId }),
    [trustedIdePeerContextBrand]: true as const,
  });
  trustedIdePeerContexts.add(context);
  return context;
}

export function isTrustedIdePeerContext(
  value: unknown,
): value is TrustedIdePeerContext {
  return Boolean(
    value &&
      typeof value === "object" &&
      trustedIdePeerContexts.has(value),
  );
}

export function trustedIdePeerMatchesPayload(
  context: TrustedIdePeerContext,
  message: {
    readonly sessionId: string;
    readonly source: { readonly role: "ide"; readonly id: string };
  },
): boolean {
  return isTrustedIdePeerContext(context) &&
    context.sessionId === message.sessionId &&
    context.source.id === message.source.id;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isBrowserId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
