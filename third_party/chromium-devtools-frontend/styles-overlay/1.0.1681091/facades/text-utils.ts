export const TextRange = Object.freeze({
  SourceRange: class { constructor(readonly offset: number, readonly length: number) {} },
  TextRange: class {
    startLine = 0; startColumn = 0; endLine = 0; endColumn = 0;
    static fromObject(value: {startLine: number, startColumn: number, endLine: number, endColumn: number}) {
      return Object.assign(new this(), value);
    }
    equal(other: object): boolean { return this === other; }
    rebaseAfterTextEdit(): this { return this; }
  },
});
export const Text = Object.freeze({Text: class {
  constructor(readonly content: string) {}
  value(): string { return this.content; }
  toTextRange(): InstanceType<typeof TextRange.TextRange> { return new TextRange.TextRange(); }
}});
export const TextUtils = Object.freeze({Utils: Object.freeze({lineIndent: (_line: string): string => ''})});
export const CodeMirrorUtils = Object.freeze({createCssTokenizer: () => () => {}});
