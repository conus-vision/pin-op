import { z } from "zod";
import {
  metadataSchema,
  SourceLocationSchema,
  SourceReferenceSchema,
} from "./references.js";
import { ProtocolCapabilitySchema } from "./capabilities.js";
import { JsonObjectSchema, utf8ByteLength } from "./json.js";
import {
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
} from "./limits.js";

export const PROTOCOL_VERSION = 4 as const;

export type EmptyMetadata = Readonly<Record<string, never>>;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? ReadonlyArray<DeepReadonly<Item>>
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export const EmptyMetadataSchema = z
  .object({})
  .strict()
  .transform((metadata): EmptyMetadata => metadata);

const opaqueIdSchema = z
  .string()
  .min(1)
  .max(RESOLUTION_LIMITS.opaqueIdLength);

const generationSchema = z
  .number()
  .int()
  .min(0)
  .max(RESOLUTION_LIMITS.generation);

const countSchema = z
  .number()
  .int()
  .min(0)
  .max(RESOLUTION_LIMITS.count);

const baseMessageSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    messageId: z.string().min(1),
    metadata: metadataSchema,
  })
  .strict();

export const ClientRoleSchema = z.enum(["browser", "ide", "simulator"]);

export const BridgeInstanceIdSchema = z.string().uuid();

export const ClientSourceSchema = z
  .object({
    role: ClientRoleSchema,
    id: z.string().min(1).max(INSPECT_LIMITS.nodeIdLength),
    label: z.string().max(INSPECT_LIMITS.textLength).optional(),
    url: z.string().max(INSPECT_LIMITS.urlLength).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const DomAttributeFactSchema = z
  .object({
    type: z.literal("dom-attribute"),
    name: z.string().min(1).max(INSPECT_LIMITS.attributeNameLength),
    value: z.string().max(INSPECT_LIMITS.valueLength),
    metadata: metadataSchema,
  })
  .strict();

export const CssRuleFactSchema = z
  .object({
    type: z.literal("css-rule"),
    selector: z.string().min(1).max(INSPECT_LIMITS.selectorLength),
    property: z.string().min(1).max(INSPECT_LIMITS.propertyNameLength),
    value: z.string().max(INSPECT_LIMITS.valueLength),
    source: SourceLocationSchema.optional(),
    metadata: metadataSchema,
  })
  .strict();

export const PluginRuntimeFactSchema = z
  .object({
    type: z
      .string()
      .max(128)
      .regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
    source: SourceLocationSchema.optional(),
    payload: JsonObjectSchema,
    metadata: JsonObjectSchema,
  })
  .strict();

export const RuntimeFactSchema = z.union([
  CssRuleFactSchema,
  DomAttributeFactSchema,
  PluginRuntimeFactSchema,
]);

const DomAttributeSchema = z
  .object({
    name: z.string().min(1).max(INSPECT_LIMITS.attributeNameLength),
    value: z.string().max(INSPECT_LIMITS.valueLength),
    metadata: metadataSchema,
  })
  .strict();

export const InspectSubjectSchema = z
  .object({
    selector: z.string().max(INSPECT_LIMITS.selectorLength).optional(),
    nodeId: z.string().max(INSPECT_LIMITS.nodeIdLength).optional(),
    text: z.string().max(INSPECT_LIMITS.textLength).optional(),
    attributes: z
      .array(DomAttributeSchema)
      .max(INSPECT_LIMITS.subjectAttributes)
      .optional(),
    metadata: metadataSchema,
  })
  .strict();

export const InspectContextSchema = z
  .object({
    url: z.string().min(1).max(INSPECT_LIMITS.urlLength),
    frameId: z.string().max(INSPECT_LIMITS.frameIdLength).optional(),
    route: z.string().max(INSPECT_LIMITS.routeLength).optional(),
    metadata: metadataSchema,
  })
  .strict();

export const InspectTargetSchema = z
  .object({
    role: z.enum(["selected", "parent"]),
    depth: z.union([z.literal(0), z.literal(1)]),
    subject: InspectSubjectSchema,
    facts: z.array(RuntimeFactSchema).max(INSPECT_LIMITS.factsPerTarget),
    metadata: metadataSchema,
  })
  .strict();

export const HelloMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("hello"),
    sessionId: z.string().min(1),
    authToken: z.string().min(1),
    bridgeInstanceId: BridgeInstanceIdSchema,
    source: ClientSourceSchema,
    capabilities: z.array(ProtocolCapabilitySchema),
  })
  .strict();

