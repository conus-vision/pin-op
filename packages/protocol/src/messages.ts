import { z } from "zod";
import { metadataSchema, SourceLocationSchema } from "./references.js";
import { ProtocolCapabilitySchema } from "./capabilities.js";
import { JsonObjectSchema, utf8ByteLength } from "./json.js";
import { PublicStylesheetUrlSchema } from "./publicStylesheetUrl.js";
import {
  INSPECT_ENVELOPE_MAX_BYTES,
  INSPECT_LIMITS,
  RESOLUTION_ENVELOPE_MAX_BYTES,
  RESOLUTION_LIMITS,
  RULE_EVIDENCE_LIMITS,
  RULES_SOURCES_ENVELOPE_MAX_BYTES,
  RULES_SOURCES_LIMITS,
  SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
  SOURCE_PRESENTATION_LIMITS,
} from "./limits.js";

export const PROTOCOL_VERSION = 7 as const;

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

function addSerializedBudgetIssue(
  message: object,
  context: z.RefinementCtx,
  envelopeMaxBytes: number,
  messageType: string,
) {
  try {
    if (utf8ByteLength(JSON.stringify(message)) > envelopeMaxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: `${messageType} message exceeds serialized byte limit`,
      });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [],
      message: `${messageType} message must be JSON serializable`,
    });
  }
}

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
    ruleRef: z.string().min(1).max(RULE_EVIDENCE_LIMITS.ruleRefLength),
    property: z.string().min(1).max(INSPECT_LIMITS.propertyNameLength),
    value: z.string().max(INSPECT_LIMITS.valueLength),
    important: z.boolean(),
    valueTruncated: z.boolean(),
    metadata: EmptyMetadataSchema,
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

export { PublicStylesheetUrlSchema } from "./publicStylesheetUrl.js";

export const InspectRuleContextSchema = z
  .object({
    kind: z.enum(["media", "supports"]),
    conditionText: z
      .string()
      .min(1)
      .max(RULE_EVIDENCE_LIMITS.contextTextLength),
  })
  .strict()
  .transform((ruleContext): DeepReadonly<typeof ruleContext> => ruleContext);

export const InspectRuleDeclarationSchema = z
  .object({
    property: z.string().min(1).max(INSPECT_LIMITS.propertyNameLength),
    value: z.string().max(INSPECT_LIMITS.valueLength),
    important: z.boolean(),
    valueTruncated: z.boolean(),
  })
  .strict()
  .transform((declaration): DeepReadonly<typeof declaration> => declaration);

const generatedPositionSchema = z
  .number()
  .int()
  .min(1)
  .max(RULES_SOURCES_LIMITS.line);

const generatedColumnSchema = z
  .number()
  .int()
  .min(1)
  .max(RULES_SOURCES_LIMITS.column);

export const InspectGeneratedSourceSchema = z
  .object({
    sourceUrl: PublicStylesheetUrlSchema,
    startLine: generatedPositionSchema.optional(),
    startColumn: generatedColumnSchema.optional(),
    endLine: generatedPositionSchema.optional(),
    endColumn: generatedColumnSchema.optional(),
    rulePath: z
      .string()
      .min(1)
      .max(RULE_EVIDENCE_LIMITS.rulePathLength)
      .regex(/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/)
      .refine(
        (value) => value.split(".").every((segment) =>
          Number.isSafeInteger(Number(segment))
        ),
        "rule path segments must be safe integers",
      )
      .optional(),
    contexts: z
      .array(InspectRuleContextSchema)
      .max(RULE_EVIDENCE_LIMITS.contextsPerRule),
    contextsTruncated: z.boolean(),
    unsupportedGroupContext: z.boolean(),
  })
  .strict()
  .superRefine((source, context) => {
    const hasStartLine = source.startLine !== undefined;
    const hasStartColumn = source.startColumn !== undefined;
    const hasEndLine = source.endLine !== undefined;
    const hasEndColumn = source.endColumn !== undefined;

    if (hasStartLine !== hasStartColumn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasStartLine ? ["startColumn"] : ["startLine"],
        message: "generated source start line and column must be paired",
      });
    }
    if (hasEndLine !== hasEndColumn) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: hasEndLine ? ["endColumn"] : ["endLine"],
        message: "generated source end line and column must be paired",
      });
    }
    if ((hasEndLine || hasEndColumn) && !(hasStartLine && hasStartColumn)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: "generated source end requires a complete start",
      });
    }
    if (!(hasStartLine && hasStartColumn) && source.rulePath === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rulePath"],
        message: "generated source requires a start position or rule path",
      });
    }
    if (
      hasStartLine &&
      hasStartColumn &&
      hasEndLine &&
      hasEndColumn &&
      (source.endLine! < source.startLine! ||
        (source.endLine === source.startLine &&
          source.endColumn! < source.startColumn!))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: "generated source end must not be before start",
      });
    }
  })
  .transform((source): DeepReadonly<typeof source> => source);

