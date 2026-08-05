# Browser2IDE Browser Inspector And DOM Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver an Inspector-like Firefox/Chrome DevTools experience with a live selectable DOM tree and page box-model overlay, show and disconnect the linked VS Code code, and return an explicit result for every active-file CSS/SCSS resolution.

**Architecture:** A shared `PageInspectionSession` in `packages/browser-extension-core` owns hover, selection, opaque node references, same-origin frames, lazy tree data, and overlays. The background binds that browser-local session to one DevTools channel, correlates inspect IDs, and sends only bounded inspect evidence over protocol v4. The bridge adds bounded targeted resolution routes and IDE peer state. VS Code keeps document-first dispatch, publishes a strict `resolution` for every retained inspect generation, and adds a conservative CSS fingerprint fallback while SCSS remains source-map-only.

**Tech Stack:** Node.js 22, pnpm 9, TypeScript 5.9, Zod 3, Vitest 2, ws 8, PostCSS, source-map, VS Code Extension API, Firefox WebExtensions, Chrome Manifest V3.

---

## Execution Preconditions

- Read `docs/superpowers/specs/2026-08-05-browser-inspector-dom-tree-design.md` before editing code.
- Start from commit `b30ba6d` or a descendant containing the approved design.
- Use `superpowers:subagent-driven-development`; give each worker one task, then run spec-compliance and code-quality reviews before accepting it.
- Do not preserve protocol-v3 wire compatibility. All Browser2IDE artifacts advance together.
- Do not open or switch VS Code files in response to a browser selection. Resolution remains active-document-first.
- Do not send DOM-tree nodes, `nodeRef`, frame internals, local paths, or source contents over the public WebSocket protocol.
- Preserve unrelated untracked files, especially `docs/superpowers/plans/2026-07-09-browser2ide-mvp.md`, `.superpowers/`, and `debug.log`.
- Use `apply_patch` for manual edits and stage only files owned by the current task.

## Planned File Structure

### Public Protocol And Bridge

```text
packages/protocol/src/messages.ts
packages/protocol/src/limits.ts
packages/protocol/src/capabilities.ts
packages/protocol/src/index.ts
packages/protocol/test/schema.test.ts
packages/protocol/test/public-export.mjs

packages/bridge/src/clientRegistry.ts
packages/bridge/src/replyRouteRegistry.ts       # new
packages/bridge/src/peerStateRegistry.ts         # new
packages/bridge/src/heartbeat.ts
packages/bridge/src/router.ts
packages/bridge/src/server.ts
packages/bridge/test/replyRouteRegistry.test.ts  # new
packages/bridge/test/peerStateRegistry.test.ts   # new
packages/bridge/test/heartbeat.test.ts
packages/bridge/test/router.test.ts
packages/bridge/test/server.test.ts
```

### Shared Browser Runtime

```text
packages/browser-extension-core/src/domProtocol.ts             # new
packages/browser-extension-core/src/domNodeRegistry.ts         # new
packages/browser-extension-core/src/frameRegistry.ts           # new
packages/browser-extension-core/src/domTreeProvider.ts         # new
packages/browser-extension-core/src/pageOverlay.ts             # new
packages/browser-extension-core/src/pageInspectionSession.ts   # new
packages/browser-extension-core/src/inspectCorrelationStore.ts # new
packages/browser-extension-core/src/panelSessionTransport.ts   # new
packages/browser-extension-core/src/domTreeController.ts       # new
packages/browser-extension-core/src/virtualTreeRows.ts         # new
packages/browser-extension-core/src/domTreeView.ts              # new
packages/browser-extension-core/src/resolutionPresenter.ts      # new
packages/browser-extension-core/src/panelView.ts                 # new
packages/browser-extension-core/src/inspectMode.ts
packages/browser-extension-core/src/inspectPortProtocol.ts
packages/browser-extension-core/src/contentScriptRuntime.ts
packages/browser-extension-core/src/backgroundInspectSession.ts
packages/browser-extension-core/src/backgroundRouter.ts
packages/browser-extension-core/src/backgroundRuntime.ts
packages/browser-extension-core/src/bridgeClient.ts
packages/browser-extension-core/src/browserWindowLinkStore.ts
packages/browser-extension-core/src/windowConnectionCoordinator.ts
packages/browser-extension-core/src/panelController.ts
packages/browser-extension-core/src/panelInspectController.ts
packages/browser-extension-core/src/panelInspectTransport.ts
packages/browser-extension-core/src/panelRuntime.ts
packages/browser-extension-core/src/index.ts
packages/browser-extension-core/assets/panel.html
packages/browser-extension-core/assets/panel.css

packages/browser-extension-core/test/domProtocol.test.ts             # new
packages/browser-extension-core/test/domNodeRegistry.test.ts         # new
packages/browser-extension-core/test/frameRegistry.test.ts           # new
packages/browser-extension-core/test/domTreeProvider.test.ts         # new
packages/browser-extension-core/test/pageOverlay.test.ts             # new
packages/browser-extension-core/test/pageInspectionSession.test.ts   # new
packages/browser-extension-core/test/inspectCorrelationStore.test.ts # new
packages/browser-extension-core/test/panelSessionTransport.test.ts   # new
packages/browser-extension-core/test/domTreeController.test.ts       # new
packages/browser-extension-core/test/virtualTreeRows.test.ts         # new
packages/browser-extension-core/test/domTreeView.test.ts              # new
packages/browser-extension-core/test/resolutionPresenter.test.ts      # new
packages/browser-extension-core/test/inspectMode.test.ts
packages/browser-extension-core/test/backgroundInspectSession.test.ts
packages/browser-extension-core/test/backgroundRouter.test.ts
packages/browser-extension-core/test/bridgeClient.test.ts
packages/browser-extension-core/test/browserWindowLinkStore.test.ts
packages/browser-extension-core/test/panelController.test.ts
packages/browser-extension-core/test/panelRuntime.test.ts
```

### Browser Adapters

```text
extensions/firefox/src/background.ts
extensions/firefox/src/contentScript.ts
extensions/firefox/src/panel.ts
extensions/firefox/test/adapter.test.ts
extensions/firefox/test/panelAssets.test.ts

extensions/chrome/src/background.ts
extensions/chrome/src/contentScript.ts
extensions/chrome/src/panel.ts
extensions/chrome/test/adapter.test.ts
extensions/chrome/test/panelAssets.test.ts
```

### VS Code Resolution

```text
extensions/vscode/src/bridgeClient.ts
extensions/vscode/src/diagnostics.ts
extensions/vscode/src/extension.ts
extensions/vscode/src/presenter/runtime.ts
extensions/vscode/src/presenter/activeEditorCoordinator.ts
extensions/vscode/src/presenter/visibleMatches.ts              # new
extensions/vscode/src/sourcePlugins/types.ts
extensions/vscode/src/sourcePlugins/registry.ts
extensions/vscode/src/sourcePlugins/resolutionOutcome.ts       # new
extensions/vscode/src/sourcePlugins/declarationFingerprint.ts  # new
extensions/vscode/src/sourcePlugins/stylesheetAst.ts
extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts
extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts

extensions/vscode/test/bridgeClient.test.ts
extensions/vscode/test/diagnostics.test.ts
extensions/vscode/test/presenterRuntime.test.ts
extensions/vscode/test/activeEditorCoordinator.test.ts
extensions/vscode/test/visibleMatches.test.ts                   # new
extensions/vscode/test/sourcePluginRegistry.test.ts
extensions/vscode/test/resolutionOutcome.test.ts                # new
extensions/vscode/test/declarationFingerprint.test.ts           # new
extensions/vscode/test/stylesheetAst.test.ts             # new
extensions/vscode/test/cssSourcePlugin.test.ts
extensions/vscode/test/scssSourcePlugin.test.ts
```

### Fixture, Documentation, And Release

```text
examples/basic-css/index.html
examples/basic-css/src/app.scss
examples/basic-css/src/card.scss
examples/basic-css/src/layout.scss
examples/basic-css/src/fallback.css
examples/basic-css/server.mjs
docs/mvp-verification.md
docs/mvp-usage.md
docs/architecture.md
docs/protocol.md
docs/security.md
docs/installed-verification.md
docs/release.md
docs/firefox-source-submission.md
README.md
extensions/vscode/README.md
PRIVACY.md
CHANGELOG.md
package.json
packages/*/package.json
extensions/*/package.json
extensions/vscode/smoke-installed-vsix.mjs
tools/smoke-packaged-chrome.mjs
tools/test/packaged-chrome-smoke.test.mjs
```

