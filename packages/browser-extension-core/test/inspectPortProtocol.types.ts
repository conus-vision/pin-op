import type {
  SourceMatchesMessage,
  SourceNavigationStateMessage,
} from "@pin-op/protocol";
import type {
  BackgroundToPanelInspectPortMessage,
  PanelPresentationSettingsCommand,
  PanelSourceOpenCommand,
  PanelToBackgroundInspectPortMessage,
} from "../src/inspectPortProtocol.js";
import type {
  StylesGetMatchedRequest,
  StylesInvalidatedEvent,
  StylesMatchedResponse,
} from "../src/stylesProtocol.js";

declare const sourceNavigationState: SourceNavigationStateMessage;

const backgroundMessage: BackgroundToPanelInspectPortMessage =
  sourceNavigationState;

void backgroundMessage;

declare const sourceMatches: SourceMatchesMessage;
const sourceMatchesBackgroundMessage: BackgroundToPanelInspectPortMessage =
  sourceMatches;

const sourceOpen: PanelSourceOpenCommand = {
  type: "pin-op.source.open",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  matchId: "match-1",
};
const presentationSettings: PanelPresentationSettingsCommand = {
  type: "pin-op.presentation.settings",
  inspectMessageId: "inspect-1",
  ideHighlightEnabled: true,
};
const panelMessages: readonly PanelToBackgroundInspectPortMessage[] = [
  sourceOpen,
  presentationSettings,
];

declare const stylesRequest: StylesGetMatchedRequest;
declare const stylesResponse: StylesMatchedResponse;
declare const stylesInvalidated: StylesInvalidatedEvent;
const stylesPanelRequest: PanelToBackgroundInspectPortMessage = stylesRequest;
const stylesPanelResponses: readonly BackgroundToPanelInspectPortMessage[] = [
  stylesResponse,
  stylesInvalidated,
];

void sourceMatchesBackgroundMessage;
void panelMessages;
void stylesPanelRequest;
void stylesPanelResponses;
