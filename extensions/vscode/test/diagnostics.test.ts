import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type ErrorMessage,
  type InspectMessage,
} from "@pinop/protocol";
import {
  DiagnosticsTracker,
  writeBridgeDiagnostics,
} from "../src/diagnostics.js";
import type { BridgeSnapshot } from "../src/bridgeManager.js";
import type { SourceResolution } from "../src/sourcePlugins/types.js";
import type { PresenterOutcome } from "../src/sourcePlugins/resolutionOutcome.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

describe("DiagnosticsTracker", () => {
  it("tracks bridge identity, browser count, source activity, and protocol errors", () => {
    const now = new Date("2026-07-10T15:00:00.000Z");
    const tracker = new DiagnosticsTracker({ now: () => now });

    tracker.recordInspect(inspectMessage());
    tracker.recordResolution(outcome(), 2, resolution());
    tracker.recordProtocolError(protocolError());

    expect(tracker.snapshot(bridgeSnapshot(), "connected")).toEqual({
      bridgeState: "running",
      clientState: "connected",
      url: "ws://127.0.0.1:48735",
      port: 48_735,
      sessionId: "session-1",
      bridgeInstanceId: INSTANCE_ID,
      linkedBrowserCount: 1,
      lastInspectAt: now,
      targetsReceived: 2,
      factsReceived: 3,
      matchesResolved: 2,
      selectedMatchesResolved: 1,
      parentMatchesResolved: 1,
      pluginDiagnostics: 1,
      lastResolutionStatus: "matched",
      lastResolutionGeneration: 2,
      inaccessibleStylesheetCount: 1,
      resolutionDiagnosticCodes: ["resolver.source-read-failed"],
      sourceDocumentUri: "file:///workspace/card.scss",
      pluginDiagnosticDetails: resolution().diagnostics,
      lastProtocolError: {
        code: "bridge.noBrowserClient",
        message: "No browser client is connected",
      },
    });
  });

  it("writes every visible diagnostic field to the output channel", () => {
    const lines: string[] = [];
    const tracker = new DiagnosticsTracker();
    tracker.recordInspect(inspectMessage());
    tracker.recordResolution(outcome(), 2, resolution());

    writeBridgeDiagnostics(
      { appendLine: (value) => lines.push(value), show() {} },
      tracker.snapshot(bridgeSnapshot(), "connected"),
    );

    expect(lines).toEqual([
      `bridge=running client=connected url=ws://127.0.0.1:48735 port=48735 session=session-1 instance=${INSTANCE_ID} browsers=1`,
      expect.stringMatching(/^lastInspect=.+ targets=2 facts=3$/),
      "resolution status=matched generation=2 document=card.scss selected=1 parent=1 inaccessible=1 codes=resolver.source-read-failed",
      "sources matches=2 pluginDiagnostics=1",
      "sourceDiagnostic pinop.scss scss.sourceMapMissing warning: SCSS source map was not found",
      "protocolError=none",
    ]);
  });

  it("retains detailed source failures only in local VS Code diagnostics", () => {
    const tracker = new DiagnosticsTracker();
    const localPath = "C:/private/workspace/card.scss";
    const localResolution: SourceResolution = {
      ...resolution(),
      matches: [],
      diagnostics: [{
        pluginId: "pinop.scss",
        code: "scss.generatedReadFailed",
        message: `Could not read ${localPath}`,
        severity: "error",
      }],
    };
    tracker.recordResolution(
      {
        ...outcome(),
        status: "error",
        matches: [],
        selectedMatchCount: 0,
        parentMatchCount: 0,
        diagnosticCodes: ["resolver.source-read-failed"],
        localDiagnostics: localResolution.diagnostics,
      },
      4,
      localResolution,
    );

    const snapshot = tracker.snapshot(bridgeSnapshot(), "connected");
    expect(JSON.stringify(snapshot.pluginDiagnosticDetails)).toContain(localPath);
    expect(snapshot.resolutionDiagnosticCodes).toEqual([
      "resolver.source-read-failed",
    ]);
  });

  it("clears retained resolution details with the presenter lifecycle", () => {
    const tracker = new DiagnosticsTracker();
    tracker.recordResolution(outcome(), 2, resolution());

    tracker.clearResolution();

    expect(tracker.snapshot(bridgeSnapshot(), "connected")).toMatchObject({
      matchesResolved: 0,
      selectedMatchesResolved: 0,
      parentMatchesResolved: 0,
      pluginDiagnostics: 0,
      inaccessibleStylesheetCount: 0,
      resolutionDiagnosticCodes: [],
      pluginDiagnosticDetails: [],
    });
    expect(tracker.snapshot(bridgeSnapshot(), "connected")).not.toHaveProperty(
      "lastResolutionStatus",
    );
  });

  it("whitelists diagnostics so link secrets and token-like values are absent", () => {
    const tracker = new DiagnosticsTracker();
    const bridge = {
      ...bridgeSnapshot(),
      pin: "97",
      linkCode: "4873597",
      authToken: "diagnostic-auth-token-secret",
      browserToken: "diagnostic-browser-token-secret",
    } as BridgeSnapshot & {
      readonly authToken: string;
      readonly browserToken: string;
    };

    const diagnostics = tracker.snapshot(bridge, "connected");
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics).not.toHaveProperty("pin");
    expect(diagnostics).not.toHaveProperty("linkCode");
    expect(diagnostics).not.toHaveProperty("authToken");
    expect(diagnostics).not.toHaveProperty("browserToken");
    expect(serialized).not.toContain("4873597");
    expect(serialized).not.toContain("diagnostic-auth-token-secret");
    expect(serialized).not.toContain("diagnostic-browser-token-secret");
    expect(serialized).not.toMatch(/"(?:pin|linkCode|authToken|browserToken)"/);

    const lines: string[] = [];
    writeBridgeDiagnostics(
      { appendLine: (value) => lines.push(value), show() {} },
      diagnostics,
    );
    expect(lines.join("\n")).not.toContain("4873597");
    expect(lines.join("\n")).not.toMatch(/auth-token|browser-token/i);
  });
});

