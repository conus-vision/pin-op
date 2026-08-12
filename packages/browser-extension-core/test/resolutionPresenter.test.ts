import {
  PROTOCOL_VERSION,
  type ResolutionDiagnosticCode,
  type ResolutionMessage,
  type ResolutionStatus,
} from "@pinop/protocol";
import { describe, expect, it } from "vitest";
import {
  ResolutionPresenter,
  formatResolutionFooter,
  presentResolution,
} from "../src/resolutionPresenter.js";

const statusCases = [
  ["no-active-editor", "No active editor"],
  ["unsupported-document", "Unsupported active file: typescriptreact"],
  ["no-facts", "No CSS facts"],
  ["source-not-found", "CSS source not found in workspace"],
  [
    "source-not-active-document",
    "Stylesheet resolves to a different workspace file",
  ],
  ["source-ambiguous", "Ambiguous source path"],
  ["source-map-missing", "SCSS source map missing"],
  ["source-map-invalid", "SCSS source map invalid"],
  ["no-rule-match", "No matching rules in active file"],
  ["rule-match-ambiguous", "Ambiguous rule match"],
] as const satisfies readonly (readonly [ResolutionStatus, string])[];

describe("resolution presenter", () => {
  it.each(statusCases)("maps %s to a stable footer", (status, text) => {
    const model = presentResolution(resolution({ status }));

    expect(model.statusText).toBe(text);
    expect(formatResolutionFooter(resolution({ status }))).toContain(text);
  });

  it("shows selected, parent, and inaccessible stylesheet counts", () => {
    const model = presentResolution(
      resolution({
        status: "matched",
        selectedMatchCount: 2,
        parentMatchCount: 1,
        inaccessibleStylesheetCount: 2,
      }),
    );

    expect(model).toMatchObject({
      kind: "matched",
      statusText: "3 rules highlighted",
      detailText: "Selected 2 · Parent 1 · 2 inaccessible stylesheets",
      tone: "success",
    });
  });

  it("adds the inaccessible count to a no-facts footer", () => {
    expect(
      formatResolutionFooter(
        resolution({
          status: "no-facts",
          inaccessibleStylesheetCount: 1,
        }),
      ),
    ).toBe("No CSS facts · 1 inaccessible stylesheet");
  });

  it.each([
    ["resolver.plugin-error", "Resolution failed (resolver.plugin-error)"],
    ["resolver.plugin-timeout", "Resolution failed (resolver.plugin-timeout)"],
    ["resolver.invalid-result", "Resolution failed (resolver.invalid-result)"],
    [
      "resolver.source-read-failed",
      "Resolution failed (resolver.source-read-failed)",
    ],
  ] as const)("sanitizes %s into a stable diagnostic", (code, expected) => {
    const message = resolution({
      status: "error",
      diagnosticCodes: [code],
    });

    expect(presentResolution(message).statusText).toBe(expected);
    expect(JSON.stringify(presentResolution(message))).not.toContain(
      "C:\\secret\\project",
    );
  });

  it("uses a closed diagnostic fallback for an error without codes", () => {
    const message = resolution({
      status: "error",
      diagnosticCodes: [],
    });

    expect(presentResolution(message).statusText).toBe(
      "Resolution failed (resolver.invalid-result)",
    );
    expect(JSON.stringify(presentResolution(message))).not.toContain(
      "C:\\secret\\project",
    );
  });

  it("keeps the selected element visible while resolving and disconnected", () => {
    const presenter = new ResolutionPresenter();

    presenter.updateSelectedElement("button#save.primary");
    expect(presenter.beginCorrelatedInspect("inspect-a")).toMatchObject({
      selectedElement: "button#save.primary",
      kind: "resolving",
      statusText: "Resolving in VS Code",
    });
    expect(presenter.ideDisconnected("inspect-a")).toMatchObject({
      selectedElement: "button#save.primary",
      kind: "ide-disconnected",
      statusText: "VS Code disconnected",
    });
  });

  it("accepts only increasing generations for the current inspect ID", () => {
    const presenter = new ResolutionPresenter();
    presenter.updateSelectedElement("main#content");
    presenter.beginCorrelatedInspect("inspect-a");

    expect(
      presenter.acceptResolution(
        resolution({
          inspectMessageId: "inspect-a",
          resolutionGeneration: 2,
        }),
      ),
    ).toMatchObject({ generation: 2, selectedElement: "main#content" });
    expect(
      presenter.acceptResolution(
        resolution({
          inspectMessageId: "inspect-a",
          resolutionGeneration: 1,
        }),
      ),
    ).toBeUndefined();
    expect(
      presenter.acceptResolution(
        resolution({
          inspectMessageId: "inspect-b",
          resolutionGeneration: 3,
        }),
      ),
    ).toBeUndefined();
  });

  it("opens a new inspect correlation after a selection or IDE reconnect", () => {
    const presenter = new ResolutionPresenter();
    presenter.updateSelectedElement("article.card");
    presenter.beginCorrelatedInspect("inspect-a");
    presenter.acceptResolution(resolution({ inspectMessageId: "inspect-a" }));

    expect(presenter.restartResolution()).toMatchObject({
      selectedElement: "article.card",
      kind: "resolving",
    });
    expect(
      presenter.acceptResolution(
        resolution({
          inspectMessageId: "inspect-b",
          resolutionGeneration: 0,
        }),
      ),
    ).toBeUndefined();
    presenter.beginCorrelatedInspect("inspect-b");
    expect(
      presenter.acceptResolution(
        resolution({
          inspectMessageId: "inspect-b",
          resolutionGeneration: 0,
        }),
      ),
    ).toMatchObject({ generation: 0 });
  });

  it("returns to idle when VS Code reconnects without a retained selection", () => {
    const presenter = new ResolutionPresenter();
    presenter.ideDisconnected();

    expect(presenter.restartResolution()).toEqual({
      kind: "idle",
      statusText: "Select an element to inspect",
      tone: "neutral",
    });
  });

  it("clears all selected and resolution state on unlink or window close", () => {
    const presenter = new ResolutionPresenter();
    presenter.updateSelectedElement("section.account");
    presenter.beginCorrelatedInspect("inspect-a");
    presenter.acceptResolution(resolution());

    expect(presenter.reset()).toEqual({
      kind: "idle",
      statusText: "Select an element to inspect",
      tone: "neutral",
    });
    expect(presenter.snapshot()).toEqual({
      kind: "idle",
      statusText: "Select an element to inspect",
      tone: "neutral",
    });
  });

  it("does not accept a resolution before an exact correlated inspect start", () => {
    const presenter = new ResolutionPresenter();
    presenter.updateSelectedElement("main#content");

    expect(presenter.acceptResolution(resolution())).toBeUndefined();
    expect(presenter.snapshot()).toMatchObject({
      kind: "idle",
      selectedElement: "main#content",
    });
  });

  it("keeps an accepted footer when the DOM selection arrives later", () => {
    const presenter = new ResolutionPresenter();
    presenter.beginCorrelatedInspect("inspect-a");
    presenter.acceptResolution(
      resolution({
        selectedMatchCount: 2,
        parentMatchCount: 1,
      }),
    );

    expect(presenter.updateSelectedElement("button#save.primary")).toMatchObject({
      kind: "matched",
      statusText: "3 rules highlighted",
      selectedElement: "button#save.primary",
      inspectMessageId: "inspect-a",
      generation: 1,
    });
  });

  it("preserves a DOM-first selected label when the correlated start arrives", () => {
    const presenter = new ResolutionPresenter();

    presenter.updateSelectedElement("article.card");

    expect(presenter.beginCorrelatedInspect("inspect-a")).toMatchObject({
      kind: "resolving",
      selectedElement: "article.card",
      inspectMessageId: "inspect-a",
    });
  });

  it("rejects stale IDs across rapid correlated inspect starts", () => {
    const presenter = new ResolutionPresenter();
    presenter.beginCorrelatedInspect("inspect-a");
    presenter.beginCorrelatedInspect("inspect-b");

    expect(
      presenter.acceptResolution(
        resolution({ inspectMessageId: "inspect-a", resolutionGeneration: 9 }),
      ),
    ).toBeUndefined();
    expect(
      presenter.acceptResolution(
        resolution({ inspectMessageId: "inspect-b", resolutionGeneration: 0 }),
      ),
    ).toMatchObject({ inspectMessageId: "inspect-b", generation: 0 });
  });

  it("rejects malformed correlated inspect IDs", () => {
    const presenter = new ResolutionPresenter();

    expect(presenter.beginCorrelatedInspect("")).toBeUndefined();
    expect(presenter.beginCorrelatedInspect("x".repeat(129))).toBeUndefined();
    expect(presenter.snapshot()).toEqual({
      kind: "idle",
      statusText: "Select an element to inspect",
      tone: "neutral",
    });
  });
});

function resolution(
  overrides: Partial<ResolutionMessage> = {},
): ResolutionMessage {
  const status = overrides.status ?? "matched";
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-1",
    sessionId: "session-1",
    source: { role: "ide", id: "vscode-1" },
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    document: {
      label: "C:\\secret\\project\\src\\App.tsx",
      languageId: "typescriptreact",
    },
    status,
    selectedMatchCount: status === "matched" ? 1 : 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [] as ResolutionDiagnosticCode[],
    metadata: {},
    ...overrides,
  };
}
