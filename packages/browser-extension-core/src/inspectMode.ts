import type { MatchableElement } from "./collectCssFacts.js";
import type { ElementSnapshotSource } from "./elementSnapshot.js";

export type InspectableElement = ElementSnapshotSource & MatchableElement & {
  readonly parentElement: InspectableElement | null;
};

export interface InspectClickEvent {
  readonly type?: string;
  readonly target?: unknown;
  readonly isTrusted?: boolean;
  readonly button?: number;
  readonly isPrimary?: boolean;
  readonly key?: string;
  readonly pointerId?: number;
  readonly pointerType?: string;
  readonly repeat?: boolean;
  composedPath?(): readonly unknown[];
  preventDefault(): void;
  stopPropagation(): void;
  stopImmediatePropagation(): void;
}

export type InspectEventType =
  | "keydown"
  | "pointermove"
  | "pointerdown"
  | "pointercancel"
  | "mousedown"
  | "pointerup"
  | "mouseup"
  | "click"
  | "dblclick"
  | "auxclick"
  | "contextmenu"
  | "touchstart"
  | "touchend";

const SUPPRESSED_EVENT_TYPES: readonly InspectEventType[] = Object.freeze([
  "pointerdown",
  "mousedown",
  "pointerup",
  "mouseup",
  "click",
  "dblclick",
  "auxclick",
  "contextmenu",
  "touchstart",
  "touchend",
]);

const CAPTURED_EVENT_TYPES: readonly InspectEventType[] = Object.freeze([
  "keydown",
  "pointermove",
  "pointercancel",
  ...SUPPRESSED_EVENT_TYPES,
]);

export type InspectListenerOptions =
  | boolean
  | {
      readonly capture: boolean;
      readonly passive?: boolean;
    };

const CAPTURE_OPTIONS = true;
const NON_PASSIVE_CAPTURE_OPTIONS: InspectListenerOptions = Object.freeze({
  capture: true,
  passive: false,
});

export interface InspectDocument {
  addEventListener(
    type: InspectEventType,
    listener: (event: InspectClickEvent) => void,
    options: InspectListenerOptions,
  ): void;
  removeEventListener(
    type: InspectEventType,
    listener: (event: InspectClickEvent) => void,
    options: InspectListenerOptions,
  ): void;
}

export interface InspectModeOptions {
  readonly document: InspectDocument;
  readonly onSelect: (element: InspectableElement) => void | Promise<void>;
  readonly onClearHover?: () => void;
  readonly onEscape?: () => void;
  readonly onHover?: (element: InspectableElement) => void;
  readonly isOverlayNode?: (node: object) => boolean;
  readonly onError?: (error: unknown) => void;
}

interface InspectDocumentRegistration {
  readonly cell: InspectListenerCell;
  readonly listener: (event: InspectClickEvent) => void;
  interaction: PrimaryInteraction | undefined;
  pointerStreamActive: boolean;
  touchStreamActive: boolean;
  active: boolean;
}

interface InspectListenerCell {
  handle?: (event: InspectClickEvent) => void;
}

type PrimaryInteraction =
  | {
      readonly kind: "pointer";
      readonly element: InspectableElement;
      readonly phase: "down" | "up";
      readonly pointerId: number | undefined;
      readonly pointerType: string | undefined;
    }
  | {
      readonly kind: "mouse" | "touch";
      readonly element: InspectableElement;
      readonly phase: "down" | "up";
    }
  | {
      readonly kind: "dedupe";
      readonly element: InspectableElement;
    };

interface ActivationProperties {
  readonly button: number | undefined;
  readonly isPrimary: boolean | undefined;
  readonly pointerId: number | undefined;
  readonly pointerType: string | undefined;
  readonly trusted: boolean;
}

