import postcss, { type ChildNode } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser, { type Node as ValueNode } from "postcss-value-parser";
import {
  INSPECT_LIMITS,
  canonicalizePublicStylesheetUrl,
  utf8ByteLength,
} from "@pin-op/protocol";
import {
  PinOpRuntimeArtifacts,
  type PinOpRuntimeCleanupResult,
} from "./pinOpRuntimeArtifacts.js";
import {
  DEFAULT_BROWSER_INTRINSICS,
  STRUCTURAL_TEST_MODE,
  type BrowserIntrinsicAccess,
} from "./browserIntrinsics.js";
import {
  selectorContainsRequestedPseudoState,
  transformPseudoStateSelector,
  type PseudoState,
  type PseudoStateMarkerNames,
} from "./pseudoStateSelector.js";
import {
  type StylesheetImportChainEntry,
  type StylesheetImportContext,
  type StylesheetOwnerState,
  type StylesheetRegistryOrigin,
} from "./stylesheetRegistry.js";

const PREVIEW_MAX_STYLESHEETS = INSPECT_LIMITS.stylesheets;
const PREVIEW_MAX_RULES = INSPECT_LIMITS.cssRules;
const PREVIEW_MAX_DEPTH = INSPECT_LIMITS.cssRuleDepth;
const PREVIEW_MAX_DECLARATIONS = INSPECT_LIMITS.declarationsPerRule;
const PREVIEW_MAX_BYTES = 512 * 1024;
const PREVIEW_MAX_ADOPTED_STYLESHEETS = PREVIEW_MAX_STYLESHEETS * 2;
const PREVIEW_VERIFICATION_PASSES = 2;
const PREVIEW_MAX_CAPTURE_PASSES = 2 + PREVIEW_VERIFICATION_PASSES;

const EXTENSION_DOCUMENT_CREATE_ELEMENT = typeof Document === "function"
  ? Document.prototype.createElement
  : undefined;
const EXTENSION_CSS_STYLESHEET = typeof CSSStyleSheet === "function"
  ? CSSStyleSheet
  : undefined;
const EXTENSION_SHADOW_ROOT_HOST_GETTER = typeof ShadowRoot === "function"
  ? Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "host")?.get
  : undefined;
const EXTENSION_SHADOW_ROOT_MODE_GETTER = typeof ShadowRoot === "function"
  ? Object.getOwnPropertyDescriptor(ShadowRoot.prototype, "mode")?.get
  : undefined;
const EXTENSION_ELEMENT_SHADOW_ROOT_GETTER = typeof Element === "function"
  ? Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot")?.get
  : undefined;

export type PseudoStatePreviewDiagnostic =
  | "adopted-sheet-assignment-failed"
  | "cleanup-incomplete"
  | "declaration-unavailable"
  | "invalid-selection"
  | "marker-application-failed"
  | "source-inapplicable"
  | "source-provenance-changed"
  | "source-order-approximation"
  | "style-mount-rejected"
  | "stylesheet-inaccessible"
  | "stylesheet-truncated"
  | "transaction-authority-lost"
  | "unsupported-group"
  | "unsupported-selector"
  | "unproven-nesting";

export interface PseudoStatePreviewStylesheet {
  readonly scope: Document | ShadowRoot;
  readonly sheet: CSSStyleSheet;
  readonly kind: "external" | "owner" | "adopted" | "import";
  readonly sourceOrder: number;
  readonly sourceUrl?: string;
  readonly owner?: Element;
  readonly ownerState?: StylesheetOwnerState;
  readonly rulePathPrefix?: string;
  readonly origin?: StylesheetRegistryOrigin;
  readonly importChain?: readonly StylesheetImportChainEntry[];
  readonly importContexts?: readonly StylesheetImportContext[];
  readonly importContextUnsupported?: boolean;
}

export interface PseudoStatePreviewResult {
  readonly states: readonly PseudoState[];
  readonly mountedRuleCount: number;
  readonly unsupportedRuleCount: number;
  readonly inaccessibleStylesheetCount: number;
  readonly approximateRuleCount: number;
  readonly diagnostics: readonly PseudoStatePreviewDiagnostic[];
}

export interface PseudoStatePreviewOptions {
  readonly artifacts?: PinOpRuntimeArtifacts;
  readonly createConstructableStylesheet?: (
    root: Document | ShadowRoot,
  ) => CSSStyleSheet;
  readonly createStyleElement?: (document: Document) => HTMLStyleElement;
  /**
   * Parses a mirror's own text the way the page's engine will, so the mount
   * check can compare two serializations instead of text against serialization.
   * The sheet it returns is never adopted and never reaches the page.
   */
  readonly createNormalizationStylesheet?: () => CSSStyleSheet;
  readonly resolveOpenShadowRootHost?: (root: object) => Element | undefined;
  /** Explicit fake-DOM authority for tests; production uses captured intrinsics. */
  readonly testOnlyIntrinsics?: BrowserIntrinsicAccess;
}

interface PreparedSourceSnapshot {
  readonly entry: SnapshotStylesheet;
  readonly provenance: SourceProvenance;
  readonly sourceCssText: string;
  readonly sourceRuleObjects: readonly object[];
  readonly ruleCount: number;
  readonly unsupportedRuleCount: number;
  readonly captureComplete: boolean;
  readonly captureFailure: CapturedRules["failure"];
}

interface PreparedMountPart extends PreparedSourceSnapshot {
  readonly cssText: string;
}

interface PreparedMount {
  readonly origin: StylesheetRegistryOrigin;
  readonly parts: readonly PreparedMountPart[];
  readonly cssText: string;
  readonly ruleCount: number;
}

interface MountedPreview {
  readonly mount: PreparedMount;
  readonly kind: "adopted" | "style";
  readonly sheet: CSSStyleSheet;
  readonly style?: HTMLStyleElement;
  readonly parent?: Node & ParentNode;
}

type MountAttempt =
  | { readonly status: "mounted"; readonly mounted: MountedPreview }
  | { readonly status: "inaccessible" | "unsupported" };

interface SnapshotStylesheet {
  readonly intrinsics: BrowserIntrinsicAccess;
  readonly scope: Document | ShadowRoot;
  readonly sheet: CSSStyleSheet;
  readonly kind: "external" | "owner" | "adopted" | "import";
  readonly sourceOrder: number;
  readonly sourceUrl?: string;
  readonly owner?: Element;
  readonly ownerState?: StylesheetOwnerState;
  readonly rulePathPrefix: string;
  readonly origin: StylesheetRegistryOrigin;
  readonly importChain: readonly SnapshotImportChainEntry[];
  readonly importContexts: readonly StylesheetImportContext[];
  readonly importContextUnsupported: boolean;
}

interface SnapshotImportChainEntry extends StylesheetImportChainEntry {
  /** Exact live import target captured during the initial bounded identity phase. */
  readonly initialImportedSheet: CSSStyleSheet;
}

interface RawRead {
  readonly readable: boolean;
  readonly value: unknown;
}

interface RawOriginSnapshot {
  readonly value: unknown;
  readonly readable: boolean;
  readonly kind: unknown;
  readonly sheet: unknown;
  readonly owner: unknown;
  readonly identityComplete: boolean;
}

interface RawImportChainEntrySnapshot {
  readonly value: unknown;
  readonly readable: boolean;
  readonly parentSheet: unknown;
  readonly rule: unknown;
  readonly ruleIndex: unknown;
  readonly importedSheet: unknown;
  readonly initialImportedSheet: unknown;
  readonly contexts: unknown;
  readonly unsupported: unknown;
}

interface RawImportChainSnapshot {
  readonly value: unknown;
  readonly readable: boolean;
  readonly bounded: boolean;
  readonly entries: readonly RawImportChainEntrySnapshot[];
  readonly identityComplete: boolean;
}

interface RawStylesheetSnapshot {
  readonly readable: boolean;
  readonly identityComplete: boolean;
  readonly scope: unknown;
  readonly sheet: unknown;
  readonly kind: unknown;
  readonly sourceOrder: unknown;
  readonly sourceUrl: unknown;
  readonly owner: unknown;
  readonly ownerState: unknown;
  readonly rulePathPrefix: unknown;
  readonly origin: RawOriginSnapshot;
  readonly importChain: RawImportChainSnapshot;
  readonly importContexts: unknown;
  readonly importContextUnsupported: unknown;
}

interface SnapshotStylesheetResult {
  readonly entry?: SnapshotStylesheet;
  readonly identityComplete: boolean;
}

interface StylesheetState {
  readonly disabled: boolean;
  readonly media: string;
}

interface SourceProvenance {
  readonly sheetStates: readonly SourceSheetState[];
  readonly ownerState?: StylesheetOwnerState;
  readonly importContexts: readonly StylesheetImportContext[];
  readonly mountContexts: readonly StylesheetImportContext[];
}

type SourceProvenanceCapture =
  | { readonly status: "supported"; readonly provenance: SourceProvenance }
  | { readonly status: "inaccessible" | "inapplicable" | "unsupported" };

interface SourceSheetState extends StylesheetState {
  readonly sheet: CSSStyleSheet;
  readonly href?: string;
}

interface CaptureState {
  readonly states: readonly PseudoState[];
  readonly markerNames: PseudoStateMarkerNames;
  readonly diagnostics: Set<PseudoStatePreviewDiagnostic>;
  unsupportedRuleCount: number;
  rulesVisited: number;
  rawRulePulls: number;
  bytes: number;
  readonly declarationReadBudget: {
    bytes: number;
    truncated: boolean;
    readonly total: { bytes: number };
  };
  readonly observedRuleObjects: object[];
  readonly intrinsics: BrowserIntrinsicAccess;
}

interface CapturedRules {
  readonly cssText: string;
  readonly ruleCount: number;
  readonly complete: boolean;
  readonly failure?: "inaccessible" | "unsupported";
}

interface BoundedObjectsResult {
  readonly values: readonly object[];
  readonly pulls: number;
  readonly status: "complete" | "invalid" | "truncated";
}

type NestedRulesSnapshot =
  | { readonly status: "absent" }
  | { readonly status: "inaccessible" }
  | {
      readonly status: "present";
      readonly rules: ArrayLike<object> | Iterable<object>;
    };

interface StylesheetInputSnapshot {
  readonly values: readonly PseudoStatePreviewStylesheet[];
  readonly status: "complete" | "invalid" | "truncated";
}

interface CapturedDeclaration {
  readonly property: string;
  readonly value: string;
  readonly important: boolean;
}

type WrappedSourceContextResult =
  | { readonly status: "supported"; readonly cssText: string }
  | { readonly status: "truncated" | "unsupported" };

/** Reversible, content-local author-style pseudo-state emulation. */
export class PseudoStatePreview {
  public readonly artifacts: PinOpRuntimeArtifacts;
  private readonly createConstructableStylesheet: (
    root: Document | ShadowRoot,
  ) => CSSStyleSheet;
  private readonly createStyleElement: (document: Document) => HTMLStyleElement;
  private readonly normalizeCssText: (cssText: string) => string | undefined;
  private readonly resolveOpenShadowRootHost: (root: object) => Element | undefined;
  private readonly intrinsics: BrowserIntrinsicAccess;
  private currentStates: readonly PseudoState[] = Object.freeze([]);

  public constructor(options: PseudoStatePreviewOptions = {}) {
    this.intrinsics = options.testOnlyIntrinsics ?? DEFAULT_BROWSER_INTRINSICS;
    this.artifacts = options.artifacts ?? new PinOpRuntimeArtifacts({
      testOnlyIntrinsics: this.intrinsics,
    });
    this.createConstructableStylesheet = options.createConstructableStylesheet ?? (
      (root) => createRealmStylesheet(root)
    );
    this.createStyleElement = options.createStyleElement ?? createRealmStyleElement;
    this.normalizeCssText = createCssTextNormalizer(
      options.createNormalizationStylesheet ?? realmNormalizationStylesheet,
      this.intrinsics,
    );
    this.resolveOpenShadowRootHost = options.resolveOpenShadowRootHost ??
      resolveRealmOpenShadowRootHost;
  }

  public get activeStates(): readonly PseudoState[] {
    return this.currentStates;
  }

