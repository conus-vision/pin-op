import type { SourceNavigationStateMessage } from "@browser2ide/protocol";
import type { BackgroundToPanelInspectPortMessage } from "../src/inspectPortProtocol.js";

declare const sourceNavigationState: SourceNavigationStateMessage;

const backgroundMessage: BackgroundToPanelInspectPortMessage =
  sourceNavigationState;

void backgroundMessage;