export class InspectMode {
  private enabled = false;
  private disposed = false;
  private authorityRevision = 0;
  private readonly documents = new Set<InspectDocument>();
  private readonly registrations = new Map<
    InspectDocument,
    InspectDocumentRegistration
  >();
  private readonly handleEvent = (
    event: InspectClickEvent,
    registration: InspectDocumentRegistration,
    isAuthoritative: () => boolean,
  ): void => {
    let type: string | undefined;
    try {
      type = event.type;
    } catch {
      clearRegistrationInteraction(registration);
      return;
    }
    if (!isAuthoritative()) {
      return;
    }
    if (type === "keydown") {
      let isEscape = false;
      try {
        isEscape = (
          event.isTrusted === true &&
          event.key === "Escape" &&
          event.repeat !== true
        );
      } catch {
        clearRegistrationInteraction(registration);
        return;
      }
      if (!isAuthoritative() || !isEscape) {
        return;
      }
      if (!suppressEvent(event, isAuthoritative)) {
        return;
      }
      try {
        this.options.onEscape?.();
      } catch (error) {
        this.reportError(error);
      }
      return;
    }
    if (type === "pointercancel") {
      clearRegistrationInteraction(registration);
      return;
    }
    if (type === "pointermove") {
      let trusted = false;
      try {
        trusted = event.isTrusted === true;
      } catch {
        clearRegistrationInteraction(registration);
        return;
      }
      if (!isAuthoritative() || !trusted) {
        return;
      }
      const target = resolveInspectableElement(
        event,
        this.options.isOverlayNode,
        isAuthoritative,
      );
      if (!isAuthoritative()) {
        return;
      }
      if (target) {
        try {
          this.options.onHover?.(target);
        } catch (error) {
          this.reportError(error);
        }
      } else {
        try {
          this.options.onClearHover?.();
        } catch (error) {
          this.reportError(error);
        }
      }
      return;
    }
    if (!suppressEvent(event, isAuthoritative)) {
      clearRegistrationInteraction(registration);
      return;
    }
    let activation: ActivationProperties;
    try {
      activation = {
        button: event.button,
        isPrimary: event.isPrimary,
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        trusted: event.isTrusted === true,
      };
    } catch {
      clearRegistrationInteraction(registration);
      return;
    }
    if (!isAuthoritative() || !activation.trusted) {
      clearRegistrationInteraction(registration);
      return;
    }
    const target = resolveInspectableElement(
      event,
      this.options.isOverlayNode,
      isAuthoritative,
    );
    if (!isAuthoritative()) {
      return;
    }
    const selected = this.advancePrimaryInteraction(
      registration,
      type,
      target,
      activation,
    );
    if (selected) {
      try {
        void Promise.resolve(this.options.onSelect(selected)).catch((error) =>
          this.reportError(error),
        );
      } catch (error) {
        this.reportError(error);
      }
    }
  };

  public constructor(private readonly options: InspectModeOptions) {
    this.documents.add(options.document);
  }

  public addDocument(document: InspectDocument): void {
    if (this.disposed) {
      return;
    }
    if (!this.documents.has(document)) {
      this.authorityRevision += 1;
      this.documents.add(document);
    }
    if (this.enabled) {
      this.install(document);
    }
  }

  public removeDocument(document: InspectDocument): void {
    if (this.disposed || !this.documents.delete(document)) {
      return;
    }
    this.authorityRevision += 1;
    this.detach(document);
  }

  public enable(): void {
    if (this.disposed) {
      return;
    }
    if (!this.enabled) {
      this.authorityRevision += 1;
      this.enabled = true;
    }
    for (const document of this.documents) {
      this.install(document);
    }
  }

