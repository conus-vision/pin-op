import type {
  PinOpMessage,
  EmptyMetadata,
  PeerStateMessage,
  PageRefreshMessage,
  PresentationSettingsMessage,
  ResolutionMessage,
  SourceExcerpt,
  SourceMatchesMessage,
  SourceNavigateMessage,
  SourceNavigationDirection,
  SourceNavigationStateMessage,
  SourceOpenMessage,
} from "@pin-op/protocol";

// @ts-expect-error Legacy reference envelopes are not part of protocol v6.
type RemovedReferencesMessage = import("@pin-op/protocol").ReferencesMessage;
// @ts-expect-error Legacy command envelopes are not part of protocol v6.
type RemovedCommandMessage = import("@pin-op/protocol").CommandMessage;
// @ts-expect-error Legacy open-source commands are not part of protocol v6.
type RemovedOpenSourceCommandMessage = import("@pin-op/protocol").OpenSourceCommandMessage;
// @ts-expect-error Legacy highlight commands are not part of protocol v6.
type RemovedHighlightCommandMessage = import("@pin-op/protocol").HighlightElementCommandMessage;
// @ts-expect-error Legacy source references are not publicly exported.
type RemovedSourceReference = import("@pin-op/protocol").SourceReference;

const emptyMetadata: EmptyMetadata = {};

// @ts-expect-error EmptyMetadata is intentionally a zero-key type.
const nonEmptyMetadata: EmptyMetadata = { extra: true };

const resolution: ResolutionMessage = {
  protocolVersion: 6,
  type: "resolution",
  messageId: "resolution-1",
  sessionId: "session-1",
  source: { role: "ide", id: "vscode-1" },
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  status: "no-facts",
  selectedMatchCount: 0,
  parentMatchCount: 0,
  inaccessibleStylesheetCount: 0,
  diagnosticCodes: [],
  metadata: emptyMetadata,
};

const resolutionWithMetadata: ResolutionMessage = {
  ...resolution,
  // @ts-expect-error ResolutionMessage metadata is intentionally empty.
  metadata: { extra: true },
};

const peerState: PeerStateMessage = {
  protocolVersion: 6,
  type: "peerState",
  messageId: "peer-state-1",
  sessionId: "session-1",
  role: "ide",
  connected: true,
  peerGeneration: 1,
  metadata: emptyMetadata,
};

const peerStateWithMetadata: PeerStateMessage = {
  ...peerState,
  // @ts-expect-error PeerStateMessage metadata is intentionally empty.
  metadata: { extra: true },
};

const previousDirection: SourceNavigationDirection = "previous";
const nextDirection: SourceNavigationDirection = "next";

// @ts-expect-error SourceNavigationDirection is a closed union.
const unsupportedDirection: SourceNavigationDirection = "first";

const sourceNavigate: SourceNavigateMessage = {
  protocolVersion: 6,
  type: "source.navigate",
  messageId: "source-navigate-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  direction: nextDirection,
  metadata: emptyMetadata,
};

const sourceNavigationStateWithoutActiveMatch: SourceNavigationStateMessage = {
  protocolVersion: 6,
  type: "source.navigationState",
  messageId: "source-navigation-state-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  source: { role: "ide", id: "vscode-1" },
  resolutionGeneration: 1,
  selectedMatchCount: 4,
  metadata: emptyMetadata,
};

const sourceNavigationStateWithActiveMatch: SourceNavigationStateMessage = {
  ...sourceNavigationStateWithoutActiveMatch,
  activeMatchIndex: 0,
  activeMatchId: "match-1",
};

const pageRefresh: PageRefreshMessage = {
  protocolVersion: 6,
  type: "page.refresh",
  messageId: "refresh-1",
  sessionId: "session-1",
  source: { role: "ide", id: "vscode-1" },
  refreshGeneration: 1,
  mode: "styles",
  metadata: emptyMetadata,
};

const sourceExcerpt: SourceExcerpt = {
  matchId: "match-1",
  targetRole: "selected",
  label: "App.tsx:1",
  kind: "component",
  relation: "renders",
  confidence: "exact",
  startLine: 1,
  endLine: 2,
  text: "export function App() {}",
  truncated: false,
};

const sourceMatches: SourceMatchesMessage = {
  protocolVersion: 6,
  type: "source.matches",
  messageId: "matches-1",
  sessionId: "session-1",
  source: { role: "ide", id: "vscode-1" },
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  document: { label: "App.tsx", languageId: "typescriptreact" },
  matches: [sourceExcerpt],
  omittedMatchCount: 0,
  metadata: emptyMetadata,
};

const sourceOpen: SourceOpenMessage = {
  protocolVersion: 6,
  type: "source.open",
  messageId: "open-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  matchId: "match-1",
  metadata: emptyMetadata,
};

const presentationSettings: PresentationSettingsMessage = {
  protocolVersion: 6,
  type: "presentation.settings",
  messageId: "settings-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  ideHighlightEnabled: true,
  metadata: emptyMetadata,
};

void nonEmptyMetadata;
void resolutionWithMetadata;
void peerStateWithMetadata;
void previousDirection;
void unsupportedDirection;
void sourceNavigate;
void sourceNavigationStateWithActiveMatch;
void pageRefresh;
void sourceMatches;
void sourceOpen;
void presentationSettings;

declare const readonlyResolution: ResolutionMessage;

// @ts-expect-error ResolutionMessage fields are readonly.
readonlyResolution.status = "error";
// @ts-expect-error ResolutionMessage source fields are readonly.
readonlyResolution.source.id = "other-ide";
// @ts-expect-error ResolutionMessage document fields are readonly.
readonlyResolution.document!.label = "other.tsx";
// @ts-expect-error ResolutionMessage diagnosticCodes is readonly.
readonlyResolution.diagnosticCodes.push("resolver.plugin-error");

declare const readonlyPeerState: PeerStateMessage;

// @ts-expect-error PeerStateMessage fields are readonly.
readonlyPeerState.connected = false;

declare const readonlySourceNavigate: SourceNavigateMessage;

// @ts-expect-error SourceNavigateMessage fields are readonly.
readonlySourceNavigate.direction = "previous";

declare const readonlySourceNavigationState: SourceNavigationStateMessage;

// @ts-expect-error SourceNavigationStateMessage fields are readonly.
readonlySourceNavigationState.activeMatchIndex = 1;
// @ts-expect-error SourceNavigationStateMessage fields are readonly.
readonlySourceNavigationState.activeMatchId = "match-2";
// @ts-expect-error SourceNavigationStateMessage source fields are readonly.
readonlySourceNavigationState.source.id = "other-ide";

declare const readonlyUnionMessage: PinOpMessage;

if (readonlyUnionMessage.type === "resolution") {
  // @ts-expect-error PinOpMessage resolution branches are readonly.
  readonlyUnionMessage.source.id = "other-ide";
}

if (readonlyUnionMessage.type === "peerState") {
  // @ts-expect-error PinOpMessage peer-state branches are readonly.
  readonlyUnionMessage.connected = false;
}

if (readonlyUnionMessage.type === "source.navigate") {
  // @ts-expect-error PinOpMessage source-navigation intents are readonly.
  readonlyUnionMessage.direction = "previous";
}

if (readonlyUnionMessage.type === "source.navigationState") {
  // @ts-expect-error PinOpMessage source-navigation states are deeply readonly.
  readonlyUnionMessage.source.id = "other-ide";
}