## Task 1: Define Protocol V4 Resolution And Peer State

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/limits.ts`
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/index.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/public-export.mjs`

- [ ] **Step 1: Write failing protocol-v4 schema tests**

Add builders and strict acceptance/rejection cases in `schema.test.ts`:

```ts
const resolution = {
  protocolVersion: 4,
  type: "resolution",
  messageId: crypto.randomUUID(),
  sessionId: "default",
  source: { role: "ide", id: "vscode-window-1" },
  inspectMessageId: crypto.randomUUID(),
  resolutionGeneration: 2,
  document: { label: "card.scss", languageId: "scss" },
  status: "matched",
  selectedMatchCount: 2,
  parentMatchCount: 1,
  inaccessibleStylesheetCount: 0,
  diagnosticCodes: [],
  metadata: {},
} as const;

it("accepts a bounded matched resolution", () => {
  expect(parseMessage(resolution)).toEqual(resolution);
});

it("rejects a matched resolution without visible matches", () => {
  expect(() => parseMessage({
    ...resolution,
    selectedMatchCount: 0,
    parentMatchCount: 0,
  })).toThrow();
});

it("rejects extension fields in resolution metadata and source", () => {
  expect(() => parseMessage({
    ...resolution,
    source: { ...resolution.source, label: "private path" },
  })).toThrow();
  expect(() => parseMessage({
    ...resolution,
    metadata: { extra: true },
  })).toThrow();
});

it("accepts a bridge peer-state transition", () => {
  expect(parseMessage({
    protocolVersion: 4,
    type: "peerState",
    messageId: crypto.randomUUID(),
    sessionId: "default",
    role: "ide",
    connected: false,
    peerGeneration: 3,
    metadata: {},
  }).type).toBe("peerState");
});
```

Also reject unknown statuses/diagnostics, duplicate diagnostic codes, negative or oversized counters, a resolution over 16 KiB, `matched` with zero counts, and non-matched statuses with nonzero counts. Update the public-export test to import all new schemas and inferred types.

- [ ] **Step 2: Run the focused protocol test and confirm failure**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol test
```

Expected: FAIL because protocol version 4, `ResolutionMessageSchema`, and `PeerStateMessageSchema` do not exist.

- [ ] **Step 3: Implement the closed v4 schemas and limits**

Use closed Zod objects and a union-level invariant:

```ts
export const PROTOCOL_VERSION = 4 as const;
export const RESOLUTION_ENVELOPE_MAX_BYTES = 16 * 1024;

export const ResolutionStatusSchema = z.enum([
  "matched", "no-active-editor", "unsupported-document", "no-facts",
  "source-not-found", "source-not-active-document", "source-ambiguous",
  "source-map-missing", "source-map-invalid", "no-rule-match",
  "rule-match-ambiguous", "error",
]);

export const ResolutionDiagnosticCodeSchema = z.enum([
  "resolver.plugin-error",
  "resolver.plugin-timeout",
  "resolver.invalid-result",
  "resolver.source-read-failed",
]);

const EmptyMetadataSchema = z.object({}).strict();
const ResolutionSourceSchema = z.object({
  role: z.literal("ide"),
  id: BoundedOpaqueIdSchema,
}).strict();

export const ResolutionMessageSchema = baseMessageSchema.extend({
  type: z.literal("resolution"),
  source: ResolutionSourceSchema,
  inspectMessageId: MessageIdSchema,
  resolutionGeneration: BoundedCounterSchema,
  document: z.object({
    label: z.string().min(1).max(128),
    languageId: z.string().min(1).max(64),
  }).strict().optional(),
  status: ResolutionStatusSchema,
  selectedMatchCount: BoundedCounterSchema,
  parentMatchCount: BoundedCounterSchema,
  inaccessibleStylesheetCount: BoundedCounterSchema,
  diagnosticCodes: z.array(ResolutionDiagnosticCodeSchema).max(8),
  metadata: EmptyMetadataSchema,
}).strict().superRefine(validateResolutionCounts);
```

Add `PeerStateMessageSchema`, include both messages in `Browser2IdeMessageSchema`, and export schemas/types from `index.ts`.

- [ ] **Step 4: Run protocol tests, typecheck, and lint**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol test
corepack pnpm --filter @browser2ide/protocol typecheck
corepack pnpm --filter @browser2ide/protocol lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit protocol v4**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/protocol
git -c safe.directory=F:/_Browser2IDE commit -m "feat(protocol): add resolution results"
```

## Task 2: Add Targeted Bridge Reply Routes

**Files:**
- Create: `packages/bridge/src/replyRouteRegistry.ts`
- Create: `packages/bridge/test/replyRouteRegistry.test.ts`
- Modify: `packages/bridge/src/clientRegistry.ts`
- Modify: `packages/bridge/src/heartbeat.ts`
- Modify: `packages/bridge/src/router.ts`
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `packages/bridge/test/heartbeat.test.ts`
- Modify: `packages/bridge/test/server.test.ts`

- [ ] **Step 1: Write failing bounded-route and isolation tests**

Use registered connection IDs rather than socket identity in the route API:

```ts
it("routes a resolution only to the browser that sent the inspect", () => {
  const routes = new ReplyRouteRegistry(256);
  routes.record("default", "inspect-a", "browser-a");
  expect(routes.resolve("default", "inspect-a")).toBe("browser-a");
  expect(routes.resolve("default", "inspect-b")).toBeUndefined();
});

it("evicts least-recently-used routes per browser connection", () => {
  const routes = new ReplyRouteRegistry(2);
  routes.record("default", "a", "browser-a");
  routes.record("default", "b", "browser-a");
  routes.resolve("default", "a");
  routes.record("default", "c", "browser-a");
  expect(routes.resolve("default", "b")).toBeUndefined();
});

it("removes every route when its browser disconnects", () => {
  routes.removeConnection("browser-a");
  expect(routes.resolve("default", "a")).toBeUndefined();
});
```

In router/server tests, connect two browser clients and one IDE, send an inspect from browser A, then assert the correlated resolution reaches A and never B. Assert unknown inspect IDs are rejected with a sanitized protocol error and no broadcast.

- [ ] **Step 2: Run bridge tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/bridge test
```

Expected: FAIL because reply routes and resolution routing do not exist.

- [ ] **Step 3: Implement bounded target routing**

Create a small LRU keyed by `(sessionId, inspectMessageId)`:

```ts
export class ReplyRouteRegistry {
  constructor(private readonly maxPerConnection = 256) {}
  record(sessionId: string, inspectMessageId: string, connectionId: string): "registered" | "collision";
  resolve(sessionId: string, inspectMessageId: string): string | undefined;
  removeConnection(connectionId: string): void;
}
```

Expose exact client lookup in `ClientRegistry`:

```ts
findRegistered(connectionId: string): RegisteredClient | undefined {
  return this.registeredById.get(connectionId);
}
```

Update `routeMessage` so browser `inspect` records the sender route before IDE delivery, while IDE `resolution` resolves and refreshes that route and sends only to the target browser connection. Same-client registration is idempotent; a cross-client inspect-ID collision fails closed. Remove routes on socket close, unlink, heartbeat eviction, and bridge stop. The route stores IDs only, never payloads.

- [ ] **Step 4: Run bridge tests, typecheck, and lint**

```powershell
corepack pnpm --filter @browser2ide/bridge test
corepack pnpm --filter @browser2ide/bridge typecheck
corepack pnpm --filter @browser2ide/bridge lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit targeted resolution routing**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/bridge
git -c safe.directory=F:/_Browser2IDE commit -m "feat(bridge): target resolution replies"
```

## Task 3: Publish IDE Peer State From The Bridge

**Files:**
- Create: `packages/bridge/src/peerStateRegistry.ts`
- Create: `packages/bridge/test/peerStateRegistry.test.ts`
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/test/server.test.ts`

- [ ] **Step 1: Write failing transition tests**