  public disable(): void {
    if (this.disposed || !this.enabled) {
      return;
    }
    this.authorityRevision += 1;
    this.enabled = false;
    for (const document of [...this.registrations.keys()]) {
      this.detach(document);
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.authorityRevision += 1;
    this.enabled = false;
    for (const document of [...this.registrations.keys()]) {
      this.detach(document);
    }
    this.documents.clear();
  }

  private install(document: InspectDocument): boolean {
    if (this.disposed || this.registrations.has(document)) {
      return this.registrations.has(document);
    }
    let registration!: InspectDocumentRegistration;
    const cell: InspectListenerCell = {};
    const listener = (event: InspectClickEvent): void => {
      cell.handle?.(event);
    };
    registration = {
      cell,
      listener,
      interaction: undefined,
      pointerStreamActive: false,
      touchStreamActive: false,
      active: true,
    };
    cell.handle = (event: InspectClickEvent): void => {
      if (
        this.disposed ||
        !this.enabled ||
        !registration.active ||
        this.registrations.get(document) !== registration
      ) {
        return;
      }
      const revision = this.authorityRevision;
      try {
        const isAuthoritative = () => (
          !this.disposed &&
          this.enabled &&
          this.authorityRevision === revision &&
          registration.active &&
          this.registrations.get(document) === registration
        );
        this.handleEvent(event, registration, isAuthoritative);
        if (!isAuthoritative()) {
          clearRegistrationInteraction(registration);
        }
      } catch (error) {
        clearRegistrationInteraction(registration);
        this.reportError(error);
      }
    };
    this.registrations.set(document, registration);
    const attempted: InspectEventType[] = [];
    try {
      for (const type of CAPTURED_EVENT_TYPES) {
        attempted.push(type);
        document.addEventListener(type, listener, listenerOptions(type));
      }
      return true;
    } catch (error) {
      registration.active = false;
      clearRegistrationInteraction(registration);
      registration.cell.handle = undefined;
      this.registrations.delete(document);
      for (const type of attempted) {
        try {
          document.removeEventListener(type, listener, listenerOptions(type));
        } catch {
          // The detached cell makes any partially installed listener inert.
        }
      }
      this.reportError(error);
      return false;
    }
  }

  private detach(document: InspectDocument): void {
    const registration = this.registrations.get(document);
    if (!registration) {
      return;
    }
    registration.active = false;
    clearRegistrationInteraction(registration);
    registration.cell.handle = undefined;
    this.registrations.delete(document);
    for (const type of CAPTURED_EVENT_TYPES) {
      try {
        document.removeEventListener(
          type,
          registration.listener,
          listenerOptions(type),
        );
      } catch {
        // The detached cell makes leaked listeners harmless.
      }
    }
  }

  private reportError(error: unknown): void {
    if (this.disposed) {
      return;
    }
    try {
      this.options.onError?.(error);
    } catch {
      // Diagnostics cannot change listener authority.
    }
  }

  private advancePrimaryInteraction(
    registration: InspectDocumentRegistration,
    type: string | undefined,
    target: InspectableElement | undefined,
    activation: ActivationProperties,
  ): InspectableElement | undefined {
    const previous = registration.interaction;
    const touchStreamWasActive = registration.touchStreamActive;
    if (type === "pointerdown" || type === "pointerup") {
      registration.pointerStreamActive = true;
    }
    if (!target) {
      registration.interaction = undefined;
      return undefined;
    }
    if (type === "pointerdown") {
      if (touchStreamWasActive) {
        registration.interaction = undefined;
        return undefined;
      }
      if (!isPrimaryButton(activation) || activation.isPrimary === false) {
        registration.interaction = undefined;
        return undefined;
      }
      registration.interaction = {
        kind: "pointer",
        element: target,
        phase: "down",
        pointerId: normalizedPointerId(activation.pointerId),
        pointerType: normalizedPointerType(activation.pointerType),
      };
      return undefined;
    }
    if (type === "pointerup") {
      if (
        !isPrimaryButton(activation) ||
        activation.isPrimary === false ||
        previous?.kind !== "pointer" ||
        previous.phase !== "down" ||
        previous.element !== target ||
        previous.pointerId !== normalizedPointerId(activation.pointerId) ||
        previous.pointerType !== normalizedPointerType(activation.pointerType)
      ) {
        registration.interaction = undefined;
        return undefined;
      }
      if (previous.pointerType === "touch") {
        registration.interaction = { kind: "dedupe", element: target };
        return target;
      }
      registration.interaction = { ...previous, phase: "up" };
      return undefined;
    }
    if (type === "mousedown") {
      if (registration.pointerStreamActive) {
        return undefined;
      }
      if (registration.touchStreamActive) {
        registration.interaction = undefined;
        return undefined;
      }
      if (!isPrimaryButton(activation)) {
        registration.interaction = undefined;
      } else if (previous?.kind !== "pointer" && previous?.kind !== "dedupe") {
        registration.interaction = {
          kind: "mouse",
          element: target,
          phase: "down",
        };
      }
      return undefined;
    }
    if (type === "mouseup") {
      if (
        registration.pointerStreamActive ||
        registration.touchStreamActive ||
        previous?.kind === "dedupe"
      ) {
        return undefined;
      }
      if (
        isPrimaryButton(activation) &&
        previous?.element === target &&
        previous.kind === "mouse" &&
        previous.phase === "down"
      ) {
        registration.interaction = {
          kind: "mouse",
          element: target,
          phase: "up",
        };
      } else {
        registration.interaction = undefined;
      }
      return undefined;
    }
    if (type === "touchstart") {
      registration.touchStreamActive = true;
      if (
        previous?.kind === "pointer" ||
        previous?.kind === "dedupe"
      ) {
        return undefined;
      }
      registration.interaction = {
        kind: "touch",
        element: target,
        phase: "down",
      };
      return undefined;
    }
    if (type === "touchend") {
      registration.touchStreamActive = false;
      if (previous?.kind === "pointer" || previous?.kind === "dedupe") {
        return undefined;
      }
      if (
        previous?.element === target &&
        previous.kind === "touch" &&
        previous.phase === "down"
      ) {
        registration.interaction = { kind: "dedupe", element: target };
        return target;
      }
      registration.interaction = undefined;
      return undefined;
    }
    registration.interaction = undefined;
    const pointerStreamActive = registration.pointerStreamActive;
    registration.pointerStreamActive = false;
    registration.touchStreamActive = false;
    if (type !== "click" || !isPrimaryButton(activation)) {
      return undefined;
    }
    if (previous?.kind === "dedupe") {
      return undefined;
    }
    if (
      previous?.element === target &&
      (
        previous.kind === "pointer" ||
        (previous.kind === "mouse" && !pointerStreamActive)
      ) &&
      previous.phase === "up"
    ) {
      return target;
    }
    return undefined;
  }
}

function clearRegistrationInteraction(
  registration: InspectDocumentRegistration,
): void {
  registration.interaction = undefined;
  registration.pointerStreamActive = false;
  registration.touchStreamActive = false;
}

function listenerOptions(type: InspectEventType): InspectListenerOptions {
  return type === "touchstart" || type === "touchend"
    ? NON_PASSIVE_CAPTURE_OPTIONS
    : CAPTURE_OPTIONS;
}

function isPrimaryButton(activation: ActivationProperties): boolean {
  return activation.button === 0;
}

function normalizedPointerId(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizedPointerType(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 32
    ? value
    : undefined;
}

function isInspectableElement(value: unknown): value is InspectableElement {
  try {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<InspectableElement>;
    return (
      typeof candidate.tagName === "string" &&
      typeof candidate.id === "string" &&
      candidate.classList !== undefined &&
      candidate.attributes !== undefined &&
      typeof candidate.matches === "function" &&
      (candidate.parentElement === null ||
        typeof candidate.parentElement === "object")
    );
  } catch {
    return false;
  }
}

function resolveInspectableElement(
  event: InspectClickEvent,
  isOverlayNode: InspectModeOptions["isOverlayNode"],
  isAuthoritative: () => boolean,
): InspectableElement | undefined {
  let path: readonly unknown[];
  try {
    if (!isAuthoritative()) {
      return undefined;
    }
    path = typeof event.composedPath === "function"
      ? event.composedPath()
      : [event.target];
  } catch {
    return undefined;
  }
  if (!isAuthoritative() || !Array.isArray(path) || path.length > 256) {
    return undefined;
  }
  for (const candidate of path) {
    if (!isAuthoritative()) {
      return undefined;
    }
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    try {
      if (isOverlayNode?.(candidate)) {
        continue;
      }
    } catch {
      return undefined;
    }
    if (!isAuthoritative()) {
      return undefined;
    }
    if (isInspectableElement(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function suppressEvent(
  event: InspectClickEvent,
  isAuthoritative: () => boolean,
): boolean {
  try {
    if (!isAuthoritative()) {
      return false;
    }
    event.preventDefault();
    if (!isAuthoritative()) {
      return false;
    }
    event.stopPropagation();
    if (!isAuthoritative()) {
      return false;
    }
    event.stopImmediatePropagation();
    return isAuthoritative();
  } catch {
    return false;
  }
}