export const InspectRuleEvidenceSchema = z
  .object({
    ruleRef: z.string().min(1).max(RULE_EVIDENCE_LIMITS.ruleRefLength),
    selector: z.string().min(1).max(INSPECT_LIMITS.selectorLength),
    declarations: z
      .array(InspectRuleDeclarationSchema)
      .max(RULE_EVIDENCE_LIMITS.declarationsPerRule),
    declarationsTruncated: z.boolean(),
    generatedSource: InspectGeneratedSourceSchema.optional(),
  })
  .strict()
  .transform((evidence): DeepReadonly<typeof evidence> => evidence);

export const InspectRuleEvidenceBatchSchema = z
  .object({
    rules: z
      .array(InspectRuleEvidenceSchema)
      .max(RULE_EVIDENCE_LIMITS.rules),
    omittedRuleCount: countSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    const seen = new Set<string>();
    for (let index = 0; index < evidence.rules.length; index += 1) {
      const ruleRef = evidence.rules[index]!.ruleRef;
      if (seen.has(ruleRef)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", index, "ruleRef"],
          message: "inspect rule evidence refs must be unique",
        });
      }
      seen.add(ruleRef);
    }
  })
  .transform((evidence): DeepReadonly<typeof evidence> => evidence);

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
    ideHighlightEnabled: z.boolean(),
    targets: z
      .array(InspectTargetSchema)
      .min(1)
      .max(INSPECT_LIMITS.targets),
    ruleEvidence: InspectRuleEvidenceBatchSchema,
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

    const evidenceByRef = new Map(
      message.ruleEvidence.rules.map((evidence) => [
        evidence.ruleRef,
        evidence,
      ]),
    );
    for (let targetIndex = 0; targetIndex < message.targets.length; targetIndex += 1) {
      const target = message.targets[targetIndex]!;
      for (let factIndex = 0; factIndex < target.facts.length; factIndex += 1) {
        const fact = target.facts[factIndex]!;
        if (fact.type !== "css-rule" || !("ruleRef" in fact)) continue;
        const evidence = evidenceByRef.get(fact.ruleRef);
        if (!evidence) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["targets", targetIndex, "facts", factIndex, "ruleRef"],
            message: "CSS fact must reference included rule evidence",
          });
          continue;
        }
        const exactDeclaration = evidence.declarations.some(
          (declaration) =>
            declaration.property === fact.property &&
            declaration.value === fact.value &&
            declaration.important === fact.important &&
            declaration.valueTruncated === fact.valueTruncated,
        );
        if (!exactDeclaration) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["targets", targetIndex, "facts", factIndex],
            message: "CSS fact must match an exact evidence declaration",
          });
        }
      }
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

export const RulesGenerationSchema = z
  .number()
  .int()
  .min(0)
  .max(RESOLUTION_LIMITS.generation);

export const RulesSourceConfidenceSchema = z.enum(["exact", "sourcemap"]);