  public apply(
    element: Element,
    stylesheets: readonly PseudoStatePreviewStylesheet[],
    states: readonly PseudoState[],
  ): PseudoStatePreviewResult {
    const canonical = canonicalStates(states);
    const diagnostics = new Set<PseudoStatePreviewDiagnostic>();
    const cleanup = this.artifacts.cleanup();
    if (!cleanup.complete) {
      diagnostics.add("cleanup-incomplete");
      return result(this.currentStates, 0, 0, 0, 0, diagnostics);
    }
    this.currentStates = Object.freeze([]);
    if (!canonical || !isObject(element)) {
      diagnostics.add("invalid-selection");
      return result([], 0, 0, 0, 0, diagnostics);
    }
    if (canonical.length === 0) return result(canonical, 0, 0, 0, 0, diagnostics);

    const root = selectedRoot(
      element,
      this.resolveOpenShadowRootHost,
      this.intrinsics,
    );
    if (!root) {
      diagnostics.add("invalid-selection");
      return result(this.currentStates, 0, 0, 0, 0, diagnostics);
    }
    const capture: CaptureState = {
      states: canonical,
      markerNames: this.artifacts.markerNames,
      diagnostics,
      unsupportedRuleCount: 0,
      rulesVisited: 0,
      rawRulePulls: 0,
      bytes: 0,
      declarationReadBudget: { bytes: 0, truncated: false, total: { bytes: 0 } },
      observedRuleObjects: [],
      intrinsics: this.intrinsics,
    };
    const stylesheetInputs = snapshotStylesheetInputs(stylesheets);
    if (stylesheetInputs.status === "invalid") {
      diagnostics.add("stylesheet-inaccessible");
    } else if (stylesheetInputs.status === "truncated") {
      diagnostics.add("stylesheet-truncated");
      capture.unsupportedRuleCount += 1;
    }
    const transactionSourceSheets = new Set<object>();
    let constructableWritesAllowed = true;
    const capturedMounts: PreparedMountPart[] = [];
    const capturedSources: PreparedSourceSnapshot[] = [];
    const inapplicableSources: SnapshotStylesheet[] = [];
    let inaccessibleStylesheetCount = stylesheetInputs.status === "invalid" ? 1 : 0;
    const seenSheets = new Set<object>();
    for (let index = 0; index < stylesheetInputs.values.length; index += 1) {
      let entry: SnapshotStylesheet;
      try {
        const snapshotResult = snapshotStylesheet(
          stylesheetInputs.values[index]!,
          transactionSourceSheets,
          this.intrinsics,
        );
        constructableWritesAllowed &&= snapshotResult.identityComplete;
        if (!snapshotResult.entry) throw new Error("invalid stylesheet entry");
        entry = snapshotResult.entry;
        rememberEntrySourceSheets(transactionSourceSheets, entry);
        if (entry.scope !== root) continue;
        if (seenSheets.has(entry.sheet)) continue;
      } catch {
        inaccessibleStylesheetCount += 1;
        diagnostics.add("stylesheet-inaccessible");
        continue;
      }
      seenSheets.add(entry.sheet);
      const provenanceCapture = captureSourceProvenance(root, entry, diagnostics);
      if (provenanceCapture.status !== "supported") {
        if (provenanceCapture.status === "inaccessible") {
          inaccessibleStylesheetCount += 1;
        } else if (provenanceCapture.status === "unsupported") {
          capture.unsupportedRuleCount += 1;
        } else {
          inapplicableSources.push(entry);
        }
        continue;
      }
      const { provenance } = provenanceCapture;
      let rules: ArrayLike<object> | Iterable<object>;
      try {
        const cssRules = entry.intrinsics.read(entry.sheet, "stylesheet.cssRules");
        if (!isObject(cssRules)) throw new Error("stylesheet rules unavailable");
        rules = cssRules as ArrayLike<object> | Iterable<object>;
      } catch {
        inaccessibleStylesheetCount += 1;
        diagnostics.add("stylesheet-inaccessible");
        continue;
      }
      const ruleObjectStart = capture.observedRuleObjects.length;
      const unsupportedRuleStart = capture.unsupportedRuleCount;
      const captured = captureRules(
        rules,
        undefined,
        entry.sourceUrl,
        entry.kind === "owner" || entry.kind === "adopted",
        0,
        capture,
      );
      if (!captured.complete && captured.failure === "inaccessible") {
        inaccessibleStylesheetCount += 1;
      }
      if (captured.complete || captured.ruleCount > 0) {
        const sourceSnapshot = {
          entry,
          provenance,
          sourceCssText: captured.cssText,
          sourceRuleObjects: Object.freeze(
            capture.observedRuleObjects.slice(ruleObjectStart),
          ),
          ruleCount: captured.ruleCount,
          unsupportedRuleCount: capture.unsupportedRuleCount - unsupportedRuleStart,
          captureComplete: captured.complete,
          captureFailure: captured.failure,
        } satisfies PreparedSourceSnapshot;
        if (captured.ruleCount === 0) {
          capturedSources.push(Object.freeze(sourceSnapshot));
          continue;
        }
        const wrapped = wrapSourceContexts(captured.cssText, provenance, capture);
        if (wrapped.status !== "supported") {
          capturedSources.push(Object.freeze(sourceSnapshot));
          capture.unsupportedRuleCount += captured.ruleCount;
          diagnostics.add(wrapped.status === "truncated"
            ? "stylesheet-truncated"
            : "unsupported-group");
          continue;
        }
        const part = Object.freeze({
          ...sourceSnapshot,
          cssText: wrapped.cssText,
        });
        capturedMounts.push(part);
        capturedSources.push(part);
      }
    }
    const prepared = groupPreparedMounts(capturedMounts, capture);
    const mountedSources = new Set<PreparedSourceSnapshot>(
      prepared.flatMap(({ parts }) => parts),
    );

    let mountedRuleCount = 0;
    const mountedPreviews: MountedPreview[] = [];
    const verifiedSources: PreparedSourceSnapshot[] = [];
    const preMountVerification = createVerificationCapture(capture);
    for (const source of capturedSources) {
      if (mountedSources.has(source)) continue;
      if (!verifyPreparedSourceContent(root, source, preMountVerification)) {
        diagnostics.add("source-provenance-changed");
        diagnostics.add("stylesheet-inaccessible");
        inaccessibleStylesheetCount += 1;
        continue;
      }
      verifiedSources.push(source);
    }
    for (const mount of prepared) {
      const availableParts: PreparedMountPart[] = [];
      for (const part of mount.parts) {
        if (verifyPreparedSourceContent(root, part, preMountVerification)) {
          availableParts.push(part);
        } else {
          diagnostics.add("source-provenance-changed");
          diagnostics.add("stylesheet-inaccessible");
          inaccessibleStylesheetCount += 1;
        }
      }
      const availableMount = preparedMountSubset(mount, availableParts);
      if (!availableMount) continue;
      const attempt = this.mount(
        root,
        availableMount,
        diagnostics,
        transactionSourceSheets,
        constructableWritesAllowed,
      );
      if (attempt.status === "mounted") {
        verifiedSources.push(...availableMount.parts);
        mountedPreviews.push(attempt.mounted);
        mountedRuleCount += availableMount.ruleCount;
      } else if (attempt.status === "inaccessible") {
        inaccessibleStylesheetCount += availableMount.parts.length;
      } else {
        verifiedSources.push(...availableMount.parts);
        capture.unsupportedRuleCount += availableMount.ruleCount;
      }
    }
    if (diagnostics.has("cleanup-incomplete")) {
      if (!this.artifacts.cleanup().complete) diagnostics.add("cleanup-incomplete");
      return result(
        this.currentStates,
        0,
        capture.unsupportedRuleCount,
        inaccessibleStylesheetCount,
        0,
        diagnostics,
      );
    }
    if (!this.artifacts.setStateMarkers(element, canonical)) {
      diagnostics.add("marker-application-failed");
      if (!this.artifacts.cleanup().complete) diagnostics.add("cleanup-incomplete");
      return result(
        this.currentStates,
        0,
        capture.unsupportedRuleCount,
        inaccessibleStylesheetCount,
        0,
        diagnostics,
      );
    }
    for (let phase = 0; phase < PREVIEW_VERIFICATION_PASSES; phase += 1) {
      const verification = createVerificationCapture(capture);
      if (
        selectedRoot(element, this.resolveOpenShadowRootHost, this.intrinsics) !== root ||
        !stateMarkersAreOwned(this.artifacts, element, canonical) ||
        !verifyPreparedSources(root, verifiedSources, verification) ||
        !sourcesRemainInapplicable(root, inapplicableSources) ||
        mountedPreviews.some((mounted) => !validateMountedPreview(
          root,
          mounted,
          this.normalizeCssText,
        )) ||
        selectedRoot(element, this.resolveOpenShadowRootHost, this.intrinsics) !== root ||
        !stateMarkersAreOwned(this.artifacts, element, canonical)
      ) {
        mergeVerificationFailure(capture, verification);
        diagnostics.add("transaction-authority-lost");
        if (!this.artifacts.cleanup().complete) diagnostics.add("cleanup-incomplete");
        return result(
          this.currentStates,
          0,
          capture.unsupportedRuleCount,
          inaccessibleStylesheetCount,
          0,
          diagnostics,
        );
      }
    }
    this.currentStates = canonical;
    if (mountedRuleCount > 0) diagnostics.add("source-order-approximation");
    return result(
      canonical,
      mountedRuleCount,
      capture.unsupportedRuleCount,
      inaccessibleStylesheetCount,
      mountedRuleCount,
      diagnostics,
    );
  }

  public clear(): PinOpRuntimeCleanupResult {
    const cleanup = this.artifacts.cleanup();
    if (cleanup.complete) this.currentStates = Object.freeze([]);
    return cleanup;
  }

  private mount(
    root: Document | ShadowRoot,
    mount: PreparedMount,
    diagnostics: Set<PseudoStatePreviewDiagnostic>,
    transactionSourceSheets: ReadonlySet<object>,
    constructableWritesAllowed: boolean,
  ): MountAttempt {
    if (!revalidatePreparedMount(root, mount)) {
      diagnostics.add("source-provenance-changed");
      return Object.freeze({ status: "inaccessible" });
    }
    if (mount.origin.kind === "adopted" && constructableWritesAllowed) {
      let mirror: CSSStyleSheet | undefined;
      let assignmentBaseline: readonly CSSStyleSheet[] | undefined;
      try {
        const previous = snapshotAdoptedStylesheets(root, this.intrinsics);
        if (!previous) throw new Error("adopted stylesheet list unavailable");
        if (previous.length >= PREVIEW_MAX_ADOPTED_STYLESHEETS) {
          throw new Error("adopted stylesheet runtime slot unavailable");
        }
        const sourceIndex = previous.indexOf(mount.origin.sheet);
        if (
          sourceIndex < 0 ||
          previous.lastIndexOf(mount.origin.sheet) !== sourceIndex
        ) throw new Error("adopted source unavailable");
        mirror = this.createConstructableStylesheet(root);
        if (!revalidatePreparedMount(root, mount)) {
          throw new Error("adopted source changed during construction");
        }
        const currentBeforeWrite = snapshotAdoptedStylesheets(root, this.intrinsics);
        if (!currentBeforeWrite) throw new Error("adopted stylesheet list unavailable");
        const preWriteSourceIndex = currentBeforeWrite.indexOf(mount.origin.sheet);
        if (
          !isFreshConstructableStylesheet(
            mirror,
            mount,
            currentBeforeWrite,
            this.artifacts,
            transactionSourceSheets,
            this.intrinsics,
          ) ||
          preWriteSourceIndex < 0 ||
          currentBeforeWrite.lastIndexOf(mount.origin.sheet) !== preWriteSourceIndex
        ) throw new Error("constructable stylesheet was not fresh");
        this.artifacts.registerAdoptedStylesheet(root, mirror, currentBeforeWrite);
        this.intrinsics.call(mirror, "stylesheet.replaceSync", [mount.cssText]);
        if (!mountedStylesheetMatches(
          mirror,
          mount.cssText,
          mount.ruleCount,
          mount.parts[0]?.entry.intrinsics ?? this.intrinsics,
          this.normalizeCssText,
        )) {
          throw new Error("constructable stylesheet contents were not committed");
        }
        if (!revalidatePreparedMount(root, mount)) {
          throw new Error("adopted source changed during construction");
        }
        const currentBeforeAssignment = snapshotAdoptedStylesheets(
          root,
          this.intrinsics,
        );
        if (!currentBeforeAssignment) throw new Error("adopted stylesheet list unavailable");
        assignmentBaseline = currentBeforeAssignment;
        if (currentBeforeAssignment.length >= PREVIEW_MAX_ADOPTED_STYLESHEETS) {
          throw new Error("adopted stylesheet runtime slot unavailable");
        }
        const currentSourceIndex = currentBeforeAssignment.indexOf(mount.origin.sheet);
        if (
          currentSourceIndex < 0 ||
          currentBeforeAssignment.lastIndexOf(mount.origin.sheet) !== currentSourceIndex ||
          currentBeforeAssignment.includes(mirror)
        ) throw new Error("adopted source unavailable before assignment");
        const next = [...currentBeforeAssignment];
        next.splice(currentSourceIndex + 1, 0, mirror);
        this.intrinsics.call(root, "set:root.adoptedStyleSheets", [next]);
        const current = snapshotAdoptedStylesheets(root, this.intrinsics);
        if (!current) throw new Error("adopted stylesheet list unavailable");
        const mirrorIndex = current.indexOf(mirror);
        if (
          !sameStylesheetSequence(current, next) ||
          mirrorIndex < 0 ||
          current.lastIndexOf(mirror) !== mirrorIndex ||
          current[mirrorIndex - 1] !== mount.origin.sheet ||
          !mountedStylesheetMatches(
            mirror,
            mount.cssText,
            mount.ruleCount,
            mount.parts[0]?.entry.intrinsics ?? this.intrinsics,
            this.normalizeCssText,
          ) ||
          !revalidatePreparedMount(root, mount)
        ) {
          throw new Error("adopted stylesheet placement was not committed");
        }
        return Object.freeze({
          status: "mounted",
          mounted: Object.freeze({
            mount,
            kind: "adopted",
            sheet: mirror,
          }),
        });
      } catch {
        diagnostics.add("adopted-sheet-assignment-failed");
        if (
          mirror &&
          !(assignmentBaseline
            ? this.artifacts.rollbackAdoptedStylesheet(
                root,
                mirror,
                assignmentBaseline,
              )
            : this.artifacts.cleanupAdoptedStylesheet(root, mirror))
        ) {
          diagnostics.add("cleanup-incomplete");
          return Object.freeze({ status: "unsupported" });
        }
      }
      if (!revalidatePreparedMount(root, mount)) {
        diagnostics.add("source-provenance-changed");
        return Object.freeze({ status: "inaccessible" });
      }
    }
    return mountStyleNode(
      root,
      mount,
      this.artifacts,
      diagnostics,
      transactionSourceSheets,
      this.createStyleElement,
      this.normalizeCssText,
    );
  }
}

function rememberEntrySourceSheets(
  target: Set<object>,
  entry: SnapshotStylesheet,
): void {
  target.add(entry.sheet);
  target.add(entry.origin.sheet);
  for (const step of entry.importChain) {
    target.add(step.parentSheet);
    target.add(step.importedSheet);
  }
}

function sameStylesheetSequence(
  left: readonly CSSStyleSheet[],
  right: readonly CSSStyleSheet[],
): boolean {
  return left.length === right.length &&
    left.every((sheet, index) => sheet === right[index]);
}

function stateMarkersAreOwned(
  artifacts: PinOpRuntimeArtifacts,
  element: Element,
  states: readonly PseudoState[],
): boolean {
  const names = [
    artifacts.markerNames.selection,
    ...states.map((state) => artifacts.markerNames[state]),
  ];
  return names.every((name) => artifacts.ownsAttribute(element, name));
}

