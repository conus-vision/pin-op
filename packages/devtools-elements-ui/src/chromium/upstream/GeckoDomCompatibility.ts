/**
 * Chromium's DevTools DOM extensions reach for `ShadowRoot.getSelection()`,
 * which only Blink implements. Gecko throws `getSelection is not a function`
 * there, and because `Node.hasSelection()` is the first thing every upstream
 * tree click handler calls, that one missing method took the whole interaction
 * with it: rows would not open and hover handling died mid-flight.
 *
 * Gecko does not scope selection to a shadow root -- `document.getSelection()`
 * already reports selections inside one -- so handing back the document's
 * selection is the same answer Blink gives, not an approximation.
 */
export function installGeckoDomCompatibility(
  scope: typeof globalThis = globalThis,
): boolean {
  const shadowRoot = (scope as { ShadowRoot?: unknown }).ShadowRoot;
  if (typeof shadowRoot !== "function") {
    return false;
  }
  const prototype = (shadowRoot as { prototype?: unknown }).prototype;
  if (!prototype || typeof prototype !== "object") {
    return false;
  }
  const candidate = prototype as {
    getSelection?: unknown;
    ownerDocument?: Document;
  };
  if (typeof candidate.getSelection === "function") {
    return false;
  }
  Object.defineProperty(prototype, "getSelection", {
    configurable: true,
    writable: true,
    value: function getSelection(this: ShadowRoot): Selection | null {
      return this.ownerDocument?.getSelection() ?? null;
    },
  });
  return true;
}
