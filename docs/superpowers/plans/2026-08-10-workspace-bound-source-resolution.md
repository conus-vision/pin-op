# Workspace-Bound Source Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `/_ORB/...` browser stylesheets inside the `_ORB` VS Code workspace folder, continue through SCSS source maps, and retain an explicitly diagnosed automatic fallback when URLs do not identify a project.

**Architecture:** Extend the local source-plugin API so every URI resolution reports `workspace-bound` or `automatic`. `VsCodeSourceWorkspace` derives an optional folder identity from document and source URL prefixes, scopes glob results to that folder, and strips the folder prefix once. CSS and SCSS consume the strategy to control heuristics and append local-only diagnostics; the WebSocket protocol remains unchanged.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, VS Code workspace APIs, PostCSS, `source-map`, Firefox `web-ext` validation.

---

## File Map

- Modify `packages/plugin-api/src/index.ts`: publish source-resolution strategy and optional bound-folder URI.
- Modify `extensions/vscode/src/sourcePlugins/sourceWorkspace.ts`: choose a strategy, normalize the workspace URL prefix, scope and deduplicate candidates, and fail safely on malformed URLs.
- Create `extensions/vscode/test/support/memorySourceWorkspace.ts`: model VS Code root-relative glob matching for resolver and SCSS integration tests.
- Modify `extensions/vscode/test/sourceWorkspace.test.ts`: replace the inaccurate local host and cover bound, automatic, conflicting, Windows, and malformed URL behavior.
- Modify `extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts`: disable source-miss fingerprint guessing in bound mode and report the strategy locally.
- Modify `extensions/vscode/test/cssSourcePlugin.test.ts`: migrate resolution fixtures and prove strict versus automatic CSS behavior.
- Modify `extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts`: permit diagnosed automatic basename discovery for generated CSS while retaining strict original-source checks.
- Modify `extensions/vscode/test/scssSourcePlugin.test.ts`: migrate fixtures, cover strategy behavior, and exercise the `_ORB` resolver through a real source map.
- Modify `docs/architecture.md`: document bound and automatic source resolution.
- Modify `docs/mvp-usage.md`: document strategy diagnostics and the accepted automatic-mode risk.
- Modify `docs/mvp-verification.md`: add installed verification for a workspace-name URL prefix.

### Task 1: Source API And Workspace Resolver

**Files:**
- Modify: `packages/plugin-api/src/index.ts:32`
- Modify: `extensions/vscode/src/sourcePlugins/sourceWorkspace.ts:11`
- Create: `extensions/vscode/test/support/memorySourceWorkspace.ts`
- Modify: `extensions/vscode/test/sourceWorkspace.test.ts:1`

- [ ] **Step 1: Create the root-relative test workspace**

Create `extensions/vscode/test/support/memorySourceWorkspace.ts` with a reusable host that evaluates `**/...` against each workspace-relative path, never against the folder's own basename:

```ts
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

function workspaceRelativePath(candidate: string, folder: string): string | undefined {
  const candidatePath = decodedPath(candidate);
  const folderPath = decodedPath(folder).replace(/\/+$/, "");
  const windows = /^\/[a-z]:\//i.test(candidatePath) || /^\/[a-z]:\//i.test(folderPath);
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
```

Replace the private `sourceWorkspace`, `uri`, and `unescapeGlob` helpers in `sourceWorkspace.test.ts` with an import of `memorySourceWorkspace`.

- [ ] **Step 2: Write failing workspace-bound resolver tests**

Add focused tests to `extensions/vscode/test/sourceWorkspace.test.ts`. Migrate every existing expected `SourceUriResolution` to include `strategy`; automatic expectations use `strategy: "automatic"`.

