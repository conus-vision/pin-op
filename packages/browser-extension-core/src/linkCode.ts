import {
  isManagedBridgePort,
  MANAGED_BRIDGE_PORT_END,
  MANAGED_BRIDGE_PORT_START,
} from "@pin-op/protocol";

export interface ParsedLinkCode {
  readonly value: string;
  readonly port: number;
  readonly pin: string;
  readonly url: string;
}

const LINK_CODE_PATTERN = /([0-9]{5})(?:[ -])?([0-9]{2})/;

export function parseLinkCode(value: string): ParsedLinkCode {
  const match = LINK_CODE_PATTERN.exec(value);
  if (!match || match[0] !== value) {
    throw new Error(
      "Link code must contain seven digits with an optional space or hyphen",
    );
  }

  const port = Number(match[1]);
  if (!isManagedBridgePort(port)) {
    throw new Error(
      `Link code port must be between ${MANAGED_BRIDGE_PORT_START} and ${MANAGED_BRIDGE_PORT_END}`,
    );
  }

  const pin = match[2];
  return {
    value: `${match[1]}${pin}`,
    port,
    pin,
    url: `ws://127.0.0.1:${port}`,
  };
}
