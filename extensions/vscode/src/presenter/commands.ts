import type { SourcePosition, SourceRange } from "@pin-op/plugin-api";
import type { ResolvedSourceMatch } from "../sourcePlugins/types.js";
import type { DisposableLike } from "./decorations.js";

export interface RevealEditorLike {
  readonly document: { readonly uri: { toString(): string } };
}

export interface PresenterCommandHost {
  registerCommand(
    command: string,
    callback: (...arguments_: unknown[]) => unknown,
  ): DisposableLike;
  getActiveEditor(): RevealEditorLike | undefined;
  createRange(range: SourceRange): unknown;
  revealRange(editor: RevealEditorLike, range: unknown): void;
  selectRangeStart(editor: RevealEditorLike, start: SourcePosition): void;
}

export interface SourceMatchLookup {
  getMatch(sourceMatchId: string): ResolvedSourceMatch | undefined;
  getDocumentUri(): string | undefined;
}

export function registerPresenterCommands(
  host: PresenterCommandHost,
  matches: SourceMatchLookup,
  reportError: (error: unknown) => void,
): DisposableLike {
  return host.registerCommand(
    "pin-op.revealSourceMatch",
    (sourceMatchId: unknown) => {
      if (typeof sourceMatchId !== "string") return;
      const match = matches.getMatch(sourceMatchId);
      if (!match) return;

      const editor = host.getActiveEditor();
      const documentUri = matches.getDocumentUri();
      if (!editor || !documentUri || editor.document.uri.toString() !== documentUri) {
        reportError(
          new Error("PinOp source match is not in the active editor"),
        );
        return;
      }

      const range = host.createRange(match.range);
      host.revealRange(editor, range);
      host.selectRangeStart(editor, match.range.start);
    },
  );
}
