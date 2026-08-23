import type {
  TreeDataSource,
  TreePresentationSnapshot,
} from "../../src/contracts.js";

export class FakeElementsBackend implements TreeDataSource {
  public readonly expanded: string[] = [];
  public readonly collapsed: string[] = [];
  public readonly loadedMore: string[] = [];
  public readonly selected: string[] = [];
  public readonly focused: string[] = [];
  public readonly hovered: Array<string | undefined> = [];
  private readonly listeners = new Set<() => void>();

  public constructor(private current: TreePresentationSnapshot) {}

  public snapshot(): TreePresentationSnapshot {
    return this.current;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public async expand(nodeRef: string): Promise<void> {
    this.expanded.push(nodeRef);
  }

  public collapse(nodeRef: string): void {
    this.collapsed.push(nodeRef);
  }

  public async loadMore(parentRef: string): Promise<void> {
    this.loadedMore.push(parentRef);
  }

  public async select(nodeRef: string): Promise<void> {
    this.selected.push(nodeRef);
  }

  public focus(nodeRef: string): void {
    this.focused.push(nodeRef);
  }

  public hover(nodeRef?: string): void {
    this.hovered.push(nodeRef);
  }

  public publish(snapshot: TreePresentationSnapshot): void {
    this.current = snapshot;
    for (const listener of [...this.listeners]) listener();
  }

  public listenerCount(): number {
    return this.listeners.size;
  }
}
