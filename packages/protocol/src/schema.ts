import {
  PinOpMessageSchema,
  type PinOpMessage,
} from "./messages.js";

export function parseMessage(input: unknown): PinOpMessage {
  return PinOpMessageSchema.parse(input);
}

export { PinOpMessageSchema };
export * from "./messages.js";
export * from "./references.js";
export * from "./capabilities.js";
export * from "./json.js";
