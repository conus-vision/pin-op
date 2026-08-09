import type {
  SourceResolutionStrategy,
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

interface WorkspaceFolderIdentity {
  readonly uri: string;
  readonly name: string | undefined;
  readonly windows: boolean;
}

interface ResolutionScope {
  readonly strategy: SourceResolutionStrategy;
  readonly folder?: WorkspaceFolderIdentity;
  readonly ambiguous: boolean;
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
    const absolute = safeUrl(sourceUrl, baseUrl);
    const folders = this.workspaceFolders();
    const scope = resolutionScope(folders, safeUrl(baseUrl), absolute);
    const baseResult = scope.folder === undefined
      ? { strategy: scope.strategy } as const
      : {
        strategy: scope.strategy,
        workspaceFolderUri: scope.folder.uri,
      } as const;

    if (scope.ambiguous) {
      return { uris: [], status: "ambiguous", ...baseResult };
    }
    if (!absolute) {
      return { uris: [], status: "not-found", ...baseResult };
    }
    if (absolute.protocol === "file:") {
      const canonical = this.host.parseUri(absolute.toString()).toString();
      const owner = scope.folder ??
        folders.find((folder) => uriWithin(canonical, folder.uri));
      if (!owner || !uriWithin(canonical, owner.uri)) {
        return { uris: [], status: "not-found", ...baseResult };
      }
      return {
        uris: [canonical],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri: owner.uri,
      };
    }
    const pathname = safeDecodedPathname(absolute);
    if (!pathname) {
      return { uris: [], status: "not-found", ...baseResult };
    }
    let relativePath = pathname.replace(/^\/+/, "");
    if (scope.folder) {
      relativePath = stripLeadingFolder(relativePath, scope.folder);
    }
    if (!relativePath) {
      return { uris: [], status: "not-found", ...baseResult };
    }

    const exact = await this.findCandidates(relativePath, scope.folder);
    if (exact.length === 1) {
      return { uris: exact, status: "exact", ...baseResult };
    }
    if (exact.length > 1) {
      return { uris: [], status: "ambiguous", ...baseResult };
    }

    const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const fallback = await this.findCandidates(basename, scope.folder);
    if (fallback.length === 1) {
      return {
        uris: fallback,
        status: "unique-basename",
        ...baseResult,
      };
    }
    return {
      uris: [],
      status: fallback.length > 1 ? "ambiguous" : "not-found",
      ...baseResult,
    };
  }

  public resolveRelativeUri(baseUri: string, reference: string): string {
    return new URL(reference, baseUri).toString();
  }

  public isWorkspaceUri(uri: string): boolean {
    return this.host.workspaceFolders.some((folder) =>
      uriWithin(uri, folder.uri.toString())
    );
  }

  private async findCandidates(
    relativePath: string,
    folder?: WorkspaceFolderIdentity,
  ): Promise<readonly string[]> {
    const matches = await this.findFiles(`**/${escapeGlob(relativePath)}`);
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of matches) {
      if (folder && !uriWithin(candidate, folder.uri)) continue;
      const key = normalizedUri(candidate) ?? candidate;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    return candidates;
  }

  private workspaceFolders(): readonly WorkspaceFolderIdentity[] {
    return this.host.workspaceFolders
      .map((folder) => workspaceFolderIdentity(folder.uri.toString()))
      .filter((folder): folder is WorkspaceFolderIdentity =>
        folder !== undefined
      );
  }
}

function workspaceFolderIdentity(
  value: string,
): WorkspaceFolderIdentity | undefined {
  const uri = safeUrl(value);
  const decodedPathname = uri && safeDecodedPathname(uri);
  if (!uri || decodedPathname === undefined) return undefined;
  const pathname = decodedPathname.replace(/\/+$/, "");
  const segments = pathname.split("/").filter(Boolean);
  const name = segments[segments.length - 1];
  return {
    uri: value,
    name,
    windows: isWindowsFileUri(uri, decodedPathname),
  };
}

function resolutionScope(
  folders: readonly WorkspaceFolderIdentity[],
  documentUrl: URL | undefined,
  sourceUrl: URL | undefined,
): ResolutionScope {
  const documentMatches = matchingFolders(folders, documentUrl);
  const sourceMatches = matchingFolders(folders, sourceUrl);
  if (documentMatches.length > 1 || sourceMatches.length > 1) {
    return { strategy: "workspace-bound", ambiguous: true };
  }

  const documentFolder = documentMatches[0];
  const sourceFolder = sourceMatches[0];
  if (
    documentFolder !== undefined &&
    sourceFolder !== undefined &&
    documentFolder !== sourceFolder
  ) {
    return { strategy: "workspace-bound", ambiguous: true };
  }

  const folder = sourceFolder ?? documentFolder;
  return folder === undefined
    ? { strategy: "automatic", ambiguous: false }
    : { strategy: "workspace-bound", folder, ambiguous: false };
}

function matchingFolders(
  folders: readonly WorkspaceFolderIdentity[],
  url: URL | undefined,
): readonly WorkspaceFolderIdentity[] {
  const segment = firstDecodedPathSegment(url);
  return segment === undefined
    ? []
    : folders.filter((folder) => sameFolderName(segment, folder));
}

function firstDecodedPathSegment(url: URL | undefined): string | undefined {
  const encoded = url?.pathname.split("/").find(Boolean);
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return undefined;
  }
}

function stripLeadingFolder(
  relativePath: string,
  folder: WorkspaceFolderIdentity,
): string {
  const separator = relativePath.indexOf("/");
  const firstSegment = separator === -1
    ? relativePath
    : relativePath.slice(0, separator);
  if (!sameFolderName(firstSegment, folder)) return relativePath;
  return separator === -1 ? "" : relativePath.slice(separator + 1);
}

function sameFolderName(
  candidate: string,
  folder: WorkspaceFolderIdentity,
): boolean {
  if (folder.name === undefined) return false;
  return folder.windows
    ? candidate.toLowerCase() === folder.name.toLowerCase()
    : candidate === folder.name;
}

function safeUrl(value: string, baseUrl?: string): URL | undefined {
  try {
    return baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    if (baseUrl !== undefined) return safeUrl(value);
    return undefined;
  }
}

function safeDecodedPathname(url: URL): string | undefined {
  try {
    return decodeURIComponent(url.pathname).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
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

function uriWithin(candidateUri: string, rootUri: string): boolean {
  const candidate = normalizedUri(candidateUri);
  const root = normalizedUri(rootUri);
  return candidate !== undefined && root !== undefined &&
    (candidate === root || candidate.startsWith(`${root}/`));
}

function isWindowsFileUri(uri: URL, pathname: string): boolean {
  return uri.protocol === "file:" &&
    (
      uri.host !== "" ||
      /^\/[a-z]:\//i.test(pathname)
    );
}
