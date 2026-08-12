import type {
  SourceResolutionStrategy,
  SourceUriResolution,
  SourceWorkspace,
} from "@pinop/plugin-api";
import type { ActiveDocumentSourceKind } from "./types.js";

export interface UriLike {
  toString(): string;
}

export interface WorkspaceHost {
  readonly workspaceFolders: readonly { readonly uri: UriLike }[];
  findFiles(pattern: string, exclude: string): PromiseLike<readonly UriLike[]>;
  joinPath(base: UriLike, ...pathSegments: string[]): UriLike;
  parseUri(value: string): UriLike;
  readFile(uri: UriLike): PromiseLike<Uint8Array>;
  stat(uri: UriLike): PromiseLike<unknown>;
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

interface WorkspaceFolderSelection {
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
    if (!this.isWorkspaceUri(uri)) {
      throw new Error(`URI is outside the workspace: ${uri}`);
    }
    const parsed = this.host.parseUri(filePathUri(uri) ?? uri);
    return new TextDecoder().decode(await this.host.readFile(parsed));
  }

  public async resolveSourceUri(
    sourceUrl: string,
    baseUrl: string,
  ): Promise<SourceUriResolution> {
    const documentUrl = safeUrl(baseUrl);
    if (!documentUrl) {
      return { uris: [], status: "not-found", strategy: "automatic" };
    }
    const folders = this.workspaceFolders();
    const document = documentWorkspaceFolder(folders, documentUrl);
    if (document.ambiguous) {
      return {
        uris: [],
        status: "ambiguous",
        strategy: "workspace-bound",
      };
    }
    const documentBaseResult = document.folder === undefined
      ? { strategy: "automatic" } as const
      : {
        strategy: "workspace-bound",
        workspaceFolderUri: document.folder.uri,
      } as const;
    if (safeDecodedPathname(documentUrl) === undefined) {
      return { uris: [], status: "not-found", ...documentBaseResult };
    }

    const absolute = safeUrl(sourceUrl, documentUrl);
    if (!absolute) {
      return { uris: [], status: "not-found", ...documentBaseResult };
    }
    const pathname = safeDecodedPathname(absolute);
    if (pathname === undefined) {
      return { uris: [], status: "not-found", ...documentBaseResult };
    }

    const scope = resolutionScope(folders, document, absolute);
    const baseResult = scope.folder === undefined
      ? { strategy: scope.strategy } as const
      : {
        strategy: scope.strategy,
        workspaceFolderUri: scope.folder.uri,
      } as const;

    if (scope.ambiguous) {
      return { uris: [], status: "ambiguous", ...baseResult };
    }
    if (absolute.protocol === "file:") {
      const canonical = this.host.parseUri(filePathUrl(absolute).toString())
        .toString();
      const owner = fileWorkspaceOwner(folders, absolute);
      if (owner.ambiguous) {
        return {
          uris: [],
          status: "ambiguous",
          strategy: "workspace-bound",
        };
      }
      if (!owner.folder || !uriWithin(canonical, owner.folder.uri)) {
        return { uris: [], status: "not-found", ...baseResult };
      }
      if (
        scope.folder !== undefined &&
        !sameCanonicalUri(scope.folder.uri, owner.folder.uri)
      ) {
        return { uris: [], status: "not-found", ...baseResult };
      }
      return {
        uris: [canonical],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri: owner.folder.uri,
      };
    }
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

    const boundCandidate = scope.folder
      ? await this.probeBoundCandidate(relativePath, scope.folder)
      : undefined;
    if (boundCandidate) {
      return {
        uris: [boundCandidate],
        status: "exact",
        ...baseResult,
      };
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
    let matches: readonly string[];
    try {
      matches = await this.findFiles(`**/${escapeGlob(relativePath)}`);
    } catch {
      return [];
    }
    const seen = new Set<string>();
    const candidates: string[] = [];
    for (const candidate of matches) {
      if (folder && !uriWithin(candidate, folder.uri)) continue;
      const key = normalizedUri(candidate);
      if (key === undefined) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
    return candidates;
  }

  private async probeBoundCandidate(
    relativePath: string,
    folder: WorkspaceFolderIdentity,
  ): Promise<string | undefined> {
    const root = this.host.parseUri(folder.uri);
    const candidate = this.host.joinPath(root, ...relativePath.split("/"))
      .toString();
    if (!uriWithin(candidate, folder.uri)) return undefined;

    try {
      await this.host.stat(this.host.parseUri(candidate));
      return candidate;
    } catch (error) {
      return isNotFoundError(error) ? undefined : candidate;
    }
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
  document: WorkspaceFolderSelection,
  sourceUrl: URL | undefined,
): ResolutionScope {
  const sourceMatches = matchingFolders(folders, sourceUrl);
  if (document.ambiguous || sourceMatches.length > 1) {
    return { strategy: "workspace-bound", ambiguous: true };
  }

  const documentFolder = document.folder;
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

function documentWorkspaceFolder(
  folders: readonly WorkspaceFolderIdentity[],
  documentUrl: URL | undefined,
): WorkspaceFolderSelection {
  const nameMatches = matchingFolders(folders, documentUrl);
  const owner = fileWorkspaceOwner(folders, documentUrl);
  if (nameMatches.length > 1 || owner.ambiguous) {
    return { ambiguous: true };
  }

  const nameMatch = nameMatches[0];
  if (
    nameMatch !== undefined &&
    owner.folder !== undefined &&
    nameMatch !== owner.folder
  ) {
    return { ambiguous: true };
  }
  return {
    folder: owner.folder ?? nameMatch,
    ambiguous: false,
  };
}

function fileWorkspaceOwner(
  folders: readonly WorkspaceFolderIdentity[],
  url: URL | undefined,
): WorkspaceFolderSelection {
  if (url?.protocol !== "file:") return { ambiguous: false };
  const owners = folders
    .map((folder) => ({ folder, key: normalizedUri(folder.uri) }))
    .filter((owner): owner is {
      readonly folder: WorkspaceFolderIdentity;
      readonly key: string;
    } => owner.key !== undefined && uriWithin(url.toString(), owner.folder.uri));
  if (owners.length === 0) return { ambiguous: false };

  const longest = Math.max(...owners.map((owner) => owner.key.length));
  const mostSpecific = owners.filter((owner) => owner.key.length === longest);
  return mostSpecific.length === 1
    ? { folder: mostSpecific[0]?.folder, ambiguous: false }
    : { ambiguous: true };
}

function matchingFolders(
  folders: readonly WorkspaceFolderIdentity[],
  url: URL | undefined,
): readonly WorkspaceFolderIdentity[] {
  if (url?.protocol === "file:") return [];
  const segment = firstDecodedPathSegment(url);
  return segment === undefined
    ? []
    : folders.filter((folder) => sameFolderName(segment, folder));
}

function firstDecodedPathSegment(url: URL | undefined): string | undefined {
  if (hasEncodedPathSeparator(url)) return undefined;
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

function safeUrl(value: string, baseUrl?: string | URL): URL | undefined {
  try {
    return baseUrl === undefined ? new URL(value) : new URL(value, baseUrl);
  } catch {
    return undefined;
  }
}

function safeDecodedPathname(url: URL): string | undefined {
  if (hasEncodedPathSeparator(url)) return undefined;
  try {
    return decodeURIComponent(url.pathname).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
}

function filePathUri(value: string): string | undefined {
  const url = safeUrl(value);
  return url?.protocol === "file:" ? filePathUrl(url).toString() : undefined;
}

function filePathUrl(url: URL): URL {
  const pathUrl = new URL(url.toString());
  pathUrl.search = "";
  pathUrl.hash = "";
  return pathUrl;
}

function escapeGlob(value: string): string {
  return value.replace(/[?*[\]{}]/g, (character) => `[${character}]`);
}

function normalizedUri(value: string): string | undefined {
  try {
    const uri = new URL(value);
    if (hasEncodedPathSeparator(uri)) return undefined;
    let pathname = decodeURI(uri.pathname)
      .replace(/\\/g, "/");
    const windows = isWindowsFileUri(uri, pathname);
    pathname = pathname
      .replace(/\/+$/, "")
      .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
    if (windows) {
      pathname = pathname.toLowerCase();
    }
    const suffix = uri.protocol === "file:" ? "" : `${uri.search}${uri.hash}`;
    return `${uri.protocol.toLowerCase()}//${uri.host.toLowerCase()}${pathname}${suffix}`;
  } catch {
    return undefined;
  }
}

function hasEncodedPathSeparator(url: URL | undefined): boolean {
  return url !== undefined && /%(?:2f|5c)/i.test(url.pathname);
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

function isNotFoundError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "ENOENT" || code === "FileNotFound";
}