```ts
it("binds an _ORB URL to the _ORB root before basename fallback", async () => {
  const intended = "file:///D:/sites/_ORB/wp-content/themes/orbiter/style.css";
  const workspace = memorySourceWorkspace(
    {
      [intended]: "body {}",
      "file:///D:/sites/_ORB/wp-includes/css/style.css": "a {}",
      "file:///D:/sites/_ORB/wp-admin/css/style.css": "b {}",
      "file:///D:/sites/OTHER/wp-content/themes/orbiter/style.css": "c {}",
    },
    ["file:///D:/sites/_ORB", "file:///D:/sites/OTHER"],
  );

  await expect(workspace.resolveSourceUri(
    "/_ORB/wp-content/themes/orbiter/style.css?v=7",
    "http://localhost/_ORB/",
  )).resolves.toEqual({
    uris: [intended],
    status: "exact",
    strategy: "workspace-bound",
    workspaceFolderUri: "file:///D:/sites/_ORB",
  });
});

it("rejects conflicting and duplicate workspace identities", async () => {
  const conflicting = memorySourceWorkspace({}, [
    "file:///sites/_ORB",
    "file:///sites/OTHER",
  ]);
  const duplicates = memorySourceWorkspace({}, [
    "file:///work/a/_ORB",
    "file:///work/b/_ORB",
  ]);

  await expect(conflicting.resolveSourceUri(
    "/OTHER/style.css",
    "http://localhost/_ORB/",
  )).resolves.toEqual({
    uris: [],
    status: "ambiguous",
    strategy: "workspace-bound",
  });
  await expect(duplicates.resolveSourceUri(
    "/_ORB/style.css",
    "http://localhost/_ORB/",
  )).resolves.toEqual({
    uris: [],
    status: "ambiguous",
    strategy: "workspace-bound",
  });
});

it("keeps URL-without-project matching automatic", async () => {
  const uri = "file:///workspace/src/styles/app.css";
  const workspace = memorySourceWorkspace({ [uri]: "a {}" });

  await expect(workspace.resolveSourceUri(
    "/assets/app.css",
    "http://localhost:3000/",
  )).resolves.toEqual({
    uris: [uri],
    status: "unique-basename",
    strategy: "automatic",
  });
});

it("matches Windows workspace URL prefixes case-insensitively", async () => {
  const uri = "file:///C:/sites/_ORB/styles/app.css";
  const workspace = memorySourceWorkspace({ [uri]: "a {}" }, [
    "file:///C:/sites/_ORB",
  ]);

  await expect(workspace.resolveSourceUri(
    "/_orb/styles/app.css",
    "http://localhost/_orb/",
  )).resolves.toEqual({
    uris: [uri],
    status: "exact",
    strategy: "workspace-bound",
    workspaceFolderUri: "file:///C:/sites/_ORB",
  });
});

it("returns not-found instead of throwing for malformed encoded paths", async () => {
  const workspace = memorySourceWorkspace({}, ["file:///sites/_ORB"]);

  await expect(workspace.resolveSourceUri(
    "/_ORB/%E0%A4%A.css",
    "http://localhost/_ORB/",
  )).resolves.toEqual({
    uris: [],
    status: "not-found",
    strategy: "workspace-bound",
    workspaceFolderUri: "file:///sites/_ORB",
  });
});
```

- [ ] **Step 3: Run the resolver test and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/sourceWorkspace.test.ts
```

Expected: FAIL. The `_ORB` case reports `ambiguous`, existing results lack `strategy`, and malformed decoding throws.

- [ ] **Step 4: Extend the plugin API**

Modify `packages/plugin-api/src/index.ts`:

```ts
export type SourceResolutionStrategy = "workspace-bound" | "automatic";

export interface SourceUriResolution {
  readonly uris: readonly string[];
  readonly status: "exact" | "unique-basename" | "not-found" | "ambiguous";
  readonly strategy: SourceResolutionStrategy;
  readonly workspaceFolderUri?: string;
}
```

- [ ] **Step 5: Implement bound and automatic resolution**

Refactor `VsCodeSourceWorkspace.resolveSourceUri` so it first creates safe URL and workspace-folder identities, then calls one shared candidate resolver. Preserve the existing file-URI fast path, but return the containing folder as `workspace-bound`.

Use these internal shapes and branch order:

```ts
interface WorkspaceFolderIdentity {
  readonly uri: string;
  readonly name: string;
  readonly windows: boolean;
}