function groupPreparedMounts(
  parts: readonly PreparedMountPart[],
  state: CaptureState,
): readonly PreparedMount[] {
  const groups: Array<{
    readonly origin: StylesheetRegistryOrigin;
    readonly parts: PreparedMountPart[];
  }> = [];
  for (const part of parts) {
    let group = groups.find(({ origin }) => sameOrigin(origin, part.entry.origin));
    if (!group) {
      group = { origin: part.entry.origin, parts: [] };
      groups.push(group);
    }
    group.parts.push(part);
  }
  const prepared: PreparedMount[] = [];
  for (const group of groups) {
    const ordered = [...group.parts].sort(compareMountParts);
    const ruleCount = ordered.reduce((total, part) => total + part.ruleCount, 0);
    let cssText = "";
    let cssBytes = 0;
    let truncated = false;
    for (const part of ordered) {
      const partBytes = utf8ByteLength(part.cssText);
      if (partBytes > PREVIEW_MAX_BYTES - cssBytes) {
        truncated = true;
        break;
      }
      cssBytes += partBytes;
      cssText += part.cssText;
    }
    if (
      truncated ||
      cssText.length === 0 ||
      !Number.isSafeInteger(ruleCount) ||
      ruleCount <= 0 ||
      ruleCount > PREVIEW_MAX_RULES
    ) {
      state.unsupportedRuleCount += Math.max(1, ruleCount);
      state.diagnostics.add("stylesheet-truncated");
      continue;
    }
    prepared.push(Object.freeze({
      origin: group.origin,
      parts: Object.freeze(ordered),
      cssText,
      ruleCount,
    }));
  }
  return Object.freeze(prepared);
}

function sameOrigin(
  left: StylesheetRegistryOrigin,
  right: StylesheetRegistryOrigin,
): boolean {
  return left.kind === right.kind &&
    left.sheet === right.sheet &&
    left.owner === right.owner;
}

function isMountSourceStylesheet(
  mount: PreparedMount,
  candidate: object,
): boolean {
  return mount.origin.sheet === candidate || mount.parts.some(({ entry, provenance }) => (
    entry.sheet === candidate ||
    provenance.sheetStates.some(({ sheet }) => sheet === candidate)
  ));
}

function isFreshConstructableStylesheet(
  candidate: CSSStyleSheet,
  mount: PreparedMount,
  currentAdopted: readonly CSSStyleSheet[],
  artifacts: PinOpRuntimeArtifacts,
  transactionSourceSheets: ReadonlySet<object>,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  if (!isObject(candidate) || isMountSourceStylesheet(mount, candidate)) return false;
  if (
    transactionSourceSheets.has(candidate) ||
    currentAdopted.includes(candidate) ||
    artifacts.isRuntimeStylesheet(candidate)
  ) return false;
  try {
    if (
      intrinsics.read(candidate, "stylesheet.ownerNode") !== null ||
      intrinsics.read(candidate, "stylesheet.href") !== null ||
      intrinsics.read(candidate, "stylesheet.disabled") !== false
    ) return false;
    const media = intrinsics.read(candidate, "stylesheet.media");
    if (
      !isObject(media) ||
      intrinsics.read(media, "media.mediaText") !== ""
    ) return false;
    const cssRules = intrinsics.read(candidate, "stylesheet.cssRules");
    if (!isObject(cssRules)) return false;
    const rules = boundedRuleObjects(
      cssRules as ArrayLike<object>,
      1,
      2,
      intrinsics,
    );
    return rules.status === "complete" && rules.values.length === 0;
  } catch {
    return false;
  }
}

function compareMountParts(left: PreparedMountPart, right: PreparedMountPart): number {
  const leftPath = left.entry.importChain.map(({ ruleIndex }) => ruleIndex);
  const rightPath = right.entry.importChain.map(({ ruleIndex }) => ruleIndex);
  const shared = Math.min(leftPath.length, rightPath.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = leftPath[index]! - rightPath[index]!;
    if (difference !== 0) return difference;
  }
  if (leftPath.length !== rightPath.length) return rightPath.length - leftPath.length;
  return left.entry.sourceOrder - right.entry.sourceOrder;
}

function revalidatePreparedMount(
  root: Document | ShadowRoot,
  mount: PreparedMount,
): boolean {
  return mount.parts.every(({ entry, provenance }) => (
    revalidateSourceProvenance(root, entry, provenance)
  ));
}

function createVerificationCapture(source: CaptureState): CaptureState {
  return {
    states: source.states,
    markerNames: source.markerNames,
    diagnostics: new Set<PseudoStatePreviewDiagnostic>(),
    unsupportedRuleCount: 0,
    rulesVisited: 0,
    rawRulePulls: 0,
    bytes: 0,
    declarationReadBudget: {
      bytes: 0,
      truncated: false,
      total: source.declarationReadBudget.total,
    },
    observedRuleObjects: [],
    intrinsics: source.intrinsics,
  };
}

function mergeVerificationFailure(
  target: CaptureState,
  verification: CaptureState,
): void {
  const alreadyTruncated = target.diagnostics.has("stylesheet-truncated");
  for (const diagnostic of verification.diagnostics) {
    target.diagnostics.add(diagnostic);
  }
  if (
    verification.declarationReadBudget.truncated &&
    !alreadyTruncated
  ) {
    target.diagnostics.add("stylesheet-truncated");
    target.unsupportedRuleCount += 1;
  }
}

function preparedMountSubset(
  mount: PreparedMount,
  availableParts: readonly PreparedMountPart[],
): PreparedMount | undefined {
  if (availableParts.length === 0) return undefined;
  const available = new Set(availableParts);
  const parts = mount.parts.filter((part) => available.has(part));
  let cssText = "";
  let bytes = 0;
  let ruleCount = 0;
  for (const part of parts) {
    const partBytes = utf8ByteLength(part.cssText);
    if (
      partBytes > PREVIEW_MAX_BYTES - bytes ||
      part.cssText.length > PREVIEW_MAX_BYTES - cssText.length
    ) return undefined;
    bytes += partBytes;
    cssText += part.cssText;
    ruleCount += part.ruleCount;
  }
  if (
    cssText.length === 0 ||
    !Number.isSafeInteger(ruleCount) ||
    ruleCount <= 0 ||
    ruleCount > PREVIEW_MAX_RULES
  ) return undefined;
  return Object.freeze({
    origin: mount.origin,
    parts: Object.freeze(parts),
    cssText,
    ruleCount,
  });
}

function verifyPreparedSources(
  root: Document | ShadowRoot,
  sources: readonly PreparedSourceSnapshot[],
  verification: CaptureState,
): boolean {
  for (const source of sources) {
    if (!verifyPreparedSourceContent(root, source, verification)) return false;
  }
  return true;
}

function sourcesRemainInapplicable(
  root: Document | ShadowRoot,
  entries: readonly SnapshotStylesheet[],
): boolean {
  for (const entry of entries) {
    const diagnostics = new Set<PseudoStatePreviewDiagnostic>();
    if (captureSourceProvenance(root, entry, diagnostics).status !== "inapplicable") {
      return false;
    }
  }
  return true;
}

function verifyPreparedSourceContent(
  root: Document | ShadowRoot,
  source: PreparedSourceSnapshot,
  verification: CaptureState,
): boolean {
  if (!revalidateSourceProvenance(root, source.entry, source.provenance)) return false;
  let rules: ArrayLike<object> | Iterable<object>;
  try {
    const cssRules = source.entry.intrinsics.read(
      source.entry.sheet,
      "stylesheet.cssRules",
    );
    if (!isObject(cssRules)) return false;
    rules = cssRules as ArrayLike<object> | Iterable<object>;
  } catch {
    return false;
  }
  const objectStart = verification.observedRuleObjects.length;
  const unsupportedRuleStart = verification.unsupportedRuleCount;
  const captured = captureRules(
    rules,
    undefined,
    source.entry.sourceUrl,
    source.entry.kind === "owner" || source.entry.kind === "adopted",
    0,
    verification,
  );
  const objects = verification.observedRuleObjects.slice(objectStart);
  const contentMatches = captured.complete === source.captureComplete &&
    captured.failure === source.captureFailure &&
    captured.ruleCount === source.ruleCount &&
    verification.unsupportedRuleCount - unsupportedRuleStart ===
      source.unsupportedRuleCount &&
    captured.cssText === source.sourceCssText &&
    objects.length === source.sourceRuleObjects.length &&
    objects.every((rule, index) => rule === source.sourceRuleObjects[index]);
  return contentMatches &&
    revalidateSourceProvenance(root, source.entry, source.provenance);
}

function validateMountedPreview(
  root: Document | ShadowRoot,
  mounted: MountedPreview,
  normalizeCssText: CssTextNormalizer,
): boolean {
  const { mount, sheet } = mounted;
  const intrinsics = mount.parts[0]?.entry.intrinsics ?? DEFAULT_BROWSER_INTRINSICS;
  if (!mountedStylesheetMatches(
    sheet,
    mount.cssText,
    mount.ruleCount,
    intrinsics,
    normalizeCssText,
  )) return false;
  let placementMatches = false;
  if (mounted.kind === "adopted") {
    try {
      const current = snapshotAdoptedStylesheets(root, intrinsics);
      if (!current) return false;
      const index = current.indexOf(sheet);
      placementMatches = index >= 0 &&
        current.lastIndexOf(sheet) === index &&
        current[index - 1] === mount.origin.sheet;
    } catch {
      return false;
    }
  } else {
    const { style, parent } = mounted;
    if (
      !style ||
      !parent ||
      intrinsics.read(style, "node.parentNode") !== parent ||
      intrinsics.read(style, "style.sheet") !== sheet ||
      intrinsics.read(style, "node.textContent") !== mount.cssText ||
      safeRoot(style, intrinsics) !== root
    ) return false;
    if (mount.origin.kind === "adopted") {
      placementMatches = true;
    } else {
      const owner = mount.origin.owner;
      placementMatches = Boolean(
        owner &&
        intrinsics.read(owner, "node.parentNode") === parent &&
        intrinsics.read(owner, "node.nextSibling") === style &&
        intrinsics.read(style, "node.previousSibling") === owner &&
        safeRoot(owner, intrinsics) === root &&
        ownerOwnsSheet(owner, mount.origin.sheet, intrinsics),
      );
    }
  }
  return placementMatches && revalidatePreparedMount(root, mount);
}

function snapshotStylesheetInputs(
  values: readonly PseudoStatePreviewStylesheet[],
): StylesheetInputSnapshot {
  try {
    const length = (values as { readonly length?: unknown }).length;
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
      return Object.freeze({ values: Object.freeze([]), status: "invalid" });
    }
    if (length > PREVIEW_MAX_STYLESHEETS) {
      return Object.freeze({ values: Object.freeze([]), status: "truncated" });
    }
    const result: PseudoStatePreviewStylesheet[] = [];
    for (let index = 0; index < length; index += 1) {
      result.push(values[index]!);
    }
    return Object.freeze({ values: Object.freeze(result), status: "complete" });
  } catch {
    return Object.freeze({ values: Object.freeze([]), status: "invalid" });
  }
}

function snapshotStylesheet(
  value: PseudoStatePreviewStylesheet,
  transactionSourceSheets: Set<object>,
  intrinsics: BrowserIntrinsicAccess,
): SnapshotStylesheetResult {
  const raw = captureRawStylesheetSnapshot(value, transactionSourceSheets, intrinsics);
  if (!raw.readable) {
    return Object.freeze({ identityComplete: raw.identityComplete });
  }
  try {
    const {
      scope,
      sheet,
      kind,
      sourceOrder,
      sourceUrl,
      owner,
    } = raw;
    if (
      !isObject(scope) ||
      !isObject(sheet) ||
      (kind !== "external" && kind !== "owner" && kind !== "adopted" && kind !== "import") ||
      typeof sourceOrder !== "number" ||
      !Number.isSafeInteger(sourceOrder) ||
      sourceOrder < 0
    ) return Object.freeze({ identityComplete: raw.identityComplete });
    if (
      sourceUrl !== undefined &&
      (typeof sourceUrl !== "string" || sourceUrl.length > INSPECT_LIMITS.urlLength)
    ) return Object.freeze({ identityComplete: raw.identityComplete });
    if (owner !== undefined && !isObject(owner)) {
      return Object.freeze({ identityComplete: raw.identityComplete });
    }
    const ownerState = raw.ownerState === undefined
      ? undefined
      : isObject(raw.ownerState)
        ? snapshotOwnerState(raw.ownerState as StylesheetOwnerState)
        : undefined;
    if (raw.ownerState !== undefined && !ownerState) {
      return Object.freeze({ identityComplete: raw.identityComplete });
    }
    const rulePathPrefix = raw.rulePathPrefix ?? "";
    if (
      typeof rulePathPrefix !== "string" ||
      rulePathPrefix.length > INSPECT_LIMITS.valueLength
    ) return Object.freeze({ identityComplete: raw.identityComplete });
    const origin = raw.origin.value === undefined
      ? defaultOrigin(kind, sheet as CSSStyleSheet, owner as Element | undefined)
      : snapshotOrigin(raw.origin);
    if (!origin) return Object.freeze({ identityComplete: raw.identityComplete });
    const importChain = snapshotImportChain(raw.importChain);
    if (!importChain) return Object.freeze({ identityComplete: raw.identityComplete });
    const importContexts = snapshotImportContexts(raw.importContexts ?? []);
    if (!importContexts) return Object.freeze({ identityComplete: raw.identityComplete });
    const importContextUnsupported = raw.importContextUnsupported ?? false;
    if (typeof importContextUnsupported !== "boolean") {
      return Object.freeze({ identityComplete: raw.identityComplete });
    }
    const entry = Object.freeze({
      intrinsics,
      scope: scope as Document | ShadowRoot,
      sheet: sheet as CSSStyleSheet,
      kind,
      sourceOrder,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(owner === undefined ? {} : { owner: owner as Element }),
      ...(ownerState === undefined ? {} : { ownerState }),
      rulePathPrefix,
      origin,
      importChain,
      importContexts,
      importContextUnsupported,
    });
    return Object.freeze({ entry, identityComplete: raw.identityComplete });
  } catch {
    return Object.freeze({ identityComplete: raw.identityComplete });
  }
}

