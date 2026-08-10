# Browser2IDE DOM Tree Recovery And Source Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the browser DevTools DOM tree expanded across recoverable content-session replacements and add duplicated previous/next controls that navigate the VS Code cursor among source ranges for the selected DOM element.

**Architecture:** Protocol v5 adds a browser-to-IDE navigation intent and an IDE-to-originating-browser cursor state, routed through the existing inspect reply route. VS Code owns selected-only source ranges and cursor movement; the shared browser core owns both control surfaces and a conservative browser-local DOM locator. During content recovery the panel freezes the old tree, resolves locators against the new session, hydrates live branches, and swaps the tree atomically.

**Tech Stack:** Node.js 20+, pnpm 9, TypeScript 5, Zod 3, Vitest 2, ws 8, VS Code Extension API, Lucide 0.468, Firefox WebExtensions, Chrome Manifest V3.

---

## Execution Preconditions

- Read `docs/superpowers/specs/2026-08-10-dom-tree-recovery-source-navigation-design.md` before editing.
- Start from commit `71fc5b6` or a descendant containing the approved design.
- Use TDD for every behavior change: add one focused failing test, observe the intended failure, implement the smallest behavior, and rerun the focused suite.
- Use a fresh worker for each task under subagent-driven execution and perform both spec-compliance and code-quality review before accepting the task.
- Do not preserve protocol-v4 compatibility. Browser, bridge, simulator test clients, VS Code, package metadata, and current protocol documentation advance together.
- Keep source navigation selected-only. Existing immediate-parent decorations remain unchanged and never enter the navigation count.
- Do not move the VS Code cursor when a DOM element is selected. Cursor movement begins only after a previous/next command.
- Do not send DOM locators, node refs, local file paths, source ranges, or source contents over WebSocket.
- Preserve unrelated untracked files: `.superpowers/`, `debug.log`, and `docs/superpowers/plans/2026-07-09-browser2ide-mvp.md`.
- Use `apply_patch` for manual edits and stage only files owned by the current task.

## Planned File Structure

### Public Protocol And Bridge

```text
packages/protocol/src/capabilities.ts
packages/protocol/src/limits.ts
packages/protocol/src/messages.ts
packages/protocol/src/index.ts
packages/protocol/test/sourceNavigation.test.ts          # new
packages/protocol/test/schema.test.ts
packages/protocol/test/public-types.ts
packages/protocol/test/public-export.mjs

packages/bridge/src/clientRegistry.ts
packages/bridge/src/router.ts
packages/bridge/src/server.ts
packages/bridge/test/router.test.ts
packages/bridge/test/server.test.ts
```

### Shared Browser Runtime

```text
packages/browser-extension-core/src/bridgeClient.ts
packages/browser-extension-core/src/windowConnectionCoordinator.ts
packages/browser-extension-core/src/backgroundRuntime.ts
packages/browser-extension-core/src/backgroundRouter.ts
packages/browser-extension-core/src/inspectCorrelationStore.ts
packages/browser-extension-core/src/inspectPortProtocol.ts
packages/browser-extension-core/src/panelSessionTransport.ts
packages/browser-extension-core/src/panelInspectTransport.ts
packages/browser-extension-core/src/sourceNavigationController.ts  # new
packages/browser-extension-core/src/domStableLocator.ts             # new
packages/browser-extension-core/src/domProtocol.ts
packages/browser-extension-core/src/domTreeProvider.ts
packages/browser-extension-core/src/pageInspectionSession.ts
packages/browser-extension-core/src/domTreeRecoveryCoordinator.ts   # new
packages/browser-extension-core/src/domTreeController.ts
packages/browser-extension-core/src/domTreeView.ts
packages/browser-extension-core/src/panelView.ts
packages/browser-extension-core/src/panelRuntime.ts
packages/browser-extension-core/src/index.ts
packages/browser-extension-core/assets/panel.html
packages/browser-extension-core/assets/panel.css

packages/browser-extension-core/test/bridgeClient.test.ts
packages/browser-extension-core/test/windowConnectionCoordinator.test.ts
packages/browser-extension-core/test/backgroundRouter.test.ts
packages/browser-extension-core/test/inspectCorrelationStore.test.ts
packages/browser-extension-core/test/inspectPort.test.ts
packages/browser-extension-core/test/panelSessionTransport.test.ts
packages/browser-extension-core/test/panelInspectTransport.test.ts
packages/browser-extension-core/test/sourceNavigationController.test.ts # new
packages/browser-extension-core/test/domProtocol.test.ts
packages/browser-extension-core/test/domTreeProvider.test.ts
packages/browser-extension-core/test/pageInspectionSession.test.ts
packages/browser-extension-core/test/domTreeRecoveryCoordinator.test.ts # new
packages/browser-extension-core/test/domTreeController.test.ts
packages/browser-extension-core/test/domTreeView.test.ts
packages/browser-extension-core/test/panelRuntime.test.ts
packages/browser-extension-core/test/publicExports.test.ts
```

### VS Code Runtime

```text
extensions/vscode/src/bridgeClient.ts
extensions/vscode/src/extension.ts
extensions/vscode/src/presenter/sourceNavigator.ts        # new
extensions/vscode/src/presenter/runtime.ts
extensions/vscode/test/bridgeClient.test.ts
extensions/vscode/test/sourceNavigator.test.ts            # new
extensions/vscode/test/presenterRuntime.test.ts
extensions/vscode/test/packageBuild.test.ts
```

### Adapters, Contracts, And Documentation

```text
extensions/test/browserExtensionContract.ts
extensions/firefox/test/panelAssets.test.ts
extensions/chrome/test/panelAssets.test.ts
tools/simulator/src/sendInspect.ts
tools/simulator/test/sendInspect.test.ts
tools/test/runtime-metadata.test.mjs
tools/test/packaged-vsix-smoke.test.mjs
tools/test/packaged-chrome-smoke.test.mjs
tools/test/installed-verification-doc.test.mjs
docs/protocol.md
docs/mvp-verification.md
```

## Task 1: Define Protocol V5 Source Navigation

**Files:**
- Modify: `packages/protocol/src/capabilities.ts`
- Modify: `packages/protocol/src/limits.ts`
- Modify: `packages/protocol/src/messages.ts`
- Modify: `packages/protocol/src/index.ts`
- Create: `packages/protocol/test/sourceNavigation.test.ts`
- Modify: `packages/protocol/test/schema.test.ts`
- Modify: `packages/protocol/test/public-types.ts`
- Modify: `packages/protocol/test/public-export.mjs`