interface ResolutionScope {
  readonly strategy: "workspace-bound" | "automatic";
  readonly folder?: WorkspaceFolderIdentity;
  readonly ambiguous: boolean;
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
    const owner = folders.find((folder) => uriWithin(canonical, folder.uri));
    return owner
      ? {
          uris: [canonical],
          status: "exact",
          strategy: "workspace-bound",
          workspaceFolderUri: owner.uri,
        }
      : { uris: [], status: "not-found", ...baseResult };
  }

  const pathname = safeDecodedPathname(absolute);
  if (!pathname) return { uris: [], status: "not-found", ...baseResult };
  let relativePath = pathname.replace(/^\/+/, "");
  if (scope.folder) {
    relativePath = stripLeadingFolder(relativePath, scope.folder);
  }
  if (!relativePath) return { uris: [], status: "not-found", ...baseResult };

  const exact = await this.findCandidates(relativePath, scope.folder);
  if (exact.length === 1) return { uris: exact, status: "exact", ...baseResult };
  if (exact.length > 1) return { uris: [], status: "ambiguous", ...baseResult };

  const basename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const fallback = await this.findCandidates(basename, scope.folder);
  return fallback.length === 1
    ? { uris: fallback, status: "unique-basename", ...baseResult }
    : {
        uris: [],
        status: fallback.length > 1 ? "ambiguous" : "not-found",
        ...baseResult,
      };
}
```

`findCandidates` must call the existing excluded `findFiles`, deduplicate by canonical URI, and filter every result through `uriWithin` when `scope.folder` exists. `resolutionScope` compares first decoded URL segments with folder basenames, uses Windows-insensitive comparison only for Windows file roots, and returns ambiguous when URLs identify different folders or duplicate folder names. `safeUrl` and `safeDecodedPathname` catch URL/decoding failures and return `undefined`.

- [ ] **Step 6: Run focused tests and plugin API checks for GREEN**

Run:

```powershell
corepack pnpm --filter @browser2ide/plugin-api build
corepack pnpm --filter browser2ide-vscode exec vitest run test/sourceWorkspace.test.ts
corepack pnpm --filter @browser2ide/plugin-api typecheck
```

Expected: all commands exit 0 and resolver tests pass. The full VS Code
typecheck is intentionally deferred until Tasks 2 and 3 migrate every typed
CSS/SCSS fixture to the required `strategy` field.

- [ ] **Step 7: Commit the API and resolver**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/plugin-api/src/index.ts extensions/vscode/src/sourcePlugins/sourceWorkspace.ts extensions/vscode/test/sourceWorkspace.test.ts extensions/vscode/test/support/memorySourceWorkspace.ts
git -c safe.directory=F:/_Browser2IDE commit -m "fix(vscode): bind source URLs to workspace roots"
```

### Task 2: CSS Strategy Policy And Diagnostics

**Files:**
- Modify: `extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts:45`
- Modify: `extensions/vscode/test/cssSourcePlugin.test.ts:1090`

- [ ] **Step 1: Migrate CSS resolution fixtures**

Add `strategy: "automatic"` to the default `Resolution` in `resolveCss` and to automatic not-found/basename fixtures. Add `strategy: "workspace-bound"` plus `workspaceFolderUri: "file:///workspace"` to exact bound fixtures where the URI identifies the active workspace.

- [ ] **Step 2: Write failing strict-versus-automatic CSS tests**

Add:

```ts
it("refuses source-miss fingerprint fallback in workspace-bound mode", async () => {
  const result = await resolveCss(
    ".card { display: grid; }",
    selection([cssTargetWithDeclarations(
      "selected",
      ".card",
      "/_ORB/missing/app.css",
      [["display", "grid"]],
    )]),
    {
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///workspace/_ORB",
    },
  );

  expect(result.matches).toEqual([]);
  expect(result.status).toBe("source-not-found");
  expect(result.diagnostics?.map((entry) => entry.code)).toContain(
    "css.sourceWorkspaceBound",
  );
});

it("retains source-miss fingerprint fallback in automatic mode", async () => {
  const result = await resolveCss(
    ".card { display: grid; }",
    selection([cssTargetWithDeclarations(
      "selected",
      ".card",
      "/assets/app.css",
      [["display", "grid"]],
    )]),
    { uris: [], status: "not-found", strategy: "automatic" },
  );

  expect(result.status).toBe("matched");
  expect(result.matches[0]?.confidence).toBe("heuristic");
  expect(result.diagnostics?.map((entry) => entry.code)).toContain(
    "css.sourceAutomatic",
  );
});
```

- [ ] **Step 3: Run CSS tests and verify RED**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/cssSourcePlugin.test.ts
```

Expected: FAIL because bound `not-found` still falls back and strategy diagnostics do not exist.

- [ ] **Step 4: Gate CSS fallback by strategy**

In `CssSourcePlugin.resolve`, change only the wholly missing-source branch:

```ts
const canFallback = sourceKind === "not-found"
  ? resolution.strategy === "automatic" && canFingerprintFallback(entry.fact)
  : canFingerprintFallback(entry.fact, context.document);
