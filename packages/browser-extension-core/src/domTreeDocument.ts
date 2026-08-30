/** The narrow document surface the panel runtimes need for the DOM tree. */
export type DomTreeDocument = Pick<
  Document,
  "activeElement" | "createElement" | "createElementNS" | "getElementById"
>;