function captureRawStylesheetSnapshot(
  value: PseudoStatePreviewStylesheet,
  transactionSourceSheets: Set<object>,
  intrinsics: BrowserIntrinsicAccess,
): RawStylesheetSnapshot {
  if (!isObject(value)) return unreadableRawStylesheetSnapshot();

  // Identity-bearing fields are read first and exactly once. Semantic
  // validation below must only consume this bounded snapshot.
  const sheet = readRawProperty(value, "sheet");
  if (isObject(sheet.value)) transactionSourceSheets.add(sheet.value);
  const origin = captureRawOrigin(
    readRawProperty(value, "origin"),
    transactionSourceSheets,
  );
  const importChain = captureRawImportChain(
    readRawProperty(value, "importChain"),
    transactionSourceSheets,
    intrinsics,
  );
  const scope = readRawProperty(value, "scope");
  const kind = readRawProperty(value, "kind");
  const sourceOrder = readRawProperty(value, "sourceOrder");
  const sourceUrl = readRawProperty(value, "sourceUrl");
  const owner = readRawProperty(value, "owner");
  const ownerState = readRawProperty(value, "ownerState");
  const rulePathPrefix = readRawProperty(value, "rulePathPrefix");
  const importContexts = readRawProperty(value, "importContexts");
  const importContextUnsupported = readRawProperty(value, "importContextUnsupported");
  const readable = [
    sheet,
    scope,
    kind,
    sourceOrder,
    sourceUrl,
    owner,
    ownerState,
    rulePathPrefix,
    importContexts,
    importContextUnsupported,
  ].every(({ readable: fieldReadable }) => fieldReadable) &&
    origin.readable && importChain.readable;
  return Object.freeze({
    readable,
    identityComplete: sheet.readable && origin.identityComplete &&
      importChain.identityComplete,
    scope: scope.value,
    sheet: sheet.value,
    kind: kind.value,
    sourceOrder: sourceOrder.value,
    sourceUrl: sourceUrl.value,
    owner: owner.value,
    ownerState: ownerState.value,
    rulePathPrefix: rulePathPrefix.value,
    origin,
    importChain,
    importContexts: importContexts.value,
    importContextUnsupported: importContextUnsupported.value,
  });
}

function unreadableRawStylesheetSnapshot(): RawStylesheetSnapshot {
  const origin = Object.freeze({
    value: undefined,
    readable: true,
    kind: undefined,
    sheet: undefined,
    owner: undefined,
    identityComplete: true,
  });
  const importChain = Object.freeze({
    value: undefined,
    readable: true,
    bounded: true,
    entries: Object.freeze([]),
    identityComplete: true,
  });
  return Object.freeze({
    readable: false,
    identityComplete: true,
    scope: undefined,
    sheet: undefined,
    kind: undefined,
    sourceOrder: undefined,
    sourceUrl: undefined,
    owner: undefined,
    ownerState: undefined,
    rulePathPrefix: undefined,
    origin,
    importChain,
    importContexts: undefined,
    importContextUnsupported: undefined,
  });
}

function captureRawOrigin(
  read: RawRead,
  transactionSourceSheets: Set<object>,
): RawOriginSnapshot {
  if (!read.readable) {
    return Object.freeze({
      value: undefined,
      readable: false,
      kind: undefined,
      sheet: undefined,
      owner: undefined,
      identityComplete: false,
    });
  }
  if (!isObject(read.value)) {
    return Object.freeze({
      value: read.value,
      readable: true,
      kind: undefined,
      sheet: undefined,
      owner: undefined,
      identityComplete: true,
    });
  }
  const kind = readRawProperty(read.value, "kind");
  const sheet = readRawProperty(read.value, "sheet");
  const owner = readRawProperty(read.value, "owner");
  if (isObject(sheet.value)) transactionSourceSheets.add(sheet.value);
  return Object.freeze({
    value: read.value,
    readable: kind.readable && sheet.readable && owner.readable,
    kind: kind.value,
    sheet: sheet.value,
    owner: owner.value,
    identityComplete: sheet.readable,
  });
}

function captureRawImportChain(
  read: RawRead,
  transactionSourceSheets: Set<object>,
  intrinsics: BrowserIntrinsicAccess,
): RawImportChainSnapshot {
  if (!read.readable) {
    return Object.freeze({
      value: undefined,
      readable: false,
      bounded: false,
      entries: Object.freeze([]),
      identityComplete: false,
    });
  }
  if (read.value === undefined) {
    return Object.freeze({
      value: undefined,
      readable: true,
      bounded: true,
      entries: Object.freeze([]),
      identityComplete: true,
    });
  }
  let isArray = false;
  try {
    isArray = Array.isArray(read.value);
  } catch {
    return Object.freeze({
      value: read.value,
      readable: false,
      bounded: false,
      entries: Object.freeze([]),
      identityComplete: false,
    });
  }
  if (!isArray) {
    return Object.freeze({
      value: read.value,
      readable: true,
      bounded: false,
      entries: Object.freeze([]),
      identityComplete: !isObject(read.value),
    });
  }
  const array = read.value as readonly unknown[];
  const length = readRawProperty(array, "length");
  if (
    !length.readable ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0 ||
    length.value > PREVIEW_MAX_DEPTH
  ) {
    return Object.freeze({
      value: read.value,
      readable: length.readable,
      bounded: false,
      entries: Object.freeze([]),
      identityComplete: false,
    });
  }
  const entries: RawImportChainEntrySnapshot[] = [];
  let readable = true;
  let identityComplete = true;
  for (let index = 0; index < length.value; index += 1) {
    const item = readRawProperty(array, String(index));
    if (!item.readable) {
      readable = false;
      identityComplete = false;
      entries.push(Object.freeze({
        value: undefined,
        readable: false,
        parentSheet: undefined,
        rule: undefined,
        ruleIndex: undefined,
        importedSheet: undefined,
        initialImportedSheet: undefined,
        contexts: undefined,
        unsupported: undefined,
      }));
      continue;
    }
    if (!isObject(item.value)) {
      entries.push(Object.freeze({
        value: item.value,
        readable: true,
        parentSheet: undefined,
        rule: undefined,
        ruleIndex: undefined,
        importedSheet: undefined,
        initialImportedSheet: undefined,
        contexts: undefined,
        unsupported: undefined,
      }));
      continue;
    }
    const parentSheet = readRawProperty(item.value, "parentSheet");
    const rule = readRawProperty(item.value, "rule");
    const ruleIndex = readRawProperty(item.value, "ruleIndex");
    const importedSheet = readRawProperty(item.value, "importedSheet");
    const initialImportedSheet = rule.readable && isObject(rule.value)
      ? readRawIntrinsic(intrinsics, rule.value, "import.styleSheet")
      : Object.freeze({ readable: true, value: undefined });
    const contexts = readRawProperty(item.value, "contexts");
    const unsupported = readRawProperty(item.value, "unsupported");
    if (isObject(parentSheet.value)) transactionSourceSheets.add(parentSheet.value);
    if (isObject(importedSheet.value)) transactionSourceSheets.add(importedSheet.value);
    if (isObject(initialImportedSheet.value)) {
      transactionSourceSheets.add(initialImportedSheet.value);
    }
    const itemReadable = [
      parentSheet,
      rule,
      ruleIndex,
      importedSheet,
      initialImportedSheet,
      contexts,
      unsupported,
    ].every(({ readable: fieldReadable }) => fieldReadable);
    readable &&= itemReadable;
    identityComplete &&= parentSheet.readable && rule.readable && importedSheet.readable &&
      initialImportedSheet.readable;
    entries.push(Object.freeze({
      value: item.value,
      readable: itemReadable,
      parentSheet: parentSheet.value,
      rule: rule.value,
      ruleIndex: ruleIndex.value,
      importedSheet: importedSheet.value,
      initialImportedSheet: initialImportedSheet.value,
      contexts: contexts.value,
      unsupported: unsupported.value,
    }));
  }
  return Object.freeze({
    value: read.value,
    readable,
    bounded: true,
    entries: Object.freeze(entries),
    identityComplete,
  });
}

function readRawProperty(target: object, key: PropertyKey): RawRead {
  try {
    return Object.freeze({ readable: true, value: Reflect.get(target, key) });
  } catch {
    return Object.freeze({ readable: false, value: undefined });
  }
}

function readRawIntrinsic(
  intrinsics: BrowserIntrinsicAccess,
  target: object,
  intrinsic: string,
): RawRead {
  try {
    return Object.freeze({ readable: true, value: intrinsics.read(target, intrinsic) });
  } catch {
    return Object.freeze({ readable: false, value: undefined });
  }
}

function defaultOrigin(
  kind: SnapshotStylesheet["kind"],
  sheet: CSSStyleSheet,
  owner: Element | undefined,
): StylesheetRegistryOrigin | undefined {
  if (kind === "import" || (kind !== "adopted" && !owner)) return undefined;
  return Object.freeze({
    kind,
    sheet,
    ...(owner && kind !== "adopted" ? { owner } : {}),
  });
}

function snapshotOrigin(
  value: RawOriginSnapshot,
): StylesheetRegistryOrigin | undefined {
  if (!value.readable || !isObject(value.value)) return undefined;
  const { sheet, kind, owner } = value;
  if (
    (kind !== "external" && kind !== "owner" && kind !== "adopted") ||
    !isObject(sheet) ||
    (owner !== undefined && !isObject(owner)) ||
    (kind !== "adopted" && !owner)
  ) return undefined;
  return Object.freeze({
    kind,
    sheet: sheet as CSSStyleSheet,
    ...(owner === undefined ? {} : { owner: owner as Element }),
  });
}

function snapshotImportChain(
  values: RawImportChainSnapshot,
): readonly SnapshotImportChainEntry[] | undefined {
  try {
    if (!values.readable || !values.bounded) return undefined;
    const chain: SnapshotImportChainEntry[] = [];
    for (const candidate of values.entries) {
      if (!candidate.readable || !isObject(candidate.value)) return undefined;
      const {
        parentSheet,
        importedSheet,
        initialImportedSheet,
        rule,
        ruleIndex,
        unsupported,
      } = candidate;
      const contexts = snapshotImportContexts(candidate.contexts ?? []);
      if (
        !isObject(parentSheet) ||
        !isObject(rule) ||
        typeof ruleIndex !== "number" ||
        !Number.isSafeInteger(ruleIndex) ||
        ruleIndex < 0 ||
        ruleIndex >= PREVIEW_MAX_RULES ||
        !isObject(importedSheet) ||
        !isObject(initialImportedSheet) ||
        typeof unsupported !== "boolean" ||
        !contexts
      ) return undefined;
      chain.push(Object.freeze({
        parentSheet: parentSheet as CSSStyleSheet,
        rule,
        ruleIndex,
        importedSheet: importedSheet as CSSStyleSheet,
        initialImportedSheet: initialImportedSheet as CSSStyleSheet,
        contexts,
        unsupported,
      }));
    }
    return Object.freeze(chain);
  } catch {
    return undefined;
  }
}

function snapshotOwnerState(value: StylesheetOwnerState): StylesheetOwnerState | undefined {
  try {
    const { media, disabled, rel, href, title, alternate } = value;
    if (
      typeof media !== "string" ||
      typeof disabled !== "boolean" ||
      typeof rel !== "string" ||
      typeof href !== "string" ||
      typeof title !== "string" ||
      typeof alternate !== "boolean" ||
      media.length > INSPECT_LIMITS.valueLength ||
      rel.length > INSPECT_LIMITS.valueLength ||
      href.length > INSPECT_LIMITS.urlLength ||
      title.length > INSPECT_LIMITS.valueLength
    ) return undefined;
    return Object.freeze({ media, disabled, rel, href, title, alternate });
  } catch {
    return undefined;
  }
}

function snapshotImportContexts(
  values: unknown,
): readonly StylesheetImportContext[] | undefined {
  try {
    if (!Array.isArray(values)) return undefined;
    const length = values.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > PREVIEW_MAX_DEPTH) {
      return undefined;
    }
    const contexts: StylesheetImportContext[] = [];
    for (let index = 0; index < length; index += 1) {
      const value = values[index];
      if (
        !isObject(value) ||
        ((value as Partial<StylesheetImportContext>).kind !== "media" &&
          (value as Partial<StylesheetImportContext>).kind !== "supports") ||
        !safeCondition((value as Partial<StylesheetImportContext>).text as string)
      ) return undefined;
      const context = value as StylesheetImportContext;
      contexts.push(Object.freeze({ kind: context.kind, text: context.text }));
    }
    return Object.freeze(contexts);
  } catch {
    return undefined;
  }
}

