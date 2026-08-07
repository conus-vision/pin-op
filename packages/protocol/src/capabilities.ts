import { z } from "zod";

export const ProtocolCapability = {
  Inspect: "inspect",
  Resolution: "resolution",
  Link: "link",
} as const;

export const ProtocolCapabilitySchema = z.enum([
  ProtocolCapability.Inspect,
  ProtocolCapability.Resolution,
  ProtocolCapability.Link,
]);

export type ProtocolCapability =
  (typeof ProtocolCapability)[keyof typeof ProtocolCapability];