- [ ] **Step 1: Write strict schema tests for both messages**

Create `packages/protocol/test/sourceNavigation.test.ts` with valid fixtures and focused invariant failures:

```ts
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  SourceNavigateMessageSchema,
  SourceNavigationStateMessageSchema,
} from "../src/index.js";

const navigate = {
  protocolVersion: PROTOCOL_VERSION,
  type: "source.navigate",
  messageId: "navigate-1",
  sessionId: "default",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 2,
  direction: "next",
  metadata: {},
} as const;

const state = {
  protocolVersion: PROTOCOL_VERSION,
  type: "source.navigationState",
  messageId: "state-1",
  sessionId: "default",
  source: { role: "ide", id: "ide-1" },
  inspectMessageId: "inspect-1",
  resolutionGeneration: 2,
  selectedMatchCount: 4,
  activeMatchIndex: 1,
  metadata: {},
} as const;

describe("source navigation protocol", () => {
  it("accepts bounded navigation intent and state", () => {
    expect(SourceNavigateMessageSchema.parse(navigate)).toEqual(navigate);
    expect(SourceNavigationStateMessageSchema.parse(state)).toEqual(state);
  });

  it("accepts an absent active index for a cursor outside every match", () => {
    const { activeMatchIndex: _omitted, ...outside } = state;
    expect(SourceNavigationStateMessageSchema.parse(outside)).toEqual(outside);
  });

  it.each([
    { selectedMatchCount: 0, activeMatchIndex: 0 },
    { selectedMatchCount: 4, activeMatchIndex: 4 },
    { selectedMatchCount: 4, activeMatchIndex: -1 },
  ])("rejects invalid index invariants: %o", (override) => {
    expect(() => SourceNavigationStateMessageSchema.parse({
      ...state,
      ...override,
    })).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => SourceNavigateMessageSchema.parse({
      ...navigate,
      command: "workbench.action.files.save",
    })).toThrow();
  });
});
```

Also add public type assertions showing readonly fields, the closed direction union, and optional `activeMatchIndex`.

- [ ] **Step 2: Run the focused protocol test and observe the missing exports**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol exec vitest run test/sourceNavigation.test.ts
```

Expected: FAIL because protocol v5 and both source-navigation schemas do not exist.

- [ ] **Step 3: Add the capability, limits, schemas, and public exports**

Add the capability and a shared small-envelope limit:

```ts
export const ProtocolCapability = {
  Inspect: "inspect",
  Resolution: "resolution",
  Link: "link",
  SourceNavigation: "source-navigation",
} as const;

export const SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES = 16 * 1024;
```

Advance the exact protocol version and add strict schemas in `messages.ts`:

```ts
export const PROTOCOL_VERSION = 5 as const;

export const SourceNavigationDirectionSchema = z.enum(["previous", "next"]);

export function createSourceNavigateMessageSchema(
  envelopeMaxBytes = SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
) {
  const schema = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("source.navigate"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    inspectMessageId: opaqueIdSchema,
    resolutionGeneration: generationSchema,
    direction: SourceNavigationDirectionSchema,
    metadata: EmptyMetadataSchema,
  }).strict();
  return schema.superRefine((message, context) => {
    addSerializedBudgetIssue(message, envelopeMaxBytes, context,
      "source navigation message exceeds serialized byte limit");
  }).transform((message): DeepReadonly<z.infer<typeof schema>> => message);
}

export function createSourceNavigationStateMessageSchema(
  envelopeMaxBytes = SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
) {
  const schema = z.object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("source.navigationState"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    source: ResolutionSourceSchema,
    inspectMessageId: opaqueIdSchema,
    resolutionGeneration: generationSchema,
    selectedMatchCount: countSchema,
    activeMatchIndex: countSchema.optional(),
    metadata: EmptyMetadataSchema,
  }).strict();
  return schema.superRefine((message, context) => {
    if (message.activeMatchIndex !== undefined &&
        message.activeMatchIndex >= message.selectedMatchCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["activeMatchIndex"],
        message: "active match index must reference a selected match",
      });
    }
    addSerializedBudgetIssue(message, envelopeMaxBytes, context,
      "source navigation state exceeds serialized byte limit");
  }).transform((message): DeepReadonly<z.infer<typeof schema>> => message);
}
```

Implement `addSerializedBudgetIssue` with the same JSON/UTF-8 behavior already
used by `createResolutionMessageSchema`, export both schemas and inferred types,
and include both in `Browser2IdeMessageSchema`.

- [ ] **Step 4: Update protocol capability and version assertions**

Change current protocol tests and public type fixtures from literal `4` to
literal `5`. Add `SourceNavigation: "source-navigation"` to the closed
capability assertion. Do not edit historical specs or historical plans that
describe protocol v4.

- [ ] **Step 5: Run the complete protocol package checks**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol test
corepack pnpm --filter @browser2ide/protocol typecheck
```

Expected: PASS, including public exports and readonly public type checks.

- [ ] **Step 6: Commit protocol v5**

```powershell
git add packages/protocol
git commit -m "feat(protocol): add source navigation"
```

## Task 2: Route Navigation Through The Exact Inspect Reply Route

**Files:**
- Modify: `packages/bridge/src/clientRegistry.ts`
- Modify: `packages/bridge/src/router.ts`
- Modify: `packages/bridge/src/server.ts`
- Modify: `packages/bridge/test/router.test.ts`
- Modify: `packages/bridge/test/server.test.ts`

- [ ] **Step 1: Add failing routing and role tests**

Extend `router.test.ts` with one browser and one IDE registered in the same
session. Register an inspect route, then assert:

```ts
routeMessage(registry, replyRoutes, browser, navigate({
  inspectMessageId: "inspect-a",
}));
expect(messages(ide)).toContainEqual(expect.objectContaining({
  type: "source.navigate",
  inspectMessageId: "inspect-a",
}));

routeMessage(registry, replyRoutes, ide, navigationState({
  inspectMessageId: "inspect-a",
  activeMatchIndex: 2,
}));
expect(messages(browser)).toContainEqual(expect.objectContaining({
  type: "source.navigationState",
  activeMatchIndex: 2,
}));
```