function captureSourceProvenance(
  root: Document | ShadowRoot,
  entry: SnapshotStylesheet,
  diagnostics: Set<PseudoStatePreviewDiagnostic>,
): SourceProvenanceCapture {
  const importContexts = validateExactImportChain(entry, true);
  if (!importContexts) {
    if (entry.importContextUnsupported) {
      diagnostics.add("unsupported-group");
      return Object.freeze({ status: "unsupported" });
    }
    diagnostics.add("source-provenance-changed");
    return Object.freeze({ status: "inaccessible" });
  }
  if (entry.importContextUnsupported) {
    diagnostics.add("unsupported-group");
    return Object.freeze({ status: "unsupported" });
  }
  const sheetStates = snapshotSourceSheetStates(entry);
  if (!sheetStates) {
    diagnostics.add("stylesheet-inaccessible");
    return Object.freeze({ status: "inaccessible" });
  }
  if (!sourceUrlMatchesLiveSheet(entry, sheetStates.at(-1))) {
    diagnostics.add("source-provenance-changed");
    return Object.freeze({ status: "inaccessible" });
  }
  if (sheetStates.some(({ disabled }) => disabled)) {
    diagnostics.add("source-inapplicable");
    return Object.freeze({ status: "inapplicable" });
  }
  if (sheetStates.some(({ media }) => !safeSourceMedia(media))) {
    diagnostics.add("unsupported-group");
    return Object.freeze({ status: "unsupported" });
  }
  if (entry.origin.kind === "adopted") {
    if (!isAdoptedSource(root, entry.origin.sheet, entry.intrinsics)) {
      diagnostics.add("source-provenance-changed");
      return Object.freeze({ status: "inaccessible" });
    }
    return Object.freeze({
      status: "supported",
      provenance: Object.freeze({
        sheetStates,
        importContexts,
        mountContexts: buildMountContexts(undefined, entry, sheetStates),
      }),
    });
  }
  const owner = entry.origin.owner;
  const expectedOwnerState = entry.ownerState;
  if (
    !owner ||
    entry.owner !== owner ||
    !expectedOwnerState ||
    safeRoot(owner, entry.intrinsics) !== root ||
    !ownerOwnsSheet(owner, entry.origin.sheet, entry.intrinsics)
  ) {
    diagnostics.add("source-provenance-changed");
    return Object.freeze({ status: "inaccessible" });
  }
  const currentOwnerState = readLiveOwnerState(owner, entry.intrinsics);
  if (!currentOwnerState) {
    diagnostics.add("stylesheet-inaccessible");
    return Object.freeze({ status: "inaccessible" });
  }
  if (currentOwnerState.disabled || currentOwnerState.alternate) {
    diagnostics.add("source-inapplicable");
    return Object.freeze({ status: "inapplicable" });
  }
  if (!safeSourceMedia(currentOwnerState.media)) {
    diagnostics.add("unsupported-group");
    return Object.freeze({ status: "unsupported" });
  }
  if (!sameOwnerState(currentOwnerState, expectedOwnerState)) {
    diagnostics.add("source-provenance-changed");
    return Object.freeze({ status: "inaccessible" });
  }
  return Object.freeze({
    status: "supported",
    provenance: Object.freeze({
      sheetStates,
      ownerState: currentOwnerState,
      importContexts,
      mountContexts: buildMountContexts(currentOwnerState, entry, sheetStates),
    }),
  });
}

function revalidateSourceProvenance(
  root: Document | ShadowRoot,
  entry: SnapshotStylesheet,
  provenance: SourceProvenance,
): boolean {
  const importContexts = validateExactImportChain(entry);
  if (!importContexts || !sameImportContexts(importContexts, provenance.importContexts)) {
    return false;
  }
  const sheetStates = snapshotSourceSheetStates(entry);
  if (!sheetStates || !sameSourceSheetStates(sheetStates, provenance.sheetStates)) return false;
  if (entry.origin.kind === "adopted") {
    return isAdoptedSource(root, entry.origin.sheet, entry.intrinsics);
  }
  const owner = entry.origin.owner;
  const ownerState = provenance.ownerState;
  if (
    !owner ||
    entry.owner !== owner ||
    !ownerState ||
    safeRoot(owner, entry.intrinsics) !== root ||
    !ownerOwnsSheet(owner, entry.origin.sheet, entry.intrinsics)
  ) return false;
  const currentOwnerState = readLiveOwnerState(owner, entry.intrinsics);
  if (!currentOwnerState) return false;
  if (
    currentOwnerState.disabled ||
    currentOwnerState.alternate ||
    !sameOwnerState(currentOwnerState, ownerState)
  ) return false;
  return true;
}

function readStylesheetState(
  sheet: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): SourceSheetState | undefined {
  try {
    const disabled = intrinsics.read(sheet, "stylesheet.disabled");
    if (typeof disabled !== "boolean") return undefined;
    const mediaValue = intrinsics.read(sheet, "stylesheet.media");
    if (!isObject(mediaValue)) return undefined;
    const mediaText = intrinsics.read(mediaValue, "media.mediaText");
    if (
      typeof mediaText !== "string" ||
      mediaText.length > INSPECT_LIMITS.valueLength
    ) return undefined;
    const media = mediaText;
    const hrefValue = intrinsics.read(sheet, "stylesheet.href");
    if (
      (hrefValue !== null && typeof hrefValue !== "string") ||
      (typeof hrefValue === "string" && hrefValue.length > INSPECT_LIMITS.urlLength)
    ) {
      return undefined;
    }
    return Object.freeze({
      sheet,
      disabled: disabled === true,
      media,
      ...(typeof hrefValue === "string" ? { href: hrefValue } : {}),
    });
  } catch {
    return undefined;
  }
}

function validateExactImportChain(
  entry: SnapshotStylesheet,
  useInitialImportedSheet = false,
): readonly StylesheetImportContext[] | undefined {
  if (entry.kind !== "import") {
    return entry.importChain.length === 0 &&
      entry.origin.kind === entry.kind &&
      entry.origin.sheet === entry.sheet &&
      entry.importContexts.length === 0 &&
      !entry.importContextUnsupported
      ? Object.freeze([])
      : undefined;
  }
  if (entry.importChain.length === 0) return undefined;
  const contexts: StylesheetImportContext[] = [];
  let unsupported = false;
  let expectedParent = entry.origin.sheet;
  for (const step of entry.importChain) {
    try {
      if (step.parentSheet !== expectedParent) return undefined;
      const rules = entry.intrinsics.read(step.parentSheet, "stylesheet.cssRules");
      if (!isObject(rules)) return undefined;
      const length = entry.intrinsics.read(rules, "ruleList.length");
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        step.ruleIndex >= length ||
        entry.intrinsics.call(rules, "ruleList.item", [step.ruleIndex]) !== step.rule
      ) return undefined;
      const provenance = readImportProvenance(step.rule, entry.intrinsics);
      if (
        provenance.unsupported !== step.unsupported ||
        !sameImportContexts(provenance.contexts, step.contexts) ||
        (useInitialImportedSheet
          ? step.initialImportedSheet
          : entry.intrinsics.read(step.rule, "import.styleSheet")) !== step.importedSheet
      ) return undefined;
      contexts.push(...step.contexts);
      unsupported ||= step.unsupported;
      expectedParent = step.importedSheet;
    } catch {
      return undefined;
    }
  }
  return expectedParent === entry.sheet &&
    unsupported === entry.importContextUnsupported &&
    sameImportContexts(contexts, entry.importContexts)
    ? Object.freeze(contexts)
    : undefined;
}

function readImportProvenance(
  rule: object,
  intrinsics: BrowserIntrinsicAccess,
): {
  readonly contexts: readonly StylesheetImportContext[];
  readonly unsupported: boolean;
} {
  const contexts: StylesheetImportContext[] = [];
  let unsupported = false;
  try {
    const layerName = intrinsics.read(rule, "import.layerName");
    if (layerName !== null && layerName !== undefined) unsupported = true;
  } catch {
    unsupported = true;
  }
  try {
    const supports = intrinsics.read(rule, "import.supportsText");
    if (supports !== null && supports !== undefined && supports !== "") {
      if (typeof supports === "string" && safeCondition(supports)) {
        contexts.push(Object.freeze({ kind: "supports", text: supports }));
      } else {
        unsupported = true;
      }
    }
  } catch {
    unsupported = true;
  }
  try {
    const media = intrinsics.read(rule, "import.media");
    if (media !== null && media !== undefined) {
      if (!isObject(media)) {
        unsupported = true;
      } else {
        const text = intrinsics.read(media, "media.mediaText");
        if (text !== null && text !== undefined && text !== "") {
          if (typeof text === "string" && safeCondition(text)) {
            contexts.push(Object.freeze({ kind: "media", text }));
          } else {
            unsupported = true;
          }
        }
      }
    }
  } catch {
    unsupported = true;
  }
  return Object.freeze({ contexts: Object.freeze(contexts), unsupported });
}

function snapshotSourceSheetStates(
  entry: SnapshotStylesheet,
): readonly SourceSheetState[] | undefined {
  const sourceSheets = [
    entry.origin.sheet,
    ...entry.importChain.map(({ importedSheet }) => importedSheet),
  ];
  if (sourceSheets.at(-1) !== entry.sheet) return undefined;
  const states: SourceSheetState[] = [];
  for (const sheet of sourceSheets) {
    const state = readStylesheetState(sheet, entry.intrinsics);
    if (!state) return undefined;
    states.push(state);
  }
  return Object.freeze(states);
}

function sourceUrlMatchesLiveSheet(
  entry: SnapshotStylesheet,
  leaf: SourceSheetState | undefined,
): boolean {
  if (!leaf) return false;
  if (leaf.href === undefined || leaf.href === "") return entry.sourceUrl === undefined;
  const canonical = canonicalizePublicStylesheetUrl(leaf.href, {
    baseUrl: sourceScopeBaseUrl(entry.scope, entry.intrinsics),
    maxLength: INSPECT_LIMITS.urlLength,
  });
  return canonical !== undefined && entry.sourceUrl === canonical;
}