export const LinkRequestMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("linkRequest"),
    pin: z.string().regex(/^\d{2}$/),
    source: ClientSourceSchema.refine(
      (source) => source.role === "browser" || source.role === "simulator",
      "link requests require a browser or simulator source",
    ),
  })
  .strict();

export const LinkAcceptedMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("linkAccepted"),
    sessionId: z.string().min(1),
    bridgeInstanceId: BridgeInstanceIdSchema,
    authToken: z.string().min(32),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const AuthenticatedMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("authenticated"),
    sessionId: z.string().min(1),
    bridgeInstanceId: BridgeInstanceIdSchema,
  })
  .strict();

export const UnlinkMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("unlink"),
    sessionId: z.string().min(1),
  })
  .strict();

export const InspectMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("inspect"),
    sessionId: z.string().min(1),
    source: ClientSourceSchema,
    targets: z
      .array(InspectTargetSchema)
      .min(1)
      .max(INSPECT_LIMITS.targets),
    context: InspectContextSchema,
  })
  .strict()
  .superRefine((message, context) => {
    const selected = message.targets.filter(
      (target) => target.role === "selected",
    );
    const parents = message.targets.filter((target) => target.role === "parent");
    if (selected.length !== 1 || selected[0]?.depth !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "inspect requires one selected target at depth 0",
      });
    }
    if (parents.length > 1 || parents.some((target) => target.depth !== 1)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targets"],
        message: "inspect permits one parent target at depth 1",
      });
    }

    try {
      if (
        utf8ByteLength(JSON.stringify(message)) >
        INSPECT_ENVELOPE_MAX_BYTES
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: "inspect message exceeds serialized byte limit",
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "inspect message must be JSON serializable",
      });
    }
  });

const resolutionSourceObjectSchema = z
  .object({
    role: z.literal("ide"),
    id: opaqueIdSchema,
  })
  .strict();

export const ResolutionSourceSchema = resolutionSourceObjectSchema.transform(
  (source): DeepReadonly<z.infer<typeof resolutionSourceObjectSchema>> =>
    source,
);

export const ResolutionDiagnosticCodeSchema = z.enum([
  "resolver.plugin-error",
  "resolver.plugin-timeout",
  "resolver.invalid-result",
  "resolver.source-read-failed",
]);

export const ResolutionStatusSchema = z.enum([
  "matched",
  "no-active-editor",
  "unsupported-document",
  "no-facts",
  "source-not-found",
  "source-not-active-document",
  "source-ambiguous",
  "source-map-missing",
  "source-map-invalid",
  "no-rule-match",
  "rule-match-ambiguous",
  "error",
]);

const ResolutionDocumentSchema = z
  .object({
    label: z.string().min(1).max(RESOLUTION_LIMITS.labelLength),
    languageId: z
      .string()
      .min(1)
      .max(RESOLUTION_LIMITS.languageIdLength),
  })
  .strict();

export function createResolutionMessageSchema(
  envelopeMaxBytes = RESOLUTION_ENVELOPE_MAX_BYTES,
) {
  const schema = z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal("resolution"),
      messageId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      source: ResolutionSourceSchema,
      inspectMessageId: opaqueIdSchema,
      resolutionGeneration: generationSchema,
      document: ResolutionDocumentSchema.optional(),
      status: ResolutionStatusSchema,
      selectedMatchCount: countSchema,
      parentMatchCount: countSchema,
      inaccessibleStylesheetCount: countSchema,
      diagnosticCodes: z
        .array(ResolutionDiagnosticCodeSchema)
        .max(RESOLUTION_LIMITS.diagnosticCodes),
      metadata: EmptyMetadataSchema,
    })
    .strict();

  return schema
    .superRefine((message, context) => {
      const hasMatches =
        message.selectedMatchCount > 0 || message.parentMatchCount > 0;

      if (message.status === "matched" && !hasMatches) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: "matched resolutions require at least one match",
        });
      }

      if (message.status !== "matched" && hasMatches) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["status"],
          message: "non-matched resolutions require zero matches",
        });
      }

      if (
        new Set(message.diagnosticCodes).size !== message.diagnosticCodes.length
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["diagnosticCodes"],
          message: "resolution diagnostic codes must be unique",
        });
      }

      try {
        if (utf8ByteLength(JSON.stringify(message)) > envelopeMaxBytes) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [],
            message: "resolution message exceeds serialized byte limit",
          });
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [],
          message: "resolution message must be JSON serializable",
        });
      }
    })
    .transform(
      (message): DeepReadonly<z.infer<typeof schema>> => message,
    );
}

export const ResolutionMessageSchema = createResolutionMessageSchema();

const peerStateObjectSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("peerState"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    role: z.literal("ide"),
    connected: z.boolean(),
    peerGeneration: generationSchema,
    metadata: EmptyMetadataSchema,
  })
  .strict();

export const PeerStateMessageSchema = peerStateObjectSchema.transform(
  (message): DeepReadonly<z.infer<typeof peerStateObjectSchema>> => message,
);

export const ReferencesMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("references"),
    subject: InspectSubjectSchema,
    references: z.array(SourceReferenceSchema),
  })
  .strict();

const OpenSourceArgumentsSchema = z
  .object({
    source: SourceLocationSchema,
    metadata: metadataSchema,
  })
  .strict();

const HighlightElementArgumentsSchema = z
  .object({
    selector: z.string().min(1).max(INSPECT_LIMITS.selectorLength),
    metadata: metadataSchema,
  })
  .strict();

export const OpenSourceCommandMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("command"),
    command: z.literal("openSource"),
    arguments: OpenSourceArgumentsSchema,
  })
  .strict();

export const HighlightElementCommandMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("command"),
    command: z.literal("highlightElement"),
    arguments: HighlightElementArgumentsSchema,
  })
  .strict();

export const CommandMessageSchema = z.discriminatedUnion("command", [
  OpenSourceCommandMessageSchema,
  HighlightElementCommandMessageSchema,
]);

export const ProtocolErrorCodeSchema = z.enum([
  "link.invalidCode",
  "link.unreachable",
  "link.rejected",
  "link.rateLimited",
  "auth.tokenRejected",
  "auth.instanceChanged",
  "protocol.invalidMessage",
  "bridge.noIdeClient",
  "bridge.noBrowserClient",
  "bridge.offline",
  "resolver.fileNotFound",
  "resolver.sourceMapFailed",
  "browser.stylesheetInaccessible",
]);

export const ErrorMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("error"),
    code: ProtocolErrorCodeSchema,
    message: z.string().min(1),
    details: metadataSchema.optional(),
  })
  .strict();

export const PingMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("ping"),
    sentAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const PongMessageSchema = baseMessageSchema
  .extend({
    type: z.literal("pong"),
    pingMessageId: z.string().min(1),
    sentAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const Browser2IdeMessageSchema = z.union([
  HelloMessageSchema,
  LinkRequestMessageSchema,
  LinkAcceptedMessageSchema,
  AuthenticatedMessageSchema,
  UnlinkMessageSchema,
  InspectMessageSchema,
  ResolutionMessageSchema,
  PeerStateMessageSchema,
  ReferencesMessageSchema,
  CommandMessageSchema,
  ErrorMessageSchema,
  PingMessageSchema,
  PongMessageSchema,
]);

export type ClientRole = z.infer<typeof ClientRoleSchema>;
export type BridgeInstanceId = z.infer<typeof BridgeInstanceIdSchema>;
export type ClientSource = z.infer<typeof ClientSourceSchema>;
export type InspectSubject = z.infer<typeof InspectSubjectSchema>;
export type InspectContext = z.infer<typeof InspectContextSchema>;
export type InspectTarget = z.infer<typeof InspectTargetSchema>;
export type RuntimeFact = z.infer<typeof RuntimeFactSchema>;
export type PluginRuntimeFact = z.infer<typeof PluginRuntimeFactSchema>;
export type CssRuleFact = z.infer<typeof CssRuleFactSchema>;
export type DomAttributeFact = z.infer<typeof DomAttributeFactSchema>;
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type LinkRequestMessage = z.infer<typeof LinkRequestMessageSchema>;
export type LinkAcceptedMessage = z.infer<typeof LinkAcceptedMessageSchema>;
export type AuthenticatedMessage = z.infer<
  typeof AuthenticatedMessageSchema
>;
export type UnlinkMessage = z.infer<typeof UnlinkMessageSchema>;
export type InspectMessage = z.infer<typeof InspectMessageSchema>;
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>;
export type ResolutionDiagnosticCode = z.infer<
  typeof ResolutionDiagnosticCodeSchema
>;
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;
export type ResolutionMessage = z.infer<typeof ResolutionMessageSchema>;
export type PeerStateMessage = z.infer<typeof PeerStateMessageSchema>;
export type ReferencesMessage = z.infer<typeof ReferencesMessageSchema>;
export type OpenSourceCommandMessage = z.infer<
  typeof OpenSourceCommandMessageSchema
>;
export type HighlightElementCommandMessage = z.infer<
  typeof HighlightElementCommandMessageSchema
>;
export type CommandMessage = z.infer<typeof CommandMessageSchema>;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type Browser2IdeMessage = z.infer<typeof Browser2IdeMessageSchema>;
