# Browser2IDE Workspace-Bound Source Resolution Design

**Date:** 2026-08-10
**Status:** Approved for implementation planning

## Summary

Browser2IDE will resolve browser stylesheet URLs relative to the workspace
folder named by the page or stylesheet URL. For a page under `/_ORB/` and a VS
Code workspace folder named `_ORB`, source lookup is restricted to that folder
and the `_ORB` URL prefix is removed before matching the workspace-relative
path.

When neither URL identifies a workspace folder, Browser2IDE keeps automatic
matching. Automatic mode may use a unique path or filename across the open
workspace folders. This is an explicit usability trade-off: the user accepts
the possibility of a coincidental match when the site has no project identity
in its URL.

## Problem

The inspected page serves this stylesheet:

```text
http://localhost/_ORB/wp-content/themes/orbiter/style.css?v=7
```

The VS Code workspace root is already `_ORB`, so VS Code glob patterns are
evaluated relative to this path:

```text
wp-content/themes/orbiter/style.css
```

The current resolver incorrectly searches for:

```text
**/_ORB/wp-content/themes/orbiter/style.css
```

That search returns nothing. The resolver then falls back to `**/style.css`.
A WordPress workspace contains many files with that basename, so the result is
`source-ambiguous`. `ScssSourcePlugin` consequently never opens the adjacent
source map and cannot map the generated rule to `style.scss`.

The current source-workspace test host hides this defect because its fake glob
matching includes the workspace root name. Real VS Code `findFiles` patterns
are relative to each workspace folder.

## Goals

- Map `/_ORB/...` only inside the `_ORB` workspace folder.
- Remove exactly one matching workspace-folder prefix from a source URL.
- Preserve SCSS source-map resolution after the generated CSS is found.
- Refuse ambiguous candidates instead of selecting a file arbitrarily.
- Retain automatic mapping when no workspace folder is identifiable in URLs.
- Make the selected resolution strategy visible in VS Code diagnostics.
- Correct the test host so it models VS Code root-relative glob behavior.

## Non-Goals

- Persisting URL-to-workspace mappings.
- Adding a setup wizard or project-mapping setting.
- Binding a browser origin permanently to a workspace.
- Opening or switching source files automatically.
- Changing the WebSocket protocol or browser extension message schemas.
- Resolving files outside the currently open VS Code workspace folders.

## Resolution Strategies

`SourceUriResolution` gains a strategy field:

```ts
type SourceResolutionStrategy = "workspace-bound" | "automatic";

interface SourceUriResolution {
  readonly uris: readonly string[];
  readonly status: "exact" | "unique-basename" | "not-found" | "ambiguous";
  readonly strategy: SourceResolutionStrategy;
  readonly workspaceFolderUri?: string;
}
```

This is a local plugin API change. Browser2IDE's current CSS and SCSS plugins
will migrate together; compatibility with older source plugins is not required
for this milestone.

### Workspace-Bound Mode

The resolver decodes the document URL (`baseUrl`) and the absolute stylesheet
URL (`sourceUrl` resolved against `baseUrl`). It compares each URL's first
nonempty path segment with the basename of every open workspace folder.

Workspace-bound mode is selected when exactly one workspace folder is named by
either URL. If the document and source URLs identify different workspace
folders, or multiple open folders have the same matching basename, resolution
returns `ambiguous` and no source is selected.

For a bound folder:

1. remove one leading source-path segment when it equals the bound folder name;
2. search the remaining relative path only inside the bound folder;
3. return `exact` for one candidate;
4. return `ambiguous` for multiple candidates;
5. if the exact path is absent, allow the existing unique-basename fallback,
   but restrict it to the bound folder;
6. return `not-found` when neither search has a unique result.

Folder-name comparison follows URI canonicalization already used by
`VsCodeSourceWorkspace`: Windows file-workspace names are case-insensitive;
other URI paths remain case-sensitive. Query strings and URL fragments never
participate in path matching.

### Automatic Mode

Automatic mode is selected when neither the document nor source URL identifies
an open workspace folder. It preserves the current search order across all
workspace folders:

1. search the complete decoded URL path;
2. accept one exact candidate;
3. reject multiple exact candidates as ambiguous;
4. otherwise search by basename;
5. mark one basename candidate as `unique-basename`;
6. reject multiple basename candidates as ambiguous.

Automatic mode intentionally permits a coincidental match. Diagnostics must
identify it as automatic so the user can distinguish it from a project-bound
result. Browser2IDE still never resolves outside the open workspace.

## CSS And SCSS Behavior

`CssSourcePlugin` keeps exact rule matching and its existing declaration
fingerprint fallback. A workspace-bound source that resolves to another file or
is ambiguous is never matched against the active document. When a bound source
is not found, the plugin reports that failure rather than treating an unrelated
active file as the source. Automatic mode retains the current active-document
heuristic under the user's responsibility.

`ScssSourcePlugin` accepts an exact generated CSS file in either strategy and
continues through its source map. A unique-basename generated CSS result may be
used only in automatic mode and must add an informational heuristic diagnostic.
The mapped original SCSS source must still resolve uniquely and equal the active
document before any decoration is published.

Both plugins continue to return complete rule-block ranges. Selected-element
and immediate-parent decorations retain their existing colors and precedence.

## Diagnostics

VS Code diagnostics record, for the latest resolution:

- `Workspace-bound: <folder name>` when a URL selected one folder;
- `Automatic source matching` when no folder name was available;
- the existing not-found, other-document, ambiguous, source-map, and rule-match
  outcomes.

Only the workspace folder label is shown in the strategy summary. Absolute
local paths remain in the detailed local diagnostics and do not cross the
WebSocket boundary. The Firefox/Chrome footer keeps its existing bounded
resolution status; no protocol change is needed.

## Error Handling

- Malformed or undecodable URLs return `not-found` with the appropriate
  strategy diagnostic instead of throwing through the presenter.
- Conflicting workspace names return `ambiguous` and disable heuristic rule
  matching for that fact.
- Duplicate results are canonicalized and deduplicated before cardinality is
  evaluated.
- A matching workspace URL prefix is removed at most once.
- A source-map reference remains constrained by `isWorkspaceUri` before it is
  read.
- Cancellation continues to stop stale resolution work after a newer browser
  selection or editor change.

## Testing Strategy

The source-workspace test host will match globs against paths relative to each
workspace folder, mirroring VS Code instead of including the folder basename.

Focused tests cover:

- `/_ORB/wp-content/themes/orbiter/style.css?v=7` resolving to the unique file
  under an `_ORB` root even when many other `style.css` files exist;
- no candidate outside `_ORB` being accepted in workspace-bound mode;
- document/source URLs naming conflicting roots;
- duplicate workspace folder basenames producing ambiguity;
- case-insensitive Windows workspace-prefix matching;
- a URL without a workspace name retaining automatic exact and basename
  behavior;
- automatic-mode ambiguity across multiple roots;
- CSS refusing source-miss fingerprint fallback in workspace-bound mode;
- CSS retaining that heuristic in automatic mode;
- SCSS loading `style.css.map` and mapping to the active `style.scss` after
  prefix normalization;
- SCSS automatic unique-basename use being diagnosed as heuristic;
- malformed encoded paths failing without an uncaught exception.

The complete workspace build, test, typecheck, lint, Firefox `web-ext` lint,
and packaged-artifact gates run after the focused tests.

## Acceptance Criteria

1. Selecting the demonstrated `_ORB` DOM element no longer reports
   `Ambiguous source path` solely because WordPress contains other
   `style.css` files.
2. With `style.scss` active, Browser2IDE reads the resolved generated CSS and
   source map and highlights every applicable complete SCSS block.
3. A URL that identifies `_ORB` never resolves a candidate from another
   workspace folder.
4. Ambiguous or conflicting project identities produce no decoration.
5. URLs without a project identity still use automatic matching, and VS Code
   diagnostics label that strategy explicitly.
6. Existing browser inspection, parent highlighting, WebSocket pairing, and
   read-only security behavior remain unchanged.