function inspectMessage(): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: "inspect-1",
    sessionId: "session-1",
    source: { role: "browser", id: "browser-1", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [cssFact(), domFact()],
        metadata: {},
      },
      {
        role: "parent",
        depth: 1,
        subject: { selector: ".layout", metadata: {} },
        facts: [cssFact()],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:3000", metadata: {} },
    metadata: {},
  };
}

function resolution(): SourceResolution {
  return {
    selectionMessageId: "inspect-1",
    documentUri: "file:///workspace/card.scss",
    documentVersion: 1,
    matches: [
      {
        pluginId: "pinop.scss",
        targetRole: "selected",
        range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
        label: ".card",
        kind: "style-rule",
        relation: "styles",
        confidence: "sourcemap",
      },
      {
        pluginId: "pinop.scss",
        targetRole: "parent",
        range: { start: { line: 4, character: 0 }, end: { line: 6, character: 1 } },
        label: ".layout",
        kind: "style-rule",
        relation: "styles",
        confidence: "sourcemap",
      },
    ],
    diagnostics: [
      {
        pluginId: "pinop.scss",
        code: "scss.sourceMapMissing",
        message: "SCSS source map was not found",
        severity: "warning",
      },
    ],
  };
}

function outcome(): PresenterOutcome {
  const localResolution = resolution();
  return {
    status: "matched",
    document: { label: "card.scss", languageId: "scss" },
    matches: localResolution.matches,
    selectedMatchCount: 1,
    parentMatchCount: 1,
    inaccessibleStylesheetCount: 1,
    diagnosticCodes: ["resolver.source-read-failed"],
    localDiagnostics: localResolution.diagnostics,
  };
}

function cssFact() {
  return {
    type: "css-rule" as const,
    selector: ".card",
    property: "display",
    value: "grid",
    metadata: {},
  };
}

function domFact() {
  return {
    type: "dom-attribute" as const,
    name: "role",
    value: "region",
    metadata: {},
  };
}

function protocolError(): ErrorMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "error",
    messageId: "error-1",
    code: "bridge.noBrowserClient",
    message: "No browser client is connected",
    metadata: {},
  };
}

function bridgeSnapshot(): BridgeSnapshot {
  return {
    state: "running",
    url: "ws://127.0.0.1:48735",
    port: 48_735,
    pin: "07",
    linkCode: "4873507",
    bridgeInstanceId: INSTANCE_ID,
    sessionId: "session-1",
    linkedBrowserCount: 1,
  };
}