Add negative tests for wrong roles, wrong session, missing capability, missing
route, wrong IDE `source.id`, and a second browser attempting to navigate
`inspect-a`.

- [ ] **Step 2: Run the focused bridge tests and observe ignored messages**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol build
corepack pnpm --filter @browser2ide/bridge exec vitest run test/router.test.ts test/server.test.ts
```

Expected: FAIL because the registry discards capabilities and the server rejects
both new inbound message types.

- [ ] **Step 3: Retain authenticated capabilities in the client registry**

Extend both registration types:

```ts
export interface ClientRegistration {
  readonly connection: BridgeConnection;
  readonly source: ClientSource;
  readonly sessionId: string;
  readonly authToken: string;
  readonly capabilities: readonly ProtocolCapability[];
}

export function supportsCapability(
  client: RegisteredClient,
  capability: ProtocolCapability,
): boolean {
  return client.capabilities.includes(capability);
}
```

Pass `message.capabilities` into `registry.add()` after hello authentication.
Store a frozen copy so caller mutation cannot alter authorization.

- [ ] **Step 4: Permit and route only authorized navigation traffic**

Add server direction checks:

```ts
case "source.navigate":
  return (client.source.role === "browser" ||
    client.source.role === "simulator") &&
    message.sessionId === client.sessionId &&
    supportsCapability(client, "source-navigation");
case "source.navigationState":
  return client.source.role === "ide" &&
    message.sessionId === client.sessionId &&
    message.source.id === client.source.id &&
    supportsCapability(client, "source-navigation");
```

In `router.ts`, resolve `inspectMessageId` before either direction. For an
intent, require `replyRoutes.resolve(...) === sender.id`, then send to linked
IDE clients that advertise `source-navigation`. For state, reuse the
resolution recipient checks and forward only to the stored browser connection
when it advertises the capability. Return existing bounded
`protocol.invalidMessage`, `bridge.noIdeClient`, or `bridge.noBrowserClient`
errors on failure.

- [ ] **Step 5: Run bridge tests and typecheck**

Run:

```powershell
corepack pnpm --filter @browser2ide/bridge test
corepack pnpm --filter @browser2ide/bridge typecheck
```

Expected: PASS with no broadcast navigation and no cross-window command path.

- [ ] **Step 6: Commit bridge routing**

```powershell
git add packages/bridge
git commit -m "feat(bridge): route source navigation"
```

## Task 3: Carry Navigation Through The Browser Background

**Files:**
- Modify: `packages/browser-extension-core/src/bridgeClient.ts`
- Modify: `packages/browser-extension-core/src/windowConnectionCoordinator.ts`
- Modify: `packages/browser-extension-core/src/backgroundRuntime.ts`
- Modify: `packages/browser-extension-core/src/backgroundRouter.ts`
- Modify: `packages/browser-extension-core/src/inspectCorrelationStore.ts`
- Modify: `packages/browser-extension-core/src/inspectPortProtocol.ts`
- Modify: `packages/browser-extension-core/src/panelSessionTransport.ts`
- Modify: `packages/browser-extension-core/src/panelInspectTransport.ts`
- Modify: `packages/browser-extension-core/test/bridgeClient.test.ts`
- Modify: `packages/browser-extension-core/test/windowConnectionCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/backgroundRouter.test.ts`
- Modify: `packages/browser-extension-core/test/inspectCorrelationStore.test.ts`
- Modify: `packages/browser-extension-core/test/inspectPort.test.ts`
- Modify: `packages/browser-extension-core/test/panelSessionTransport.test.ts`
- Modify: `packages/browser-extension-core/test/panelInspectTransport.test.ts`

- [ ] **Step 1: Add failing browser WebSocket client tests**

Assert that authenticated browser hello advertises
`["inspect", "link", "source-navigation"]`, that this method emits a strict
wire message, and that same-session state notifies listeners:

```ts
expect(client.sendSourceNavigation({
  inspectMessageId: "inspect-1",
  resolutionGeneration: 3,
  direction: "next",
})).toBe("sent");

expect(lastSent(socket)).toMatchObject({
  type: "source.navigate",
  sessionId: "default",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 3,
  direction: "next",
});
```

Also verify not-connected, invalid-message, transport-error, wrong-session
state, and listener disposal behavior.

- [ ] **Step 2: Add failing local panel/background transport tests**

Define a browser-local panel command that omits session and message IDs:

```ts
interface PanelSourceNavigateCommand {
  readonly type: "browser2ide.source.navigate";
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly direction: "previous" | "next";
}
```

Test strict key validation in `inspectPort.test.ts`, panel posting in
`panelInspectTransport.test.ts`, background forwarding with the bound
`windowId`, and state publication back only to the correlated panel channel.

- [ ] **Step 3: Run focused browser-core transport tests**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol build
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/bridgeClient.test.ts test/windowConnectionCoordinator.test.ts test/backgroundRouter.test.ts test/inspectCorrelationStore.test.ts test/inspectPort.test.ts test/panelSessionTransport.test.ts test/panelInspectTransport.test.ts
```

Expected: FAIL because the new browser/background path is absent.

- [ ] **Step 4: Implement the browser client and window coordinator APIs**

Add these public methods/events:

```ts
export type SourceNavigationSendOutcome = InspectSendOutcome;

sendSourceNavigation(input: Pick<SourceNavigateMessage,
  "inspectMessageId" | "resolutionGeneration" | "direction"
>): SourceNavigationSendOutcome;

onSourceNavigationState(
  listener: (message: SourceNavigationStateMessage) => void,
): BrowserBridgeSubscription;
```

Construct the strict WebSocket message from authenticated credentials. Extend
`WindowConnectionClient` and `WindowConnectionCoordinator` with
`publishSourceNavigation(windowId, input)` and
`onSourceNavigationState(listener)`. Forward only from a current client token,
just like resolution forwarding.

- [ ] **Step 5: Implement strict local command and correlated state delivery**

Add `parsePanelSourceNavigateCommand` to `inspectPortProtocol.ts`. In
`BackgroundRouter.queueInspectRequest`, branch to a dedicated method before DOM
parsing:

```ts
const navigation = parsePanelSourceNavigateCommand(message);
if (navigation) {
  this.publishSourceNavigation(record, activationToken, navigation);
  return;
}
```

Extend `InspectCorrelationStore` without changing resolution monotonicity:

```ts
public acceptNavigationState(
  message: SourceNavigationStateMessage,
): string | undefined {
  const parsed = SourceNavigationStateMessageSchema.safeParse(message);
  if (!parsed.success) return undefined;
  const correlation = this.correlations.get(parsed.data.inspectMessageId);
  if (!correlation ||
      correlation.resolutionGeneration !== parsed.data.resolutionGeneration) {
    return undefined;
  }
  return correlation.channel;
}
```

Equal generations must remain valid here because cursor movement emits repeated
states. Extend `PanelSessionTransport.publish` and
`PanelInspectTransport.validatedPushMessage` for the new state schema.

- [ ] **Step 6: Run focused and complete browser-core tests**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/bridgeClient.test.ts test/windowConnectionCoordinator.test.ts test/backgroundRouter.test.ts test/inspectCorrelationStore.test.ts test/inspectPort.test.ts test/panelSessionTransport.test.ts test/panelInspectTransport.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit browser transport**

```powershell
git add packages/browser-extension-core/src packages/browser-extension-core/test
git commit -m "feat(browser): transport source navigation"
```

## Task 4: Add The VS Code Protocol Endpoint

**Files:**
- Modify: `extensions/vscode/src/bridgeClient.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Modify: `extensions/vscode/test/bridgeClient.test.ts`

- [ ] **Step 1: Add failing IDE client tests**

Test that hello advertises `["resolution", "source-navigation"]`, authenticated
`source.navigate` reaches a listener, stale-session data is rejected, and this
sender writes a strict state message:

```ts
client.sendSourceNavigationState({
  inspectMessageId: "inspect-1",
  resolutionGeneration: 4,
  selectedMatchCount: 3,
  activeMatchIndex: 1,
});

expect(lastSent(socket)).toMatchObject({
  type: "source.navigationState",
  source: { role: "ide", id: expect.any(String) },
  selectedMatchCount: 3,
  activeMatchIndex: 1,
});
```

- [ ] **Step 2: Run the focused VS Code bridge test**

Run:

```powershell
corepack pnpm --filter @browser2ide/protocol build
corepack pnpm --filter browser2ide-vscode exec vitest run test/bridgeClient.test.ts
```

Expected: FAIL because `BridgeClient` does not expose the new event or sender.

- [ ] **Step 3: Implement IDE sender/listener routing**

Add:

```ts
export type SourceNavigationStateInput = Pick<
  SourceNavigationStateMessage,
  | "inspectMessageId"
  | "resolutionGeneration"
  | "selectedMatchCount"
  | "activeMatchIndex"
>;

export interface SourceNavigationStateSender {
  sendSourceNavigationState(state: SourceNavigationStateInput): void;
}
```

Add a small `SourceNavigationClientRouter` parallel to
`ResolutionClientRouter`, a listener set for `SourceNavigateMessage`, and
schema-based `sendSourceNavigationState`. Bind/unbind both routers to the same
client in `extension.ts`; leave actual navigation handling for Task 5.

- [ ] **Step 4: Run test and typecheck**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/bridgeClient.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the IDE endpoint**

```powershell
git add extensions/vscode/src/bridgeClient.ts extensions/vscode/src/extension.ts extensions/vscode/test/bridgeClient.test.ts
git commit -m "feat(vscode): transport source navigation"
```

## Task 5: Navigate Selected-Only Source Ranges In VS Code

**Files:**
- Create: `extensions/vscode/src/presenter/sourceNavigator.ts`
- Modify: `extensions/vscode/src/presenter/runtime.ts`
- Modify: `extensions/vscode/src/extension.ts`
- Create: `extensions/vscode/test/sourceNavigator.test.ts`
- Modify: `extensions/vscode/test/presenterRuntime.test.ts`

- [ ] **Step 1: Write focused cursor and ordering tests**

Build a memory host with one document, a primary cursor, state publications,
and navigation calls. Cover selected-only filtering, exact duplicate removal,
retained nested ranges, deterministic sorting, all cursor positions, wrapping,
and stale correlations. Representative assertions:

```ts
navigator.update({
  inspectMessageId: "inspect-1",
  resolutionGeneration: 2,
  documentUri: "file:///workspace/card.scss",
  matches: [selected(20, 30), parent(10, 15), selected(2, 8), selected(2, 8)],
});

expect(states.at(-1)).toMatchObject({
  selectedMatchCount: 2,
  activeMatchIndex: undefined,
});

navigator.navigate(intent("next", { resolutionGeneration: 2 }));
expect(host.cursor).toEqual({ line: 2, character: 0 });
expect(host.revealed).toEqual(range(2, 8));
```

Add cases for cursor inside match 1/2, before, between, after, previous/next
wrap, multiple VS Code selections using only the primary cursor, editor change,
and text-change invalidation.

- [ ] **Step 2: Run the new source navigator tests**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/sourceNavigator.test.ts
```

Expected: FAIL because `SourceNavigator` does not exist.

- [ ] **Step 3: Implement a host-independent source navigator**

Create these boundaries:

```ts
export interface SourceNavigationEditor {
  readonly documentUri: string;
}

export interface SourceNavigationHost {
  getActiveEditor(): SourceNavigationEditor | undefined;
  getPrimaryCursor(editor: SourceNavigationEditor): SourcePosition;
  setPrimaryCursor(editor: SourceNavigationEditor, position: SourcePosition): void;
  revealRange(editor: SourceNavigationEditor, range: SourceRange): void;
  onDidChangeActiveEditor(listener: () => void): DisposableLike;
  onDidChangePrimaryCursor(listener: () => void): DisposableLike;
}

export interface SourceNavigationResolution {
  readonly inspectMessageId: string;
  readonly resolutionGeneration: number;
  readonly documentUri?: string;
  readonly matches: readonly ResolvedSourceMatch[];
}
```

`SourceNavigator.update` must filter `targetRole === "selected"`, deduplicate
only identical URI/start/end ranges, and sort by start then end. Use
end-exclusive containment. `navigate` verifies inspect ID and generation,
chooses relative to the actual cursor, wraps, sets the cursor to `range.start`,
reveals the complete range, then publishes state. `invalidate` drops ranges and
publishes zero matches for the retained current identity. `beginInspect`
invalidates old intent immediately without moving the cursor. An absent
`documentUri` represents a completed no-active-editor outcome and publishes
zero navigable matches.