```

Keep exact active-document path fallback unchanged; a stale CSSOM rule path may still use a strong fingerprint after the stylesheet URI has been proven to equal the active document.

- [ ] **Step 5: Append one local strategy diagnostic per strategy**

Collect diagnostics in insertion order while processing facts, then append them after existing source/rule diagnostics so current failure precedence and first-error expectations remain stable:

```ts
function sourceStrategyDiagnostic(
  resolution: SourceUriResolution,
): PluginDiagnostic {
  if (resolution.strategy === "automatic") {
    return {
      code: "css.sourceAutomatic",
      message: "Automatic source matching",
      severity: "info",
    };
  }
  return {
    code: "css.sourceWorkspaceBound",
    message: `Workspace-bound: ${workspaceLabel(resolution.workspaceFolderUri)}`,
    severity: "info",
  };
}

function workspaceLabel(uri: string | undefined): string {
  if (!uri) return "ambiguous workspace";
  try {
    return decodeURIComponent(new URL(uri).pathname.split("/").filter(Boolean).at(-1) ?? "workspace");
  } catch {
    return "workspace";
  }
}
```

Use a `Map<string, PluginDiagnostic>` keyed by diagnostic code and message to avoid one entry per CSS fact. Do not place absolute URIs in diagnostic metadata or messages.

- [ ] **Step 6: Run CSS tests for GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/cssSourcePlugin.test.ts
```

Expected: CSS tests pass. Full VS Code typecheck remains deferred until the
SCSS fixture migration in Task 3.

- [ ] **Step 7: Commit CSS policy**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts extensions/vscode/test/cssSourcePlugin.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "fix(vscode): enforce bound CSS source policy"
```

### Task 3: SCSS Strategy And `_ORB` Source-Map Regression

**Files:**
- Modify: `extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts:45`
- Modify: `extensions/vscode/test/scssSourcePlugin.test.ts:250`
- Use: `extensions/vscode/test/support/memorySourceWorkspace.ts`

- [ ] **Step 1: Migrate SCSS workspace fixtures**

Every `resolveSourceUri` result in `scssSourcePlugin.test.ts` must include a strategy. The `memoryWorkspace` helper returns `strategy: "automatic"` for URL-path searches and returns `strategy: "workspace-bound", workspaceFolderUri: "file:///workspace"` for exact `file:` URIs inside the fixture root.

- [ ] **Step 2: Write failing generated-CSS strategy tests**

Replace the old blanket rejection test with two explicit cases:

```ts
it("uses a unique generated basename only in automatic mode", async () => {
  const activeUri = "file:///workspace/src/card.scss";
  const generatedUri = "file:///workspace/build/app.css";
  const mapUri = `${generatedUri}.map`;
  const generator = new SourceMapGenerator({ file: "app.css" });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: "../src/card.scss",
  });
  const files = {
    [activeUri]: ".card { color: red; }",
    [generatedUri]: ".card { color: red; }\n/*# sourceMappingURL=app.css.map */",
    [mapUri]: generator.toString(),
  };
  const base = memoryWorkspace(files);
  const result = await new ScssSourcePlugin().resolve({
    selection: selection([cssTarget("selected", ".card", "/assets/app.css")]),
    document: document(activeUri, files[activeUri]),
    workspace: {
      ...base,
      resolveSourceUri: async (sourceUrl, baseUrl) =>
        sourceUrl === "/assets/app.css"
          ? {
              uris: [generatedUri],
              status: "unique-basename",
              strategy: "automatic",
            }
          : base.resolveSourceUri(sourceUrl, baseUrl),
    },
    signal: new AbortController().signal,
  });

  expect(result.status).toBe("matched");
  expect(result.diagnostics?.map((entry) => entry.code)).toContain(
    "scss.generatedSourceHeuristic",
  );
});

