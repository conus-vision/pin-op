import type { SourceRange } from "@pin-op/plugin-api";
import {
  RESOLUTION_LIMITS,
  RULES_SOURCES_LIMITS,
} from "@pin-op/protocol";
import type { RuleSourceDependencySnapshot } from "./rulesSourceResolver.js";

export const RULES_OPEN_ROUTE_HISTORY_LIMIT = RULES_SOURCES_LIMITS.sources;

export interface StoredRuleOpenAuthority {
  readonly openAuthorityId: string;
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly ruleRef: string;
  readonly documentUri: string;
  readonly documentVersion: number;
  readonly range: SourceRange;
  readonly workspaceGeneration: number;
  readonly dependencies: readonly RuleSourceDependencySnapshot[];
}

export interface RuleOpenAuthorityGenerationInput {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly authorities: readonly StoredRuleOpenAuthority[];
}

export interface RuleOpenAuthorityTuple {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly openAuthorityId: string;
}

export interface CurrentRuleOpenAuthorityGeneration {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly authorityCount: number;
}

declare const ruleOpenPreparationBrand: unique symbol;

export interface PreparedRuleOpenAuthorityGeneration {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly [ruleOpenPreparationBrand]: true;
}

interface AuthorityGeneration {
  readonly inspectMessageId: string;
  readonly rulesGeneration: number;
  readonly authorities: ReadonlyMap<string, StoredRuleOpenAuthority>;
  readonly dependencyUris: readonly string[];
}

interface PreparationState {
  readonly candidate: AuthorityGeneration;
  readonly previous: AuthorityGeneration | undefined;
  readonly preparedAtMutation: number;
  status: "prepared" | "active" | "committed" | "rolled-back";
}

export class RulesOpenAuthorityRegistry {
  private active: AuthorityGeneration | undefined;
  private readonly highWatermarks = new Map<string, number>();
  private mutation = 0;
  private readonly preparations = new WeakMap<
    PreparedRuleOpenAuthorityGeneration,
    PreparationState
  >();

  public prepare(
    input: RuleOpenAuthorityGenerationInput,
  ): PreparedRuleOpenAuthorityGeneration {
    const routeHighWatermark = this.highWatermarks.get(input.inspectMessageId) ??
      0;
    validateGenerationInput(input, routeHighWatermark);
    const candidate = freezeGeneration(input);
    this.mutation += 1;
    const prepared = Object.freeze({
      inspectMessageId: candidate.inspectMessageId,
      rulesGeneration: candidate.rulesGeneration,
    }) as PreparedRuleOpenAuthorityGeneration;
    this.preparations.set(prepared, {
      candidate,
      previous: this.active?.inspectMessageId === input.inspectMessageId
        ? this.active
        : undefined,
      preparedAtMutation: this.mutation,
      status: "prepared",
    });
    this.rememberHighWatermark(
      input.inspectMessageId,
      input.rulesGeneration,
    );
    return prepared;
  }

  public activate(prepared: PreparedRuleOpenAuthorityGeneration): void {
    const state = this.preparation(prepared, "prepared");
    if (state.preparedAtMutation !== this.mutation) {
      state.status = "rolled-back";
      throw new Error("Rules authority preparation is stale");
    }
    this.active = state.candidate;
    this.mutation += 1;
    state.status = "active";
  }

  public commit(prepared: PreparedRuleOpenAuthorityGeneration): void {
    const state = this.preparation(prepared, "active");
    if (this.active !== state.candidate) {
      state.status = "rolled-back";
      throw new Error("Rules authority activation is stale");
    }
    state.status = "committed";
  }

  public rollback(prepared: PreparedRuleOpenAuthorityGeneration): void {
    const state = this.preparations.get(prepared);
    if (!state || state.status === "rolled-back" || state.status === "committed") {
      throw new Error("Rules authority preparation cannot be rolled back");
    }
    if (state.status === "active") {
      if (this.active !== state.candidate) {
        state.status = "rolled-back";
        throw new Error("Rules authority activation is stale");
      }
      this.active = state.previous;
      this.mutation += 1;
    }
    state.status = "rolled-back";
  }