const FORBIDDEN_RULES_SOURCE_LABEL =
  /[\/:\\\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u;

export const RulesSourceDocumentSchema = z
  .object({
    label: z
      .string()
      .min(1)
      .max(RULES_SOURCES_LIMITS.labelLength)
      .refine(
        (label) =>
          label !== "." &&
          label !== ".." &&
          !FORBIDDEN_RULES_SOURCE_LABEL.test(label) &&
          !/^[a-z][a-z0-9+.-]*:/i.test(label),
        "rules source label must be a safe basename",
      ),
    languageId: z.enum(["css", "scss"]),
  })
  .strict()
  .transform((document): DeepReadonly<typeof document> => document);

export const RulesSourceSchema = z
  .object({
    ruleRef: z.string().min(1).max(RULE_EVIDENCE_LIMITS.ruleRefLength),
    openAuthorityId: z
      .string()
      .min(1)
      .max(RULES_SOURCES_LIMITS.authorityIdLength),
    document: RulesSourceDocumentSchema,
    startLine: z
      .number()
      .int()
      .min(1)
      .max(RULES_SOURCES_LIMITS.line),
    startColumn: z
      .number()
      .int()
      .min(1)
      .max(RULES_SOURCES_LIMITS.column),
    confidence: RulesSourceConfidenceSchema,
  })
  .strict()
  .transform((source): DeepReadonly<typeof source> => source);

export function createRulesSourcesMessageSchema(
  envelopeMaxBytes = RULES_SOURCES_ENVELOPE_MAX_BYTES,
) {
  const schema = z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal("rules.sources"),
      messageId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      source: ResolutionSourceSchema,
      inspectMessageId: opaqueIdSchema,
      rulesGeneration: RulesGenerationSchema,
      sources: z
        .array(RulesSourceSchema)
        .max(RULES_SOURCES_LIMITS.sources),
      unresolvedRuleCount: z
        .number()
        .int()
        .min(0)
        .max(RULES_SOURCES_LIMITS.unresolvedRules),
      metadata: EmptyMetadataSchema,
    })
    .strict();

  return schema
    .superRefine((message, context) => {
      const ruleRefs = new Set<string>();
      const authorityIds = new Set<string>();
      for (let index = 0; index < message.sources.length; index += 1) {
        const source = message.sources[index]!;
        if (ruleRefs.has(source.ruleRef)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sources", index, "ruleRef"],
            message: "rules source refs must be unique",
          });
        }
        if (authorityIds.has(source.openAuthorityId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["sources", index, "openAuthorityId"],
            message: "rules source open authorities must be unique",
          });
        }
        ruleRefs.add(source.ruleRef);
        authorityIds.add(source.openAuthorityId);
      }
      addSerializedBudgetIssue(
        message,
        context,
        envelopeMaxBytes,
        "rules.sources",
      );
    })
    .transform((message): DeepReadonly<z.infer<typeof schema>> => message);
}

export const RulesSourcesMessageSchema = createRulesSourcesMessageSchema();

const rulesOpenMessageObjectSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("rules.open"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    inspectMessageId: opaqueIdSchema,
    rulesGeneration: RulesGenerationSchema,
    openAuthorityId: z
      .string()
      .min(1)
      .max(RULES_SOURCES_LIMITS.authorityIdLength),
    metadata: EmptyMetadataSchema,
  })
  .strict();

export const RulesOpenMessageSchema = rulesOpenMessageObjectSchema.transform(
  (message): DeepReadonly<z.infer<typeof rulesOpenMessageObjectSchema>> =>
    message,
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

export const SourceDocumentSchema = z
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
      document: SourceDocumentSchema.optional(),
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

      addSerializedBudgetIssue(
        message,
        context,
        envelopeMaxBytes,
        "resolution",
      );
    })
    .transform(
      (message): DeepReadonly<z.infer<typeof schema>> => message,
    );
}

export const ResolutionMessageSchema = createResolutionMessageSchema();

export const PageRefreshModeSchema = z.enum(["styles", "reload"]);

const pageRefreshMessageObjectSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("page.refresh"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    source: ResolutionSourceSchema,
    refreshGeneration: generationSchema,
    mode: PageRefreshModeSchema,
    metadata: EmptyMetadataSchema,
  })
  .strict();

export const PageRefreshMessageSchema =
  pageRefreshMessageObjectSchema.transform(
    (message): DeepReadonly<z.infer<typeof pageRefreshMessageObjectSchema>> =>
      message,
  );

export const SourceExcerptTargetRoleSchema = z.enum(["selected", "parent"]);

export const SourceExcerptConfidenceSchema = z.enum([
  "exact",
  "sourcemap",
  "instrumented",
  "heuristic",
  "unknown",
]);

export const SOURCE_EXCERPT_KINDS = Object.freeze([
  "component",
  "fixture",
  "rule",
  "source",
  "style-rule",
  "template",
] as const);

export const SOURCE_EXCERPT_RELATIONS = Object.freeze([
  "applies",
  "contains",
  "declared-in",
  "matches",
  "parent",
  "renders",
  "selected",
  "styles",
  "templates",
] as const);

export const SourceExcerptKindSchema = z.enum(SOURCE_EXCERPT_KINDS);

export const SourceExcerptRelationSchema = z.enum(SOURCE_EXCERPT_RELATIONS);

