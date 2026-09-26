export const INSPECT_ENVELOPE_MAX_BYTES = 768 * 1024;
export const RESOLUTION_ENVELOPE_MAX_BYTES = 16 * 1024;
export const SOURCE_NAVIGATION_ENVELOPE_MAX_BYTES = 16 * 1024;
export const SOURCE_PRESENTATION_ENVELOPE_MAX_BYTES = 256 * 1024;
export const RULES_SOURCES_ENVELOPE_MAX_BYTES = 128 * 1024;

export const INSPECT_LIMITS = {
  targets: 2,
  factsPerTarget: 256,
  subjectAttributes: 64,
  selectorLength: 2048,
  propertyNameLength: 256,
  attributeNameLength: 256,
  valueLength: 16_384,
  textLength: 16_384,
  urlLength: 8192,
  nodeIdLength: 1024,
  frameIdLength: 256,
  routeLength: 8192,
  classNames: 128,
  stylesheets: 256,
  cssRules: 4096,
  cssRuleDepth: 32,
  declarationsPerRule: 128,
  mediaConditions: 16,
  inaccessibleStylesheets: 64,
} as const;

export const RESOLUTION_LIMITS = {
  opaqueIdLength: 128,
  labelLength: 128,
  languageIdLength: 64,
  generation: 0x7fffffff,
  count: 0x7fffffff,
  diagnosticCodes: 8,
} as const;

export const SOURCE_PRESENTATION_LIMITS = {
  matches: 32,
  textBytes: 8 * 1024,
  textLines: 80,
} as const;

export const RULE_EVIDENCE_LIMITS = {
  rules: 256,
  declarationsPerRule: 32,
  contextsPerRule: 16,
  contextTextLength: 2048,
  ruleRefLength: 128,
  rulePathLength: 512,
  sourceUrlLength: 2048,
} as const;

export const RULES_SOURCES_LIMITS = {
  sources: 256,
  unresolvedRules: 256,
  labelLength: 128,
  authorityIdLength: 128,
  propertyNameLength: 256,
  line: 10_000_000,
  column: 1_000_000,
} as const;