  public authorize(
    tuple: RuleOpenAuthorityTuple,
  ): StoredRuleOpenAuthority | undefined {
    const active = this.active;
    if (
      !active ||
      active.inspectMessageId !== tuple.inspectMessageId ||
      active.rulesGeneration !== tuple.rulesGeneration
    ) {
      return undefined;
    }
    return active.authorities.get(tuple.openAuthorityId);
  }

  public current(): CurrentRuleOpenAuthorityGeneration | undefined {
    const active = this.active;
    return active
      ? Object.freeze({
          inspectMessageId: active.inspectMessageId,
          rulesGeneration: active.rulesGeneration,
          authorityCount: active.authorities.size,
        })
      : undefined;
  }

  public dependencyUris(): readonly string[] {
    return this.active?.dependencyUris ?? EMPTY_DEPENDENCIES;
  }

  public clear(): void {
    this.active = undefined;
    this.mutation += 1;
  }

  private rememberHighWatermark(
    inspectMessageId: string,
    rulesGeneration: number,
  ): void {
    this.highWatermarks.delete(inspectMessageId);
    this.highWatermarks.set(inspectMessageId, rulesGeneration);
    if (this.highWatermarks.size <= RULES_OPEN_ROUTE_HISTORY_LIMIT) return;

    const activeInspectMessageId = this.active?.inspectMessageId;
    for (const retainedInspectMessageId of this.highWatermarks.keys()) {
      if (
        retainedInspectMessageId === activeInspectMessageId ||
        retainedInspectMessageId === inspectMessageId
      ) {
        continue;
      }
      this.highWatermarks.delete(retainedInspectMessageId);
      return;
    }
  }

  private preparation(
    prepared: PreparedRuleOpenAuthorityGeneration,
    expected: PreparationState["status"],
  ): PreparationState {
    const state = this.preparations.get(prepared);
    if (!state || state.status !== expected) {
      throw new Error("Rules authority preparation is not current");
    }
    return state;
  }
}

const EMPTY_DEPENDENCIES = Object.freeze([]) as readonly string[];

function validateGenerationInput(
  input: RuleOpenAuthorityGenerationInput,
  highWatermark: number,
): void {
  if (!validOpaque(input.inspectMessageId)) {
    throw new Error("Rules authority inspect ID is invalid");
  }
  if (
    !Number.isSafeInteger(input.rulesGeneration) ||
    input.rulesGeneration < 1 ||
    input.rulesGeneration > RESOLUTION_LIMITS.generation ||
    input.rulesGeneration <= highWatermark
  ) {
    throw new Error("Rules authority generation must be newer");
  }
  if (input.authorities.length > RULES_SOURCES_LIMITS.sources) {
    throw new Error("Rules authority generation exceeds capacity");
  }
  const authorityIds = new Set<string>();
  const ruleRefs = new Set<string>();
  for (const authority of input.authorities) {
    validateAuthority(authority, input);
    if (
      authorityIds.has(authority.openAuthorityId) ||
      ruleRefs.has(authority.ruleRef)
    ) {
      throw new Error("Rules authority generation contains a duplicate");
    }
    authorityIds.add(authority.openAuthorityId);
    ruleRefs.add(authority.ruleRef);
  }
}

