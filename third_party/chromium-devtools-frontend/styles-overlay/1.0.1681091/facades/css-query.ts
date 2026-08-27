export class CSSQuery {
  text = '';
  range = null;
  styleSheetId = undefined;
  constructor(protected readonly cssModel: object) {}
  active(): boolean { return true; }
  rebase(): void {}
  equal(other: object): boolean { return this === other; }
  lineNumberInSource(): undefined { return undefined; }
  columnNumberInSource(): undefined { return undefined; }
  header(): null { return null; }
  rawLocation(): null { return null; }
}