```ts
it("sends the current IDE snapshot after browser authentication", async () => {
  const browser = await connectAuthenticatedBrowser();
  expect(await browser.nextMessage()).toMatchObject({
    type: "peerState", role: "ide", connected: false, peerGeneration: 0,
  });
});

it("emits only zero-to-one and one-to-zero IDE transitions", async () => {
  const browser = await connectAuthenticatedBrowser();
  const ideA = await connectIde();
  expect(await browser.nextMessage()).toMatchObject({ connected: true, peerGeneration: 1 });
  const ideB = await connectIde();
  expect(browser.hasPendingMessage()).toBe(false);
  ideA.close();
  expect(browser.hasPendingMessage()).toBe(false);
  ideB.close();
  expect(await browser.nextMessage()).toMatchObject({ connected: false, peerGeneration: 2 });
});
```

- [ ] **Step 2: Run the focused server test and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/bridge test -- server.test.ts
```

Expected: FAIL because no `peerState` snapshot or generation is emitted.

- [ ] **Step 3: Implement per-session peer generations**

```ts
export class PeerStateRegistry {
  snapshot(sessionId: string): { connected: boolean; generation: number };
  updateIdeCount(sessionId: string, count: number): PeerTransition | undefined;
  removeSession(sessionId: string): void;
}
```

After browser authentication send one snapshot. When IDE counts cross zero, broadcast only the strict bridge-originated `peerState` to authenticated browsers in that session. Use bridge-generated message IDs and empty metadata.

- [ ] **Step 4: Run bridge verification**

```powershell
corepack pnpm --filter @browser2ide/bridge test
corepack pnpm --filter @browser2ide/bridge typecheck
corepack pnpm --filter @browser2ide/bridge lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit peer-state support**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/bridge
git -c safe.directory=F:/_Browser2IDE commit -m "feat(bridge): report ide peer state"
```

## Task 4: Add Strict Browser-Local DOM Protocol

**Files:**
- Create: `packages/browser-extension-core/src/domProtocol.ts`
- Create: `packages/browser-extension-core/test/domProtocol.test.ts`
- Modify: `packages/browser-extension-core/src/inspectPortProtocol.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing parser and bounds tests**

```ts
it("parses a paginated child request", () => {
  expect(parseDomRequest({
    type: "dom.getChildren",
    requestId: "request-1",
    documentEpoch: 4,
    nodeRef: "node-7",
    branchRevision: 2,
    cursor: "cursor-1",
  })).toEqual(expect.objectContaining({ type: "dom.getChildren" }));
});

it.each([
  { type: "dom.select", documentEpoch: -1, nodeRef: "node-1" },
  { type: "dom.hover", documentEpoch: 1, nodeRef: "x".repeat(200) },
  { type: "dom.getRoot", requestId: "r", tabId: 99 },
])("rejects malformed or cross-tab commands", (value) => {
  expect(() => parseDomRequest(value)).toThrow();
});

it("rejects an oversized serialized node page", () => {
  expect(() => parseDomResponse(oversizedChildrenResponse())).toThrow();
});
```

- [ ] **Step 2: Run browser-core tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domProtocol.test.ts
```

Expected: FAIL because browser-local DOM message types/parsers do not exist.

- [ ] **Step 3: Implement closed internal message types**

Use manual guards consistent with `inspectPortProtocol.ts`, with constants for node/page/attribute/message bounds:

```ts
export type DomRequest =
  | { type: "dom.getRoot"; requestId: string; documentEpoch?: number }
  | { type: "dom.getChildren"; requestId: string; documentEpoch: number;
      nodeRef: string; branchRevision: number; cursor?: string }
  | { type: "dom.select"; documentEpoch: number; nodeRef: string }
  | { type: "dom.hover"; documentEpoch: number; nodeRef: string }
  | { type: "dom.clearHover"; documentEpoch: number };

export interface DomNodeView {
  nodeRef: string;
  kind: "element" | "shadow-root" | "frame-document";
  label: string;
  expandable: boolean;
  inaccessible?: boolean;
  branchRevision: number;
}
```

Implement all approved response/event forms, reject unknown keys, and expose only browser-local types from the browser-core package.

- [ ] **Step 4: Run focused verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domProtocol.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the internal protocol**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src/domProtocol.ts packages/browser-extension-core/src/inspectPortProtocol.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test/domProtocol.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): define dom session protocol"
```

## Task 5: Implement Opaque Node And Frame Registries

**Files:**
- Create: `packages/browser-extension-core/src/domNodeRegistry.ts`
- Create: `packages/browser-extension-core/src/frameRegistry.ts`
- Create: `packages/browser-extension-core/test/domNodeRegistry.test.ts`
- Create: `packages/browser-extension-core/test/frameRegistry.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing registry tests**

```ts
it("keeps refs opaque and scoped to a document epoch", () => {
  const registry = new DomNodeRegistry({ maxReverseEntries: 32 });
  const ref = registry.reference(element, frameContext(1, 1));
  expect(ref).toMatch(/^node-/);
  expect(registry.resolve(ref, frameContext(1, 1))).toBe(element);
  registry.resetDocument(2);
  expect(registry.resolve(ref, frameContext(1, 1))).toBeUndefined();
});

it("strongly retains only selected, hovered, and expanded nodes", () => {
  registry.retain(ref, "selected");
  registry.retain(ref, "hovered");
  registry.release(ref, "hovered");
  expect(registry.retentionReasons(ref)).toEqual(["selected"]);
});

it("translates a nested same-origin frame rectangle", () => {
  const result = frames.toTopViewport(childFrameRef, rect(2, 3, 10, 20));
  expect(result).toEqual(rect(102, 203, 10, 20));
});

it("treats a cross-origin iframe as an inaccessible leaf", () => {
  expect(frames.describeFrame(crossOriginIframe)).toMatchObject({ inaccessible: true });
});
```

- [ ] **Step 2: Run the new tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domNodeRegistry.test.ts frameRegistry.test.ts
```

Expected: FAIL because both registries are absent.

- [ ] **Step 3: Implement bounded registry ownership**

```ts
export class DomNodeRegistry {
  private readonly forward = new WeakMap<Node, string>();
  private readonly reverse = new Map<string, WeakRef<Node>>();
  private readonly retained = new Map<string, { node: Node; reasons: Set<RetentionReason> }>();

  reference(node: Node, scope: NodeScope): string;
  resolve(nodeRef: string, scope: NodeScope): Node | undefined;
  retain(nodeRef: string, reason: RetentionReason): void;
  release(nodeRef: string, reason: RetentionReason): void;
  invalidateSubtree(root: Node): readonly string[];
  resetDocument(documentEpoch: number): void;
}
```

`FrameRegistry` must assign `frameRef`/`frameEpoch`, walk only accessible `contentDocument`, install per-document lifecycle callbacks, and translate rectangles through frame elements. Never catch an origin error and then inspect the child anyway.

- [ ] **Step 4: Run registry tests and browser-core checks**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domNodeRegistry.test.ts frameRegistry.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit registries**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src/domNodeRegistry.ts packages/browser-extension-core/src/frameRegistry.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test/domNodeRegistry.test.ts packages/browser-extension-core/test/frameRegistry.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): register dom nodes and frames"
```

## Task 6: Build Lazy DOM Tree Provider

**Files:**
- Create: `packages/browser-extension-core/src/domTreeProvider.ts`
- Create: `packages/browser-extension-core/test/domTreeProvider.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing tree-provider tests**

```ts
it("returns only element children in bounded pages", () => {
  const first = provider.getChildren(rootRef, revision, undefined);
  expect(first.nodes).toHaveLength(50);
  expect(first.nodes.every((node) => node.kind === "element")).toBe(true);
  expect(first.nextCursor).toBeDefined();
});

it("serializes an explicit open-shadow-root container", () => {
  expect(provider.getChildren(hostRef, revision).nodes).toContainEqual(
    expect.objectContaining({ kind: "shadow-root", expandable: true }),
  );
});

it("invalidates an expanded branch before returning a new revision", async () => {
  mutateExpandedBranch();
  await flushMutationDebounce();
  expect(onInvalidated).toHaveBeenCalledWith(expect.objectContaining({ branchRevision: 2 }));
});

it("rejects a child cursor from an older branch revision", () => {
  expect(() => provider.getChildren(parentRef, 1, oldCursor)).toThrowError("stale-branch");
});
```

Cover root/path lookup, late-created open shadow roots, per-shadow observers, same-origin frame-document containers, cross-origin locked leaves, selected-node removal, and document-epoch reset.