- [ ] **Step 4: Integrate with presenter publication and VS Code events**

Extend `PresenterRuntimeHost` with primary-selection access and
`onDidChangeTextEditorSelection`. Create one navigator in
`createPresenterRuntime` and update it inside `onOutcome` after sending the
resolution:

```ts
sourceNavigator.update({
  inspectMessageId: publication.inspectMessageId,
  resolutionGeneration: publication.resolutionGeneration,
  ...(publication.resolution
    ? { documentUri: publication.resolution.documentUri }
    : {}),
  matches: publication.resolution?.matches ?? [],
});
```

Expose `navigate(message)` on `PresenterRuntime`. In `extension.ts`, adapt
`vscode.window.onDidChangeTextEditorSelection`, `selection.active`, cursor
assignment, and `TextEditorRevealType.InCenter`. Register the bridge listener:

```ts
nextClient.onSourceNavigate((message) => runtime.navigate(message));
```

Send state through the bound `SourceNavigationClientRouter`.

- [ ] **Step 5: Verify no automatic cursor movement**

Add a presenter-runtime test that calls `runtime.select(inspect)` and completes
resolution without invoking `setPrimaryCursor` or `revealRange`. Then issue the
first `next` intent and assert exactly one cursor/reveal call.

- [ ] **Step 6: Run VS Code presenter tests and typecheck**

Run:

```powershell
corepack pnpm --filter browser2ide-vscode exec vitest run test/sourceNavigator.test.ts test/presenterRuntime.test.ts test/activeEditorCoordinator.test.ts
corepack pnpm --filter browser2ide-vscode typecheck
```

Expected: PASS. Parent decoration tests remain unchanged.

- [ ] **Step 7: Commit selected-only navigation**

```powershell
git add extensions/vscode/src extensions/vscode/test
git commit -m "feat(vscode): navigate selected source ranges"
```

## Task 6: Render Synchronized Row And Footer Controls

**Files:**
- Create: `packages/browser-extension-core/src/sourceNavigationController.ts`
- Modify: `packages/browser-extension-core/src/domTreeView.ts`
- Modify: `packages/browser-extension-core/src/panelView.ts`
- Modify: `packages/browser-extension-core/src/panelRuntime.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/assets/panel.html`
- Modify: `packages/browser-extension-core/assets/panel.css`
- Create: `packages/browser-extension-core/test/sourceNavigationController.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeView.test.ts`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`

- [ ] **Step 1: Write the controller state-machine tests**

Test these exact transitions:

```ts
controller.beginInspect("inspect-1");
expect(controller.snapshot()).toMatchObject({
  visible: false,
  reserveRowSpace: true,
  disabled: true,
});
controller.acceptResolution(resolution({
  inspectMessageId: "inspect-1",
  resolutionGeneration: 3,
  selectedMatchCount: 4,
}));
expect(controller.snapshot()).toMatchObject({
  visible: true,
  reserveRowSpace: true,
  disabled: true,
  counter: "- / 4",
});

controller.acceptState(state({ activeMatchIndex: 1 }));
expect(controller.snapshot()).toMatchObject({
  disabled: false,
  counter: "2 / 4",
});
```

Also cover repeated equal-generation cursor states, stale inspect/generation,
count mismatch, parent-only resolution, invalidation, IDE disconnect, and both
directions dispatching the same current identifiers.

- [ ] **Step 2: Add failing view tests for both control surfaces**

Assert that only the selected row receives two buttons, each row button has the
correct title/ARIA label, clicking stops row selection/toggle, footer and row
buttons dispatch identical commands, and controls hide at zero selected
matches.

- [ ] **Step 3: Run focused browser UI tests**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/sourceNavigationController.test.ts test/domTreeView.test.ts test/panelRuntime.test.ts
```

Expected: FAIL because the shared controller and controls do not exist.

- [ ] **Step 4: Implement the shared navigation controller**

Use one immutable view model for both views:

```ts
export interface SourceNavigationViewModel {
  readonly visible: boolean;
  readonly reserveRowSpace: boolean;
  readonly disabled: boolean;
  readonly selectedMatchCount: number;
  readonly activeMatchIndex?: number;
  readonly counter: string;
}

export class SourceNavigationController {
  beginInspect(inspectMessageId: string): void;
  acceptResolution(message: ResolutionMessage): void;
  acceptState(message: SourceNavigationStateMessage): void;
  navigate(direction: SourceNavigationDirection): void;
  invalidate(): void;
  subscribe(listener: () => void): () => void;
  snapshot(): SourceNavigationViewModel;
}
```

The controller owns no DOM nodes. Its dispatch callback calls
`PanelInspectTransport.dispatchSourceNavigation` with current correlation
fields. `beginInspect` sets `reserveRowSpace` while keeping controls disabled;
a completed zero-match resolution clears the reservation. This prevents the
selected row label from shifting when matching controls first appear.

- [ ] **Step 5: Render Lucide controls without layout shift**

Use `ChevronLeft`, `ChevronRight`, and Lucide `createElement` for dynamically
created row buttons. Add a fixed-width `.source-navigation-controls` after the
ellipsized label only on the selected row. Buttons use
`data-action="source-previous"` and `data-action="source-next"`; handle these
before normal row click behavior and call both `preventDefault()` and
`stopPropagation()`.

Add this footer structure:

```html
<div class="resolution-row">
  <output id="resolution-status" class="resolution-status" role="status">
    Select an element to inspect
  </output>
  <div id="source-navigation-footer" class="source-navigation-footer" hidden>
    <output id="source-navigation-counter"></output>
    <button id="source-previous" class="source-navigation-button"
      type="button" aria-label="Previous source match"
      title="Previous source match"></button>
    <button id="source-next" class="source-navigation-button"
      type="button" aria-label="Next source match"
      title="Next source match"></button>
  </div>
</div>
```

Keep buttons square, stable, and compact; set the label to `min-width: 0` and
`flex: 1 1 auto`; never let controls overlap or resize a row.

- [ ] **Step 6: Wire panel lifecycle state**

In `panelRuntime`, call `beginInspect` on
`browser2ide.inspect.started`, `acceptResolution` only after the resolution
presenter accepts the message, `acceptState` for strict state messages, and
`invalidate` on disconnect, inspect invalidation, or selection reset. Render
the same model through `DomTreeView` and `DomPanelView` subscriptions.

