import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  type InspectMessage,
} from "@pin-op/protocol";
import { SelectionStore } from "../src/presenter/selectionStore.js";

describe("SelectionStore", () => {
  it("retains only the source-neutral inspect selection and clears it", () => {
    const store = new SelectionStore();
    const message = inspectMessage("inspect-1");

    const selected = store.replace(message);

    expect(selected).toEqual({
      sessionId: "session-1",
      messageId: "inspect-1",
      targets: message.targets,
      ruleEvidence: message.ruleEvidence,
      context: message.context,
      metadata: message.metadata,
    });
    expect(store.current()).toBe(selected);
    store.clear();
    expect(store.current()).toBeUndefined();
  });
});

function inspectMessage(messageId: string): InspectMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId,
    sessionId: "session-1",
    source: { role: "browser", id: "firefox", metadata: {} },
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: { selector: ".card", metadata: {} },
        facts: [
          {
            type: "css-rule",
            ruleRef: "rule-card",
            property: "color",
            value: "red",
            important: false,
            valueTruncated: false,
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
    ruleEvidence: {
      rules: [{
        ruleRef: "rule-card",
        selector: ".card",
        declarations: [{
          property: "color",
          value: "red",
          important: false,
          valueTruncated: false,
        }],
        declarationsTruncated: false,
        generatedSource: {
          sourceUrl: "http://localhost:4173/dist/app.css",
          rulePath: "0.0",
          contexts: [],
          contextsTruncated: false,
          unsupportedGroupContext: false,
        },
      }],
      omittedRuleCount: 0,
    },
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: { fixture: true },
  };
}