- [ ] **Step 2: Run the provider test and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domTreeProvider.test.ts
```

Expected: FAIL because `DomTreeProvider` does not exist.

- [ ] **Step 3: Implement lazy traversal and revision invalidation**

```ts
export class DomTreeProvider {
  getRoot(expectedEpoch?: number): DomRootResponse;
  getChildren(request: DomChildrenRequest): DomChildrenResponse;
  ancestorPath(nodeRef: string, documentEpoch: number): readonly DomNodeView[];
  dispose(): void;
}
```

Use fixed page size and cursor records bound to `{nodeRef, branchRevision, offset}`. Observe every accessible document and discovered open shadow root. Debounce mutations, increment only affected expanded branches, release collapsed/removed references, and run a bounded low-frequency check only across expanded shadow hosts.

- [ ] **Step 4: Run provider and browser-core verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domTreeProvider.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the tree provider**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src/domTreeProvider.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test/domTreeProvider.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): provide lazy dom tree"
```

## Task 7: Render Inspector Box-Model Overlay

**Files:**
- Create: `packages/browser-extension-core/src/pageOverlay.ts`
- Create: `packages/browser-extension-core/test/pageOverlay.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing geometry and lifecycle tests**

```ts
it("renders margin, border, padding, and content geometry", () => {
  overlay.show(element, topFrame);
  expect(host.layers()).toMatchObject({ margin: expect.anything(), border: expect.anything(), padding: expect.anything(), content: expect.anything() });
});

it("renders every client rect of a multiline inline element", () => {
  overlay.show(multilineElement, topFrame);
  expect(host.contentRects()).toHaveLength(3);
});

it("coalesces scroll and resize work to one animation frame", () => {
  dispatchScroll();
  dispatchScroll();
  dispatchResize();
  expect(scheduleFrame).toHaveBeenCalledTimes(1);
});

it("creates a noninteractive isolated host and removes it on dispose", () => {
  expect(host.style.pointerEvents).toBe("none");
  overlay.dispose();
  expect(document.contains(host)).toBe(false);
});
```

- [ ] **Step 2: Run the overlay test and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- pageOverlay.test.ts
```

Expected: FAIL because `PageOverlay` does not exist.

- [ ] **Step 3: Implement rAF-coalesced overlay rendering**

```ts
export class PageOverlay {
  show(element: Element, frameRef: string): void;
  clear(): void;
  ownsNode(node: Node): boolean;
  dispose(): void;
}
```

Create one isolated host per accessible document session, render via created elements and `textContent`, and set `pointer-events: none`. Bound `tag#id.classes` and dimensions. Use `getClientRects`, computed margins/borders/padding, and `FrameRegistry.toTopViewport`. Exclude the host from hit testing and tree serialization.

- [ ] **Step 4: Run overlay verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- pageOverlay.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the overlay**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src/pageOverlay.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test/pageOverlay.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): render inspector overlay"
```

## Task 8: Unify Picker And Tree Selection In PageInspectionSession

**Files:**
- Create: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Create: `packages/browser-extension-core/test/pageInspectionSession.test.ts`
- Modify: `packages/browser-extension-core/src/inspectMode.ts`
- Modify: `packages/browser-extension-core/test/inspectMode.test.ts`
- Modify: `packages/browser-extension-core/src/index.ts`

- [ ] **Step 1: Write failing interaction tests**

```ts
it("uses one selection path for page clicks and tree commands", async () => {
  session.enablePicker();
  dispatchTrustedPrimarySequence(card);
  await session.selectByRef(cardRef, epoch);
  expect(onSelection).toHaveBeenCalledTimes(2);
  expect(onSelection.mock.calls[0][0].nodeRef).toBe(cardRef);
  expect(onSelection.mock.calls[1][0].nodeRef).toBe(cardRef);
});

it("suppresses the complete picker action sequence", () => {
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "touchstart", "touchend"]) {
    expect(dispatch(type, card).defaultPrevented).toBe(true);
  }
});

it("selects exactly once and rejects synthetic or nonprimary events", () => {
  dispatchSyntheticClick(card);
  dispatchSecondaryClick(card);
  dispatchTrustedPrimarySequence(card);
  expect(onSelection).toHaveBeenCalledTimes(1);
});

it("keeps picker active and applies two-stage Escape", () => {
  session.hover(card);
  pressEscape();
  expect(session.pickerEnabled).toBe(true);
  pressEscape();
  expect(session.pickerEnabled).toBe(false);
});
```

Cover `composedPath`, one hover update per animation frame, bounded selection rate, tree selection while picker is off, ancestor-path reveal, selected-node removal, frame listeners, navigation, and complete disposal.

- [ ] **Step 2: Run interaction tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- inspectMode.test.ts pageInspectionSession.test.ts
```

Expected: FAIL because the existing click-only `InspectMode` lacks session semantics.

- [ ] **Step 3: Implement the single page authority**

```ts
export class PageInspectionSession {
  enablePicker(): void;
  disablePicker(): void;
  hoverByRef(nodeRef: string, epoch: number): void;
  clearHover(epoch?: number): void;
  selectByRef(nodeRef: string, epoch: number): Promise<void>;
  republishSelection(): Promise<boolean>;
  handle(request: DomRequest): Promise<DomResponse | readonly DomEvent[]>;
  dispose(): void;
}
```

Refactor `InspectMode` into the event-capture capability used by the session. The session owns selected/hovered refs, overlay calls, tree provider calls, payload creation, and exactly one `onSelection` callback. Tree commands and picker clicks must call the same private `selectElement` implementation.

- [ ] **Step 4: Run page-session verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- inspectMode.test.ts pageInspectionSession.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit unified inspection**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src/inspectMode.ts packages/browser-extension-core/src/pageInspectionSession.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test/inspectMode.test.ts packages/browser-extension-core/test/pageInspectionSession.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): unify page inspection"
```

## Task 9: Keep Content Sessions Alive And Route Correlated Results

**Files:**
- Create: `packages/browser-extension-core/src/inspectCorrelationStore.ts`
- Create: `packages/browser-extension-core/src/panelSessionTransport.ts`
- Create: `packages/browser-extension-core/test/inspectCorrelationStore.test.ts`
- Create: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/src/contentScriptRuntime.ts`
- Modify: `packages/browser-extension-core/src/backgroundInspectSession.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/backgroundRuntime.ts`
- Modify: `packages/browser-extension-core/src/bridgeClient.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/test/contentScriptRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundInspectSession.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/bridgeClient.test.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`

- [ ] **Step 1: Write failing lifecycle and correlation tests**

```ts
it("keeps the content session alive while picker mode is off", async () => {
  await coordinator.attachPanel(channel, tabId);
  await coordinator.setPickerEnabled(channel, false);
  expect(contentSession.disposed).toBe(false);
  expect(await coordinator.requestDom(channel, { type: "dom.getRoot", requestId: "r" })).toBeDefined();
});

it("records the inspect ID before sending and removes it on send failure", () => {
  bridge.sendInspect.mockReturnValue(false);
  router.publishInspect(channel, payload);
  expect(router.currentCorrelation(channel)).toBeUndefined();
  expect(panel.lastState).toMatchObject({ status: "ide-disconnected" });
});

it("delivers resolution only to the originating panel", () => {
  router.recordInspect("panel-a", "inspect-a");
  router.receiveResolution(resolution("inspect-a", 1));
  expect(panelA.messages).toHaveLength(1);
  expect(panelB.messages).toHaveLength(0);
});

it("rejects stale generations and republishes on peer reconnect", async () => {
  router.receiveResolution(resolution("inspect-a", 2));
  router.receiveResolution(resolution("inspect-a", 1));
  expect(panel.lastResolution.resolutionGeneration).toBe(2);
  router.receivePeerState(peerState(true, 4));
  expect(contentSession.republishSelection).toHaveBeenCalledTimes(1);
});

it("bounds correlations and drops them with the panel channel", () => {
  const store = new InspectCorrelationStore(256);
  store.record("panel-a", "inspect-a", 7);
  store.disposeChannel("panel-a");
  expect(store.resolve("inspect-a")).toBeUndefined();
});
```

