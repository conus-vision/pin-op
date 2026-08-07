import type {
  Browser2IdeMessage,
  EmptyMetadata,
  PeerStateMessage,
  ResolutionMessage,
} from "@browser2ide/protocol";

// @ts-expect-error Legacy reference envelopes are not part of protocol v4.
type RemovedReferencesMessage = import("@browser2ide/protocol").ReferencesMessage;
// @ts-expect-error Legacy command envelopes are not part of protocol v4.
type RemovedCommandMessage = import("@browser2ide/protocol").CommandMessage;
// @ts-expect-error Legacy open-source commands are not part of protocol v4.
type RemovedOpenSourceCommandMessage = import("@browser2ide/protocol").OpenSourceCommandMessage;
// @ts-expect-error Legacy highlight commands are not part of protocol v4.
type RemovedHighlightCommandMessage = import("@browser2ide/protocol").HighlightElementCommandMessage;
// @ts-expect-error Legacy source references are not publicly exported.
type RemovedSourceReference = import("@browser2ide/protocol").SourceReference;

const emptyMetadata: EmptyMetadata = {};

// @ts-expect-error EmptyMetadata is intentionally a zero-key type.
const nonEmptyMetadata: EmptyMetadata = { extra: true };

const resolution: ResolutionMessage = {
  protocolVersion: 4,
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
  protocolVersion: 4,
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

void nonEmptyMetadata;
void resolutionWithMetadata;
void peerStateWithMetadata;

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

declare const readonlyUnionMessage: Browser2IdeMessage;

if (readonlyUnionMessage.type === "resolution") {
  // @ts-expect-error Browser2IdeMessage resolution branches are readonly.
  readonlyUnionMessage.source.id = "other-ide";
}

if (readonlyUnionMessage.type === "peerState") {
  // @ts-expect-error Browser2IdeMessage peer-state branches are readonly.
  readonlyUnionMessage.connected = false;
}