- [ ] **Step 7: Run UI tests, typecheck, and both browser builds**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/sourceNavigationController.test.ts test/domTreeView.test.ts test/panelRuntime.test.ts test/publicExports.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
corepack pnpm --filter browser2ide-firefox build
corepack pnpm --filter browser2ide-chrome build
```

Expected: PASS and both generated panels contain the duplicated controls.

- [ ] **Step 8: Commit browser controls**

```powershell
git add packages/browser-extension-core extensions/firefox/dist extensions/chrome/dist
git commit -m "feat(browser): add source navigation controls"
```

Do not stage generated `dist` directories if they are ignored; stage only
tracked source/assets and tests in that case.

## Task 7: Add A Strict Browser-Local Stable Locator Protocol

**Files:**
- Create: `packages/browser-extension-core/src/domStableLocator.ts`
- Modify: `packages/browser-extension-core/src/domProtocol.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Modify: `packages/browser-extension-core/test/domProtocol.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`

- [ ] **Step 1: Add failing locator parser tests**

Use this concrete browser-local shape:

```ts
interface DomStableLocator {
  readonly version: 1;
  readonly targetKind: "element" | "shadow-root" | "frame-document";
  readonly boundaries: readonly {
    readonly kind: "shadow-root" | "frame-document";
    readonly hostPath: readonly DomPathSegment[];
  }[];
  readonly path: readonly DomPathSegment[];
}

interface DomPathSegment {
  readonly tagName: string;
  readonly siblingIndex: number;
  readonly id?: string;
  readonly classes?: readonly string[];
  readonly attributes?: readonly {
    readonly name: string;
    readonly value: string;
  }[];
}
```

Test a normal element, nested open shadow/frame boundaries, unknown keys,
unsorted/duplicate classes or attributes, invalid tags, negative index,
depth greater than 64, oversized values, and a message larger than 64 KiB.

- [ ] **Step 2: Add failing DOM request/response tests**

Add a query and success response:

```ts
interface DomResolveLocatorRequest {
  readonly type: "dom.resolveLocator";
  readonly requestId: string;
  readonly locator: DomStableLocator;
}

interface DomLocatorResponse {
  readonly type: "dom.locator";
  readonly requestId: string;
  readonly documentEpoch: number;
  readonly node: DomNodeView;
  readonly ancestorPath: readonly DomNodeView[];
}
```

Every `DomNodeView` must now include its stable locator. Failed resolution uses
the existing closed `dom.error` family with `node-unavailable`; malformed input
uses `invalid-request`.

- [ ] **Step 3: Run focused DOM protocol tests**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domProtocol.test.ts test/publicExports.test.ts
```

Expected: FAIL because locator parsing and the new query do not exist.

- [ ] **Step 4: Implement hostile-input-safe parsing and bounds**

Add constants:

```ts
export const DOM_STABLE_LOCATOR_VERSION = 1;
export const DOM_STABLE_LOCATOR_MAX_DEPTH = 64;
export const DOM_STABLE_LOCATOR_MAX_BOUNDARIES = 16;
export const DOM_STABLE_LOCATOR_MAX_CLASSES = 8;
export const DOM_STABLE_LOCATOR_MAX_ATTRIBUTES = 8;
export const DOM_STABLE_LOCATOR_MAX_TOKEN_LENGTH = 128;
export const DOM_TREE_RECOVERY_MAX_EXPANDED = 64;
```

Follow `domProtocol.ts`'s descriptor snapshot pattern: never read arbitrary
getters during validation, require canonical sorted arrays, freeze every
accepted object, and enforce the existing 64 KiB message budget. Extend the
request/response unions and expected-response switch in
`PanelSessionTransport` and `PanelInspectTransport`. Enforce a maximum of 64
total path segments across every boundary host path plus the final path, not 64
segments independently per array.

- [ ] **Step 5: Run DOM protocol suite and typecheck**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domProtocol.test.ts test/panelSessionTransport.test.ts test/panelInspectTransport.test.ts test/publicExports.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit the locator protocol**

```powershell
git add packages/browser-extension-core/src/domStableLocator.ts packages/browser-extension-core/src/domProtocol.ts packages/browser-extension-core/src/index.ts packages/browser-extension-core/test
git commit -m "feat(browser): add stable DOM locators"
```

## Task 8: Capture And Resolve Stable DOM Locators

**Files:**
- Modify: `packages/browser-extension-core/src/domStableLocator.ts`
- Modify: `packages/browser-extension-core/src/domTreeProvider.ts`
- Modify: `packages/browser-extension-core/src/pageInspectionSession.ts`
- Modify: `packages/browser-extension-core/test/domTreeProvider.test.ts`
- Modify: `packages/browser-extension-core/test/pageInspectionSession.test.ts`

- [ ] **Step 1: Add failing provider identity tests**

Use the existing fake DOM in `domTreeProvider.test.ts`. Capture a locator from
the returned node view, create a fresh equivalent document/provider, and
resolve it. Assert the response returns new node refs and a complete new
ancestor path. Add focused failures for:

- duplicate ID in the current root;
- same structural index but changed tag;
- changed captured class or approved attribute value;
- missing sibling;
- inaccessible frame;
- closed/missing shadow root;
- depth above 64;
- stale session node refs never being consulted.

Representative success assertion:

```ts
const original = firstProvider.revealElement(firstTarget);
const restored = secondProvider.resolveLocator(
  original.ancestorPath.at(-1)!.locator,
);

expect(restored.node.nodeRef).not.toBe(original.nodeRef);
expect(restored.ancestorPath.map((node) => node.label)).toEqual([
  "html", "body", "main", "h2#section_title_id1.block_title",
]);
```

- [ ] **Step 2: Run provider tests and observe missing locator materialization**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domTreeProvider.test.ts test/pageInspectionSession.test.ts
```

Expected: FAIL because views do not capture locators and the provider cannot
resolve them.

- [ ] **Step 3: Implement deterministic capture**

In `domStableLocator.ts`, implement a `DomStableLocatorService` used only by
`DomTreeProvider`:

```ts
export interface StableLocatorResolution {
  readonly kind: DomStableLocator["targetKind"];
  readonly node: Node;
}

export class DomStableLocatorService {
  capture(node: Node, kind: DomStableLocator["targetKind"]): DomStableLocator;
  resolve(locator: DomStableLocator): StableLocatorResolution | undefined;
}
```

