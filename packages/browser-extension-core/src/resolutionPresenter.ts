import type {
  ResolutionDiagnosticCode,
  ResolutionMessage,
  ResolutionStatus,
} from "@browser2ide/protocol";

export type ResolutionPresentationKind =
  | "idle"
  | "resolving"
  | "ide-disconnected"
  | ResolutionStatus;

export type ResolutionTone = "neutral" | "success" | "warning" | "error";

export interface ResolutionViewModel {
  readonly kind: ResolutionPresentationKind;
  readonly statusText: string;
  readonly detailText?: string;
  readonly selectedElement?: string;
  readonly tone: ResolutionTone;
  readonly inspectMessageId?: string;
  readonly generation?: number;
}

export interface ResolvingPresentation {
  readonly status: "resolving";
}

export interface IdeDisconnectedPresentation {
  readonly status: "ide-disconnected";
  readonly inspectMessageId?: string;
}

export type ResolutionPresentation =
  | ResolutionMessage
  | ResolvingPresentation
  | IdeDisconnectedPresentation;

const idleModel: ResolutionViewModel = Object.freeze({
  kind: "idle",
  statusText: "Select an element to inspect",
  tone: "neutral",
});

const statusText: Readonly<Record<Exclude<ResolutionStatus, "matched" | "error">, string>> = {
  "no-active-editor": "No active editor",
  "unsupported-document": "Unsupported active file",
  "no-facts": "No CSS facts",
  "source-not-found": "CSS source not found in workspace",
  "source-not-active-document":
    "Stylesheet resolves to a different workspace file",
  "source-ambiguous": "Ambiguous source path",
  "source-map-missing": "SCSS source map missing",
  "source-map-invalid": "SCSS source map invalid",
  "no-rule-match": "No matching rules in active file",
  "rule-match-ambiguous": "Ambiguous rule match",
};

const diagnosticPriority = [
  "resolver.plugin-error",
  "resolver.plugin-timeout",
  "resolver.invalid-result",
  "resolver.source-read-failed",
] as const satisfies readonly ResolutionDiagnosticCode[];

export function presentResolution(
  presentation: ResolutionPresentation,
): ResolutionViewModel {
  if (presentation.status === "resolving") {
    return {
      kind: "resolving",
      statusText: "Resolving in VS Code",
      tone: "neutral",
    };
  }
  if (presentation.status === "ide-disconnected") {
    return {
      kind: "ide-disconnected",
      statusText: "VS Code disconnected",
      tone: "warning",
      inspectMessageId: presentation.inspectMessageId,
    };
  }

  const message = presentation;
  const details = resolutionDetails(message);
  return {
    kind: message.status,
    statusText: resolutionStatusText(message),
    detailText: details.length > 0 ? details.join(" · ") : undefined,
    tone: resolutionTone(message.status),
    inspectMessageId: message.inspectMessageId,
    generation: message.resolutionGeneration,
  };
}

export function formatResolutionFooter(
  presentation: ResolutionPresentation,
): string {
  const model = presentResolution(presentation);
  return model.detailText
    ? `${model.statusText} · ${model.detailText}`
    : model.statusText;
}

export class ResolutionPresenter {
  private selectedElement: string | undefined;
  private inspectMessageId: string | undefined;
  private generation = -1;
  private current: ResolutionViewModel = idleModel;

  public updateSelectedElement(selectedElement: string): ResolutionViewModel {
    this.selectedElement = normalizeSelectedElement(selectedElement) || undefined;
    this.current = this.withSelection(withoutSelection(this.current));
    return this.current;
  }

  public beginCorrelatedInspect(
    inspectMessageId: string,
  ): ResolutionViewModel | undefined {
    if (!isOpaqueId(inspectMessageId)) {
      return undefined;
    }
    this.inspectMessageId = inspectMessageId;
    this.generation = -1;
    this.current = this.withSelection({
      ...presentResolution({ status: "resolving" }),
      inspectMessageId,
    });
    return this.current;
  }

  public restartResolution(): ResolutionViewModel {
    if (!this.selectedElement) {
      return this.reset();
    }
    return this.beginResolving();
  }

  public ideDisconnected(
    inspectMessageId?: string,
  ): ResolutionViewModel | undefined {
    if (inspectMessageId && inspectMessageId !== this.inspectMessageId) {
      return undefined;
    }
    this.current = this.withSelection(
      presentResolution({ status: "ide-disconnected", inspectMessageId }),
    );
    return this.current;
  }

  public acceptResolution(
    message: ResolutionMessage,
  ): ResolutionViewModel | undefined {
    if (
      this.inspectMessageId !== message.inspectMessageId ||
      message.resolutionGeneration <= this.generation
    ) {
      return undefined;
    }

    this.generation = message.resolutionGeneration;
    this.current = this.withSelection(presentResolution(message));
    return this.current;
  }

  public reset(): ResolutionViewModel {
    this.selectedElement = undefined;
    this.inspectMessageId = undefined;
    this.generation = -1;
    this.current = idleModel;
    return this.current;
  }

  public snapshot(): ResolutionViewModel {
    return this.current;
  }

  private beginResolving(): ResolutionViewModel {
    this.inspectMessageId = undefined;
    this.generation = -1;
    this.current = this.withSelection(
      presentResolution({ status: "resolving" }),
    );
    return this.current;
  }

  private withSelection(model: ResolutionViewModel): ResolutionViewModel {
    return this.selectedElement
      ? { ...model, selectedElement: this.selectedElement }
      : model;
  }
}

function resolutionStatusText(message: ResolutionMessage): string {
  if (message.status === "matched") {
    const total = message.selectedMatchCount + message.parentMatchCount;
    return `${total} ${plural(total, "rule", "rules")} highlighted`;
  }
  if (message.status === "error") {
    const diagnostic = diagnosticPriority.find((code) =>
      message.diagnosticCodes.includes(code),
    ) ?? "resolver.invalid-result";
    return `Resolution failed (${diagnostic})`;
  }
  if (
    message.status === "unsupported-document" &&
    message.document?.languageId
  ) {
    return `${statusText[message.status]}: ${message.document.languageId}`;
  }
  return statusText[message.status];
}

function resolutionDetails(message: ResolutionMessage): string[] {
  const details: string[] = [];
  if (message.status === "matched") {
    details.push(`Selected ${message.selectedMatchCount}`);
    details.push(`Parent ${message.parentMatchCount}`);
  }
  if (message.inaccessibleStylesheetCount > 0) {
    const count = message.inaccessibleStylesheetCount;
    details.push(
      `${count} ${plural(count, "inaccessible stylesheet", "inaccessible stylesheets")}`,
    );
  }
  return details;
}

function resolutionTone(status: ResolutionStatus): ResolutionTone {
  if (status === "matched") {
    return "success";
  }
  if (status === "error") {
    return "error";
  }
  return "warning";
}

function normalizeSelectedElement(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 512);
}

function withoutSelection(model: ResolutionViewModel): ResolutionViewModel {
  const { selectedElement: _selectedElement, ...rest } = model;
  return rest;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm;
}