function sourceScopeBaseUrl(
  scope: Document | ShadowRoot,
  intrinsics: BrowserIntrinsicAccess,
): string | undefined {
  try {
    const document = intrinsics.read(scope, "node.nodeType") === 9
      ? scope as Document
      : intrinsics.read(scope, "node.ownerDocument");
    if (!isObject(document)) return undefined;
    const href = intrinsics.read(document, "document.URL");
    return typeof href === "string" && href.length <= INSPECT_LIMITS.urlLength
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

function buildMountContexts(
  ownerState: StylesheetOwnerState | undefined,
  entry: SnapshotStylesheet,
  sheetStates: readonly SourceSheetState[],
): readonly StylesheetImportContext[] {
  const contexts: StylesheetImportContext[] = [];
  if (ownerState?.media) {
    contexts.push(Object.freeze({ kind: "media", text: ownerState.media }));
  }
  if (sheetStates[0]?.media) {
    contexts.push(Object.freeze({ kind: "media", text: sheetStates[0].media }));
  }
  for (let index = 0; index < entry.importChain.length; index += 1) {
    contexts.push(...entry.importChain[index]!.contexts);
    const importedState = sheetStates[index + 1];
    if (importedState?.media) {
      contexts.push(Object.freeze({ kind: "media", text: importedState.media }));
    }
  }
  return Object.freeze(contexts);
}

function wrapSourceContexts(
  cssText: string,
  provenance: SourceProvenance,
  state: CaptureState,
): WrappedSourceContextResult {
  let wrapped = cssText;
  for (let index = provenance.mountContexts.length - 1; index >= 0; index -= 1) {
    const context = provenance.mountContexts[index]!;
    const prefix = `@${context.kind} ${context.text}{`;
    const addedBytes = utf8ByteLength(prefix) + 1;
    if (
      addedBytes > PREVIEW_MAX_BYTES - utf8ByteLength(wrapped) ||
      state.bytes + addedBytes > PREVIEW_MAX_BYTES
    ) return Object.freeze({ status: "truncated" });
    const candidate = `${prefix}${wrapped}}`;
    if (!safeGroupText(candidate, context.kind, context.text)) {
      return Object.freeze({ status: "unsupported" });
    }
    state.bytes += addedBytes;
    wrapped = candidate;
  }
  return Object.freeze({ status: "supported", cssText: wrapped });
}

function ownerOwnsSheet(
  owner: Element,
  sheet: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  try {
    return intrinsics.read(owner, "owner.sheet") === sheet;
  } catch {
    return false;
  }
}

function readLiveOwnerState(
  owner: Element,
  intrinsics: BrowserIntrinsicAccess,
): StylesheetOwnerState | undefined {
  try {
    const disabledProperty = intrinsics.read(owner, "owner.disabled");
    if (typeof disabledProperty !== "boolean") return undefined;
    const readAttribute = (name: string): string | null | undefined => {
      const value = intrinsics.call(owner, "element.getAttribute", [name]);
      return value === null || typeof value === "string" ? value : undefined;
    };
    const media = readAttribute("media");
    const rel = readAttribute("rel");
    const href = readAttribute("href");
    const title = readAttribute("title");
    const disabledAttribute = readAttribute("disabled");
    if (
      media === undefined ||
      rel === undefined ||
      href === undefined ||
      title === undefined ||
      disabledAttribute === undefined
    ) return undefined;
    const relText = rel ?? "";
    if (
      (media?.length ?? 0) > INSPECT_LIMITS.valueLength ||
      relText.length > INSPECT_LIMITS.valueLength ||
      (href?.length ?? 0) > INSPECT_LIMITS.urlLength ||
      (title?.length ?? 0) > INSPECT_LIMITS.valueLength ||
      (disabledAttribute?.length ?? 0) > INSPECT_LIMITS.valueLength
    ) return undefined;
    return Object.freeze({
      media: media ?? "",
      disabled: disabledProperty || disabledAttribute !== null,
      rel: relText,
      href: href ?? "",
      title: title ?? "",
      alternate: relText.toLowerCase().split(/\s+/).includes("alternate"),
    });
  } catch {
    return undefined;
  }
}

function sameOwnerState(left: StylesheetOwnerState, right: StylesheetOwnerState): boolean {
  return left.media === right.media &&
    left.disabled === right.disabled &&
    left.rel === right.rel &&
    left.href === right.href &&
    left.title === right.title &&
    left.alternate === right.alternate;
}

function sameSheetState(left: StylesheetState, right: StylesheetState): boolean {
  return left.disabled === right.disabled && left.media === right.media;
}

function sameSourceSheetStates(
  left: readonly SourceSheetState[],
  right: readonly SourceSheetState[],
): boolean {
  return left.length === right.length && left.every((value, index) => {
    const expected = right[index];
    return expected !== undefined &&
      value.sheet === expected.sheet &&
      value.href === expected.href &&
      sameSheetState(value, expected) &&
      !value.disabled;
  });
}

function sameImportContexts(
  left: readonly StylesheetImportContext[],
  right: readonly StylesheetImportContext[],
): boolean {
  return left.length === right.length && left.every((value, index) => (
    value.kind === right[index]?.kind && value.text === right[index]?.text
  ));
}

function safeSourceMedia(value: string): boolean {
  return value === "" || safeCondition(value);
}

function captureRules(
  rules: ArrayLike<object> | Iterable<object>,
  parentSelector: string | undefined,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
  depth: number,
  state: CaptureState,
): CapturedRules {
  if (depth > PREVIEW_MAX_DEPTH) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("unsupported-group");
    return emptyCapture();
  }
  const bounded = boundedRuleObjects(
    rules,
    PREVIEW_MAX_RULES - state.rulesVisited,
    PREVIEW_MAX_RULES + 1 - state.rawRulePulls,
    state.intrinsics,
  );
  state.rawRulePulls += bounded.pulls;
  if (bounded.status !== "complete") {
    if (bounded.status === "truncated") state.unsupportedRuleCount += 1;
    state.diagnostics.add(bounded.status === "truncated"
      ? "stylesheet-truncated"
      : "stylesheet-inaccessible");
    return emptyCapture(
      false,
      bounded.status === "truncated" ? "unsupported" : "inaccessible",
    );
  }
  const values = bounded.values;
  let cssText = "";
  let ruleCount = 0;
  for (const rule of values) {
    state.observedRuleObjects.push(rule);
    state.rulesVisited += 1;
    if (state.rulesVisited > PREVIEW_MAX_RULES) break;
    const styleRule = snapshotStyleRule(
      rule,
      parentSelector,
      sourceUrl,
      allowUnrebasedRelativeUrls,
      state,
    );
    if (state.declarationReadBudget.truncated) {
      return failedCapture(cssText, ruleCount, "unsupported");
    }
    if (styleRule) {
      if (styleRule.cssText) {
        cssText += styleRule.cssText;
        ruleCount += 1;
      }
      const nested = readNestedRules(rule, state.intrinsics);
      if (nested.status === "inaccessible") {
        state.diagnostics.add("stylesheet-inaccessible");
        return failedCapture(cssText, ruleCount, "inaccessible");
      }
      if (
        nested.status === "present" &&
        !styleRule.resolvedSelector &&
        !styleRule.unresolvedCounted
      ) {
        state.unsupportedRuleCount += 1;
        state.diagnostics.add("unproven-nesting");
      }
      if (nested.status === "present" && styleRule.resolvedSelector) {
        const children = captureRules(
          nested.rules,
          styleRule.resolvedSelector,
          sourceUrl,
          allowUnrebasedRelativeUrls,
          depth + 1,
          state,
        );
        cssText += children.cssText;
        ruleCount += children.ruleCount;
        if (!children.complete) {
          return failedCapture(cssText, ruleCount, children.failure ?? "inaccessible");
        }
      }
      continue;
    }
    if (isCssNestedDeclarations(rule, state.intrinsics)) {
      const nestedDeclarations = snapshotNestedDeclarations(
        rule,
        parentSelector,
        sourceUrl,
        allowUnrebasedRelativeUrls,
        state,
      );
      if (state.declarationReadBudget.truncated) {
        return failedCapture(cssText, ruleCount, "unsupported");
      }
      if (nestedDeclarations) {
        cssText += nestedDeclarations;
        ruleCount += 1;
      }
      continue;
    }
    const nested = readNestedRules(rule, state.intrinsics);
    if (nested.status === "inaccessible") {
      state.diagnostics.add("stylesheet-inaccessible");
      return failedCapture(cssText, ruleCount, "inaccessible");
    }
    if (nested.status === "absent") continue;
    const group = supportedGroup(rule, state.intrinsics);
    if (!group) {
      state.unsupportedRuleCount += 1;
      state.diagnostics.add("unsupported-group");
      continue;
    }
    const children = captureRules(
      nested.rules,
      parentSelector,
      sourceUrl,
      allowUnrebasedRelativeUrls,
      depth + 1,
      state,
    );
    if (children.ruleCount > 0) {
      const wrapped = `@${group.kind} ${group.condition}{${children.cssText}}`;
      if (!safeGroupText(wrapped, group.kind, group.condition) || !charge(state, wrapped)) {
        state.unsupportedRuleCount += children.ruleCount;
        state.diagnostics.add("unsupported-group");
      } else {
        cssText += wrapped;
        ruleCount += children.ruleCount;
      }
    }
    if (!children.complete) {
      return failedCapture(cssText, ruleCount, children.failure ?? "inaccessible");
    }
  }
  return Object.freeze({ cssText, ruleCount, complete: true });
}

function snapshotStyleRule(
  rule: object,
  parentSelector: string | undefined,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
  state: CaptureState,
): {
  readonly resolvedSelector: string | undefined;
  readonly cssText: string;
  readonly unresolvedCounted: boolean;
} | undefined {
  let selectorText: unknown;
  try {
    selectorText = state.intrinsics.read(rule, "styleRule.selectorText");
  } catch {
    if (isCssNestedDeclarations(rule, state.intrinsics)) return undefined;
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("unsupported-selector");
    return undefined;
  }
  if (typeof selectorText !== "string") return undefined;
  const resolvedSelector = resolvePreviewSelector(selectorText, parentSelector);
  if (!resolvedSelector) {
    const target = selectorContainsRequestedPseudoState(selectorText, state.states);
    const unresolvedCounted = target !== false;
    if (unresolvedCounted) {
      state.unsupportedRuleCount += 1;
      state.diagnostics.add("unproven-nesting");
    }
    return Object.freeze({
      resolvedSelector: undefined,
      cssText: "",
      unresolvedCounted,
    });
  }
  return Object.freeze({
    resolvedSelector,
    unresolvedCounted: false,
    cssText: snapshotStyleForSelector(
      resolvedSelector,
      rule,
      sourceUrl,
      allowUnrebasedRelativeUrls,
      state,
    ),
  });
}

function snapshotNestedDeclarations(
  rule: object,
  parentSelector: string | undefined,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
  state: CaptureState,
): string | undefined {
  if (!parentSelector) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("unproven-nesting");
    return undefined;
  }
  const cssText = snapshotStyleForSelector(
    parentSelector,
    rule,
    sourceUrl,
    allowUnrebasedRelativeUrls,
    state,
    "nestedDeclarations.style",
  );
  return cssText || undefined;
}

function snapshotStyleForSelector(
  resolvedSelector: string,
  rule: object,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
  state: CaptureState,
  declarationIntrinsic = "styleRule.style",
): string {
  const transformed = transformPseudoStateSelector(
    resolvedSelector,
    state.markerNames,
    state.states,
  );
  if (transformed.kind === "unsupported") {
    if (transformed.reason !== "no-target-pseudo") {
      state.unsupportedRuleCount += 1;
      state.diagnostics.add("unsupported-selector");
    }
    return "";
  }
  let style: unknown;
  try {
    style = state.intrinsics.read(rule, declarationIntrinsic);
  } catch {
    style = undefined;
  }
  if (!isObject(style)) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("declaration-unavailable");
    return "";
  }
  const declarations = snapshotDeclarations(
    style,
    sourceUrl,
    allowUnrebasedRelativeUrls,
    state,
  );
  if (!declarations) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("declaration-unavailable");
    return "";
  }
  if (transformed.unsupportedOmittedBranches > 0) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("unsupported-selector");
  }
  if (declarations.length === 0) {
    return "";
  }
  const cssText = serializeRule(transformed.selectorText, declarations);
  if (!cssText || !charge(state, cssText)) {
    state.unsupportedRuleCount += 1;
    state.diagnostics.add("declaration-unavailable");
    return "";
  }
  return cssText;
}

function isCssNestedDeclarations(
  rule: object,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  try {
    const style = intrinsics.read(rule, "nestedDeclarations.style");
    if (!isObject(style)) return false;
    try {
      return typeof intrinsics.read(rule, "styleRule.selectorText") !== "string";
    } catch {
      return true;
    }
  } catch {
    if (!STRUCTURAL_TEST_MODE) return false;
    try {
      return (rule as { readonly constructor?: { readonly name?: unknown } })
        .constructor?.name === "CSSNestedDeclarations";
    } catch {
      return false;
    }
  }
}

function snapshotDeclarations(
  style: object,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
  state: CaptureState,
): readonly CapturedDeclaration[] | undefined {
  if (state.declarationReadBudget.truncated) return undefined;
  let length: number;
  try {
    length = state.intrinsics.read(style, "declaration.length") as number;
  } catch {
    return undefined;
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > PREVIEW_MAX_DECLARATIONS) {
    return undefined;
  }
  const declarations: CapturedDeclaration[] = [];
  for (let index = 0; index < length; index += 1) {
    try {
      const property = state.intrinsics.call(
        style,
        "declaration.item",
        [index],
      );
      if (
        typeof property !== "string" ||
        !chargeDeclarationRead(state, property) ||
        !validProperty(property)
      ) return undefined;
      const rawValue = state.intrinsics.call(
        style,
        "declaration.getPropertyValue",
        [property],
      );
      if (
        typeof rawValue !== "string" ||
        !chargeDeclarationRead(state, rawValue)
      ) return undefined;
      const priority = state.intrinsics.call(
        style,
        "declaration.getPropertyPriority",
        [property],
      );
      if (
        typeof priority !== "string" ||
        !chargeDeclarationRead(state, priority) ||
        (priority !== "" && priority !== "important")
      ) {
        return undefined;
      }
      const value = rebaseCssUrls(
        rawValue,
        sourceUrl,
        allowUnrebasedRelativeUrls,
      );
      if (value === undefined) return undefined;
      declarations.push(Object.freeze({
        property,
        value,
        important: priority === "important",
      }));
    } catch {
      return undefined;
    }
  }
  return Object.freeze(declarations);
}

function chargeDeclarationRead(state: CaptureState, value: string): boolean {
  const budget = state.declarationReadBudget;
  const remaining = Math.min(
    PREVIEW_MAX_BYTES - budget.bytes,
    PREVIEW_MAX_BYTES * PREVIEW_MAX_CAPTURE_PASSES - budget.total.bytes,
  );
  if (remaining < 0 || value.length > remaining) {
    budget.truncated = true;
    state.diagnostics.add("stylesheet-truncated");
    return false;
  }
  const bytes = utf8ByteLength(value);
  if (bytes > remaining) {
    budget.truncated = true;
    state.diagnostics.add("stylesheet-truncated");
    return false;
  }
  budget.bytes += bytes;
  budget.total.bytes += bytes;
  return true;
}

function serializeRule(
  selector: string,
  declarations: readonly CapturedDeclaration[],
): string | undefined {
  let cssText = `${selector}{`;
  let bytes = utf8ByteLength(cssText) + 1;
  if (bytes > PREVIEW_MAX_BYTES) return undefined;
  for (const { property, value, important } of declarations) {
    const priority = important ? " !important" : "";
    const codeUnits = property.length + value.length + priority.length + 2;
    if (codeUnits > PREVIEW_MAX_BYTES - cssText.length - 1) return undefined;
    const serialized = `${property}:${value}${priority};`;
    const serializedBytes = utf8ByteLength(serialized);
    if (serializedBytes > PREVIEW_MAX_BYTES - bytes) return undefined;
    cssText += serialized;
    bytes += serializedBytes;
  }
  cssText += "}";
  try {
    const parsed = postcss.parse(cssText, { from: undefined });
    const rule = parsed.nodes[0];
    if (parsed.nodes.length !== 1 || rule?.type !== "rule" || rule.selector !== selector) {
      return undefined;
    }
    const parsedDeclarations = rule.nodes?.filter(({ type }) => type !== "comment") ?? [];
    if (parsedDeclarations.length !== declarations.length) return undefined;
    for (let index = 0; index < declarations.length; index += 1) {
      const parsedDeclaration = parsedDeclarations[index];
      const expected = declarations[index]!;
      if (
        parsedDeclaration?.type !== "decl" ||
        parsedDeclaration.prop !== expected.property ||
        parsedDeclaration.value !== expected.value ||
        Boolean(parsedDeclaration.important) !== expected.important
      ) return undefined;
    }
    return cssText;
  } catch {
    return undefined;
  }
}

function rebaseCssUrls(
  value: string,
  sourceUrl: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
): string | undefined {
  if (value.length > INSPECT_LIMITS.valueLength) return undefined;
  let parsed: ReturnType<typeof valueParser>;
  try {
    parsed = valueParser(value);
    parsed.walk((node) => {
      if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
      rebaseUrlFunction(
        node,
        sourceUrl && isHttpUrl(sourceUrl) ? sourceUrl : undefined,
        allowUnrebasedRelativeUrls,
      );
    });
    const output = parsed.toString();
    return output.length <= INSPECT_LIMITS.valueLength ? output : undefined;
  } catch {
    return undefined;
  }
}

function rebaseUrlFunction(
  node: Extract<ValueNode, { readonly type: "function" }>,
  base: string | undefined,
  allowUnrebasedRelativeUrls: boolean,
): void {
  const meaningful = node.nodes.filter(({ type }) => type !== "space" && type !== "comment");
  if (meaningful.length !== 1) throw new Error("unsupported url token");
  const valueNode = meaningful[0]!;
  if (valueNode.type !== "word" && valueNode.type !== "string") {
    throw new Error("unsupported url token");
  }
  const raw = valueNode.value.trim();
  if (/[\\\u0000-\u001f\u007f]/u.test(raw)) {
    throw new Error("ambiguous URL token");
  }
  if (
    raw.length === 0 ||
    raw.startsWith("#") ||
    /^(?:[a-z][a-z0-9+.-]*):/iu.test(raw)
  ) return;
  if (!base) {
    if (allowUnrebasedRelativeUrls) return;
    throw new Error("relative URL base unavailable");
  }
  const resolved = new URL(raw, base);
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
    throw new Error("unsupported rebased URL");
  }
  valueNode.value = resolved.href;
}