- [ ] **Step 2: Run affected browser-core tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- inspectCorrelationStore.test.ts panelSessionTransport.test.ts contentScriptRuntime.test.ts backgroundInspectSession.test.ts backgroundRouter.test.ts bridgeClient.test.ts panelInspectTransport.test.ts
```

Expected: FAIL because session/picker lifecycles are coupled and no result correlation exists.

- [ ] **Step 3: Implement session routing and public-protocol handling**

Change the bridge client signature and listeners:

```ts
sendInspect(inspectMessageId: string, payload: InspectPayload, sourceId: string): InspectSendOutcome;
onResolution(listener: (message: ResolutionMessage) => void): Disposable;
onPeerState(listener: (message: PeerStateMessage) => void): Disposable;
```

Generate `inspectMessageId` in `BackgroundRouter`, record `{channel, tabId, generation}` first, then send. Bind all DOM requests to the registered channel/tab without accepting a tab ID from panel input. Keep one `PageInspectionSession` while a linked panel lease exists; toggle only picker listeners. On peer reconnection, request `republishSelection`, creating a new inspect ID. Dispose on panel lease loss, navigation, protected-page failure, unlink, or window close.

Keep bounded correlation and panel/content forwarding out of the already-large router:

```ts
export class InspectCorrelationStore {
  record(channel: string, inspectMessageId: string, tabId: number): void;
  accept(message: ResolutionMessage): string | undefined;
  disposeChannel(channel: string): void;
}

export class PanelSessionTransport {
  request(channel: string, request: DomRequest): Promise<DomResponse>;
  publish(channel: string, event: DomEvent | ResolutionMessage | PeerStateMessage): void;
  disposeChannel(channel: string): void;
}
```

- [ ] **Step 4: Run browser routing verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit background/content integration**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core/src packages/browser-extension-core/test
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): route live inspection sessions"
```

## Task 10: Build Virtualized Accessible DOM Tree UI

**Files:**
- Create: `packages/browser-extension-core/src/domTreeController.ts`
- Create: `packages/browser-extension-core/src/virtualTreeRows.ts`
- Create: `packages/browser-extension-core/src/domTreeView.ts`
- Create: `packages/browser-extension-core/src/panelView.ts`
- Create: `packages/browser-extension-core/test/domTreeController.test.ts`
- Create: `packages/browser-extension-core/test/virtualTreeRows.test.ts`
- Create: `packages/browser-extension-core/test/domTreeView.test.ts`
- Modify: `packages/browser-extension-core/src/panelRuntime.ts`
- Modify: `packages/browser-extension-core/src/panelInspectController.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/assets/panel.html`
- Modify: `packages/browser-extension-core/assets/panel.css`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`

- [ ] **Step 1: Write failing tree-controller and view tests**

```ts
it("expands lazily and discards stale branch pages", async () => {
  await controller.expand(parentRef);
  transport.emitInvalidated(parentRef, 2);
  transport.resolveChildren(parentRef, 1, oldNodes);
  expect(controller.visibleRows()).not.toContainEqual(expect.objectContaining({ nodeRef: oldChildRef }));
});

it("implements standard tree keyboard navigation", async () => {
  view.focus(parentRef);
  view.key("ArrowRight");
  expect(controller.isExpanded(parentRef)).toBe(true);
  view.key("ArrowDown");
  expect(view.focusedRef()).toBe(firstChildRef);
  view.key("Enter");
  expect(transport.select).toHaveBeenCalledWith(firstChildRef, epoch);
});

it("does not expand or scroll for an unmaterialized page hover", () => {
  controller.pageHover(unknownRef, "button.save");
  expect(controller.expandedRefs()).toEqual([]);
  expect(view.scrollCalls).toBe(0);
});

it("renders page-provided labels through textContent", () => {
  view.renderNode(nodeWithLabel("<img src=x onerror=alert(1)>") );
  expect(tree.querySelector("img")).toBeNull();
});

it("materializes only the viewport and overscan rows", () => {
  const rows = virtualTreeRows(allRows, { start: 500, size: 20, overscan: 5 });
  expect(rows).toHaveLength(30);
  expect(rows[0]?.index).toBe(495);
});
```

Cover pagination, virtualization windows, selection path reveal/scroll, focus/selected/hovered states, disclosure actions, locked frame rows, shadow-root rows, narrow panel dimensions, and disposal.

- [ ] **Step 2: Run panel-tree tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domTreeController.test.ts virtualTreeRows.test.ts domTreeView.test.ts panelRuntime.test.ts
```

Expected: FAIL because the tree controller/view and DOM assets are absent.

- [ ] **Step 3: Implement controller, view, and panel markup**

```ts
export class DomTreeController {
  loadRoot(): Promise<void>;
  expand(nodeRef: string): Promise<void>;
  collapse(nodeRef: string): void;
  select(nodeRef: string): Promise<void>;
  hover(nodeRef?: string): void;
  handleKey(key: "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter"): void;
  visibleRows(viewport: VirtualViewport): readonly DomTreeRow[];
}

export function virtualTreeRows(
  rows: readonly DomTreeRow[],
  viewport: VirtualViewport,
): readonly VirtualTreeRow[];
```

Extract the existing DOM implementation from `panelRuntime.ts` into `panelView.ts`. Render an actual `role="tree"` with `role="treeitem"`, stable row height, `aria-expanded`, roving `tabindex`, and overscan. Use text nodes only for labels. Keep toolbar/tree/footer as stable CSS grid rows; do not put cards inside cards or introduce decorative gradients.

- [ ] **Step 4: Run UI unit verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- domTreeController.test.ts virtualTreeRows.test.ts domTreeView.test.ts panelRuntime.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit DOM tree UI**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): add devtools dom tree"
```

## Task 11: Show Link Code, Disconnect, And Resolution Footer

**Files:**
- Create: `packages/browser-extension-core/src/resolutionPresenter.ts`
- Create: `packages/browser-extension-core/test/resolutionPresenter.test.ts`
- Modify: `packages/browser-extension-core/src/browserWindowLinkStore.ts`
- Modify: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Modify: `packages/browser-extension-core/src/panelController.ts`
- Modify: `packages/browser-extension-core/src/panelRuntime.ts`
- Modify: `packages/browser-extension-core/src/panelDiagnostics.ts`
- Modify: `packages/browser-extension-core/assets/panel.html`
- Modify: `packages/browser-extension-core/assets/panel.css`
- Modify: `packages/browser-extension-core/test/browserWindowLinkStore.test.ts`
- Modify: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/panelController.test.ts`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/panelDiagnostics.test.ts`

- [ ] **Step 1: Write failing connected-header and footer tests**

```ts
it("shows the exact session-only link code and Disconnect", () => {
  controller.apply(windowState({ linkCode: "4873507", state: "connected" }));
  expect(view.model.linkCode).toBe("48735 07");
  expect(view.model.primaryAction).toEqual({ id: "disconnect", label: "Disconnect" });
});

it("clears code, token, picker, and tree on Disconnect", async () => {
  await controller.disconnect();
  expect(store.read(windowId)).resolves.toBeUndefined();
  expect(inspect.disable).toHaveBeenCalled();
  expect(tree.dispose).toHaveBeenCalled();
  expect(view.model.state).toBe("unlinked");
});

it.each([
  ["no-active-editor", "No active editor"],
  ["source-map-missing", "SCSS source map missing"],
  ["rule-match-ambiguous", "Ambiguous rule match"],
])("maps %s to a stable footer", (status, text) => {
  expect(formatResolutionFooter(resolution({ status }))).toContain(text);
});
```

Also test matched Selected/Parent counts, inaccessible stylesheet count, resolving state, IDE disconnect, generation ordering, bridge-instance mismatch, token rejection, and browser-window close.

- [ ] **Step 2: Run panel state tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test -- resolutionPresenter.test.ts browserWindowLinkStore.test.ts windowConnectionCoordinator.test.ts panelController.test.ts panelRuntime.test.ts panelDiagnostics.test.ts
```

Expected: FAIL because linked code retention and protocol-v4 footer models are absent.

- [ ] **Step 3: Implement session-only code retention and UI states**

Extend the link record without persistent storage:

```ts
export interface BrowserWindowLink {
  windowId: number;
  endpoint: string;
  bridgeInstanceId: string;
  authToken: string;
  displayLinkCode: string;
}

export function presentResolution(
  message: ResolutionMessage | { status: "resolving" | "ide-disconnected" },
): ResolutionViewModel;
```

Clear `displayLinkCode` together with credentials on all approved unlink paths. Replace connected Copy/Change controls with a single Disconnect command. Add a compact picker icon button with tooltip, persistent selected summary, and footer formatter for every protocol status. Do not expose local paths or raw plugin messages.

