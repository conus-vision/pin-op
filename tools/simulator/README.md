# Pin-op Protocol Simulator

The simulator sends strict Pin-op protocol v6 messages to the local WebSocket
bridge. It does not use HTTP, write source files, carry workspace paths, or ask
an IDE to run commands.

## Send The Inspect Fixture

Build the workspace, start Pin-op in the IDE, and copy its seven-digit link
code. Then run:

```powershell
corepack pnpm --filter @pin-op/simulator send -- --link-code 48735-07 --fixture inspect-card
```

Every simulator `inspect` envelope includes `ideHighlightEnabled: true` unless
the programmatic `buildInspectMessage` caller explicitly supplies `false`.

Explicit bridge credentials are also supported for integration environments:

```powershell
corepack pnpm --filter @pin-op/simulator send -- --url ws://127.0.0.1:48735 --session-id SESSION --bridge-instance-id UUID --auth-token TOKEN --fixture inspect-card
```

## Protocol V6 Verification

```powershell
corepack pnpm --filter @pin-op/simulator test
```

The suite drives changed CSS, SCSS, JavaScript, and PHP saves through the
production refresh classifier, SaveObserver scheduler, IDE client, bridge
router, browser background router, and tab refresh coordinator. It also covers
inactive-tab refresh on activation; Auto Refresh and IDE Highlight off/on;
exact source opening; stale source-click rejection; and a real bridge rejecting
a protocol-v5 handshake.

Protocol mismatch close code `1002` is terminal. The simulator strictly decodes
the bridge reason into expected and received versions, does not retry the
legacy handshake, and has no protocol-v5 fallback.
