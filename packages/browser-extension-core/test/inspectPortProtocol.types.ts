import type { SourceNavigationStateMessage } from "@pinop/protocol";
import type { BackgroundToPanelInspectPortMessage } from "../src/inspectPortProtocol.js";

declare const sourceNavigationState: SourceNavigationStateMessage;

const backgroundMessage: BackgroundToPanelInspectPortMessage =
  sourceNavigationState;

void backgroundMessage;