const sourceExcerptObjectSchema = z
  .object({
    matchId: opaqueIdSchema,
    targetRole: SourceExcerptTargetRoleSchema,
    label: z.string().min(1).max(RESOLUTION_LIMITS.labelLength),
    kind: SourceExcerptKindSchema,
    relation: SourceExcerptRelationSchema,
    confidence: SourceExcerptConfidenceSchema,
    startLine: z.number().int().min(1).max(RESOLUTION_LIMITS.count),
    endLine: z.number().int().min(1).max(RESOLUTION_LIMITS.count),
    text: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const SourceExcerptSchema = sourceExcerptObjectSchema
  .superRefine((excerpt, context) => {
    if (excerpt.endLine < excerpt.startLine) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endLine"],
        message: "source excerpt end line must not be before start line",
      });
    }

    if (utf8ByteLength(excerpt.text) > SOURCE_PRESENTATION_LIMITS.textBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "source excerpt text exceeds UTF-8 byte limit",
      });
    }

    const logicalLineCount = excerpt.text.split(/\r\n|\r|\n/).length;
    if (logicalLineCount > SOURCE_PRESENTATION_LIMITS.textLines) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["text"],
        message: "source excerpt text exceeds logical line limit",
      });
    }
  })
  .transform(
    (excerpt): DeepReadonly<z.infer<typeof sourceExcerptObjectSchema>> =>
      excerpt,
  );

export function createSourceMatchesMessageSchema(
  envelopeMaxBytes = SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES,
) {
  const schema = z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal("source.matches"),
      messageId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      source: ResolutionSourceSchema,
      inspectMessageId: opaqueIdSchema,
      resolutionGeneration: generationSchema,
      document: SourceDocumentSchema,
      matches: z
        .array(SourceExcerptSchema)
        .max(SOURCE_PRESENTATION_LIMITS.matches),
      omittedMatchCount: countSchema,
      metadata: EmptyMetadataSchema,
    })
    .strict();

  return schema
    .superRefine((message, context) => {
      addSerializedBudgetIssue(
        message,
        context,
        envelopeMaxBytes,
        "source.matches",
      );
    })
    .transform((message): DeepReadonly<z.infer<typeof schema>> => message);
}

export const SourceMatchesMessageSchema = createSourceMatchesMessageSchema();

const sourceOpenMessageObjectSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("source.open"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    inspectMessageId: opaqueIdSchema,
    resolutionGeneration: generationSchema,
    matchId: opaqueIdSchema,
    metadata: EmptyMetadataSchema,
  })
  .strict();

export const SourceOpenMessageSchema = sourceOpenMessageObjectSchema.transform(
  (message): DeepReadonly<z.infer<typeof sourceOpenMessageObjectSchema>> =>
    message,
);

const presentationSettingsMessageObjectSchema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("presentation.settings"),
    messageId: opaqueIdSchema,
    sessionId: opaqueIdSchema,
    inspectMessageId: opaqueIdSchema,
    ideHighlightEnabled: z.boolean(),
    metadata: EmptyMetadataSchema,
  })
  .strict();

export const PresentationSettingsMessageSchema =
  presentationSettingsMessageObjectSchema.transform(
    (
      message,
    ): DeepReadonly<z.infer<typeof presentationSettingsMessageObjectSchema>> =>
      message,
  );

export const SourceNavigationDirectionSchema = z.enum(["previous", "next"]);

export function createSourceNavigateMessageSchema(
  envelopeMaxBytes = SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
) {
  const schema = z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal("source.navigate"),
      messageId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      inspectMessageId: opaqueIdSchema,
      resolutionGeneration: generationSchema,
      direction: SourceNavigationDirectionSchema,
      metadata: EmptyMetadataSchema,
    })
    .strict();

  return schema
    .superRefine((message, context) => {
      addSerializedBudgetIssue(
        message,
        context,
        envelopeMaxBytes,
        "source.navigate",
      );
    })
    .transform(
      (message): DeepReadonly<z.infer<typeof schema>> => message,
    );
}

export const SourceNavigateMessageSchema =
  createSourceNavigateMessageSchema();