it("rejects a workspace-bound unique generated basename", async () => {
  const result = await resolveWithGeneratedResolution({
    uris: ["file:///workspace/build/app.css"],
    status: "unique-basename",
    strategy: "workspace-bound",
    workspaceFolderUri: "file:///workspace",
  });

  expect(result.matches).toEqual([]);
  expect(result.status).toBe("source-not-found");
});
```

Add this test helper next to `resolveScss`:

```ts
async function resolveWithGeneratedResolution(
  resolution: Awaited<ReturnType<SourceWorkspace["resolveSourceUri"]>>,
) {
  const activeUri = "file:///workspace/src/card.scss";
  const generatedUri = "file:///workspace/build/app.css";
  const files = {
    [activeUri]: ".card { color: red; }",
    [generatedUri]: ".card { color: red; }",
  };
  const base = memoryWorkspace(files);
  return new ScssSourcePlugin().resolve({
    selection: selection([cssTarget(
      "selected",
      ".card",
      "/assets/app.css",
    )]),
    document: document(activeUri, files[activeUri]),
    workspace: {
      ...base,
      resolveSourceUri: async (sourceUrl, baseUrl) =>
        sourceUrl === "/assets/app.css"
          ? resolution
          : base.resolveSourceUri(sourceUrl, baseUrl),
    },
    signal: new AbortController().signal,
  });
}
```

- [ ] **Step 3: Write the end-to-end `_ORB` source-map test**

Import `memorySourceWorkspace` and add:

```ts
it("maps an _ORB stylesheet through the workspace-bound resolver", async () => {
  const root = "file:///D:/sites/_ORB";
  const activeUri = `${root}/wp-content/themes/orbiter/style.scss`;
  const generatedUri = `${root}/wp-content/themes/orbiter/style.css`;
  const mapUri = `${generatedUri}.map`;
  const generator = new SourceMapGenerator({ file: "style.css" });
  generator.addMapping({
    generated: { line: 1, column: 0 },
    original: { line: 1, column: 0 },
    source: "style.scss",
  });
  const original = ".home_slide_title { color: red; }";
  const generated = `${original}\n/*# sourceMappingURL=style.css.map */`;
  const workspace = memorySourceWorkspace(
    {
      [activeUri]: original,
      [generatedUri]: generated,
      [mapUri]: generator.toString(),
      [`${root}/wp-admin/css/style.css`]: "body {}",
      [`${root}/wp-includes/css/style.css`]: "body {}",
    },
    [root],
  );
  const selected = selection([cssTarget(
    "selected",
    ".home_slide_title",
    "/_ORB/wp-content/themes/orbiter/style.css?v=7",
    { rulePath: "0.0" },
  )], "http://localhost/_ORB/");

  const result = await new ScssSourcePlugin().resolve({
    selection: selected,
    document: document(activeUri, original),
    workspace,
    signal: new AbortController().signal,
  });

  expect(result.status).toBe("matched");
  expect(result.matches).toEqual([
    expect.objectContaining({
      targetRole: "selected",
      confidence: "sourcemap",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: original.length },
      },
    }),
  ]);
  expect(result.diagnostics?.map((entry) => entry.code)).toContain(
    "scss.sourceWorkspaceBound",
  );
});
```

Allow the `selection` helper to accept an optional context URL while preserving
its existing default:

```ts
function selection(
  targets: readonly InspectTarget[],
  url = "http://localhost:4173/page",
): SelectionSnapshot {
  return {
    sessionId: "session-1",
    messageId: "inspect-1",
    targets,
    context: { url, metadata: {} },
    metadata: {},
  };
}
```

- [ ] **Step 4: Run SCSS tests and verify RED**

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/scssSourcePlugin.test.ts
```

Expected: FAIL because automatic unique basenames are rejected, strategy diagnostics are absent, and the `_ORB` integration cannot pass until all strategy handling is implemented.

- [ ] **Step 5: Implement SCSS strategy handling**

In `ScssSourcePlugin.resolve`, accept generated CSS only under these conditions:

```ts
const generatedIsExact = generatedResolution.status === "exact" &&
  generatedResolution.uris.length === 1;
const generatedIsAutomaticBasename =
  generatedResolution.strategy === "automatic" &&
  generatedResolution.status === "unique-basename" &&
  generatedResolution.uris.length === 1;

if (!generatedIsExact && !generatedIsAutomaticBasename) {
  failures.add("source-not-found");
  diagnostics.push(diagnostic(
    "scss.generatedSourceNotFound",
    `Generated CSS is not in the workspace: ${entry.sourceUrl}`,
    "info",
  ));
  continue;
}
if (generatedIsAutomaticBasename) {
  diagnostics.push(diagnostic(
    "scss.generatedSourceHeuristic",
    `Generated CSS used automatic basename matching: ${entry.sourceUrl}`,
    "info",
  ));
}
```