function mountedStylesheetMatches(
  sheet: CSSStyleSheet,
  expectedCssText: string,
  expectedRuleCount: number,
  intrinsics: BrowserIntrinsicAccess = DEFAULT_BROWSER_INTRINSICS,
  normalizeCssText: CssTextNormalizer = noNormalization,
): boolean {
  if (
    !Number.isSafeInteger(expectedRuleCount) ||
    expectedRuleCount <= 0 ||
    expectedRuleCount > PREVIEW_MAX_RULES ||
    utf8ByteLength(expectedCssText) > PREVIEW_MAX_BYTES
  ) {
    return false;
  }
  try {
    const rules = intrinsics.read(sheet, "stylesheet.cssRules");
    if (!isObject(rules)) return false;
    const count = countMountedRules(
      rules as ArrayLike<object>,
      0,
      { remaining: PREVIEW_MAX_RULES },
      intrinsics,
    );
    if (count !== expectedRuleCount) return false;
    const committedCssText = readMountedCssText(
      rules as ArrayLike<object>,
      intrinsics,
    );
    if (committedCssText === undefined) return false;
    const committedSignature = canonicalCssSignature(committedCssText);
    if (committedSignature === undefined) return false;
    const expectedSignature = canonicalCssSignature(expectedCssText);
    if (expectedSignature === undefined) return false;
    if (expectedSignature === committedSignature) return true;
    // The engine echoes what it parsed, not what it was handed: the longhands
    // the CSSOM enumerates for a shorthand come back as that shorthand. Reading
    // that as tampering drops the whole mirror, and with it every previewed
    // rule of the sheet, so the expectation is put through the same parser and
    // the two serializations are compared instead.
    const normalized = normalizeCssText(expectedCssText);
    if (normalized === undefined) return false;
    const normalizedSignature = canonicalCssSignature(normalized);
    return normalizedSignature !== undefined &&
      normalizedSignature === committedSignature;
  } catch {
    return false;
  }
}

type CssTextNormalizer = (cssText: string) => string | undefined;

const noNormalization: CssTextNormalizer = () => undefined;

/**
 * Reads back what the page's own CSS parser makes of a mirror's text. The sheet
 * is constructed, never adopted and never handed to the page, so this is a pure
 * serialization question: it changes nothing the page can observe.
 */
function createCssTextNormalizer(
  createStylesheet: (() => CSSStyleSheet | undefined) | undefined,
  intrinsics: BrowserIntrinsicAccess,
): CssTextNormalizer {
  if (!createStylesheet) return noNormalization;
  return (cssText) => {
    try {
      if (utf8ByteLength(cssText) > PREVIEW_MAX_BYTES) return undefined;
      const sheet = createStylesheet();
      if (!isObject(sheet)) return undefined;
      intrinsics.call(sheet, "stylesheet.replaceSync", [cssText]);
      const rules = intrinsics.read(sheet, "stylesheet.cssRules");
      if (!isObject(rules)) return undefined;
      return readMountedCssText(rules as ArrayLike<object>, intrinsics);
    } catch {
      return undefined;
    }
  };
}

function readMountedCssText(
  rules: ArrayLike<object>,
  intrinsics: BrowserIntrinsicAccess,
): string | undefined {
  const length = intrinsics.read(rules, "ruleList.length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > PREVIEW_MAX_RULES
  ) {
    return undefined;
  }
  let cssText = "";
  let bytes = 0;
  for (let index = 0; index < length; index += 1) {
    const rule = intrinsics.call(rules, "ruleList.item", [index]);
    if (!isObject(rule)) return undefined;
    const serialized = intrinsics.read(rule, "rule.cssText");
    if (typeof serialized !== "string") return undefined;
    if (serialized.length > PREVIEW_MAX_BYTES - cssText.length) return undefined;
    const serializedBytes = utf8ByteLength(serialized);
    if (serializedBytes > PREVIEW_MAX_BYTES - bytes) return undefined;
    cssText += serialized;
    bytes += serializedBytes;
  }
  return cssText;
}

function canonicalCssSignature(cssText: string): string | undefined {
  try {
    if (utf8ByteLength(cssText) > PREVIEW_MAX_BYTES) return undefined;
    const parsed = postcss.parse(cssText);
    const budget = { remaining: PREVIEW_MAX_RULES + PREVIEW_MAX_DECLARATIONS };
    const nodes = parsed.nodes.map((node) => canonicalCssNode(node, budget));
    if (nodes.some((node) => node === undefined)) return undefined;
    return JSON.stringify(nodes);
  } catch {
    return undefined;
  }
}

function canonicalCssNode(
  node: ChildNode,
  budget: { remaining: number },
): readonly unknown[] | undefined {
  budget.remaining -= 1;
  if (budget.remaining < 0) return undefined;
  if (node.type === "decl") {
    return Object.freeze([
      "decl",
      node.prop.startsWith("--") ? node.prop : node.prop.toLowerCase(),
      canonicalCssValue(node.value),
      node.important,
    ]);
  }
  if (node.type === "rule") {
    const selector = selectorParser().processSync(node.selector, { lossless: false });
    const children = node.nodes.map((child) => canonicalCssNode(child, budget));
    if (children.some((child) => child === undefined)) return undefined;
    return Object.freeze(["rule", selector, Object.freeze(children)]);
  }
  if (node.type === "atrule" && node.nodes) {
    const name = node.name.toLowerCase();
    if (name !== "media" && name !== "supports") return undefined;
    const children = node.nodes.map((child) => canonicalCssNode(child, budget));
    if (children.some((child) => child === undefined)) return undefined;
    return Object.freeze([
      "at-rule",
      name,
      normalizeCondition(node.params),
      Object.freeze(children),
    ]);
  }
  return undefined;
}

function canonicalCssValue(value: string): string {
  return JSON.stringify(canonicalCssValueNodes(valueParser(value).nodes));
}

function canonicalCssValueNodes(nodes: readonly ValueNode[]): readonly unknown[] {
  return nodes.map((node) => {
    if (node.type === "function") {
      if (node.value.toLowerCase() === "url") {
        const meaningful = node.nodes.filter(({ type }) => (
          type !== "space" && type !== "comment"
        ));
        const valueNode = meaningful[0];
        if (
          meaningful.length !== 1 ||
          (valueNode?.type !== "word" && valueNode?.type !== "string")
        ) throw new Error("unsupported committed URL");
        return ["url", valueNode.value];
      }
      return ["function", node.value, canonicalCssValueNodes(node.nodes)];
    }
    if (node.type === "space") return ["space"];
    if (node.type === "comment") return ["comment"];
    return [node.type, node.value];
  });
}

function normalizeCondition(value: string): string {
  return value.trim().replace(/\s+/gu, " ").replace(/\s*([():,])\s*/gu, "$1");
}

function countMountedRules(
  rules: ArrayLike<object>,
  depth: number,
  budget: { remaining: number },
  intrinsics: BrowserIntrinsicAccess,
): number | undefined {
  if (depth > PREVIEW_MAX_DEPTH) return undefined;
  const length = intrinsics.read(rules, "ruleList.length");
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > budget.remaining
  ) {
    return undefined;
  }
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    const rule = intrinsics.call(rules, "ruleList.item", [index]);
    if (!isObject(rule)) return undefined;
    budget.remaining -= 1;
    let selector: unknown;
    let style: unknown;
    try {
      selector = intrinsics.read(rule, "styleRule.selectorText");
      style = intrinsics.read(rule, "styleRule.style");
    } catch {
      selector = undefined;
      style = undefined;
    }
    if (typeof selector === "string" && isObject(style)) {
      count += 1;
      continue;
    }
    let nested: unknown;
    try {
      nested = intrinsics.read(rule, "styleRule.cssRules");
    } catch {
      return undefined;
    }
    if (!isObject(nested)) return undefined;
    const childCount = countMountedRules(
      nested as ArrayLike<object>,
      depth + 1,
      budget,
      intrinsics,
    );
    if (childCount === undefined) return undefined;
    count += childCount;
  }
  return count;
}

function isFreshDetachedStyleNode(
  candidate: HTMLStyleElement,
  document: Document,
  mount: PreparedMount,
  artifacts: PinOpRuntimeArtifacts,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  if (
    !isObject(candidate) ||
    candidate === mount.origin.owner ||
    artifacts.isRuntimeNode(candidate)
  ) return false;
  try {
    if (
      intrinsics.read(candidate, "element.tagName") !== "STYLE" ||
      intrinsics.read(candidate, "node.ownerDocument") !== document ||
      intrinsics.read(candidate, "node.parentNode") !== null ||
      intrinsics.read(candidate, "node.textContent") !== "" ||
      intrinsics.call(candidate, "element.hasAttributes") !== false ||
      intrinsics.call(candidate, "node.hasChildNodes") !== false
    ) return false;
    return intrinsics.read(candidate, "style.sheet") === null;
  } catch {
    return false;
  }
}

function isCurrentAdoptedStylesheet(
  root: Document | ShadowRoot,
  candidate: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  const current = snapshotAdoptedStylesheets(root, intrinsics);
  return !current || current.includes(candidate);
}

function mountStyleNode(
  root: Document | ShadowRoot,
  mount: PreparedMount,
  artifacts: PinOpRuntimeArtifacts,
  diagnostics: Set<PseudoStatePreviewDiagnostic>,
  transactionSourceSheets: ReadonlySet<object>,
  createStyleElement: (document: Document) => HTMLStyleElement,
  normalizeCssText: CssTextNormalizer,
): MountAttempt {
  const intrinsics = mount.parts[0]?.entry.intrinsics ?? DEFAULT_BROWSER_INTRINSICS;
  let style: HTMLStyleElement | undefined;
  let mountedParent: (Node & ParentNode) | undefined;
  try {
    if (!revalidatePreparedMount(root, mount)) {
      throw new Error("stylesheet provenance changed");
    }
    const document = intrinsics.read(root, "node.nodeType") === 9
      ? root as Document
      : intrinsics.read(root, "node.ownerDocument");
    if (!isObject(document)) throw new Error("style document unavailable");
    const created = createStyleElement(document as Document);
    if (!isFreshDetachedStyleNode(
      created,
      document as Document,
      mount,
      artifacts,
      intrinsics,
    )) {
      throw new Error("style element was not fresh");
    }
    style = created;
    artifacts.registerDetachedStyleNode(style);
    if (!artifacts.markStyleNode(style)) throw new Error("style marker unavailable");
    intrinsics.call(style, "set:node.textContent", [mount.cssText]);
    if (
      intrinsics.read(style, "node.textContent") !== mount.cssText ||
      intrinsics.read(style, "style.sheet") !== null
    ) throw new Error("detached style text was not committed");
    if (!revalidatePreparedMount(root, mount)) {
      throw new Error("stylesheet provenance changed before insertion");
    }
    const owner = mount.origin.owner;
    const parent = owner && intrinsics.read(owner, "node.parentNode");
    if (mount.origin.kind !== "adopted") {
      if (!owner || !isObject(parent)) {
        throw new Error("stylesheet owner unavailable");
      }
      if (
        safeRoot(owner, intrinsics) !== root ||
        !ownerOwnsSheet(owner, mount.origin.sheet, intrinsics)
      ) throw new Error("stylesheet owner moved roots");
      intrinsics.call(parent, "node.insertBefore", [
        style,
        intrinsics.read(owner, "node.nextSibling"),
      ]);
      mountedParent = parent as Node & ParentNode;
      if (
        intrinsics.read(style, "node.parentNode") !== parent ||
        intrinsics.read(style, "node.previousSibling") !== owner ||
        safeRoot(owner, intrinsics) !== root ||
        safeRoot(style, intrinsics) !== root
      ) {
        throw new Error("style owner placement was not committed");
      }
    } else {
      const container = fallbackStyleContainer(root, intrinsics);
      if (!container) throw new Error("style fallback container unavailable");
      intrinsics.call(container, "node.appendChild", [style]);
      mountedParent = container;
      if (
        intrinsics.read(style, "node.parentNode") !== container ||
        safeRoot(style, intrinsics) !== root
      ) {
        throw new Error("style root placement was not committed");
      }
    }
    const attachedSheet = intrinsics.read(style, "style.sheet");
    if (!isObject(attachedSheet)) throw new Error("style mount rejected");
    if (
      intrinsics.read(attachedSheet, "stylesheet.ownerNode") !== style ||
      transactionSourceSheets.has(attachedSheet) ||
      isMountSourceStylesheet(mount, attachedSheet) ||
      artifacts.hasRuntimeStylesheetIdentity(attachedSheet) ||
      isCurrentAdoptedStylesheet(root, attachedSheet as CSSStyleSheet, intrinsics)
    ) throw new Error("style stylesheet was not fresh");
    if (!artifacts.registerAttachedStyleNodeStylesheet(
      style,
      attachedSheet as CSSStyleSheet,
    )) {
      throw new Error("style stylesheet identity changed");
    }
    if (
      intrinsics.read(style, "node.textContent") !== mount.cssText ||
      safeRoot(style, intrinsics) !== root ||
      !mountedStylesheetMatches(
        attachedSheet as CSSStyleSheet,
        mount.cssText,
        mount.ruleCount,
        intrinsics,
        normalizeCssText,
      ) ||
      !revalidatePreparedMount(root, mount)
    ) throw new Error("style mount was not committed");
    return Object.freeze({
      status: "mounted",
      mounted: Object.freeze({
        mount,
        kind: "style",
        sheet: attachedSheet as CSSStyleSheet,
        style,
        parent: mountedParent,
      }),
    });
  } catch {
    if (style && !artifacts.cleanupStyleNode(style)) {
      diagnostics.add("cleanup-incomplete");
    }
    diagnostics.add("style-mount-rejected");
    if (!revalidatePreparedMount(root, mount)) {
      diagnostics.add("source-provenance-changed");
      return Object.freeze({ status: "inaccessible" });
    }
    return Object.freeze({ status: "unsupported" });
  }
}

