import type {
  SourceMatchesMessage,
  SourceNavigationStateMessage,
  RulesSourcesMessage,
} from "@pin-op/protocol";
import type {
  BackgroundToPanelInspectPortMessage,
  PanelPresentationSettingsCommand,
  PanelInspectStartedState,
  PanelRulesOpenCommand,
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
  {
    type: "pin-op.rules.open",
    inspectMessageId: "inspect-1",
    rulesGeneration: 1,
    openAuthorityId: "authority-1",
  } satisfies PanelRulesOpenCommand,
];

declare const rulesSources: RulesSourcesMessage;
const inspectStarted: PanelInspectStartedState = {
  type: "pin-op.inspect.started",
  inspectMessageId: "inspect-1",
  selectionRevision: 1,
  expectedRuleRefs: ["rule-1"],
};
const rulesPanelResponses: readonly BackgroundToPanelInspectPortMessage[] = [
  rulesSources,
  inspectStarted,
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
void rulesPanelResponses;
void stylesPanelRequest;
void stylesPanelResponses;
