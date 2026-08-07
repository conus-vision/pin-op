import { describe, expect, it } from "vitest";
import {
  RESOLUTION_LIMITS,
  type ResolutionStatus,
} from "@browser2ide/protocol";
import {
  reduceResolutionOutcome,
  toProtocolResolution,
} from "../src/sourcePlugins/resolutionOutcome.js";
import type {
  PluginResolutionCandidate,
  ResolvedPluginDiagnostic,
  ResolvedSourceMatch,
} from "../src/sourcePlugins/types.js";

describe("reduceResolutionOutcome", () => {
  it("reduces failures in the documented deterministic precedence", () => {
    const precedence: readonly ResolutionStatus[] = [
      "no-active-editor",
      "unsupported-document",
      "no-facts",
      "source-ambiguous",
      "source-not-active-document",
      "source-not-found",
      "source-map-invalid",
      "source-map-missing",
      "rule-match-ambiguous",
      "no-rule-match",
      "error",
    ];

    for (const [index, expected] of precedence.entries()) {
      const candidates = precedence
        .slice(index)
        .reverse()
        .map((status, candidateIndex) => candidate(status, `plugin-${candidateIndex}`));

      expect(reduceResolutionOutcome(candidates).status).toBe(expected);
    }
  });

  it("returns matched for nonempty visible matches despite nonfatal failures", () => {
    const result = reduceResolutionOutcome([
      candidate("source-not-found", "missing"),
      candidate("matched", "css", [match("selected", 0, 8)]),
    ]);

    expect(result).toMatchObject({
      status: "matched",
      selectedMatchCount: 1,
      parentMatchCount: 0,
    });
  });

  it("publishes only bounded stable diagnostics and a bounded document summary", () => {
    const localPath = "C:/private/workspace/src/card.scss";
    const diagnostics: readonly ResolvedPluginDiagnostic[] = [
      diagnostic("plugin.exception", `Failed at ${localPath}`),
      diagnostic("plugin.timeout", "Timed out"),
      diagnostic("plugin.invalidResult", "Bad result"),
      diagnostic("scss.generatedReadFailed", `Could not read ${localPath}`),
      diagnostic("external.secret", "token=should-not-cross-the-bridge"),
    ];
    const result = reduceResolutionOutcome(
      [candidate("error", "scss", [], diagnostics)],
      {
        document: {
          label: `card-${"x".repeat(RESOLUTION_LIMITS.labelLength * 2)}.scss`,
          languageId: `scss-${"y".repeat(RESOLUTION_LIMITS.languageIdLength * 2)}`,
        },
        inaccessibleStylesheetCount: 3,
      },
    );

    const protocol = toProtocolResolution(result);
    const serialized = JSON.stringify(protocol);

    expect(protocol.document?.label.length).toBeLessThanOrEqual(
      RESOLUTION_LIMITS.labelLength,
    );
    expect(protocol.document?.languageId.length).toBeLessThanOrEqual(
      RESOLUTION_LIMITS.languageIdLength,
    );
    expect(protocol.diagnosticCodes).toEqual([
      "resolver.plugin-error",
      "resolver.plugin-timeout",
      "resolver.invalid-result",
      "resolver.source-read-failed",
    ]);
    expect(protocol.inaccessibleStylesheetCount).toBe(3);
    expect(serialized).not.toContain(localPath);
    expect(serialized).not.toContain("should-not-cross-the-bridge");
    expect(protocol).not.toHaveProperty("localDiagnostics");
  });

  it("adds a stable diagnostic code for an otherwise unclassified error", () => {
    expect(
      reduceResolutionOutcome([candidate("error", "fixture")])
        .diagnosticCodes,
    ).toEqual(["resolver.plugin-error"]);
  });

  it("maps an unclassified error diagnostic without exposing its message", () => {
    const localMessage = "Unexpected failure at C:/private/source.css";
    const result = reduceResolutionOutcome([
      candidate(
        "matched",
        "fixture",
        [match("selected", 0, 8)],
        [diagnostic("external.failure", localMessage)],
      ),
    ]);

    expect(result.status).toBe("matched");
    expect(result.diagnosticCodes).toEqual(["resolver.plugin-error"]);
    expect(JSON.stringify(toProtocolResolution(result))).not.toContain(
      localMessage,
    );
  });
});

function candidate(
  status: ResolutionStatus,
  pluginId: string,
  matches: readonly ResolvedSourceMatch[] = [],
  diagnostics: readonly ResolvedPluginDiagnostic[] = [],
): PluginResolutionCandidate {
  return { status, pluginId, matches, diagnostics };
}

function match(
  targetRole: "selected" | "parent",
  startCharacter: number,
  endCharacter: number,
): ResolvedSourceMatch {
  return {
    pluginId: "fixture",
    targetRole,
    range: {
      start: { line: 0, character: startCharacter },
      end: { line: 0, character: endCharacter },
    },
    label: ".card",
    kind: "style-rule",
    relation: "styles",
    confidence: "exact",
  };
}

function diagnostic(
  code: string,
  message: string,
): ResolvedPluginDiagnostic {
  return {
    pluginId: "fixture",
    code,
    message,
    severity: "error",
  };
}
