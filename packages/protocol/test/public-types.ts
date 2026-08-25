import {
  SOURCE_EXCERPT_KINDS,
  SOURCE_EXCERPT_RELATIONS,
  SourceExcerptKindSchema,
  SourceExcerptRelationSchema,
} from "@pin-op/protocol";
import type {
  PinOpMessage,
  EmptyMetadata,
  InspectGeneratedSource,
  InspectMessage,
  InspectRuleContext,
  InspectRuleDeclaration,
  InspectRuleEvidence,
  InspectRuleEvidenceBatch,
  PeerStateMessage,
  PageRefreshMessage,
  PresentationSettingsMessage,
  RulesOpenMessage,
  RulesSource,
  RulesSourceDocument,
  RulesSourcesMessage,
  ProtocolVersionProbe,
  ResolutionMessage,
  SourceExcerpt,
  SourceExcerptKind,
  SourceExcerptRelation,
  SourceMatchesMessage,
  SourceNavigateMessage,
  SourceNavigationDirection,
  SourceNavigationStateMessage,
  SourceOpenMessage,
} from "@pin-op/protocol";

// @ts-expect-error Legacy reference envelopes are not part of protocol v7.
type RemovedReferencesMessage = import("@pin-op/protocol").ReferencesMessage;
// @ts-expect-error Legacy command envelopes are not part of protocol v7.
type RemovedCommandMessage = import("@pin-op/protocol").CommandMessage;
// @ts-expect-error Legacy open-source commands are not part of protocol v7.
type RemovedOpenSourceCommandMessage = import("@pin-op/protocol").OpenSourceCommandMessage;
// @ts-expect-error Legacy highlight commands are not part of protocol v7.
type RemovedHighlightCommandMessage = import("@pin-op/protocol").HighlightElementCommandMessage;
// @ts-expect-error Legacy source references are not publicly exported.
type RemovedSourceReference = import("@pin-op/protocol").SourceReference;

const emptyMetadata: EmptyMetadata = {};

// @ts-expect-error EmptyMetadata is intentionally a zero-key type.
const nonEmptyMetadata: EmptyMetadata = { extra: true };

const resolution: ResolutionMessage = {
  protocolVersion: 7,
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
  protocolVersion: 7,
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
  protocolVersion: 7,
  type: "source.navigate",
  messageId: "source-navigate-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  direction: nextDirection,
  metadata: emptyMetadata,
};