- [ ] **Step 4: Run panel state verification**

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core test
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter @browser2ide/browser-extension-core lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit connected panel states**

```powershell
git -c safe.directory=F:/_Browser2IDE add packages/browser-extension-core
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): show linked ide results"
```

## Task 12: Publish Explicit VS Code Resolution Outcomes

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/resolutionOutcome.ts`
- Create: `extensions/vscode/src/presenter/visibleMatches.ts`
- Create: `extensions/vscode/test/resolutionOutcome.test.ts`
- Create: `extensions/vscode/test/visibleMatches.test.ts`
- Modify: `extensions/vscode/src/sourcePlugins/types.ts`
- Modify: `extensions/vscode/src/sourcePlugins/registry.ts`
- Modify: `extensions/vscode/src/presenter/activeEditorCoordinator.ts`
- Modify: `extensions/vscode/src/presenter/runtime.ts`
- Modify: `extensions/vscode/src/bridgeClient.ts`
- Modify: `extensions/vscode/src/diagnostics.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/test/sourcePluginRegistry.test.ts`
- Modify: `extensions/vscode/test/activeEditorCoordinator.test.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`
- Modify: `extensions/vscode/test/diagnostics.test.ts`

- [ ] **Step 1: Write failing outcome and publication tests**

```ts
it("publishes no-active-editor instead of silently returning", async () => {
  await coordinator.refresh();
  expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "no-active-editor" }));
});

it("distinguishes unsupported documents from empty matches", async () => {
  host.activeEditor = editor("typescript");
  await coordinator.refresh();
  expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({ status: "unsupported-document" }));
});

it("counts deduplicated selected ranges before parent ranges", async () => {
  registry.resolve.mockResolvedValue(resolutionWithOverlappingRoles());
  await coordinator.refresh();
  expect(onOutcome).toHaveBeenCalledWith(expect.objectContaining({
    status: "matched", selectedMatchCount: 2, parentMatchCount: 1,
  }));
});

it("reuses inspect ID and increments generation on editor change", async () => {
  runtime.select(inspect("inspect-a"));
  host.fireActiveEditorChange();
  expect(bridge.sendResolution.mock.calls.map(([m]) => [m.inspectMessageId, m.resolutionGeneration]))
    .toEqual([["inspect-a", 0], ["inspect-a", 1]]);
});

it("reduces source failures in deterministic precedence order", () => {
  expect(reduceResolutionOutcome([
    sourceFailure("source-not-found"),
    sourceFailure("source-ambiguous"),
  ]).status).toBe("source-ambiguous");
});

it("deduplicates ranges with selected precedence over parent", () => {
  expect(visibleMatches(overlappingSelectedAndParent())).toMatchObject({
    selectedMatchCount: 1,
    parentMatchCount: 0,
  });
});
```

Test deterministic precedence, cancellation, document edits, plugin registry changes, sanitized diagnostics, and all stable statuses.

- [ ] **Step 2: Run VS Code tests and confirm failure**

```powershell
corepack pnpm --filter browser2ide-vscode test -- resolutionOutcome.test.ts visibleMatches.test.ts sourcePluginRegistry.test.ts activeEditorCoordinator.test.ts presenterRuntime.test.ts bridgeClient.test.ts diagnostics.test.ts
```

Expected: FAIL because coordinator/registry failures are still silent and the IDE client cannot send `resolution`.

- [ ] **Step 3: Implement closed internal outcomes and v4 publishing**

```ts
export interface PresenterOutcome {
  status: ResolutionStatus;
  document?: { label: string; languageId: string };
  matches: readonly ResolvedSourceMatch[];
  inaccessibleStylesheetCount: number;
  diagnosticCodes: readonly ResolutionDiagnosticCode[];
}

export interface SourcePluginDispatch {
  kind: "resolved" | "unsupported-document";
  resolution?: SourceResolution;
}

export function reduceResolutionOutcome(
  candidates: readonly PluginResolutionCandidate[],
): PresenterOutcome;

export function visibleMatches(
  matches: readonly ResolvedSourceMatch[],
): VisibleMatchResult;
```

Make `ActiveEditorCoordinator.refresh()` emit exactly one current-generation outcome. Normalize/validate ranges, deduplicate by document/range, then remove parent duplicates covered by selected matches. In `PresenterRuntime`, increment `resolutionGeneration` for the retained inspect ID and call:

```ts
bridgeClient.sendResolution({
  inspectMessageId,
  resolutionGeneration,
  ...toProtocolResolution(outcome),
});
```

Record full local diagnostics in VS Code only. Re-run on active editor, document edit, and registry change without opening files.

- [ ] **Step 4: Run VS Code verification**

```powershell
corepack pnpm --filter browser2ide-vscode test
corepack pnpm --filter browser2ide-vscode typecheck
corepack pnpm --filter browser2ide-vscode lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit explicit outcomes**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/vscode
git -c safe.directory=F:/_Browser2IDE commit -m "feat(vscode): report source resolution"
```

## Task 13: Add Conservative CSS Fingerprint Fallback

**Files:**
- Create: `extensions/vscode/src/sourcePlugins/declarationFingerprint.ts`
- Create: `extensions/vscode/test/declarationFingerprint.test.ts`
- Modify: `extensions/vscode/src/sourcePlugins/types.ts`
- Modify: `extensions/vscode/src/sourcePlugins/cssFacts.ts`
- Modify: `extensions/vscode/src/sourcePlugins/stylesheetAst.ts`
- Modify: `extensions/vscode/src/sourcePlugins/cssSourcePlugin.ts`
- Modify: `extensions/vscode/src/sourcePlugins/sourceWorkspace.ts`
- Create: `extensions/vscode/test/stylesheetAst.test.ts`
- Modify: `extensions/vscode/test/cssSourcePlugin.test.ts`
- Modify: `extensions/vscode/test/sourceWorkspace.test.ts`

- [ ] **Step 1: Write failing exact/fallback/ambiguity tests**

```ts
it("falls back to a unique selector and declaration fingerprint after a path miss", async () => {
  const result = await plugin.resolve(contextWithFact({
    sourceUrl: activeCssUrl,
    selector: ".card",
    rulePath: [99],
    declarations: [{ property: "display", value: "grid", important: false }],
  }));
  expect(result.matches).toEqual([
    expect.objectContaining({ confidence: "heuristic", range: completeCardBlock }),
  ]);
});

it("allows active-document fallback only when source is wholly not found", async () => {
  workspace.resolveSource.mockReturnValue({ kind: "not-found" });
  expect((await plugin.resolve(uniqueStrongCandidate())).matches).toHaveLength(1);
});

it.each(["other-document", "ambiguous"])('does not fallback for %s source resolution', async (kind) => {
  workspace.resolveSource.mockReturnValue({ kind });
  expect((await plugin.resolve(uniqueStrongCandidate())).matches).toEqual([]);
});

it("reports ambiguity for duplicate strong candidates", async () => {
  const result = await plugin.resolve(duplicateCardRules());
  expect(result.status).toBe("rule-match-ambiguous");
});

it("normalizes declaration order, whitespace, casing, and priority", () => {
  expect(fingerprint(runtimeDeclarations)).toEqual(fingerprint(localDeclarations));
});
```

Add conditional-rule tests, truncated runtime declarations, priority normalization, duplicate selectors with different declarations, and complete block ranges.

- [ ] **Step 2: Run CSS tests and confirm failure**

```powershell
corepack pnpm --filter browser2ide-vscode test -- declarationFingerprint.test.ts stylesheetAst.test.ts cssSourcePlugin.test.ts sourceWorkspace.test.ts
```

Expected: FAIL because matching currently lacks declaration fingerprints and stable ambiguity outcomes.

- [ ] **Step 3: Implement normalized fingerprints and ordered resolution**

```ts
export interface RuleFingerprint {
  selector: string;
  declarations: readonly {
    property: string;
    value: string;
    important: boolean;
  }[];
  conditions: readonly string[];
}

export function declarationFingerprint(
  declarations: readonly CssDeclarationEvidence[],
): readonly NormalizedDeclaration[];