Build each element segment from lowercase tag, element-sibling index, bounded
ID, sorted bounded class list, and sorted approved `data-*`, `aria-*`, and
`role` values. Split paths at open-shadow-root and same-origin frame-document
boundaries. Use `FrameRegistry` context/host ownership to cross frame boundaries
instead of inferring authority from URLs.

- [ ] **Step 4: Implement fail-closed resolution**

For each boundary/path:

1. follow the exact element-sibling index;
2. validate tag and every captured fingerprint field;
3. when an ID is present, scan the current boundary only until a second exact
   ID is found and reject duplicates;
4. enter only an open shadow root or a currently accessible frame document;
5. reject any mismatch, cycle, inaccessible root, excluded node, or excessive
   traversal.

Never search by label, text, near sibling, partial class, or selector score.
Materialize the resolved target through existing provider reference/view
methods, then return `ancestorPath` using the new session's refs.

- [ ] **Step 5: Handle `dom.resolveLocator` in the page session**

Add this branch before selection handling:

```ts
if (parsed.type === "dom.resolveLocator") {
  const resolved = this.provider.resolveLocator(parsed.locator);
  return Object.freeze({
    type: "dom.locator",
    requestId: parsed.requestId,
    documentEpoch: this.provider.currentDocumentEpoch,
    node: resolved.node,
    ancestorPath: resolved.ancestorPath,
  });
}
```

Map unresolved/ambiguous/inaccessible identity to bounded `dom.error` without
exposing why page-controlled evidence failed.

- [ ] **Step 6: Run provider/session tests and typecheck**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domTreeProvider.test.ts test/pageInspectionSession.test.ts test/domProtocol.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit locator capture/resolution**

```powershell
git add packages/browser-extension-core/src/domStableLocator.ts packages/browser-extension-core/src/domTreeProvider.ts packages/browser-extension-core/src/pageInspectionSession.ts packages/browser-extension-core/test/domTreeProvider.test.ts packages/browser-extension-core/test/pageInspectionSession.test.ts
git commit -m "feat(browser): resolve stable DOM locators"
```

## Task 9: Recover And Atomically Replace The DOM Tree

**Files:**
- Create: `packages/browser-extension-core/src/domTreeRecoveryCoordinator.ts`
- Modify: `packages/browser-extension-core/src/domTreeController.ts`
- Modify: `packages/browser-extension-core/src/domTreeView.ts`
- Modify: `packages/browser-extension-core/src/panelRuntime.ts`
- Modify: `packages/browser-extension-core/src/index.ts`
- Create: `packages/browser-extension-core/test/domTreeRecoveryCoordinator.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeController.test.ts`
- Modify: `packages/browser-extension-core/test/domTreeView.test.ts`
- Modify: `packages/browser-extension-core/test/panelRuntime.test.ts`
- Modify: `packages/browser-extension-core/test/publicExports.test.ts`

- [ ] **Step 1: Add failing snapshot/frozen-tree controller tests**

Build an expanded tree with a selected node and assert:

```ts
const snapshot = controller.beginRecovery();
expect(snapshot.selectedLocator).toEqual(selectedLocator);
expect(snapshot.expandedLocators).toHaveLength(3);
expect(controller.snapshot().recovering).toBe(true);
expect(controller.rows()).toEqual(rowsBeforeInvalidation);
```

Add a tree with more than 64 expanded nodes and assert the selected locator is
retained plus exactly 64 shallow-to-deep expanded locators. While recovering,
`select`, `toggle`, hover, keyboard, and load-more methods must not dispatch old
node refs.

- [ ] **Step 2: Add failing recovery coordinator tests**

Use a scripted transport with a replacement root and locator responses. Cover:

- selected locator restored first;
- expanded locators resolved shallow-to-deep;
- partial expanded-branch failure;
- selected locator failure produces a live root with no selection;
- new manual `dom.selectionChanged` cancels recovery and wins;
- a second invalidation cancels the first recovery token;
- successful swap triggers exactly one normal `dom.select` dispatch;
- no root-only render is emitted before a successful atomic swap.

- [ ] **Step 3: Run focused recovery tests**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domTreeRecoveryCoordinator.test.ts test/domTreeController.test.ts test/domTreeView.test.ts test/panelRuntime.test.ts
```

Expected: FAIL because invalidation still calls `treeController.reset()`.

- [ ] **Step 4: Add explicit recovery primitives to the controller**

Add these methods and state:

```ts
export interface DomTreeRecoverySnapshot {
  readonly selectedLocator?: DomStableLocator;
  readonly expandedLocators: readonly DomStableLocator[];
}

