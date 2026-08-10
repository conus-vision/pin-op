import { z } from "zod";

export const ProtocolCapability = {
  Inspect: "inspect",
  Resolution: "resolution",
  Link: "link",
  SourceNavigation: "source-navigation",
} as const;

export const ProtocolCapabilitySchema = z.enum([
  ProtocolCapability.Inspect,
  ProtocolCapability.Resolution,
  ProtocolCapability.Link,
  ProtocolCapability.SourceNavigation,
]);

export type ProtocolCapability =
  (typeof ProtocolCapability)[keyof typeof ProtocolCapability];
