class ReadOnlyElementsPanel {
  static instance(): ReadOnlyElementsPanel { return new ReadOnlyElementsPanel(); }
  deregisterAdorner(_adorner: unknown): void {}
  // Pin-op ships no adorner data or adorner presentation, and its read-only
  // boundary owns no Sources/layout capability behind the upstream badges.
  // Enabling them would leak their unstyled label text into the DOM tree.
  isAdornerEnabled(_name: string): boolean { return false; }
  registerAdorner(_adorner: unknown): void {}
}
export {ReadOnlyElementsPanel as ElementsPanel};
