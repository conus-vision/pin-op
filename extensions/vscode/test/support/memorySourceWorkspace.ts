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
  const candidatePath = decodedPath(candidate);
  const folderPath = decodedPath(folder).replace(/\/+$/, "");
  const windows = /^\/[a-z]:\//i.test(candidatePath) ||
    /^\/[a-z]:\//i.test(folderPath);
  const comparableCandidate = windows ? candidatePath.toLowerCase() : candidatePath;
  const comparableFolder = windows ? folderPath.toLowerCase() : folderPath;
  if (comparableCandidate === comparableFolder) return "";
  if (!comparableCandidate.startsWith(`${comparableFolder}/`)) return undefined;
  return candidatePath.slice(folderPath.length + 1);
}

function decodedPath(value: string): string {
  return decodeURIComponent(new URL(value).pathname).replace(/\\/g, "/");
}

function uri(value: string): UriLike {
  return { toString: () => value };
}

function unescapeGlob(value: string): string {
  return value.replace(/\[([^\]])\]/g, "$1");
}
