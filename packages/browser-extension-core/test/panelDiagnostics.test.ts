import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import { PanelDiagnostics } from "../src/panelDiagnostics.js";

const LINK = {
  url: "ws://127.0.0.1:48735",
  sessionId: "session-1",
  bridgeInstanceId: "2d7856f5-8218-4ba6-9f6c-7aa459333ee1",
} as const;

describe("PanelDiagnostics", () => {
  it("tracks link identity, transport, selection, sends, and the last error", () => {
    const diagnostics = new PanelDiagnostics();
    const sentAt = new Date("2026-07-10T15:00:00.000Z");

    diagnostics.setConnectionState("connected");
    diagnostics.setLink(LINK);
    diagnostics.recordSelection(
      [
        { facts: [{ type: "css-rule" }, { type: "dom-attribute" }] },
        { facts: [{ type: "css-rule" }] },
      ],
      2,
    );
    diagnostics.recordMessageSent(sentAt);
    diagnostics.recordError({
      code: "bridge.noIdeClient",
      message: "No IDE client is connected",
    });

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "connected",
      link: LINK,
      lastMessageSentAt: sentAt,
      lastError: {
        code: "bridge.noIdeClient",
        message: "No IDE client is connected",
      },
      inaccessibleStylesheetCount: 2,
      matchedCssFactCount: 2,
      resolution: undefined,
    });
  });

  it.each([
    ["auth.instanceChanged", "Saved link is no longer valid"],
    ["auth.tokenRejected", "Saved link is no longer valid"],
    ["link.invalidCode", "Link request was rejected"],
    ["link.unreachable", "Link request was rejected"],
    ["link.rejected", "Link request was rejected"],
    ["link.rateLimited", "Link requests are temporarily rate-limited"],
    [
      "protocol.invalidMessage",
      "Bridge sent an invalid protocol message",
    ],
    ["bridge.noIdeClient", "No IDE client is connected"],
    ["bridge.noBrowserClient", "No browser client is connected"],
    ["bridge.offline", "Bridge is offline"],
    ["resolver.fileNotFound", "Source file was not found"],
    ["resolver.sourceMapFailed", "Source map resolution failed"],
    [
      "browser.stylesheetInaccessible",
      "A stylesheet could not be inspected",
    ],
  ] as const)("sanitizes %s without retaining supplied secrets", (code, message) => {
    const diagnostics = new PanelDiagnostics();
    const sensitive = "4873507/browser-token";

    diagnostics.recordError({ code, message: `Rejected ${sensitive}` });

    expect(diagnostics.snapshot().lastError).toEqual({ code, message });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(sensitive);
  });

  it("resets link, transport, selection, send, and error diagnostics", () => {
    const diagnostics = new PanelDiagnostics();
    diagnostics.setConnectionState("connected");
    diagnostics.setLink(LINK);
    diagnostics.recordSelection([{ facts: [{ type: "css-rule" }] }], 1);
    diagnostics.recordMessageSent();
    diagnostics.recordError({ message: "Previous error" });

    diagnostics.reset();

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "disconnected",
      link: undefined,
      lastMessageSentAt: undefined,
      lastError: undefined,
      inaccessibleStylesheetCount: 0,
      matchedCssFactCount: 0,
      resolution: undefined,
    });
  });

  it("records only bounded resolution state without local source details", () => {
    const diagnostics = new PanelDiagnostics();
    diagnostics.recordResolution(
      resolution({
        resolutionGeneration: 4,
        selectedMatchCount: 2,
        parentMatchCount: 1,
        inaccessibleStylesheetCount: 3,
        diagnosticCodes: ["resolver.plugin-timeout"],
      }),
    );

    expect(diagnostics.snapshot().resolution).toEqual({
      status: "matched",
      resolutionGeneration: 4,
      selectedMatchCount: 2,
      parentMatchCount: 1,
      inaccessibleStylesheetCount: 3,
      diagnosticCodes: ["resolver.plugin-timeout"],
    });
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain(
      "C:\\secret\\workspace",
    );
  });

  it("records resolving and IDE disconnect without retaining raw messages", () => {
    const diagnostics = new PanelDiagnostics();

    diagnostics.recordResolving();
    expect(diagnostics.snapshot().resolution).toEqual({ status: "resolving" });

    diagnostics.recordIdeDisconnected();
    expect(diagnostics.snapshot().resolution).toEqual({
      status: "ide-disconnected",
    });
  });

  it("clears only the resolution summary", () => {
    const diagnostics = new PanelDiagnostics();
    const sentAt = new Date("2026-08-07T10:00:00.000Z");
    diagnostics.setConnectionState("connected");
    diagnostics.setLink(LINK);
    diagnostics.recordSelection([{ facts: [{ type: "css-rule" }] }], 2);
    diagnostics.recordMessageSent(sentAt);
    diagnostics.recordError({ message: "Connection detail" });
    diagnostics.recordResolution(resolution({ resolutionGeneration: 4 }));

    diagnostics.clearResolution();

    expect(diagnostics.snapshot()).toEqual({
      connectionState: "connected",
      link: LINK,
      lastMessageSentAt: sentAt,
      lastError: { message: "Connection detail" },
      inaccessibleStylesheetCount: 2,
      matchedCssFactCount: 1,
      resolution: undefined,
    });
  });
});

function resolution(
  overrides: Partial<ResolutionMessage> = {},
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId: "inspect-1",
    resolutionGeneration: 1,
    document: {
      label: "C:\\secret\\workspace\\src\\app.scss",
      languageId: "scss",
    },
    status: "matched",
    selectedMatchCount: 1,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
    ...overrides,
  };
}
