import type {
  ResolutionMessage,
  SourceNavigationDirection,
  SourceNavigationStateMessage,
} from "@pin-op/protocol";
import type { PanelSourceNavigateCommand } from "./inspectPortProtocol.js";

export interface SourceNavigationViewModel {
  readonly visible: boolean;
  readonly reserveRowSpace: boolean;
  readonly disabled: boolean;
  readonly selectedMatchCount: number;
  readonly activeMatchIndex?: number;
  readonly counter: string;
}

export type SourceNavigationDispatch = (
  message: PanelSourceNavigateCommand,
) => void;

const emptyModel: SourceNavigationViewModel = Object.freeze({
  visible: false,
  reserveRowSpace: false,
  disabled: true,
  selectedMatchCount: 0,
  counter: "",
});

export class SourceNavigationController {
  private readonly listeners = new Set<() => void>();
  private inspectMessageId: string | undefined;
  private resolutionGeneration: number | undefined;
  private current = emptyModel;

  public constructor(private readonly dispatch: SourceNavigationDispatch) {}

  public beginInspect(inspectMessageId: string): void {
    if (!isOpaqueId(inspectMessageId)) {
      this.invalidate();
      return;
    }
    this.inspectMessageId = inspectMessageId;
    this.resolutionGeneration = undefined;
    this.update({
      visible: false,
      reserveRowSpace: true,
      disabled: true,
      selectedMatchCount: 0,
      counter: "",
    });
  }

  public acceptResolution(message: ResolutionMessage): void {
    if (
      message.inspectMessageId !== this.inspectMessageId ||
      !isGeneration(message.resolutionGeneration) ||
      (this.resolutionGeneration !== undefined &&
        message.resolutionGeneration <= this.resolutionGeneration) ||
      !isCount(message.selectedMatchCount)
    ) {
      return;
    }

    this.resolutionGeneration = message.resolutionGeneration;
    const visible = message.selectedMatchCount > 0;
    this.update({
      visible,
      reserveRowSpace: visible,
      disabled: true,
      selectedMatchCount: message.selectedMatchCount,
      counter: visible ? `- / ${message.selectedMatchCount}` : "",
    });
  }

  public acceptState(message: SourceNavigationStateMessage): void {
    if (
      message.inspectMessageId !== this.inspectMessageId ||
      message.resolutionGeneration !== this.resolutionGeneration ||
      message.selectedMatchCount !== this.current.selectedMatchCount ||
      !isValidActiveIndex(
        message.activeMatchIndex,
        message.selectedMatchCount,
      )
    ) {
      return;
    }

    const visible = message.selectedMatchCount > 0;
    this.update({
      visible,
      reserveRowSpace: visible,
      disabled: !visible,
      selectedMatchCount: message.selectedMatchCount,
      ...(message.activeMatchIndex === undefined
        ? {}
        : { activeMatchIndex: message.activeMatchIndex }),
      counter: visible
        ? `${message.activeMatchIndex === undefined
            ? "-"
            : message.activeMatchIndex + 1} / ${message.selectedMatchCount}`
        : "",
    });
  }

  public navigate(direction: SourceNavigationDirection): void {
    if (
      this.current.disabled ||
      !this.inspectMessageId ||
      this.resolutionGeneration === undefined
    ) {
      return;
    }
    this.dispatch({
      type: "pinop.source.navigate",
      inspectMessageId: this.inspectMessageId,
      resolutionGeneration: this.resolutionGeneration,
      direction,
    });
  }

  public invalidate(): void {
    this.inspectMessageId = undefined;
    this.resolutionGeneration = undefined;
    this.update(emptyModel);
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public snapshot(): SourceNavigationViewModel {
    return this.current;
  }

  private update(model: SourceNavigationViewModel): void {
    this.current = Object.is(model, emptyModel)
      ? emptyModel
      : Object.freeze({ ...model });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // One view cannot prevent the other subscribed surface from updating.
      }
    }
  }
}

function isOpaqueId(value: string): boolean {
  return value.length > 0 && value.length <= 128;
}

function isGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidActiveIndex(
  activeMatchIndex: number | undefined,
  selectedMatchCount: number,
): boolean {
  return (
    isCount(selectedMatchCount) &&
    (activeMatchIndex === undefined || (
      Number.isSafeInteger(activeMatchIndex) &&
      activeMatchIndex >= 0 &&
      activeMatchIndex < selectedMatchCount
    ))
  );
}
