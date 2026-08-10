import type { IconNode, IconNodeChild, SVGProps } from "lucide";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

export interface LucideDocument {
  createElementNS(namespace: string, qualifiedName: string): Element;
}

export function createLucideElement(
  ownerDocument: LucideDocument,
  icon: IconNode,
): Element {
  const [tagName, attributes, children = []] = icon;
  const element = createSvgElement(ownerDocument, tagName, attributes);
  for (const child of children) {
    element.appendChild(createLucideChild(ownerDocument, child));
  }
  return element;
}

function createLucideChild(
  ownerDocument: LucideDocument,
  [tagName, attributes]: IconNodeChild,
): Element {
  return createSvgElement(ownerDocument, tagName, attributes);
}

function createSvgElement(
  ownerDocument: LucideDocument,
  tagName: string,
  attributes: SVGProps,
): Element {
  const element = ownerDocument.createElementNS(SVG_NAMESPACE, tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}
