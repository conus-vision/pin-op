/** The editable target the paste command needs, and the panel's own document. */
export interface PanelClipboardOptions {
  readonly document: Document;
  readonly clipboard?: { readText(): Promise<string> } | undefined;
}

/**
 * Reads the clipboard for the panel's Paste control.
 *
 * The asynchronous Clipboard API is gated on the `clipboard-read` permissions
 * policy, whose default allowlist is the document's own origin. A DevTools
 * panel is a frame the toolbox embeds cross-origin without delegating it, so
 * the read is refused there however the extension itself is permitted -- which
 * is why Paste answered nothing in Chrome while working in an ordinary
 * extension tab. The editing command is gated on the extension's own
 * `clipboardRead` permission instead and still answers inside the panel, so it
 * is the fallback: second, because it is the retired API and the first call is
 * the one that keeps working.
 */
export async function readPanelClipboardText(
  options: PanelClipboardOptions,
): Promise<string> {
  let refusal: unknown;
  try {
    const text = await options.clipboard?.readText();
    if (typeof text === "string") return text;
    refusal = new Error("Clipboard read returned no text");
  } catch (error) {
    refusal = error;
  }
  const commanded = readWithEditingCommand(options.document);
  if (commanded !== undefined) return commanded;
  throw refusal;
}

function readWithEditingCommand(document: Document): string | undefined {
  const body = document.body;
  if (!body || typeof document.execCommand !== "function") return undefined;
  let target: HTMLTextAreaElement;
  try {
    target = document.createElement("textarea");
  } catch {
    return undefined;
  }
  // Off-screen rather than hidden: the command pastes into whatever holds
  // focus, and a hidden element cannot take it.
  target.setAttribute("aria-hidden", "true");
  target.style.position = "fixed";
  target.style.insetBlockStart = "0";
  target.style.insetInlineStart = "-9999px";
  target.style.opacity = "0";
  const restore = document.activeElement;
  try {
    body.append(target);
    target.focus();
    return document.execCommand("paste") ? target.value : undefined;
  } catch {
    return undefined;
  } finally {
    target.remove();
    // The Paste control had focus when it was pressed; give it back.
    if (restore instanceof Object && "focus" in restore) {
      try {
        (restore as HTMLElement).focus();
      } catch {
        // A vanished element cannot be refocused, and nothing depends on it.
      }
    }
  }
}