export function findRulesByFingerprint(
  stylesheet: ParsedStylesheet,
  fact: CssRuleFact,
): readonly StylesheetRule[];
```

Normalize selector, property casing, whitespace, priority, and available enclosing conditions. Require selector plus sufficient common declarations; selector-only evidence must not decide duplicate rules. Preserve exact CSSOM path/position first. Permit heuristic search only in the active document and only for a source `not-found`; reject known-other and ambiguous sources. Return full rule ranges and `rule-match-ambiguous` for multiple indistinguishable candidates.

- [ ] **Step 4: Run CSS and VS Code verification**

```powershell
corepack pnpm --filter browser2ide-vscode test -- declarationFingerprint.test.ts stylesheetAst.test.ts cssSourcePlugin.test.ts sourceWorkspace.test.ts
corepack pnpm --filter browser2ide-vscode test
corepack pnpm --filter browser2ide-vscode typecheck
corepack pnpm --filter browser2ide-vscode lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit CSS fallback**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/vscode/src/sourcePlugins extensions/vscode/test/declarationFingerprint.test.ts extensions/vscode/test/stylesheetAst.test.ts extensions/vscode/test/cssSourcePlugin.test.ts extensions/vscode/test/sourceWorkspace.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(vscode): resolve css fingerprints"
```

## Task 14: Map SCSS Failures Without Guessing Nested Source

**Files:**
- Modify: `extensions/vscode/src/sourcePlugins/scssSourcePlugin.ts`
- Modify: `extensions/vscode/src/sourcePlugins/sourceMapLoader.ts`
- Modify: `extensions/vscode/src/sourcePlugins/types.ts`
- Modify: `extensions/vscode/test/scssSourcePlugin.test.ts`
- Modify: `extensions/vscode/test/sourceMapLoader.test.ts`

- [ ] **Step 1: Write failing source-map outcome tests**

```ts
it.each([
  ["missing-map", "source-map-missing"],
  ["invalid-map", "source-map-invalid"],
  ["missing-original", "source-not-found"],
  ["other-original", "source-not-active-document"],
  ["ambiguous-original", "source-ambiguous"],
])("maps %s to %s", async (fixture, status) => {
  const result = await plugin.resolve(scssContext(fixture));
  expect(result.status).toBe(status);
  expect(result.matches).toEqual([]);
});

it("uses improved generated CSS lookup before source-map mapping", async () => {
  const result = await plugin.resolve(pathMissWithUniqueFingerprint());
  expect(result.matches).toContainEqual(expect.objectContaining({ range: completeScssBlock }));
});

it("does not guess a nested SCSS selector when mapping is absent", async () => {
  expect((await plugin.resolve(nestedWithoutMap())).matches).toEqual([]);
});
```

- [ ] **Step 2: Run SCSS tests and confirm failure**

```powershell
corepack pnpm --filter browser2ide-vscode test -- scssSourcePlugin.test.ts sourceMapLoader.test.ts
```

Expected: FAIL because missing/invalid/ambiguous mappings are not stable outcomes.

- [ ] **Step 3: Implement explicit map-result reduction**

```ts
type SourceMapResolution =
  | { kind: "mapped"; sourceUri: string; line: number; column: number }
  | { kind: "missing" }
  | { kind: "invalid"; diagnosticCode: "resolver.source-read-failed" }
  | { kind: "unmapped" };
```

Feed the generated CSS rule resolved by Task 13 into the existing source-map loader, map only to a unique active SCSS document, and preserve complete SCSS rule ranges. Reduce each failure to the approved status and keep detailed loader errors local.

- [ ] **Step 4: Run VS Code verification**

```powershell
corepack pnpm --filter browser2ide-vscode test
corepack pnpm --filter browser2ide-vscode typecheck
corepack pnpm --filter browser2ide-vscode lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit SCSS outcomes**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/vscode/src/sourcePlugins extensions/vscode/test/scssSourcePlugin.test.ts extensions/vscode/test/sourceMapLoader.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "feat(vscode): report scss map failures"
```

## Task 15: Wire Firefox And Chrome Adapters To The Shared Runtime

**Files:**
- Modify: `extensions/firefox/src/background.ts`
- Modify: `extensions/firefox/src/contentScript.ts`
- Modify: `extensions/firefox/src/panel.ts`
- Modify: `extensions/firefox/test/adapter.test.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/chrome/src/background.ts`
- Modify: `extensions/chrome/src/contentScript.ts`
- Modify: `extensions/chrome/src/panel.ts`
- Modify: `extensions/chrome/test/adapter.test.ts`
- Modify: `extensions/chrome/test/panelAssets.test.ts`

- [ ] **Step 1: Write failing parity tests**

```ts
it.each([firefoxAdapter, chromeAdapter])("starts the shared page-inspection content runtime", (adapter) => {
  adapter.startContentScript();
  expect(startContentScriptRuntime).toHaveBeenCalledWith(expect.objectContaining({
    createInspectionSession: expect.any(Function),
  }));
});

it.each([firefoxAdapter, chromeAdapter])("ships the DOM tree, Disconnect, and resolution footer assets", (adapter) => {
  const panel = adapter.readPackagedPanel();
  expect(panel).toContain('role="tree"');
  expect(panel).toContain("Disconnect");
  expect(panel).toContain("resolution-status");
});
```

Assert no new permissions, no HTTP endpoints, and equivalent panel/background/content capabilities.

- [ ] **Step 2: Run adapter tests and confirm failure**

```powershell
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-chrome test
```

Expected: FAIL until both adapters expose the new shared runtime and assets.

- [ ] **Step 3: Wire only platform API differences**

Keep adapters thin:

```ts
startContentScriptRuntime({
  runtime: browser.runtime,
  document,
  window,
});

startBackgroundRuntime({
  runtime: browser.runtime,
  scripting: browser.scripting,
  tabs: browser.tabs,
  windows: browser.windows,
  storageSession: browser.storage.session,
});
```

Use the Chrome API namespace equivalent where necessary. Do not duplicate tree, overlay, picker, or result-formatting logic in adapters. Keep manifests permission-identical unless packaging requires an already-approved API declaration.

- [ ] **Step 4: Build and test both adapters**

```powershell
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-chrome test
corepack pnpm --filter browser2ide-firefox build
corepack pnpm --filter browser2ide-chrome build
corepack pnpm --filter browser2ide-firefox typecheck
corepack pnpm --filter browser2ide-chrome typecheck
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit browser parity**

```powershell
git -c safe.directory=F:/_Browser2IDE add extensions/firefox extensions/chrome
git -c safe.directory=F:/_Browser2IDE commit -m "feat(browser): ship inspector in firefox and chrome"
```

## Task 16: Expand The Verification Fixture

**Files:**
- Modify: `examples/basic-css/index.html`
- Modify: `examples/basic-css/src/app.scss`
- Modify: `examples/basic-css/src/card.scss`
- Modify: `examples/basic-css/src/layout.scss`
- Modify: `examples/basic-css/src/fallback.css`
- Modify: `examples/basic-css/server.mjs`
- Modify generated CSS/source maps under `examples/basic-css/dist/`
- Add focused fixture files under `examples/basic-css/frames/` as needed
- Modify: `extensions/vscode/smoke-installed-vsix.mjs`
- Modify: `tools/smoke-packaged-chrome.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `tools/simulator/test/exampleFixtureServer.test.ts`

- [ ] **Step 1: Write failing fixture/package assertions**

```js
assert.match(indexHtml, /id="dynamic-root"/);
assert.match(indexHtml, /id="open-shadow-host"/);
assert.match(indexHtml, /id="same-origin-frame"/);
assert.match(indexHtml, /id="cross-origin-frame"/);
assert.match(indexHtml, /class="multiline-inline"/);
assert.match(fallbackCss, /browser2ide-path-miss/);
```

Extend packaged smoke assertions to require protocol v4 strings, DOM tree assets, Disconnect, and resolution states in the built VSIX/XPI/ZIP.

- [ ] **Step 2: Run smoke tests and confirm failure**

```powershell
corepack pnpm --filter @browser2ide/simulator test
corepack pnpm test:release-tools
```

Expected: FAIL because the expanded fixture and packaged inspector assets are absent.

- [ ] **Step 3: Implement deterministic fixture cases**

Add runtime setup without framework dependencies:

```js
const shadowHost = document.querySelector("#open-shadow-host");
const root = shadowHost.attachShadow({ mode: "open" });
root.replaceChildren(Object.assign(document.createElement("button"), {
  className: "shadow-action",
  textContent: "Shadow action",
}));

