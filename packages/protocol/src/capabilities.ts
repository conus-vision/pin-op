import { z } from "zod";

export const ProtocolCapability = {
  Inspect: "inspect",
  Resolution: "resolution",
  Link: "link",
  SourceNavigation: "source-navigation",
  AutoRefresh: "auto-refresh",
  SourcePresentation: "source-presentation",
  PresentationSettings: "presentation-settings",
} as const;

export const ProtocolCapabilitySchema = z.enum([
  ProtocolCapability.Inspect,
  ProtocolCapability.Resolution,
  ProtocolCapability.Link,
  ProtocolCapability.SourceNavigation,
  ProtocolCapability.AutoRefresh,
  ProtocolCapability.SourcePresentation,
  ProtocolCapability.PresentationSettings,
]);

export type ProtocolCapability =
  (typeof ProtocolCapability)[keyof typeof ProtocolCapability];