public beginRecovery(): DomTreeRecoverySnapshot;
public installRecoveryRoot(response: DomRootResponse): void;
public installRecoveredPath(
  response: DomLocatorResponse,
  options: { readonly selected: boolean; readonly expanded: boolean },
): void;
public hydrateRecoveredBranches(): Promise<void>;
public finishRecovery(): void;
public cancelRecovery(reason: string): void;
```

`beginRecovery` freezes the current rendered row array, increments the async
generation, cancels pending queries, and sets `recovering`; it does not clear
the frozen rows. Build the new live maps behind that snapshot. `rows()` returns
frozen rows until `finishRecovery`, which clears the frozen array and notifies
once. `DomTreeSnapshot` exposes `recovering`; the view sets `aria-busy` and a
recovering CSS class.

- [ ] **Step 5: Implement tokenized recovery orchestration**

Create:

```ts
export class DomTreeRecoveryCoordinator {
  begin(): Promise<void>;
  handleManualSelection(event: DomSelectionChangedEvent): void;
  cancel(reason: string): void;
  dispose(): void;
}
```

`begin` obtains the controller snapshot, requests the new root, resolves the
selected locator first, resolves remaining expanded locators sorted by depth,
installs all successful paths, hydrates expanded branches while frozen, and
finishes atomically. Every await checks both a private recovery token and a
content-session generation. After swap, dispatch normal `dom.select` for the
new selected node so page overlay, inspect facts, resolution, and navigation
state are rebuilt through existing paths.

- [ ] **Step 6: Replace destructive invalidation in `panelRuntime`**

Change:

```ts
treeController.reset();
resetResolutionState();
void treeController.loadRoot();
```

to:

```ts
sourceNavigationController.invalidate();
resetResolutionState("restoring");
void recoveryCoordinator.begin().catch(reportError);
```

When a real `dom.selectionChanged` arrives during recovery, call
`handleManualSelection` before forwarding the event to the tree controller.
That method cancels the recovery token and clears the old live/frozen node-ref
maps before the event is applied, even when the replacement content session
reuses the same numeric `documentEpoch`.
On unlink/dispose, cancel recovery and perform the existing hard reset. Keep a
bounded `Restoring DOM` status only during recovery; remove it after live swap
or safe reset.

- [ ] **Step 7: Run recovery tests and the complete browser-core suite**

Run:

```powershell
corepack pnpm --filter @browser2ide/browser-extension-core exec vitest run test/domTreeRecoveryCoordinator.test.ts test/domTreeController.test.ts test/domTreeView.test.ts test/panelRuntime.test.ts
corepack pnpm --filter @browser2ide/browser-extension-core test
corepack pnpm --filter @browser2ide/browser-extension-core typecheck
```

Expected: PASS. Existing branch invalidation and selected-node-removal tests must
remain green.

- [ ] **Step 8: Commit tree recovery**

```powershell
git add packages/browser-extension-core
git commit -m "fix(browser): restore DOM tree sessions"
```

## Task 10: Update Adapters, Contracts, Protocol Guide, And Runbook

**Files:**
- Modify: `tools/simulator/src/sendInspect.ts`
- Modify: `tools/simulator/test/sendInspect.test.ts`
- Modify: `extensions/test/browserExtensionContract.ts`
- Modify: `extensions/firefox/test/panelAssets.test.ts`
- Modify: `extensions/chrome/test/panelAssets.test.ts`
- Modify: `extensions/vscode/test/packageBuild.test.ts`
- Modify: `tools/test/runtime-metadata.test.mjs`
- Modify: `tools/test/packaged-vsix-smoke.test.mjs`
- Modify: `tools/test/packaged-chrome-smoke.test.mjs`
- Modify: `tools/test/installed-verification-doc.test.mjs`
- Modify: `docs/protocol.md`
- Modify: `docs/mvp-verification.md`

- [ ] **Step 1: Update current protocol and package assertions to version 5**

Change current executable fixtures and current documentation assertions from
protocol 4 to 5. Keep historical specs/plans unchanged. Update simulator test
clients that exercise navigation to advertise `source-navigation`; clients that
only send an inspect may continue to advertise only `inspect`.

- [ ] **Step 2: Add packaged asset contract assertions**

Require Firefox and Chrome built panel HTML/CSS/JS to contain:

```ts
expect(panelHtml).toContain("source-navigation-footer");
expect(panelCss).toContain(".source-navigation-controls");
expect(panelBundle).toContain("source.navigationState");
expect(panelBundle).toContain("dom.resolveLocator");
```

Keep adapter source thin: browser-specific files must continue importing the
shared core and must not duplicate locator or navigation logic.

- [ ] **Step 3: Document protocol v5 and browser-local recovery**

Update `docs/protocol.md` with:

- exact protocol version 5;
- `source-navigation` capability;
- both strict message examples;
- same inspect reply-route targeting and role checks;
- repeated same-generation cursor state;
- selected-only counts and absent active index;
- `dom.resolveLocator`, stable-locator bounds, and the statement that locators
  never cross WebSocket;
- read-only security guarantees.

Update `docs/mvp-verification.md` with a manual scenario:

1. expand a branch and select an element with at least two selected matches;
2. confirm row and footer controls show the same count;
3. click next and previous and observe centered VS Code cursor movement;
4. manually place the cursor outside every match and confirm `- / N`;
5. reload the page and confirm the branch/selection restores when identity is
   unchanged;
6. change/remove the selected node and confirm Browser2IDE resets without
   selecting a nearby node;
7. repeat package checks for Firefox and Chrome.

- [ ] **Step 4: Run release-tool, contract, and adapter tests**

Run:

```powershell
corepack pnpm run test:release-tools
corepack pnpm --filter browser2ide-firefox test
corepack pnpm --filter browser2ide-chrome test
corepack pnpm --filter browser2ide-vscode exec vitest run test/packageBuild.test.ts
```

Expected: PASS with runtime metadata pinned to protocol 5.

- [ ] **Step 5: Commit contracts and documentation**

```powershell
git add tools extensions/test extensions/firefox/test extensions/chrome/test extensions/vscode/test/packageBuild.test.ts docs/protocol.md docs/mvp-verification.md
git commit -m "docs: document protocol v5 navigation"
```

## Task 11: Full Verification And Packaged Smoke

**Files:**
- Verify only; fixes belong to the task that owns the failing behavior.

- [ ] **Step 1: Confirm worktree scope**

Run:

```powershell
git status --short
git diff --check
```

Expected: only intended tracked changes, plus the pre-existing unrelated
untracked files. No whitespace errors.

- [ ] **Step 2: Run the complete automated gate**

Run:

```powershell
corepack pnpm install
corepack pnpm build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm dlx web-ext@10.4.0 lint --source-dir extensions/firefox --ignore-files package.json pnpm-lock.yaml tsconfig.json esbuild.mjs "src/**" "test/**"
```

Expected: every command exits 0; `web-ext` reports zero errors, warnings, and
notices.

- [ ] **Step 3: Build and verify distributable artifacts**

Run:

```powershell
corepack pnpm package
corepack pnpm smoke:vscode-package
corepack pnpm smoke:chrome-package
```

Expected: VSIX, Chrome ZIP, Firefox XPI/source archive, checksums, and smoke
tests all pass with protocol 5 metadata.

- [ ] **Step 4: Perform manual Firefox verification**

Follow `docs/mvp-verification.md` using an installed VSIX and installed Firefox
extension, not source-only assumptions. Verify:

- selected and parent colors remain distinct;
- only selected ranges participate in arrows and counter;
- row and footer controls stay synchronized;
- cursor does not move on DOM selection;
- first arrow click moves and centers the cursor;
- manual cursor movement updates the counter;
- page reload restores unchanged tree state;
- ambiguous/changed DOM resets safely;
- disconnect disables navigation and leaves no stale route.

- [ ] **Step 5: Review final history and status**

Run:

```powershell
git log --oneline -12
git status --short --branch
```

Expected: focused conventional commits, no accidental staging, and only known
unrelated untracked files. Do not create a catch-all verification commit unless
verification itself required a tracked documentation correction.