document.querySelector("#add-dynamic-node").addEventListener("click", () => {
  const item = document.createElement("div");
  item.className = "dynamic-card";
  document.querySelector("#dynamic-root").append(item);
});
```

Serve one same-origin frame and one second-origin frame. Include exact CSS, CSSOM/local-path mismatch, duplicate selectors, active media rules, inline/runtime style, source-mapped SCSS, and inaccessible stylesheet cases. Regenerate committed Sass output with the documented pinned command.

- [ ] **Step 4: Run fixture/package smoke verification**

```powershell
corepack pnpm dlx sass@1.89.2 examples/basic-css/src/app.scss examples/basic-css/dist/app.css --style=expanded --source-map --no-error-css
corepack pnpm --filter @browser2ide/simulator test
corepack pnpm test:release-tools
corepack pnpm build
```

Expected: all commands exit 0 and generated files are stable on a second build.

- [ ] **Step 5: Commit the expanded fixture**

```powershell
git -c safe.directory=F:/_Browser2IDE add examples/basic-css extensions/vscode/smoke-installed-vsix.mjs tools/smoke-packaged-chrome.mjs tools/test/packaged-chrome-smoke.test.mjs tools/simulator/test/exampleFixtureServer.test.ts
git -c safe.directory=F:/_Browser2IDE commit -m "test: expand inspector fixture"
```

## Task 17: Update Versions, Documentation, And Release Material

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/mvp-verification.md`
- Modify: `docs/mvp-usage.md`
- Modify: `docs/architecture.md`
- Modify: `docs/protocol.md`
- Modify: `docs/security.md`
- Modify: `docs/installed-verification.md`
- Modify: `docs/release.md`
- Modify: `docs/firefox-source-submission.md`
- Modify: `extensions/vscode/README.md`
- Modify: `PRIVACY.md`
- Modify: `tools/test/installed-verification-doc.test.mjs`
- Modify: `tools/test/release-version.test.mjs`
- Modify: `package.json`
- Modify: `extensions/vscode/package.json`
- Modify: `extensions/firefox/package.json`
- Modify: `extensions/firefox/manifest.json`
- Modify: `extensions/chrome/package.json`
- Modify: `extensions/chrome/manifest.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Write failing documentation/release assertions**

Add or update the existing release-material test so it requires these phrases or semantic markers:

```js
assert.match(readme, /DOM tree/i);
assert.match(readme, /box-model overlay/i);
assert.match(protocol, /protocol version 4/i);
assert.match(security, /session storage/i);
assert.match(verification, /Disconnect/);
assert.match(verification, /No active editor/);
```

- [ ] **Step 2: Run release-material tests and confirm failure**

```powershell
corepack pnpm test:release-tools
```

Expected: FAIL because documentation and package versions still describe the previous workflow/protocol.

- [ ] **Step 3: Update the user and contributor workflow**

Document the normal installed flow as:

```text
1. Open the project in VS Code; Browser2IDE starts automatically.
2. Click the Browser2IDE status item to copy `port + PIN`.
3. Open Browser2IDE DevTools in one browser window, paste the code, and connect.
4. Confirm the same code appears in the connected header.
5. Enable the picker or choose a row in the DOM tree.
6. Keep the intended CSS/SCSS document active in VS Code.
7. Read the exact resolution result in the browser footer.
8. Use Disconnect to unlink only that browser window.
```

Update architecture/protocol/security with node-ref locality, targeted replies, peer state, session-only display-code retention, and the read-only boundary. Advance all mutually incompatible artifacts to one release version and regenerate `pnpm-lock.yaml` through pnpm.

- [ ] **Step 4: Run documentation and lockfile checks**

```powershell
corepack pnpm install --lockfile-only
corepack pnpm test:release-tools
corepack pnpm lint
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit documentation and versions**

```powershell
git -c safe.directory=F:/_Browser2IDE add README.md CHANGELOG.md PRIVACY.md docs/mvp-verification.md docs/mvp-usage.md docs/architecture.md docs/protocol.md docs/security.md docs/installed-verification.md docs/release.md docs/firefox-source-submission.md extensions/vscode/README.md tools/test/installed-verification-doc.test.mjs tools/test/release-version.test.mjs package.json pnpm-lock.yaml extensions/vscode/package.json extensions/firefox/package.json extensions/firefox/manifest.json extensions/chrome/package.json extensions/chrome/manifest.json
git -c safe.directory=F:/_Browser2IDE commit -m "docs: release browser inspector workflow"
```

Before committing, inspect the staged list and remove any unrelated path from the index.

## Task 18: Run Full Automated And Installed-Artifact Verification

**Files:**
- Modify only when a verification defect requires a scoped fix, with a new failing regression test first.
- Record any durable procedure correction in `docs/mvp-verification.md`.

- [ ] **Step 1: Run the complete automated gate**

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: every command exits 0; `web-ext` reports zero errors, warnings, and notices.

- [ ] **Step 2: Build and verify packaged artifacts**

```powershell
corepack pnpm package
corepack pnpm test:release-tools
corepack pnpm smoke:vscode-package
corepack pnpm smoke:chrome-package
```

Expected: VSIX, Firefox, and Chrome package checks exit 0 and contain matching protocol-v4 versions.

- [ ] **Step 3: Verify the installed Firefox Stable workflow**

Install the produced VSIX and Firefox package, then verify without contributor terminal commands:

```text
- VS Code starts Browser2IDE automatically and shows one link code.
- Firefox accepts that code and displays the same formatted value.
- Picker hover renders margin/border/padding/content overlays and a bounded label.
- Page click does not activate the fixture control, selects exactly once, keeps picker on, and reveals the tree row.
- Tree hover previews the page; tree selection works with picker off.
- Dynamic nodes, open shadow DOM, same-origin iframe, cross-origin locked iframe, and multiline inline geometry behave as specified.
- CSS and source-mapped SCSS blocks highlight in all matching places; immediate-parent rules use the context color.
- Unsupported editor, missing map, ambiguous rule, and IDE disconnect each show their exact footer state.
- Disconnect clears the browser-window link and leaves a separately linked browser window connected.
```

- [ ] **Step 4: Verify current Chrome/Chromium parity**

Repeat the same installed package flow in Chrome/Chromium and confirm there are no adapter-only behavioral differences or new permissions.

- [ ] **Step 5: Perform visual QA at narrow and wide DevTools sizes**

Capture panel and inspected-page screenshots at approximately 360 px and 900 px DevTools widths. Verify:

```text
- nonblank virtualized tree;
- no toolbar/footer text overlap;
- stable picker and Disconnect controls;
- readable focus, selected, hovered, shadow, frame, and inaccessible states;
- correctly aligned overlay label and all box-model layers;
- no page or overlay element intercepts pointer input outside picker suppression.
```

- [ ] **Step 6: Inspect the final diff and history**

```powershell
git -c safe.directory=F:/_Browser2IDE status --short
git -c safe.directory=F:/_Browser2IDE diff --check
git -c safe.directory=F:/_Browser2IDE log --oneline -20
```

Expected: no whitespace errors, no accidental staging/modification of unrelated files, and one reviewable commit per task.

## Final Plan Review Checklist

- [ ] Every acceptance criterion in the approved design maps to at least one implementation task and one verification step.
- [ ] Protocol v4 contains no compatibility branch for protocol v3.
- [ ] Public WebSocket messages contain no DOM tree, node references, local paths, or source contents.
- [ ] Browser-local commands are channel/tab-bound, epoch-checked, revision-checked, and size-bounded.
- [ ] Same-origin frame and open-shadow behavior is tested; cross-origin and closed boundaries fail closed.
- [ ] Picker suppression covers the complete approved event sequence and selects once only for trusted primary input.
- [ ] Hover never expands or scrolls an unmaterialized tree branch; selection always reveals its path.
- [ ] Resolution routing is origin-only across tabs and browser windows.
- [ ] Every current selection generation receives one explicit VS Code outcome.
- [ ] CSS fallback refuses known-other and ambiguous sources; SCSS never guesses nested source without a map.
- [ ] Selected and immediate-parent ranges can both appear multiple times and have deterministic precedence/colors.
- [ ] Disconnect revokes only the current browser token; stop/start rotates the PIN and all credentials.
- [ ] Firefox and Chrome share all inspection behavior through browser core.
- [ ] Every command and type name is concrete and resolves in the repository at the task where it is used.
