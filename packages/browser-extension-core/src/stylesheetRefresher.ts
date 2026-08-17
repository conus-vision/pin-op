export const STYLESHEET_REFRESH_TIMEOUT_MS = 5_000;
export const MAX_STYLESHEET_REFRESH_LINKS = 256;

export interface StylesheetRefreshResult {
  readonly attempted: number;
  readonly updated: number;
  readonly failed: number;
}

interface StylesheetRefreshOptions {
  readonly timeoutMs?: number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

interface LinkLike extends Node {
  cloneNode(deep?: boolean): Node;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

interface ParentLike extends Node {
  insertBefore<T extends Node>(node: T, child: Node | null): T;
  removeChild<T extends Node>(child: T): T;
}

export async function refreshExternalStylesheets(
  document: Document,
  generation: number,
  options: StylesheetRefreshOptions = {},
): Promise<StylesheetRefreshResult> {
  requireGeneration(generation);
  if (!isTopDocument(document)) {
    return result(0, 0, 0);
  }

  const links = eligibleLinks(document);
  const timeoutMs = requireTimeout(
    options.timeoutMs ?? STYLESHEET_REFRESH_TIMEOUT_MS,
  );
  const schedule = options.setTimeout ?? globalThis.setTimeout;
  const cancel = options.clearTimeout ?? globalThis.clearTimeout;
  const outcomes = await Promise.all(
    links.map((link) => refreshLink(
      link,
      document,
      generation,
      timeoutMs,
      schedule,
      cancel,
    )),
  );
  const updated = outcomes.filter(Boolean).length;
  return result(links.length, updated, links.length - updated);
}

function refreshLink(
  original: LinkLike,
  document: Document,
  generation: number,
  timeoutMs: number,
  schedule: typeof globalThis.setTimeout,
  cancel: typeof globalThis.clearTimeout,
): Promise<boolean> {
  return new Promise((resolve) => {
    let replacement: LinkLike;
    let parent: ParentLike;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const finish = (loaded: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) cancel(timer);
      try {
        replacement.removeEventListener("load", onLoad);
        replacement.removeEventListener("error", onError);
      } catch {
        // Listener cleanup is best effort after authority is revoked.
      }
      if (loaded && removeChild(parent, original)) {
        resolve(true);
        return;
      }
      removeChild(parent, replacement);
      resolve(false);
    };
    const onLoad: EventListener = () => finish(true);
    const onError: EventListener = () => finish(false);

    try {
      const parentNode = original.parentNode;
      if (!isParentLike(parentNode)) {
        resolve(false);
        return;
      }
      parent = parentNode;
      const clone = original.cloneNode(false);
      if (!isLinkLike(clone)) {
        resolve(false);
        return;
      }
      replacement = clone;
      replacement.setAttribute(
        "href",
        refreshedHref(original, document, generation),
      );
      replacement.addEventListener("load", onLoad);
      replacement.addEventListener("error", onError);
      timer = schedule(() => finish(false), timeoutMs);
      parent.insertBefore(replacement, original.nextSibling);
    } catch {
      if (typeof replacement! === "object" && replacement !== null) {
        try {
          replacement.removeEventListener("load", onLoad);
          replacement.removeEventListener("error", onError);
        } catch {
          // A hostile clone cannot retain useful refresh authority.
        }
        if (typeof parent! === "object" && parent !== null) {
          removeChild(parent, replacement);
        }
      }
      if (timer !== undefined) cancel(timer);
      resolve(false);
    }
  });
}

function eligibleLinks(document: Document): LinkLike[] {
  let candidates: NodeListOf<Element> | ArrayLike<Element>;
  try {
    candidates = document.querySelectorAll("link");
  } catch {
    return [];
  }
  const links: LinkLike[] = [];
  let length: number;
  try {
    length = Math.min(
      requireArrayLength(candidates.length),
      MAX_STYLESHEET_REFRESH_LINKS,
    );
  } catch {
    return [];
  }
  for (let index = 0; index < length; index += 1) {
    let candidate: unknown;
    try {
      candidate = candidates[index];
    } catch {
      continue;
    }
    if (isEligibleLink(candidate, document)) {
      links.push(candidate);
    }
  }
  return links;
}

function isEligibleLink(value: unknown, document: Document): value is LinkLike {
  if (!isLinkLike(value)) return false;
  try {
    const rel = value.getAttribute("rel") ?? "";
    if (!rel.split(/\s+/u).some((token) => token.toLowerCase() === "stylesheet")) {
      return false;
    }
    const href = value.getAttribute("href");
    if (!href) return false;
    const url = new URL(href, document.baseURI);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function refreshedHref(
  link: LinkLike,
  document: Document,
  generation: number,
): string {
  const href = link.getAttribute("href");
  if (!href) throw new TypeError("Stylesheet href is unavailable");
  const url = new URL(href, document.baseURI);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Unsupported stylesheet URL");
  }
  url.searchParams.set("pin-op-refresh", String(generation));
  return url.href;
}

function isTopDocument(document: Document): boolean {
  try {
    const view = document.defaultView;
    return Boolean(view && view.top === view);
  } catch {
    return false;
  }
}

function isLinkLike(value: unknown): value is LinkLike {
  try {
    const candidate = value as Partial<LinkLike> | null;
    return Boolean(
      candidate &&
      typeof candidate.cloneNode === "function" &&
      typeof candidate.getAttribute === "function" &&
      typeof candidate.setAttribute === "function" &&
      typeof candidate.addEventListener === "function" &&
      typeof candidate.removeEventListener === "function",
    );
  } catch {
    return false;
  }
}

function isParentLike(value: unknown): value is ParentLike {
  try {
    const candidate = value as Partial<ParentLike> | null;
    return Boolean(
      candidate &&
      typeof candidate.insertBefore === "function" &&
      typeof candidate.removeChild === "function",
    );
  } catch {
    return false;
  }
}

function removeChild(parent: ParentLike, child: Node): boolean {
  try {
    if (child.parentNode !== parent) return false;
    parent.removeChild(child);
    return true;
  } catch {
    return false;
  }
}

function result(
  attempted: number,
  updated: number,
  failed: number,
): StylesheetRefreshResult {
  return Object.freeze({ attempted, updated, failed });
}

function requireGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("generation must be a nonnegative safe integer");
  }
  return value;
}

function requireTimeout(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("timeoutMs must be a nonnegative finite number");
  }
  return value;
}

function requireArrayLength(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Invalid link collection length");
  }
  return value;
}
