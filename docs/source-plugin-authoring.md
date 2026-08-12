# PinOp Source Plugin Authoring

Source plugins connect runtime facts from a browser selection to ranges in the
active VS Code document. A plugin is a separately installed VS Code extension;
PinOp never loads plugin code or packages from the inspected workspace.

Only CSS and SCSS plugins ship as production implementations today. The public
API is intentionally general enough for framework and template integrations.

## Extension Setup

Declare the PinOp core extension as a dependency. The canonical extension
identifier is `conus-vision.pinop`.

```json
{
  "publisher": "example",
  "name": "pinop-twig",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "main": "./dist/extension.cjs",
  "extensionDependencies": ["conus-vision.pinop"],
  "activationEvents": ["onLanguage:twig"]
}
```

During repository development, depend on `@pinop/plugin-api` with
`workspace:*`. After the first package release, use its published compatible
semver range. Keep `vscode` external when bundling. The API package contains
plain TypeScript contracts and can be imported by tests without starting VS
Code.

## Register A Plugin

The example below consumes development-only `twig.template` facts. Its runtime
producer supplies a template URI and zero-based, end-exclusive offsets. The
plugin verifies that the URI resolves to the active document before returning a
match.

```ts
import * as vscode from "vscode";
import {
  SOURCE_PLUGIN_API_VERSION,
  type PinOpApi,
  type SourceMatch,
  type SourcePlugin,
} from "@pinop/plugin-api";

const twigPlugin: SourcePlugin = {
  id: "example.twig-source",
  displayName: "Twig Source",
  apiVersion: SOURCE_PLUGIN_API_VERSION,
  documentSelectors: [{ languageId: "twig", scheme: "file" }],
  supportedFactKinds: ["twig.template"],

  async resolve(context) {
    const matches: SourceMatch[] = [];

    for (const target of context.selection.targets) {
      for (const fact of target.facts) {
        if (fact.type !== "twig.template") continue;

        const template = fact.payload.template;
        const startOffset = fact.payload.startOffset;
        const endOffset = fact.payload.endOffset;
        if (
          typeof template !== "string" ||
          typeof startOffset !== "number" ||
          typeof endOffset !== "number" ||
          !Number.isInteger(startOffset) ||
          !Number.isInteger(endOffset)
        ) {
          continue;
        }

        if (context.signal.aborted) return { matches: [] };
        const resolution = await context.workspace.resolveSourceUri(
          template,
          context.selection.context.url,
        );
        if (context.signal.aborted) return { matches: [] };
        if (
          resolution.status !== "exact" ||
          resolution.uris.length !== 1 ||
          resolution.uris[0] !== context.document.uri
        ) {
          continue;
        }

        const text = context.document.getText();
        if (
          startOffset < 0 ||
          endOffset <= startOffset ||
          endOffset > text.length
        ) {
          continue;
        }

        matches.push({
          targetRole: target.role,
          range: {
            start: context.document.positionAt(startOffset),
            end: context.document.positionAt(endOffset),
          },
          label: "Twig template block",
          kind: "template",
          relation: "templates",
          confidence: "instrumented",
        });
      }
    }

    return { matches };
  },
};

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const core = vscode.extensions.getExtension<PinOpApi>(
    "conus-vision.pinop",
  );
  if (!core) throw new Error("PinOp core extension is unavailable");

  const api = await core.activate();
  if (api.apiVersion !== SOURCE_PLUGIN_API_VERSION) {
    throw new Error(`Unsupported PinOp API version: ${api.apiVersion}`);
  }

  context.subscriptions.push(api.registerSourcePlugin(twigPlugin));
}
```

`SOURCE_PLUGIN_API_VERSION` is currently `1`. Reject an incompatible core API
before registration. Plugin IDs must be globally unique; duplicate IDs fail at
registration. Dispose the returned registration with the extension context so
the core can clear results when the extension is deactivated.

## Resolution Contract

PinOp uses document-first dispatch:

1. The current browser selection is retained independently of the editor.
2. The active document filters plugins by `languageId` and URI scheme.
3. A plugin runs only when one of its `supportedFactKinds` occurs on a selected
   or parent target.
4. Every compatible plugin resolves independently against that one document.
5. Core validates, deduplicates, and presents the combined result.

Follow these rules in every resolver:

- Return every relevant match in the active document, and no matches in other
  documents.
- Never open an editor, switch files, or choose decoration colors. Those are
  core presenter responsibilities.
- Treat `SourceRange` positions as zero-based and the end position as
  exclusive.
- Check `context.signal.aborted` before and after file reads, parsing, source-map
  work, and other expensive operations. Core uses a two-second soft deadline.
- Use only the provided `SourceDocument` and `SourceWorkspace` host services
  when possible. Host workspace services do not fetch network URLs or execute
  project modules.
- Treat source identity as authoritative only when `resolution.status` is
  `exact`, `resolution.uris` contains exactly one URI, and that URI is exactly
  `context.document.uri`.
- Return structured diagnostics for recoverable failures. Do not include page
  secrets, pairing codes, or session tokens in a diagnostic or its metadata.

Every source URI resolution includes a required `strategy` field:

- `workspace-bound` means an open workspace-folder identity constrained the
  lookup.
- `automatic` means no project identity was available. The risk of a
  coincidental match is the plugin and user's responsibility.

The separate `unique-basename` resolution status is heuristic. Do not treat it
as authoritative source identity unless the plugin has independent evidence,
and clearly diagnose that heuristic when using it.

Core discards out-of-bounds ranges, unknown target roles, cancelled results,
and results from superseded document or selection generations. One plugin
failure does not stop other plugins, and stale results cannot retain editor
decorations.

