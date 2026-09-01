import type { SelectionSnapshot } from "@pin-op/plugin-api";
import type { InspectMessage } from "@pin-op/protocol";
import { withDomAttributeFacts } from "../sourcePlugins/domFacts.js";

export class SelectionStore {
  private value: SelectionSnapshot | undefined;

  public replace(message: InspectMessage): SelectionSnapshot {
    this.value = {
      sessionId: message.sessionId,
      messageId: message.messageId,
      targets: withDomAttributeFacts(message.targets),
      ruleEvidence: message.ruleEvidence,
      context: message.context,
      metadata: message.metadata,
    };
    return this.value;
  }

  public current(): SelectionSnapshot | undefined {
    return this.value;
  }

  public clear(): void {
    this.value = undefined;
  }
}
