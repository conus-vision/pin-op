export const highlightedSearchResultClassName = 'highlighted-search-result';
export function highlightRangesWithStyleClass(
    _element: Element, _ranges: readonly unknown[], _className: string): Range[] {
  return [];
}
class ReadOnlyHighlightManager {
  static #instance = new ReadOnlyHighlightManager();
  static instance(): ReadOnlyHighlightManager { return ReadOnlyHighlightManager.#instance; }
  apply(_element: Element): void {}
  highlightOrderedTextRanges(_element: Node, _ranges: readonly unknown[]): Range[] { return []; }
  removeHighlights(_ranges: readonly Range[]): void {}
  set(_element: Element, _ranges: readonly unknown[], _selectedRange?: unknown): void {}
}
export const HighlightManager = Object.freeze({HighlightManager: ReadOnlyHighlightManager});
