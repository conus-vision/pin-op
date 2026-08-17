import type { PresentationSettingsMessage } from "@pin-op/protocol";
import type { TextDocumentLike } from "../sourcePlugins/sourceDocument.js";
import type { SourceResolution } from "../sourcePlugins/types.js";
import type {
  DisposableLike,
  SourceDecorationEditorLike,
} from "./decorations.js";

export interface HighlightEditor extends SourceDecorationEditorLike {
  readonly documentUri: string;
  readonly document: TextDocumentLike;
}

export interface HighlightDecorationManager extends DisposableLike {
  update(editor: SourceDecorationEditorLike, resolution: SourceResolution): void;
  clear(): void;
}

interface RetainedHighlight {
  readonly editor: HighlightEditor;
  readonly resolution: SourceResolution;
}

export class HighlightController implements DisposableLike {
  private inspectMessageId: string | undefined;
  private retained: RetainedHighlight | undefined;
  private enabled = true;
  private disposed = false;

  public constructor(
    private readonly decorations: HighlightDecorationManager,
  ) {}

  public beginInspect(
    inspectMessageId: string,
    ideHighlightEnabled = true,
  ): void {
    if (this.disposed) return;
    this.inspectMessageId = inspectMessageId;
    this.enabled = ideHighlightEnabled;
    this.retained = undefined;
    this.decorations.clear();
  }

  public update(editor: HighlightEditor, resolution: SourceResolution): void {
    if (
      this.disposed ||
      resolution.selectionMessageId !== this.inspectMessageId
    ) {
      return;
    }
    if (!isStillValid(editor, resolution)) {
      this.clear();
      return;
    }

    this.retained = { editor, resolution };
    if (this.enabled) {
      this.decorations.update(editor, resolution);
    } else {
      this.decorations.clear();
    }
  }

  public applySettings(message: PresentationSettingsMessage): boolean {
    if (
      this.disposed ||
      message.inspectMessageId !== this.inspectMessageId
    ) {
      return false;
    }

    this.enabled = message.ideHighlightEnabled;
    if (!this.enabled) {
      this.decorations.clear();
      return true;
    }

    const retained = this.retained;
    if (!retained) {
      this.decorations.clear();
      return true;
    }
    if (!isStillValid(retained.editor, retained.resolution)) {
      this.retained = undefined;
      this.decorations.clear();
      return true;
    }
    this.decorations.update(retained.editor, retained.resolution);
    return true;
  }

  public clear(): void {
    if (this.disposed) return;
    this.retained = undefined;
    this.decorations.clear();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.inspectMessageId = undefined;
    this.retained = undefined;
    this.decorations.dispose();
  }
}

function isStillValid(
  editor: HighlightEditor,
  resolution: SourceResolution,
): boolean {
  return editor.documentUri === resolution.documentUri &&
    editor.document.uri.toString() === resolution.documentUri &&
    editor.document.version === resolution.documentVersion;
}
