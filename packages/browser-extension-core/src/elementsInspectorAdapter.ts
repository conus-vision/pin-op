import type {
  TreeDataSource,
  TreePresentationSnapshot,
} from "@pin-op/devtools-elements-ui";
import type { DomTreeController } from "./domTreeController.js";

export class ElementsInspectorAdapter implements TreeDataSource {
  public constructor(private readonly controller: DomTreeController) {}

  public snapshot(): TreePresentationSnapshot {
    return Object.freeze({
      rows: this.controller.rows(),
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
