class ReadOnlyElementsPanel {
  static instance(): ReadOnlyElementsPanel { return new ReadOnlyElementsPanel(); }
  deregisterAdorner(_adorner: unknown): void {}
  isAdornerEnabled(_name: string): boolean { return true; }
  registerAdorner(_adorner: unknown): void {}
}
export {ReadOnlyElementsPanel as ElementsPanel};
