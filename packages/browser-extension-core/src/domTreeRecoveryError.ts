import type { DomErrorCode } from "./domProtocol.js";

export type DomTreeRecoveryErrorScope = "locator" | "branch";
export type DomTreeRecoveryErrorDisposition = "partial" | "fatal";

const PARTIAL_LOCATOR_ERRORS = new Set<DomErrorCode>([
  "node-unavailable",
]);

const PARTIAL_BRANCH_ERRORS = new Set<DomErrorCode>([
  "unknown-node",
  "stale-branch",
  "invalid-cursor",
  "node-unavailable",
]);

export function classifyDomTreeRecoveryError(
  scope: DomTreeRecoveryErrorScope,
  code: DomErrorCode,
): DomTreeRecoveryErrorDisposition {
  const partialErrors = scope === "locator"
    ? PARTIAL_LOCATOR_ERRORS
    : PARTIAL_BRANCH_ERRORS;
  return partialErrors.has(code) ? "partial" : "fatal";
}

export class DomTreeRecoveryFatalError extends Error {
  public readonly scope: DomTreeRecoveryErrorScope;
  public readonly code: DomErrorCode | undefined;

  public constructor(
    scope: DomTreeRecoveryErrorScope,
    message: string,
    code?: DomErrorCode,
  ) {
    super(message);
    this.name = "DomTreeRecoveryFatalError";
    this.scope = scope;
    this.code = code;
  }
}
