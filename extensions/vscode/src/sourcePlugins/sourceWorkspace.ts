import type {
  SourceUriResolution,
  SourceWorkspace,
} from "@browser2ide/plugin-api";
import type { ActiveDocumentSourceKind } from "./types.js";

export interface UriLike {
  toString(): string;
}

export interface WorkspaceHost {
  readonly workspaceFolders: readonly { readonly uri: UriLike }[];
  findFiles(pattern: string, exclude: string): PromiseLike<readonly UriLike[]>;
  parseUri(value: string): UriLike;
  readFile(uri: UriLike): PromiseLike<Uint8Array>;
}

const EXCLUDED_WORKSPACE_PATHS = "**/{node_modules,.git}/**";

export function classifyActiveDocumentSource(
  resolution: SourceUriResolution,
  activeDocumentUri: string,
): ActiveDocumentSourceKind {
  if (resolution.status === "ambiguous") return "ambiguous";
  if (resolution.uris.length > 1) return "ambiguous";
  if (resolution.status === "not-found") {
    return resolution.uris.length === 0 ? "not-found" : "other-document";
  }
  const candidate = resolution.uris[0];
  if (resolution.status === "unique-basename") {
    return candidate !== undefined && sameCanonicalUri(
        candidate,
        activeDocumentUri,
      )
      ? "not-found"
      : "other-document";
  }
  if (
    resolution.status === "exact" &&
    candidate !== undefined &&
    sameCanonicalUri(candidate, activeDocumentUri)
  ) {
    return "active-document";
  }
  return "other-document";
}

export class VsCodeSourceWorkspace implements SourceWorkspace {
  public constructor(private readonly host: WorkspaceHost) {}

  public async findFiles(pattern: string): Promise<readonly string[]> {
    return (
      await this.host.findFiles(pattern, EXCLUDED_WORKSPACE_PATHS)
    ).map((uri) => uri.toString());
  }

  public async readText(uri: string): Promise<string> {
    const parsed = this.host.parseUri(uri);
    if (!this.isWorkspaceUri(uri)) {
      throw new Error(`URI is outside the workspace: ${uri}`);
    }
    return new TextDecoder().decode(await this.host.readFile(parsed));
  }

  public async resolveSourceUri(
    sourceUrl: string,
    baseUrl: string,
  ): Promise<SourceUriResolution> {
    const absolute = new URL(sourceUrl, baseUrl);
    if (absolute.protocol === "file:") {
      const canonical = this.host.parseUri(absolute.toString()).toString();
      if (this.isWorkspaceUri(canonical)) {
        return { uris: [canonical], status: "exact" };
      }
    }
    const pathname = decodedPathname(sourceUrl, baseUrl);
    const relativePath = pathname.replace(/^\/+/, "");
    if (!relativePath) return { uris: [], status: "not-found" };

    const exact = await this.findFiles(`**/${escapeGlob(relativePath)}`);
    if (exact.length === 1) return { uris: exact, status: "exact" };
    if (exact.length > 1) return { uris: [], status: "ambiguous" };

    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const fallback = await this.findFiles(`**/${escapeGlob(basename)}`);
    if (fallback.length === 1) {
      return { uris: fallback, status: "unique-basename" };
    }
    return {
      uris: [],
      status: fallback.length > 1 ? "ambiguous" : "not-found",
    };
  }

  public resolveRelativeUri(baseUri: string, reference: string): string {
    return new URL(reference, baseUri).toString();
  }

  public isWorkspaceUri(uri: string): boolean {
    const candidate = normalizedUri(uri);
    if (!candidate) return false;
    return this.host.workspaceFolders.some((folder) => {
      const root = normalizedUri(folder.uri.toString());
      return root !== undefined &&
        (candidate === root || candidate.startsWith(`${root}/`));
    });
  }
}

function decodedPathname(sourceUrl: string, baseUrl: string): string {
  return decodeURIComponent(new URL(sourceUrl, baseUrl).pathname).replace(
    /\\/g,
    "/",
  );
}

function escapeGlob(value: string): string {
  return value.replace(/[?*[\]{}]/g, (character) => `[${character}]`);
}

function normalizedUri(value: string): string | undefined {
  try {
    const uri = new URL(value);
    let pathname = decodeURI(uri.pathname)
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
    if (isWindowsFileUri(uri, pathname)) {
      pathname = pathname.toLowerCase();
    }
    return `${uri.protocol.toLowerCase()}//${uri.host.toLowerCase()}${pathname}${uri.search}${uri.hash}`;
  } catch {
    return undefined;
  }
}

function sameCanonicalUri(left: string, right: string): boolean {
  const normalizedLeft = normalizedUri(left);
  return normalizedLeft !== undefined && normalizedLeft === normalizedUri(right);
}

function isWindowsFileUri(uri: URL, pathname: string): boolean {
  return uri.protocol === "file:" &&
    (
      process.platform === "win32" ||
      uri.host !== "" ||
      /^\/[a-z]:\//i.test(pathname)
    );
}
