import {
  VsCodeSourceWorkspace,
  type UriLike,
  type WorkspaceHost,
} from "../../src/sourcePlugins/sourceWorkspace.js";

const EXCLUDE = "**/{node_modules,.git}/**";

export function memorySourceWorkspace(
  files: Readonly<Record<string, string>>,
  folders: readonly string[] = ["file:///workspace"],
): VsCodeSourceWorkspace {
  const encoder = new TextEncoder();
  const host: WorkspaceHost = {
    workspaceFolders: folders.map((folder) => ({ uri: uri(folder) })),
    async findFiles(pattern, exclude) {
      if (exclude !== EXCLUDE) throw new Error(`Unexpected exclude: ${exclude}`);
      const suffix = unescapeGlob(pattern.replace(/^\*\*\//, ""));
      return Object.keys(files)
        .filter((candidate) => folders.some((folder) => {
          const relative = workspaceRelativePath(candidate, folder);
          return relative !== undefined &&
            (relative === suffix || relative.endsWith(`/${suffix}`));
        }))
        .map(uri);
    },
    parseUri: uri,
    async readFile(value) {
      const text = files[value.toString()];
      if (text === undefined) throw new Error(`Missing fixture: ${value}`);
      return encoder.encode(text);
    },
  };
  return new VsCodeSourceWorkspace(host);
}

function workspaceRelativePath(
  candidate: string,
  folder: string,
): string | undefined {
  const candidateUri = new URL(candidate);
  const folderUri = new URL(folder);
  if (!sameSchemeAndAuthority(candidateUri, folderUri)) return undefined;
  if (
    hasEncodedPathSeparator(candidateUri) ||
    hasEncodedPathSeparator(folderUri)
  ) {
    return undefined;
  }

  const candidatePath = decodedPath(candidateUri);
  const folderPath = decodedPath(folderUri).replace(/\/+$/, "");
  const windows = /^\/[a-z]:\//i.test(candidatePath) ||
    /^\/[a-z]:\//i.test(folderPath);
  const comparableCandidate = windows ? candidatePath.toLowerCase() : candidatePath;
  const comparableFolder = windows ? folderPath.toLowerCase() : folderPath;
  let relative: string;
  if (comparableCandidate === comparableFolder) {
    relative = "";
  } else {
    if (!comparableCandidate.startsWith(`${comparableFolder}/`)) {
      return undefined;
    }
    relative = candidatePath.slice(folderPath.length + 1);
  }
  return isExcludedWorkspacePath(relative, windows) ? undefined : relative;
}

function sameSchemeAndAuthority(left: URL, right: URL): boolean {
  return left.protocol === right.protocol &&
    left.username === right.username &&
    left.password === right.password &&
    left.host === right.host;
}

function hasEncodedPathSeparator(url: URL): boolean {
  return /%(?:2f|5c)/i.test(url.pathname);
}

function isExcludedWorkspacePath(relative: string, windows: boolean): boolean {
  return relative.split("/").some((segment) => {
    const comparable = windows ? segment.toLowerCase() : segment;
    return comparable === ".git" || comparable === "node_modules";
  });
}

function decodedPath(value: URL): string {
  return decodeURIComponent(value.pathname).replace(/\\/g, "/");
}

function uri(value: string): UriLike {
  return { toString: () => value };
}

function unescapeGlob(value: string): string {
  return value.replace(/\[([?*[\]{}])\]/g, "$1");
}
