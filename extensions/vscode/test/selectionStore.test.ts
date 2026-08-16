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
            selector: ".card",
            property: "color",
            value: "red",
            metadata: { sourceUrl: "/dist/app.css" },
          },
        ],
        metadata: {},
      },
    ],
    context: { url: "http://localhost:4173/", metadata: {} },
    metadata: { fixture: true },
  };
}