export function createSourceNavigationStateMessageSchema(
  envelopeMaxBytes = SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES,
) {
  const schema = z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal("source.navigationState"),
      messageId: opaqueIdSchema,
      sessionId: opaqueIdSchema,
      inspectMessageId: opaqueIdSchema,
      source: ResolutionSourceSchema,
      resolutionGeneration: generationSchema,
      selectedMatchCount: countSchema,
      activeMatchIndex: countSchema.optional(),
      activeMatchId: opaqueIdSchema.optional(),
      metadata: EmptyMetadataSchema,
    })
    .strict();

  return schema
    .superRefine((message, context) => {
      if (
        message.activeMatchIndex !== undefined &&
        message.activeMatchIndex >= message.selectedMatchCount
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["activeMatchIndex"],
          message: "active match index must be less than selected match count",
        });
      }

      addSerializedBudgetIssue(
        message,
        context,
        envelopeMaxBytes,
        "source.navigationState",
      );
    })
    .transform(
      (message): DeepReadonly<z.infer<typeof schema>> => message,
    );
}

export const SourceNavigationStateMessageSchema =
  createSourceNavigationStateMessageSchema();

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

export const PinOpMessageSchema = z.union([
  HelloMessageSchema,
  LinkRequestMessageSchema,
  LinkAcceptedMessageSchema,
  AuthenticatedMessageSchema,
  UnlinkMessageSchema,
  InspectMessageSchema,
  RulesSourcesMessageSchema,
  RulesOpenMessageSchema,
  PageRefreshMessageSchema,
  SourceMatchesMessageSchema,
  SourceOpenMessageSchema,
  PresentationSettingsMessageSchema,
  SourceNavigateMessageSchema,
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
  PeerStateMessageSchema,
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
export type InspectRuleContext = z.infer<typeof InspectRuleContextSchema>;
export type InspectRuleDeclaration = z.infer<
  typeof InspectRuleDeclarationSchema
>;
export type InspectGeneratedSource = z.infer<
  typeof InspectGeneratedSourceSchema
>;
export type InspectRuleEvidence = z.infer<typeof InspectRuleEvidenceSchema>;
export type InspectRuleEvidenceBatch = z.infer<
  typeof InspectRuleEvidenceBatchSchema
>;
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
export type RulesGeneration = z.infer<typeof RulesGenerationSchema>;
export type RulesSourceConfidence = z.infer<
  typeof RulesSourceConfidenceSchema
>;
export type RulesSourceDocument = z.infer<typeof RulesSourceDocumentSchema>;
export type RulesSource = z.infer<typeof RulesSourceSchema>;
export type RulesSourcesMessage = z.infer<typeof RulesSourcesMessageSchema>;
export type RulesOpenMessage = z.infer<typeof RulesOpenMessageSchema>;
export type PageRefreshMode = z.infer<typeof PageRefreshModeSchema>;
export type PageRefreshMessage = z.infer<typeof PageRefreshMessageSchema>;
export type ResolutionSource = z.infer<typeof ResolutionSourceSchema>;
export type ResolutionDiagnosticCode = z.infer<
  typeof ResolutionDiagnosticCodeSchema
>;
export type ResolutionStatus = z.infer<typeof ResolutionStatusSchema>;
export type ResolutionMessage = z.infer<typeof ResolutionMessageSchema>;
export type SourceExcerptTargetRole = z.infer<
  typeof SourceExcerptTargetRoleSchema
>;
export type SourceExcerptConfidence = z.infer<
  typeof SourceExcerptConfidenceSchema
>;
export type SourceExcerptKind = z.infer<typeof SourceExcerptKindSchema>;
export type SourceExcerptRelation = z.infer<
  typeof SourceExcerptRelationSchema
>;
export type SourceExcerpt = z.infer<typeof SourceExcerptSchema>;
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;
export type SourceMatchesMessage = z.infer<typeof SourceMatchesMessageSchema>;
export type SourceOpenMessage = z.infer<typeof SourceOpenMessageSchema>;
export type PresentationSettingsMessage = z.infer<
  typeof PresentationSettingsMessageSchema
>;
export type SourceNavigationDirection = z.infer<
  typeof SourceNavigationDirectionSchema
>;
export type SourceNavigateMessage = z.infer<
  typeof SourceNavigateMessageSchema
>;
export type SourceNavigationStateMessage = z.infer<
  typeof SourceNavigationStateMessageSchema
>;
export type PeerStateMessage = z.infer<typeof PeerStateMessageSchema>;
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCodeSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type PongMessage = z.infer<typeof PongMessageSchema>;
export type PinOpMessage = z.infer<typeof PinOpMessageSchema>;
