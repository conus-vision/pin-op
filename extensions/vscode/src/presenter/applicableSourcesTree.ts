import type * as vscode from "vscode";
import type {
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
  SourceResolution,
} from "../sourcePlugins/types.js";

export interface ApplicableSourceTreeItem extends vscode.TreeItem {
  readonly sourceMatchId?: string;
  readonly match?: ResolvedSourceMatch;
  readonly diagnostic?: ResolvedPluginDiagnostic;
}

export interface ApplicableSourcesTreeOptions {
  readonly createThemeIcon?: (id: string) => vscode.ThemeIcon;
}

export class ApplicableSourcesTreeDataProvider {
  private readonly createThemeIcon: (id: string) => vscode.ThemeIcon;
  private readonly changeListeners = new Set<
    (item: ApplicableSourceTreeItem | undefined | null) => unknown
  >();
  private items: ApplicableSourceTreeItem[] = [];
  private matchesById = new Map<string, ResolvedSourceMatch>();
  private documentUri: string | undefined;
  private disposed = false;

  public readonly onDidChangeTreeData: vscode.Event<
    ApplicableSourceTreeItem | undefined | null
  > = (listener, thisArgs, disposables) => {
    const wrapped = thisArgs
      ? (item: ApplicableSourceTreeItem | undefined | null) =>
          listener.call(thisArgs, item)
      : listener;
    this.changeListeners.add(wrapped);
    const disposable = {
      dispose: () => this.changeListeners.delete(wrapped),
    };
    disposables?.push(disposable);
    return disposable;
  };

  public constructor(options: ApplicableSourcesTreeOptions = {}) {
    this.createThemeIcon =
      options.createThemeIcon ?? ((id) => ({ id }) as vscode.ThemeIcon);
  }

  public update(snapshot: SourceResolution): void {
    if (this.disposed) return;
    this.documentUri = snapshot.documentUri;
    this.matchesById = new Map();
    const matchItems = snapshot.matches.map((match) => {
      const sourceMatchId = stableSourceMatchId(snapshot, match);
      this.matchesById.set(sourceMatchId, match);
      return {
        label: `${match.targetRole === "selected" ? "Selected" : "Parent"}  ${match.label}`,
        description: `${match.confidence} - ${match.pluginId}`,
        tooltip: `${snapshot.documentUri}:${match.range.start.line + 1}:${match.range.start.character + 1}`,
        iconPath: this.createThemeIcon(
          match.targetRole === "selected" ? "check" : "symbol-color",
        ),
        command: {
          command: "pinop.revealSourceMatch",
          title: "Reveal Source Match",
          arguments: [sourceMatchId],
        },
        contextValue: "pinop.sourceMatch",
        sourceMatchId,
        match,
      } satisfies ApplicableSourceTreeItem;
    });
    const diagnosticItems = snapshot.diagnostics.map((diagnostic) => ({
      label: diagnostic.message,
      description: `${diagnostic.severity} - ${diagnostic.pluginId}`,
      tooltip: `${diagnostic.code}: ${diagnostic.message}`,
      iconPath: this.createThemeIcon(diagnosticIcon(diagnostic)),
      contextValue: "pinop.pluginDiagnostic",
      diagnostic,
    }) satisfies ApplicableSourceTreeItem);
    this.items = [...matchItems, ...diagnosticItems];
    this.emitChange();
  }

  public getChildren(): ApplicableSourceTreeItem[] {
    return [...this.items];
  }

  public getTreeItem(item: ApplicableSourceTreeItem): ApplicableSourceTreeItem {
    return item;
  }

  public getMatch(sourceMatchId: string): ResolvedSourceMatch | undefined {
    return this.matchesById.get(sourceMatchId);
  }

  public getMatches(): readonly ResolvedSourceMatch[] {
    return [...this.matchesById.values()];
  }

  public getDocumentUri(): string | undefined {
    return this.documentUri;
  }

  public clear(): void {
    if (this.disposed) return;
    this.items = [];
    this.matchesById.clear();
    this.documentUri = undefined;
    this.emitChange();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.changeListeners.clear();
    this.items = [];
    this.matchesById.clear();
    this.documentUri = undefined;
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener(undefined);
  }
}

export function stableSourceMatchId(
  snapshot: SourceResolution,
  match: ResolvedSourceMatch,
): string {
  return encodeURIComponent(JSON.stringify([
    snapshot.selectionMessageId,
    snapshot.documentUri,
    snapshot.documentVersion,
    match.pluginId,
    match.targetRole,
    match.kind,
    match.relation,
    match.range,
    match.label,
  ]));
}

function diagnosticIcon(diagnostic: ResolvedPluginDiagnostic): string {
  if (diagnostic.severity === "error") return "error";
  if (diagnostic.severity === "warning") return "warning";
  return "info";
}
