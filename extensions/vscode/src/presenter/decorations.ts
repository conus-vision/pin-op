import type * as vscode from "vscode";
import type { SourceRange } from "@pin-op/plugin-api";
import type { SourceResolution } from "../sourcePlugins/types.js";

export type DecorationRole = "primary" | "context";

export interface DisposableLike {
  dispose(): void;
}

export interface SourceDecorationTypeLike extends DisposableLike {
  readonly role?: DecorationRole;
}

export interface SourceDecorationEditorLike {
  readonly document: { readonly uri: { toString(): string } };
  setDecorations(
    decorationType: SourceDecorationTypeLike,
    ranges: readonly unknown[],
  ): void;
}

export interface SourceDecorationHost {
  readonly overviewRulerLaneRight: vscode.OverviewRulerLane | number;
  createThemeColor(id: string): vscode.ThemeColor;
  createDecorationType(
    options: vscode.DecorationRenderOptions,
    role: DecorationRole,
  ): SourceDecorationTypeLike;
  createRange(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ): unknown;
}

export class SourceDecorationManager implements DisposableLike {
  private readonly decorationTypes: Record<
    DecorationRole,
    SourceDecorationTypeLike
  >;
  private activeEditor: SourceDecorationEditorLike | undefined;
  private disposed = false;

  public constructor(private readonly host: SourceDecorationHost) {
    const styles = semanticStyles(host);
    this.decorationTypes = {
      primary: host.createDecorationType(styles.primary, "primary"),
      context: host.createDecorationType(styles.context, "context"),
    };
  }

  public update(
    editor: SourceDecorationEditorLike,
    resolution: SourceResolution,
  ): void {
    if (this.disposed) return;
    if (this.activeEditor && this.activeEditor !== editor) {
      this.clearEditor(this.activeEditor);
    }
    this.activeEditor = editor;
    if (editor.document.uri.toString() !== resolution.documentUri) {
      this.clearEditor(editor);
      return;
    }

    const selected = uniqueRanges(
      resolution.matches
        .filter((match) => match.targetRole === "selected")
        .map((match) => match.range),
    );
    const selectedKeys = new Set(selected.map(rangeKey));
    const parent = uniqueRanges(
      resolution.matches
        .filter(
          (match) =>
            match.targetRole === "parent" &&
            !selectedKeys.has(rangeKey(match.range)),
        )
        .map((match) => match.range),
    );

    editor.setDecorations(
      this.decorationTypes.primary,
      selected.map((range) => this.createRange(range)),
    );
    editor.setDecorations(
      this.decorationTypes.context,
      parent.map((range) => this.createRange(range)),
    );
  }

  public clear(): void {
    if (this.activeEditor) this.clearEditor(this.activeEditor);
    this.activeEditor = undefined;
  }

  public dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
    this.decorationTypes.primary.dispose();
    this.decorationTypes.context.dispose();
  }

  private clearEditor(editor: SourceDecorationEditorLike): void {
    editor.setDecorations(this.decorationTypes.primary, []);
    editor.setDecorations(this.decorationTypes.context, []);
  }

  private createRange(range: SourceRange): unknown {
    return this.host.createRange(
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
    );
  }
}

function semanticStyles(
  host: SourceDecorationHost,
): Record<DecorationRole, vscode.DecorationRenderOptions> {
  return {
    primary: {
      backgroundColor: host.createThemeColor(
        "pinOp.selectedRuleBackground",
      ),
      borderColor: host.createThemeColor("pinOp.selectedRuleBorder"),
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      overviewRulerColor: host.createThemeColor(
        "pinOp.selectedRuleBorder",
      ),
      overviewRulerLane: host.overviewRulerLaneRight,
    },
    context: {
      backgroundColor: host.createThemeColor(
        "pinOp.parentRuleBackground",
      ),
      borderColor: host.createThemeColor("pinOp.parentRuleBorder"),
      borderStyle: "solid",
      borderWidth: "0 0 0 2px",
      overviewRulerColor: host.createThemeColor(
        "pinOp.parentRuleBorder",
      ),
      overviewRulerLane: host.overviewRulerLaneRight,
    },
  };
}

function uniqueRanges(ranges: readonly SourceRange[]): SourceRange[] {
  const unique = new Map<string, SourceRange>();
  for (const range of ranges) {
    const key = rangeKey(range);
    if (!unique.has(key)) unique.set(key, range);
  }
  return [...unique.values()];
}

function rangeKey(range: SourceRange): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}
