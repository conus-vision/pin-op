class LogDescriptor {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  context(_value: string): this { return this; }
  parent(_value: string): this { return this; }
  track(_events: unknown): this { return this; }
  toString(): string { return this.#value; }
}

const descriptor = (value: string): LogDescriptor => new LogDescriptor(value);
export const action = descriptor;
export const adorner = descriptor;
export const expand = descriptor;
export const tree = descriptor;
export const treeItem = descriptor;
export const value = descriptor;
export const logClick = async (_element: Element, _event?: Event): Promise<void> => {};
export const registerLoggable = (_element: Element, _config: unknown): void => {};
export const registerParentProvider = (_element: Element, _provider: unknown): void => {};