function validateAuthority(
  authority: StoredRuleOpenAuthority,
  generation: Pick<
    RuleOpenAuthorityGenerationInput,
    "inspectMessageId" | "rulesGeneration"
  >,
): void {
  if (
    authority.inspectMessageId !== generation.inspectMessageId ||
    authority.rulesGeneration !== generation.rulesGeneration ||
    !validOpaque(authority.openAuthorityId) ||
    !validOpaque(authority.ruleRef) ||
    !validUri(authority.documentUri) ||
    !validNonnegativeInteger(authority.documentVersion) ||
    !validNonnegativeInteger(authority.workspaceGeneration) ||
    !validRange(authority.range) ||
    authority.dependencies.length < 1 ||
    authority.dependencies.length > 3
  ) {
    throw new Error("Rules authority is invalid");
  }
  const dependencyKeys = new Set<string>();
  let generatedCss: RuleSourceDependencySnapshot | undefined;
  let externalSourceMap: RuleSourceDependencySnapshot | undefined;
  let originalSource: RuleSourceDependencySnapshot | undefined;
  for (const dependency of authority.dependencies) {
    if (
      !validDependency(dependency) ||
      dependencyKeys.has(`${dependency.kind}\u0000${dependency.uri}`)
    ) {
      throw new Error("Rules authority dependency is invalid or duplicate");
    }
    dependencyKeys.add(`${dependency.kind}\u0000${dependency.uri}`);
    if (dependency.kind === "generated-css") {
      if (generatedCss) {
        throw new Error("Rules authority dependency shape is invalid");
      }
      generatedCss = dependency;
    } else if (dependency.kind === "external-source-map") {
      if (externalSourceMap) {
        throw new Error("Rules authority dependency shape is invalid");
      }
      externalSourceMap = dependency;
    } else {
      if (originalSource) {
        throw new Error("Rules authority dependency shape is invalid");
      }
      originalSource = dependency;
    }
  }
  if (!generatedCss || (externalSourceMap && !originalSource)) {
    throw new Error("Rules authority dependency shape is invalid");
  }
  const targetDependency = originalSource ?? generatedCss;
  if (
    targetDependency.uri !== authority.documentUri ||
    targetDependency.documentVersion !== authority.documentVersion
  ) {
    throw new Error("Rules authority target dependency is missing");
  }
}

function validDependency(dependency: RuleSourceDependencySnapshot): boolean {
  return (
    dependency.kind === "generated-css" ||
    dependency.kind === "external-source-map" ||
    dependency.kind === "original-source"
  ) && validUri(dependency.uri) &&
    (dependency.documentVersion === undefined ||
      validNonnegativeInteger(dependency.documentVersion)) &&
    /^[0-9a-f]{64}$/.test(dependency.contentHash);
}

function freezeGeneration(
  input: RuleOpenAuthorityGenerationInput,
): AuthorityGeneration {
  const authorities = new Map<string, StoredRuleOpenAuthority>();
  const dependencyUris = new Set<string>();
  for (const inputAuthority of input.authorities) {
    const authority = freezeAuthority(inputAuthority);
    authorities.set(authority.openAuthorityId, authority);
    for (const dependency of authority.dependencies) {
      dependencyUris.add(dependency.uri);
    }
  }
  return Object.freeze({
    inspectMessageId: input.inspectMessageId,
    rulesGeneration: input.rulesGeneration,
    authorities,
    dependencyUris: Object.freeze([...dependencyUris]),
  });
}

function freezeAuthority(
  authority: StoredRuleOpenAuthority,
): StoredRuleOpenAuthority {
  return Object.freeze({
    ...authority,
    range: Object.freeze({
      start: Object.freeze({ ...authority.range.start }),
      end: Object.freeze({ ...authority.range.end }),
    }),
    dependencies: Object.freeze(authority.dependencies.map((dependency) =>
      Object.freeze({ ...dependency })
    )),
  });
}

function validOpaque(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function validUri(value: string): boolean {
  try {
    const uri = new URL(value);
    return uri.protocol.length > 1;
  } catch {
    return false;
  }
}

function validNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRange(range: SourceRange): boolean {
  const positions = [range.start, range.end];
  if (positions.some((position) =>
    !validNonnegativeInteger(position.line) ||
    !validNonnegativeInteger(position.character)
  )) {
    return false;
  }
  return range.end.line > range.start.line ||
    (range.end.line === range.start.line &&
      range.end.character > range.start.character);
}
