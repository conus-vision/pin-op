import type {
  TreeDataSource,
  TreePresentationSnapshot,
  TreeRowSnapshot,
} from "@pin-op/devtools-elements-ui";
import type { DomTreeController } from "./domTreeController.js";

export class ElementsInspectorAdapter implements TreeDataSource {
  private sourceRows: readonly TreeRowSnapshot[] | undefined;
  private projectedRows: readonly TreeRowSnapshot[] = Object.freeze([]);

  public constructor(private readonly controller: DomTreeController) {}

  public snapshot(): TreePresentationSnapshot {
    const sourceRows = this.controller.rows();
    if (sourceRows !== this.sourceRows) {
      this.sourceRows = sourceRows;
      this.projectedRows = Object.freeze(sourceRows.map((row) => Object.freeze({
        ...row,
        depth: Math.max(0, row.depth - 1),
      })));
    }
    return Object.freeze({
      rows: this.projectedRows,
    });
  }

  public subscribe(listener: () => void): () => void {
    return this.controller.subscribe(listener);
  }

  public expand(nodeRef: string): Promise<void> {
    return this.controller.expand(nodeRef);
  }

  public collapse(nodeRef: string): void {
    this.controller.collapse(nodeRef);
  }

  public loadMore(parentRef: string): Promise<void> {
    return this.controller.loadMore(parentRef);
  }

  public select(nodeRef: string): Promise<void> {
    return this.controller.select(nodeRef);
  }

  public focus(nodeRef: string): void {
    this.controller.focus(nodeRef);
  }

  public hover(nodeRef?: string): void {
    this.controller.hover(nodeRef);
  }
}