function fallbackStyleContainer(
  root: Document | ShadowRoot,
  intrinsics: BrowserIntrinsicAccess,
): (Node & ParentNode) | undefined {
  if (intrinsics.read(root, "node.nodeType") === 11) return root;
  try {
    const document = root as Document;
    for (const candidate of [
      intrinsics.read(document, "document.head"),
      intrinsics.read(document, "document.documentElement"),
    ]) {
      if (
        isObject(candidate) &&
        intrinsics.read(candidate, "node.ownerDocument") === document &&
        safeRoot(candidate as Element, intrinsics) === document
      ) return candidate as Node & ParentNode;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function selectedRoot(
  element: Element,
  resolveOpenShadowRootHost: (root: object) => Element | undefined,
  intrinsics: BrowserIntrinsicAccess,
): Document | ShadowRoot | undefined {
  try {
    const ownerDocument = intrinsics.read(element, "node.ownerDocument");
    if (!isObject(ownerDocument)) return undefined;
    const root = intrinsics.call(element, "node.getRootNode");
    if (!isObject(root)) return undefined;
    const nodeType = intrinsics.read(root, "node.nodeType");
    if (nodeType === 9) {
      return root === ownerDocument ? root as Document : undefined;
    }
    if (nodeType !== 11) return undefined;
    const shadowRoot = root as ShadowRoot;
    const host = resolveOpenShadowRootHost(root);
    return host &&
        intrinsics.read(shadowRoot, "node.ownerDocument") === ownerDocument &&
        intrinsics.read(host, "node.ownerDocument") === ownerDocument
      ? shadowRoot
      : undefined;
  } catch {
    return undefined;
  }
}

function isAdoptedSource(
  root: Document | ShadowRoot,
  source: CSSStyleSheet,
  intrinsics: BrowserIntrinsicAccess,
): boolean {
  return snapshotAdoptedStylesheets(root, intrinsics)?.includes(source) === true;
}

function snapshotAdoptedStylesheets(
  root: Document | ShadowRoot,
  intrinsics: BrowserIntrinsicAccess,
): readonly CSSStyleSheet[] | undefined {
  try {
    const adopted = intrinsics.read(root, "root.adoptedStyleSheets");
    if (!isObject(adopted)) return undefined;
    const bounded = boundedObjects(
      adopted as ArrayLike<object> | Iterable<object>,
      PREVIEW_MAX_ADOPTED_STYLESHEETS,
      PREVIEW_MAX_ADOPTED_STYLESHEETS + 1,
    );
    return bounded.status === "complete"
      ? bounded.values as readonly CSSStyleSheet[]
      : undefined;
  } catch {
    return undefined;
  }
}

function createRealmStylesheet(_root: Document | ShadowRoot): CSSStyleSheet {
  if (!EXTENSION_CSS_STYLESHEET) {
    throw new Error("constructable sheets unavailable");
  }
  return new EXTENSION_CSS_STYLESHEET();
}

function realmNormalizationStylesheet(): CSSStyleSheet | undefined {
  return EXTENSION_CSS_STYLESHEET ? new EXTENSION_CSS_STYLESHEET() : undefined;
}

function createRealmStyleElement(document: Document): HTMLStyleElement {
  if (!EXTENSION_DOCUMENT_CREATE_ELEMENT) {
    throw new Error("style creation unavailable");
  }
  const element = Reflect.apply(EXTENSION_DOCUMENT_CREATE_ELEMENT, document, ["style"]);
  if (!isObject(element)) throw new Error("style creation unavailable");
  return element as HTMLStyleElement;
}

function resolveRealmOpenShadowRootHost(root: object): Element | undefined {
  if (
    !EXTENSION_SHADOW_ROOT_HOST_GETTER ||
    !EXTENSION_SHADOW_ROOT_MODE_GETTER ||
    !EXTENSION_ELEMENT_SHADOW_ROOT_GETTER
  ) return undefined;
  try {
    const mode = Reflect.apply(EXTENSION_SHADOW_ROOT_MODE_GETTER, root, []);
    const host = Reflect.apply(EXTENSION_SHADOW_ROOT_HOST_GETTER, root, []);
    if (mode !== "open" || !isObject(host)) return undefined;
    const current = Reflect.apply(EXTENSION_ELEMENT_SHADOW_ROOT_GETTER, host, []);
    return current === root ? host as Element : undefined;
  } catch {
    return undefined;
  }
}

function supportedGroup(
  rule: object,
  intrinsics: BrowserIntrinsicAccess,
): {
  readonly kind: "media" | "supports";
  readonly condition: string;
} | undefined {
  let type: unknown;
  let condition: unknown;
  try {
    type = intrinsics.read(rule, "rule.type");
    condition = intrinsics.read(rule, "condition.conditionText");
    let structuralName = "";
    if (STRUCTURAL_TEST_MODE) {
      structuralName = (rule as { readonly constructor?: { readonly name?: unknown } })
        .constructor?.name as string ?? "";
    }
    if (structuralName === "CSSMediaRule" || type === 4) {
      return typeof condition === "string" && safeCondition(condition)
        ? Object.freeze({ kind: "media", condition })
        : undefined;
    }
    if (structuralName === "CSSSupportsRule" || type === 12) {
      return typeof condition === "string" && safeCondition(condition)
        ? Object.freeze({ kind: "supports", condition })
        : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readNestedRules(
  rule: object,
  intrinsics: BrowserIntrinsicAccess,
): NestedRulesSnapshot {
  try {
    const rules = intrinsics.read(rule, "styleRule.cssRules");
    if (rules === undefined) return Object.freeze({ status: "absent" });
    return isObject(rules)
      ? Object.freeze({
          status: "present",
          rules: rules as ArrayLike<object> | Iterable<object>,
        })
      : Object.freeze({ status: "inaccessible" });
  } catch {
    try {
      const type = intrinsics.read(rule, "rule.type");
      let structuralGroup = false;
      if (STRUCTURAL_TEST_MODE) {
        const name = (rule as { readonly constructor?: { readonly name?: unknown } })
          .constructor?.name;
        structuralGroup = name === "CSSMediaRule" || name === "CSSSupportsRule";
      }
      return type === 4 || type === 12 || structuralGroup
        ? Object.freeze({ status: "inaccessible" })
        : Object.freeze({ status: "absent" });
    } catch {
      return Object.freeze({ status: "inaccessible" });
    }
  }
}

function boundedRuleObjects(
  values: ArrayLike<object> | Iterable<object>,
  maximumObjects: number,
  maximumPulls: number,
  intrinsics: BrowserIntrinsicAccess,
): BoundedObjectsResult {
  try {
    const rawLength = intrinsics.read(values as object, "ruleList.length");
    if (rawLength === undefined && STRUCTURAL_TEST_MODE) {
      return boundedObjects(values, maximumObjects, maximumPulls);
    }
    if (
      typeof rawLength !== "number" ||
      !Number.isSafeInteger(rawLength) ||
      rawLength < 0
    ) return boundedObjectsResult([], 0, "invalid");
    if (rawLength > maximumObjects || rawLength > maximumPulls) {
      return boundedObjectsResult([], 0, "truncated");
    }
    const result: object[] = [];
    for (let index = 0; index < rawLength; index += 1) {
      const value = intrinsics.call(values as object, "ruleList.item", [index]);
      if (!isObject(value)) return boundedObjectsResult(result, index + 1, "invalid");
      result.push(value);
    }
    return boundedObjectsResult(result, rawLength, "complete");
  } catch {
    return boundedObjectsResult([], 0, "invalid");
  }
}

function boundedObjects(
  values: ArrayLike<object> | Iterable<object>,
  maximumObjects: number,
  maximumPulls: number,
): BoundedObjectsResult {
  const result: object[] = [];
  let pulls = 0;
  try {
    const rawLength = (values as { readonly length?: unknown }).length;
    if (rawLength !== undefined) {
      if (
        typeof rawLength !== "number" ||
        !Number.isSafeInteger(rawLength) ||
        rawLength < 0
      ) {
        return boundedObjectsResult(result, pulls, "invalid");
      }
      const length = rawLength;
      if (length > maximumObjects || length > maximumPulls) {
        return boundedObjectsResult(result, pulls, "truncated");
      }
      for (let index = 0; index < length; index += 1) {
        const value = (values as ArrayLike<object>)[index];
        pulls += 1;
        if (!isObject(value)) {
          return boundedObjectsResult(result, pulls, "invalid");
        }
        result.push(value);
      }
      return boundedObjectsResult(result, pulls, "complete");
    }
    const iterable = (values as Partial<Iterable<object>>)[Symbol.iterator];
    if (typeof iterable !== "function") {
      return boundedObjectsResult(result, pulls, "invalid");
    }
    const iterator = iterable.call(values) as Iterator<unknown>;
    let malformed = false;
    while (pulls < maximumPulls) {
      const next = iterator.next();
      pulls += 1;
      if (!isObject(next) || typeof next.done !== "boolean") {
        return boundedObjectsResult(result, pulls, "invalid");
      }
      if (next.done) {
        return boundedObjectsResult(
          result,
          pulls,
          malformed ? "invalid" : "complete",
        );
      }
      if (!isObject(next.value)) {
        malformed = true;
        continue;
      }
      if (result.length >= maximumObjects) {
        return boundedObjectsResult(result, pulls, "truncated");
      }
      result.push(next.value);
    }
    return boundedObjectsResult(result, pulls, "truncated");
  } catch {
    return boundedObjectsResult(result, pulls, "invalid");
  }
}

function boundedObjectsResult(
  values: readonly object[],
  pulls: number,
  status: BoundedObjectsResult["status"],
): BoundedObjectsResult {
  return Object.freeze({
    values: Object.freeze([...values]),
    pulls,
    status,
  });
}

function resolvePreviewSelector(
  selector: string,
  parent: string | undefined,
): string | undefined {
  if (!selector || selector.length > INSPECT_LIMITS.selectorLength) return undefined;
  try {
    const root = selectorParser().astSync(selector, { lossless: false });
    const nesting: selectorParser.Nesting[] = [];
    root.walkNesting((node) => {
      nesting.push(node);
    });
    if (!parent) return nesting.length === 0 ? root.toString() : undefined;
    const parentRoot = selectorParser().astSync(parent, { lossless: false });
    if (parentRoot.nodes.length === 0) return undefined;
    if (nesting.length > 0) {
      const sourceLength = root.toString().length;
      const parentText = parentRoot.toString();
      const replacementLength = parentText.length + 5;
      const remaining = INSPECT_LIMITS.selectorLength - sourceLength;
      if (
        remaining < 0 ||
        replacementLength <= 0 ||
        nesting.length > Math.floor(remaining / replacementLength)
      ) return undefined;
      for (const node of nesting) {
        node.replaceWith(selectorParser.pseudo({
          value: ":is",
          nodes: parentRoot.nodes.map((branch) => branch.clone()),
        }));
      }
      const resolved = root.toString();
      return resolved.length <= INSPECT_LIMITS.selectorLength ? resolved : undefined;
    }
    if (root.nodes.length !== 1) return undefined;
    const resolved = `:is(${parentRoot.toString()}) ${root.toString()}`;
    return resolved.length <= INSPECT_LIMITS.selectorLength ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function safeRoot(
  node: Element,
  intrinsics: BrowserIntrinsicAccess = DEFAULT_BROWSER_INTRINSICS,
): Node | undefined {
  try {
    const root = intrinsics.call(node, "node.getRootNode");
    return isObject(root) ? root as Node : undefined;
  } catch {
    return undefined;
  }
}

function safeCondition(condition: string): boolean {
  return condition.length > 0 &&
    condition.length <= INSPECT_LIMITS.valueLength &&
    !/[{};]/u.test(condition);
}

function safeGroupText(
  cssText: string,
  kind: "media" | "supports",
  condition: string,
): boolean {
  try {
    const parsed = postcss.parse(cssText, { from: undefined });
    const node = parsed.nodes[0];
    return parsed.nodes.length === 1 &&
      node?.type === "atrule" &&
      node.name.toLowerCase() === kind &&
      node.params === condition;
  } catch {
    return false;
  }
}

function validProperty(property: unknown): property is string {
  return typeof property === "string" &&
    property.length > 0 &&
    property.length <= INSPECT_LIMITS.propertyNameLength &&
    /^(?:--[\w-]+|-?[a-z][a-z0-9-]*)$/iu.test(property);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function charge(state: CaptureState, value: string): boolean {
  const bytes = utf8ByteLength(value);
  if (state.bytes + bytes > PREVIEW_MAX_BYTES) return false;
  state.bytes += bytes;
  return true;
}

function canonicalStates(states: readonly PseudoState[]): readonly PseudoState[] | undefined {
  try {
    if (!Array.isArray(states)) return undefined;
    const length = states.length;
    if (!Number.isSafeInteger(length) || length < 0 || length > 2) return undefined;
    const values = new Set<PseudoState>();
    for (let index = 0; index < length; index += 1) {
      const state = states[index];
      if (state !== "hover" && state !== "focus") return undefined;
      values.add(state);
    }
    return Object.freeze([
      ...(values.has("hover") ? ["hover" as const] : []),
      ...(values.has("focus") ? ["focus" as const] : []),
    ]);
  } catch {
    return undefined;
  }
}

function result(
  states: readonly PseudoState[],
  mountedRuleCount: number,
  unsupportedRuleCount: number,
  inaccessibleStylesheetCount: number,
  approximateRuleCount: number,
  diagnostics: ReadonlySet<PseudoStatePreviewDiagnostic>,
): PseudoStatePreviewResult {
  return Object.freeze({
    states: Object.freeze([...states]),
    mountedRuleCount,
    unsupportedRuleCount,
    inaccessibleStylesheetCount,
    approximateRuleCount,
    diagnostics: Object.freeze([...diagnostics]),
  });
}

function emptyCapture(
  complete = true,
  failure?: "inaccessible" | "unsupported",
): CapturedRules {
  return Object.freeze({
    cssText: "",
    ruleCount: 0,
    complete,
    ...(failure ? { failure } : {}),
  });
}

function failedCapture(
  cssText: string,
  ruleCount: number,
  failure: "inaccessible" | "unsupported",
): CapturedRules {
  return Object.freeze({
    cssText,
    ruleCount,
    complete: false,
    failure,
  });
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}