Keep the existing ambiguous check before this block. Keep original SCSS source acceptance exact-only via `classifyActiveDocumentSource`; do not grant a basename result active-document authority.

Collect and append deduplicated `scss.sourceWorkspaceBound` and
`scss.sourceAutomatic` informational diagnostics. Keep a private
`workspaceLabel` helper in `scssSourcePlugin.ts` with the same sanitization as
CSS, and use the exact messages `Workspace-bound: <label>` and
`Automatic source matching`. Do not include an absolute workspace URI.

- [ ] **Step 6: Run focused and combined VS Code tests for GREEN**

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/sourceWorkspace.test.ts test/cssSourcePlugin.test.ts test/scssSourcePlugin.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: all focused tests and typecheck pass with no missing `strategy` fixtures.

- [ ] **Step 7: Commit SCSS behavior**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts extensions/vscode/test/scssSourcePlugin.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "fix(vscode): resolve bound SCSS source maps"
```

### Task 4: Documentation, Full Gate, And Installable Artifact

**Files:**
- Modify: `docs/architecture.md:85`
- Modify: `docs/mvp-usage.md:100`
- Modify: `docs/mvp-verification.md:175`
- Generated: `artifacts/browser2ide-vscode-0.3.0.vsix`

- [ ] **Step 1: Document the source strategies**

Add this behavior to architecture and usage documentation:

```text
Workspace-bound resolution is selected when the document or stylesheet URL
starts with an open workspace folder name. Browser2IDE strips that segment once
and searches only that folder. Without a matching folder name it uses automatic
exact-path and unique-basename matching across open folders; diagnostics label
this weaker strategy and the user accepts the possibility of a coincidental
match.
```

Document that bound source misses do not fingerprint-match an unrelated active
CSS document, while automatic mode retains the heuristic. Document that SCSS
always requires a usable map into the active SCSS file.

- [ ] **Step 2: Extend installed verification**

Add a workspace-prefix check to `docs/mvp-verification.md`:

```text
For a project folder `_ORB` served at `http://localhost/_ORB/`, select an
element whose stylesheet is `/_ORB/wp-content/themes/orbiter/style.css` while
`style.scss` is active. Confirm complete SCSS blocks are highlighted and Open
Diagnostics reports `Workspace-bound: _ORB`, not `Ambiguous source path`, even
when the workspace contains other files named `style.css`.
```

Also add an automatic-mode check using the existing root fixture URL and confirm
Open Diagnostics reports `Automatic source matching`.

- [ ] **Step 3: Run documentation and diff checks**

```powershell
git -c safe.directory=F:/_Browser2IDE diff --check
rg -n "Workspace-bound|Automatic source matching" docs/architecture.md docs/mvp-usage.md docs/mvp-verification.md
```

Expected: `diff --check` exits 0 and all three documents contain the new terms.

- [ ] **Step 4: Run the complete automated gate**

```powershell
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: every command exits 0. Vitest reports no failed tests and `web-ext`
reports zero errors, warnings, and notices.

- [ ] **Step 5: Build and smoke-test installable artifacts**

```powershell
corepack pnpm package
corepack pnpm smoke:vscode-package
corepack pnpm smoke:chrome-package
```

Expected: package verification and both smoke commands exit 0. The VSIX at
`artifacts/browser2ide-vscode-0.3.0.vsix` contains the new resolver bundle.

- [ ] **Step 6: Commit documentation**

```powershell
git -c safe.directory=F:/_Browser2IDE add docs/architecture.md docs/mvp-usage.md docs/mvp-verification.md
git -c safe.directory=F:/_Browser2IDE commit -m "docs: explain workspace-bound source matching"
```

- [ ] **Step 7: Verify final repository state**

```powershell
git -c safe.directory=F:/_Browser2IDE status --short --branch
git -c safe.directory=F:/_Browser2IDE log -5 --oneline
```

Expected: only the pre-existing unrelated untracked files remain; the latest
commits cover resolver/API, CSS, SCSS, and documentation. Do not add, delete, or
modify `.superpowers/`, `debug.log`, or
`docs/superpowers/plans/2026-07-09-browser2ide-mvp.md`.