const sourceNavigationStateWithoutActiveMatch: SourceNavigationStateMessage = {
  protocolVersion: 7,
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
  protocolVersion: 7,
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

const templateSourceExcerpt: SourceExcerpt = {
  ...sourceExcerpt,
  kind: "template",
  relation: "templates",
};
const canonicalSourceKind: SourceExcerptKind = SOURCE_EXCERPT_KINDS.at(-1)!;
const canonicalSourceRelation: SourceExcerptRelation =
  SOURCE_EXCERPT_RELATIONS.at(-1)!;

SourceExcerptKindSchema.parse(canonicalSourceKind);
SourceExcerptRelationSchema.parse(canonicalSourceRelation);

const sourceMatches: SourceMatchesMessage = {
  protocolVersion: 7,
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
  protocolVersion: 7,
  type: "source.open",
  messageId: "open-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  resolutionGeneration: 1,
  matchId: "match-1",
  metadata: emptyMetadata,
};

const presentationSettings: PresentationSettingsMessage = {
  protocolVersion: 7,
  type: "presentation.settings",
  messageId: "settings-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  ideHighlightEnabled: true,
  metadata: emptyMetadata,
};

const rulesSourceDocument: RulesSourceDocument = {
  label: "styles.css",
  languageId: "css",
};

const rulesSource: RulesSource = {
  ruleRef: "rule-1",
  openAuthorityId: "authority-1",
  document: rulesSourceDocument,
  startLine: 1,
  startColumn: 1,
  confidence: "exact",
};

const rulesSources: RulesSourcesMessage = {
  protocolVersion: 7,
  type: "rules.sources",
  messageId: "rules-sources-1",
  sessionId: "session-1",
  source: { role: "ide", id: "vscode-1" },
  inspectMessageId: "inspect-1",
  rulesGeneration: 1,
  sources: [rulesSource],
  unresolvedRuleCount: 0,
  metadata: emptyMetadata,
};

const rulesOpen: RulesOpenMessage = {
  protocolVersion: 7,
  type: "rules.open",
  messageId: "rules-open-1",
  sessionId: "session-1",
  inspectMessageId: "inspect-1",
  rulesGeneration: 1,
  openAuthorityId: "authority-1",
  metadata: emptyMetadata,
};

const inspectRuleContext: InspectRuleContext = {
  kind: "media",
  conditionText: "screen",
};

const inspectRuleDeclaration: InspectRuleDeclaration = {
  property: "color",
  value: "red",
  important: false,
  valueTruncated: false,
};

const inspectGeneratedSource: InspectGeneratedSource = {
  sourceUrl: "https://example.test/styles.css",
  rulePath: "0",
  contexts: [inspectRuleContext],
  contextsTruncated: false,
  unsupportedGroupContext: false,
};

const inspectRuleEvidence: InspectRuleEvidence = {
  ruleRef: "rule-1",
  selector: ".card",
  declarations: [inspectRuleDeclaration],
  declarationsTruncated: false,
  generatedSource: inspectGeneratedSource,
};

const inspectRuleEvidenceBatch: InspectRuleEvidenceBatch = {
  rules: [inspectRuleEvidence],
  omittedRuleCount: 0,
};

const inspect: InspectMessage = {
  protocolVersion: 7,
  type: "inspect",
  messageId: "inspect-1",
  sessionId: "session-1",
  source: {
    role: "browser",
    id: "browser-1",
    label: "Demo tab",
    url: "https://example.test/page",
    metadata: emptyMetadata,
  },
  ideHighlightEnabled: true,
  targets: [{
    role: "selected",
    depth: 0,
    subject: { selector: ".card", metadata: emptyMetadata },
    facts: [],
    metadata: emptyMetadata,
  }],
  ruleEvidence: inspectRuleEvidenceBatch,
  context: { url: "https://example.test/page", metadata: emptyMetadata },
  metadata: emptyMetadata,
};

const protocolVersionProbe: ProtocolVersionProbe = {
  receivedVersion: 7,
  compatible: true,
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
void templateSourceExcerpt;
void sourceOpen;
void presentationSettings;
void rulesSources;
void rulesOpen;
void inspect;
void protocolVersionProbe;

// @ts-expect-error Inspect rule declarations are deeply readonly.
inspectRuleEvidence.declarations[0]!.value = "blue";
// @ts-expect-error Inspect rule contexts are deeply readonly.
inspectRuleEvidence.generatedSource!.contexts[0]!.conditionText = "print";
// @ts-expect-error Inspect evidence batches expose a readonly rules array.
inspectRuleEvidenceBatch.rules.push(inspectRuleEvidence);
// @ts-expect-error InspectMessage evidence remains deeply readonly.
inspect.ruleEvidence.rules[0]!.declarations.push({
  property: "display",
  value: "block",
  important: false,
  valueTruncated: false,
});
// @ts-expect-error Standalone InspectRuleContext fields are readonly.
inspectRuleContext.conditionText = "print";
// @ts-expect-error Standalone InspectRuleDeclaration fields are readonly.
inspectRuleDeclaration.value = "blue";
// @ts-expect-error Standalone InspectGeneratedSource arrays are readonly.
inspectGeneratedSource.contexts.push(inspectRuleContext);
// @ts-expect-error Standalone RulesSourceDocument fields are readonly.
rulesSourceDocument.label = "other.css";
// @ts-expect-error Standalone RulesSource fields are deeply readonly.
rulesSource.document.label = "other.css";
// @ts-expect-error Standalone RulesSource position fields are readonly.
rulesSource.startLine = 2;

// @ts-expect-error ProtocolVersionProbe fields are readonly.
protocolVersionProbe.receivedVersion = 5;
// @ts-expect-error ProtocolVersionProbe fields are readonly.
protocolVersionProbe.compatible = false;

type ParsedProtocolMismatch = NonNullable<
  ReturnType<
    typeof import("@pin-op/protocol").parseProtocolMismatchReason
  >
>;

declare const readonlyProtocolMismatch: ParsedProtocolMismatch;

// @ts-expect-error Parsed protocol mismatch fields are readonly.
readonlyProtocolMismatch.expectedVersion = 5;
// @ts-expect-error Parsed protocol mismatch fields are readonly.
readonlyProtocolMismatch.receivedVersion = 6;

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
