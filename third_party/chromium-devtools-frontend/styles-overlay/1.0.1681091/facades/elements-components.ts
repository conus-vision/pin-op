class EmptyElement extends HTMLElement { data: unknown; }

interface ReadOnlyCSSQueryData {
  readonly queryPrefix: string;
  readonly queryName?: string;
  readonly queryText: string;
  readonly jslogContext: string;
}

class ReadOnlyCSSQuery extends HTMLElement {
  readonly #shadow = this.attachShadow({mode: 'open'});
  #data: ReadOnlyCSSQueryData|undefined;

  set data(data: ReadOnlyCSSQueryData) {
    this.#data = data;
    this.#render();
  }

  get data(): ReadOnlyCSSQueryData|undefined {
    return this.#data;
  }

  parseStyleQueries(): void {}

  #render(): void {
    const data = this.#data;
    this.#shadow.replaceChildren();
    if (!data) return;
    const style = document.createElement('style');
    style.textContent = `
      :host { display: block; }
      .query { min-height: 18px; white-space: pre-wrap; }
      .query-prefix, .query-name { color: var(--sys-color-purple, #881280); }
    `;
    const row = document.createElement('div');
    row.className = 'query pin-op-css-query';
    row.dataset.contextKind = data.jslogContext;
    const indent = document.createElement('slot');
    indent.name = 'indent';
    row.append(indent);
    if (data.queryPrefix) {
      const prefix = document.createElement('span');
      prefix.className = 'query-prefix';
      prefix.textContent = `${data.queryPrefix} `;
      row.append(prefix);
    }
    if (data.queryName) {
      const name = document.createElement('span');
      name.className = 'query-name';
      name.textContent = `${data.queryName} `;
      row.append(name);
    }
    const text = document.createElement('span');
    text.className = 'query-text';
    text.textContent = data.queryText;
    row.append(text, ' {');
    this.#shadow.append(style, row);
  }
}

customElements.define('pin-op-readonly-css-query', ReadOnlyCSSQuery);

export const StylePropertyEditor = Object.freeze({
  FlexboxEditor: EmptyElement,
  GridEditor: EmptyElement,
  GridLanesEditor: EmptyElement,
});
export const CSSPropertyDocsView = Object.freeze({CSSPropertyDocsView: EmptyElement});
export const CSSQuery = Object.freeze({CSSQuery: ReadOnlyCSSQuery});
export const QueryContainer = Object.freeze({QueryContainer: EmptyElement});
export const CSSVariableValueView = Object.freeze({CSSVariableValueView: EmptyElement});
