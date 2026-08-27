class Descriptor {
  context(_value: string): this { return this; }
  parent(_value: string): this { return this; }
  track(_value: unknown): this { return this; }
  toString(): string { return ''; }
}
const descriptor = (_value?: string): Descriptor => new Descriptor();
export const action = descriptor;
export const cssRuleHeader = descriptor;
export const dropDown = descriptor;
export const expand = descriptor;
export const link = descriptor;
export const key = descriptor;
export const section = descriptor;
export const sectionHeader = descriptor;
export const showStyleEditor = descriptor;
export const toggle = descriptor;
export const value = descriptor;
export const logClick = async (_element: Element, _event?: Event): Promise<void> => {};