Return a diagnostic when a recoverable mapping problem is useful to the user:

```ts
return {
  matches: [],
  diagnostics: [{
    code: "example.twig.source-not-found",
    message: "The instrumented template is not in the active workspace.",
    severity: "warning",
    metadata: { template: "templates/card.twig" },
  }],
};
```

Keep diagnostic codes plugin-scoped and metadata small. A malformed individual
fact can usually be skipped; use a diagnostic when it explains why the active
document could not be resolved.

## Confidence

Use the narrowest accurate confidence value:

- `exact`: direct runtime evidence identifies the source range without a
  transformation.
- `sourcemap`: a generated source position was mapped through a source map.
- `instrumented`: a development runtime or build step emitted an explicit
  source hint.
- `heuristic`: the plugin inferred a likely match from selectors, attributes,
  names, or text patterns.
- `unknown`: reliability cannot be classified more precisely.

When otherwise equivalent matches overlap, core prefers `exact`, `sourcemap`,
`instrumented`, `heuristic`, then `unknown`. A selected-element match is
presented ahead of a parent-element match for the same range.

## Runtime Facts

Built-in facts such as `css-rule` and `dom-attribute` have strict schemas.
Extension facts use a namespaced lowercase kind with at least one dot, a JSON
`payload`, and JSON `metadata`. They may also carry a one-based protocol
`source` location.

A valid React fact:

```json
{
  "type": "react.component",
  "source": {
    "uri": "webpack:///src/components/Card.tsx",
    "line": 42,
    "column": 1,
    "endLine": 68,
    "endColumn": 2,
    "metadata": {}
  },
  "payload": {
    "name": "Card",
    "ownerChain": ["HomePage", "FeaturedGrid", "Card"]
  },
  "metadata": {
    "producer": "example-react-adapter",
    "mode": "development"
  }
}
```

A valid WordPress ACF block fact:

```json
{
  "type": "wordpress.acf-block",
  "source": {
    "uri": "file:///workspace/theme/blocks/hero/render.php",
    "line": 1,
    "column": 1,
    "metadata": {}
  },
  "payload": {
    "blockName": "acf/hero",
    "template": "blocks/hero/render.php",
    "fieldId": "field_hero_title"
  },
  "metadata": {
    "producer": "example-wordpress-adapter",
    "mode": "development"
  }
}
```

The current phase defines the wire envelope but not a browser-side third-party
producer API. Framework facts can come from a PinOp browser adapter or
development-only application instrumentation.

## Ecosystem Recipes

### HTML

Use the DOM selector plus stable `id`, `data-*`, `aria-*`, and role attributes
to search a static HTML document. Return `heuristic`: browser DOM can differ
after scripts, server transforms, or browser error recovery.

### JavaScript And TypeScript

Collect an event-listener or script-generated source location in the browser,
then map the generated location through the script source map. Match only the
active `.js`, `.jsx`, `.ts`, or `.tsx` document and return `sourcemap`.

### React

Development instrumentation should emit `react.component` with the component
name, owner chain, and source location. Resolve the instrumented URI against the
active TSX/JSX document and return `instrumented`, or `sourcemap` when the final
range requires an additional source-map step.

### Vue

Emit the component instance name, `.vue` file hint, block type, and generated
source location. Use Vue compiler source maps when available. Return
`instrumented` for a direct compiler hint or `sourcemap` for a mapped range.

### Twig, Blade, And PHP

Have the development server attach a namespaced fact containing the template
identifier and source range. The VS Code plugin maps the hint to the active
template and returns `instrumented`. Do not expose filesystem paths or template
context in production responses.

### WordPress And ACF

Emit `wordpress.acf-block` with the block name, PHP render template, relevant
field ID, and source hint. Resolve only within the active PHP/template document
and return `instrumented`. Field values are not needed and should not be sent.

React, Vue, Twig, Blade, PHP, WordPress, and ACF exactness cannot be reconstructed
reliably from final DOM alone. Component ownership, compilation, loops,
conditionals, hooks, and server rendering erase source identity. Exact-looking
DOM-only matches must remain `heuristic`; use source maps or instrumentation for
stronger confidence.

## Versioning And Distribution

The repository's `0.1.0` `@pinop/plugin-api` and
`@pinop/protocol` packages are currently private workspace packages. The
fixture proves the cross-extension runtime boundary, but an independently
published Marketplace plugin cannot consume them from npm yet.

Before third-party distribution, PinOp will publish both packages
together, replace internal `workspace:*` references with compatible semver
ranges in the published manifests, and document the supported core extension
version. Package semver describes source/package compatibility;
`SOURCE_PLUGIN_API_VERSION` is the runtime compatibility gate. A breaking
contract change increments both the package major version and the runtime API
version. External plugins must check the runtime version before calling
`registerSourcePlugin` and should declare the narrowest package range they have
tested.

## Testing

Unit-test resolver logic with fake `SourceDocument` and `SourceWorkspace`
objects. These interfaces contain no VS Code types, so tests can supply fixed
text, deterministic URI resolution, and an `AbortController` without starting
an Extension Host. Cover active-document filtering, multiple ranges, malformed
facts, cancellation, and out-of-range input.

Use the repository fixture under `extensions/source-plugin-fixture` as the
cross-extension pattern. The real VS Code boundary is tested with:

```powershell
corepack pnpm test:integration
```

That command builds the core and fixture, launches VS Code 1.124.2, activates
the external fixture through `conus-vision.pinop`, and verifies API
version and registration. Node.js 22 or newer is required by the integration
test runner.
