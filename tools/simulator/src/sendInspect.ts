#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import {
  PinOpMessageSchema,
  InspectMessageSchema,
  PROTOCOL_VERSION,
  type AuthenticatedMessage,
  type PinOpMessage,
  type InspectMessage,
  type LinkAcceptedMessage,
} from "@pin-op/protocol";

const DEFAULT_SOURCE_ID = "pin-op-simulator";
const DEFAULT_TIMEOUT_MS = 2_000;

interface BuildInspectOptions {
  readonly sessionId: string;
  readonly sourceId: string;
}

interface BaseSendInspectOptions {
  readonly fixture: string;
  readonly sourceId?: string;
  readonly timeoutMs?: number;
}

interface LinkSendInspectOptions extends BaseSendInspectOptions {
  readonly linkCode: string;
  readonly url?: never;
  readonly authToken?: never;
  readonly sessionId?: never;
  readonly bridgeInstanceId?: never;
}

interface TokenSendInspectOptions extends BaseSendInspectOptions {
  readonly linkCode?: never;
  readonly url: string;
  readonly authToken: string;
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
}

export type SendInspectOptions =
  | LinkSendInspectOptions
  | TokenSendInspectOptions;

export type ParsedSendArgs =
  | (LinkSendInspectOptions & {
      readonly command: "send";
      readonly sourceId: string;
    })
  | (TokenSendInspectOptions & {
      readonly command: "send";
      readonly sourceId: string;
    });

interface BridgeCredentials {
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

type ConnectionMode =
  | { readonly kind: "link"; readonly url: string; readonly pin: string }
  | {
      readonly kind: "credentials";
      readonly url: string;
      readonly credentials: BridgeCredentials;
    };

export function buildInspectMessage(
  fixture: unknown,
  options: BuildInspectOptions,
): InspectMessage {
  if (!isRecord(fixture)) {
    throw new Error("Inspect fixture must contain a JSON object");
  }

  return InspectMessageSchema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: "inspect",
    messageId: randomUUID(),
    sessionId: options.sessionId,
    source: {
      role: "simulator",
      id: options.sourceId,
      metadata: {},
    },
    targets: fixture.targets,
    context: fixture.context,
    metadata: fixture.metadata ?? {},
  });
}

export function parseLinkCode(value: string): { url: string; pin: string } {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d{7}$/.test(digits)) {
    throw new Error("Link code must contain seven digits");
  }
  const port = Number(digits.slice(0, 5));
  if (port < 10_000 || port > 65_535) {
    throw new Error("Link code contains an invalid port");
  }
  return { url: `ws://127.0.0.1:${port}`, pin: digits.slice(5) };
}

export function parseSendArgs(args: string[]): ParsedSendArgs {
  const [command, ...rawFlags] = args;
  if (command !== "send") {
    throw new Error("Expected command: send");
  }
  const flags = rawFlags[0] === "--" ? rawFlags.slice(1) : rawFlags;

  const values = new Map<string, string>();
  const supportedFlags = new Set([
    "--link-code",
    "--url",
    "--auth-token",
    "--session-id",
    "--bridge-instance-id",
    "--fixture",
    "--source-id",
  ]);

  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];

    if (!flag || !supportedFlags.has(flag)) {
      throw new Error(`Unknown option: ${flag ?? "<missing>"}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    if (values.has(flag)) {
      throw new Error(`Option supplied more than once: ${flag}`);
    }

    values.set(flag, value);
  }

  const linkCode = values.get("--link-code");
  const url = values.get("--url");
  const authToken = values.get("--auth-token");
  const sessionId = values.get("--session-id");
  const bridgeInstanceId = values.get("--bridge-instance-id");
  const fixture = values.get("--fixture");
  const sourceId = values.get("--source-id") ?? DEFAULT_SOURCE_ID;
  const hasExplicitTokenField = Boolean(
    url || authToken || sessionId || bridgeInstanceId,
  );

  if (!fixture) {
    throw new Error("--fixture is required");
  }
  if (linkCode && hasExplicitTokenField) {
    throw new Error(
      "Use either --link-code or explicit token credentials, not both",
    );
  }
  if (linkCode) {
    parseLinkCode(linkCode);
    return {
      command: "send",
      linkCode,
      fixture,
      sourceId,
    };
  }
  if (!hasExplicitTokenField) {
    throw new Error(
      "--link-code or complete explicit token credentials are required",
    );
  }
  if (!url || !sessionId || !bridgeInstanceId || !authToken) {
    throw new Error(
      "Explicit token mode requires --url, --session-id, --bridge-instance-id, and --auth-token",
    );
  }

  assertWebSocketUrl(url);
  return {
    command: "send",
    url,
    sessionId,
    bridgeInstanceId,
    authToken,
    fixture,
    sourceId,
  };
}

export async function sendInspect(
  options: SendInspectOptions,
): Promise<InspectMessage> {
  validateSendOptions(options);

  const sourceId = options.sourceId ?? DEFAULT_SOURCE_ID;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fixture = await loadFixture(options.fixture);
  const mode = resolveConnectionMode(options);
  const socket = await connect(mode.url, timeoutMs);

  try {
    const credentials =
      mode.kind === "link"
        ? await requestLink(socket, mode.pin, sourceId, timeoutMs)
        : mode.credentials;

    await authenticate(socket, credentials, sourceId, timeoutMs);

    const inspect = buildInspectMessage(fixture, {
      sessionId: credentials.sessionId,
      sourceId,
    });
    await sendProtocolMessage(socket, inspect);
    return inspect;
  } finally {
    await closeSocket(socket, timeoutMs);
  }
}

export async function runCli(args = process.argv.slice(2)): Promise<void> {
  const options = parseSendArgs(args);
  const inspect = await sendInspect(options);
  console.log(
    `Sent inspect for ${inspect.targets[0]?.subject.selector ?? "selected element"} in session ${inspect.sessionId}`,
  );
}

async function requestLink(
  socket: WebSocket,
  pin: string,
  sourceId: string,
  timeoutMs: number,
): Promise<BridgeCredentials> {
  const accepted = waitForMessage(
    socket,
    (message): message is LinkAcceptedMessage => message.type === "linkAccepted",
    timeoutMs,
  );

  await sendProtocolMessage(socket, {
    protocolVersion: PROTOCOL_VERSION,
    type: "linkRequest",
    messageId: randomUUID(),
    pin,
    source: {
      role: "simulator",
      id: sourceId,
      metadata: {},
    },
    metadata: {},
  });

  const response = await accepted;
  return {
    sessionId: response.sessionId,
    bridgeInstanceId: response.bridgeInstanceId,
    authToken: response.authToken,
  };
}

async function authenticate(
  socket: WebSocket,
  credentials: BridgeCredentials,
  sourceId: string,
  timeoutMs: number,
): Promise<void> {
  const acknowledged = waitForMessage(
    socket,
    (message): message is AuthenticatedMessage => message.type === "authenticated",
    timeoutMs,
  );

  await sendProtocolMessage(socket, {
    protocolVersion: PROTOCOL_VERSION,
    type: "hello",
    messageId: randomUUID(),
    sessionId: credentials.sessionId,
    authToken: credentials.authToken,
    bridgeInstanceId: credentials.bridgeInstanceId,
    source: {
      role: "simulator",
      id: sourceId,
      metadata: {},
    },
    capabilities: ["inspect"],
    metadata: {},
  });

  const response = await acknowledged;
  if (
    response.sessionId !== credentials.sessionId ||
    response.bridgeInstanceId !== credentials.bridgeInstanceId
  ) {
    throw new Error(
      "Bridge authenticated a different session or bridge instance",
    );
  }
}

async function loadFixture(name: string): Promise<unknown> {
  const normalizedName = name.endsWith(".json") ? name.slice(0, -5) : name;
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(normalizedName)) {
    throw new Error(`Invalid fixture name: ${name}`);
  }

  const fixtureUrl = new URL(`../fixtures/${normalizedName}.json`, import.meta.url);
  try {
    return JSON.parse(await readFile(fixtureUrl, "utf8"));
  } catch (error) {
    throw new Error(`Could not load fixture: ${name}`, { cause: error });
  }
}

function validateSendOptions(options: SendInspectOptions): void {
  const linkCode = options.linkCode;
  const hasExplicitTokenField = Boolean(
    options.url ||
      options.authToken ||
      options.sessionId ||
      options.bridgeInstanceId,
  );

  if (linkCode && hasExplicitTokenField) {
    throw new Error(
      "Use either linkCode or explicit token credentials, not both",
    );
  }
  if (linkCode) {
    parseLinkCode(linkCode);
  } else if (
    !options.url ||
    !options.authToken ||
    !options.sessionId ||
    !options.bridgeInstanceId
  ) {
    throw new Error(
      "Explicit token mode requires url, sessionId, bridgeInstanceId, and authToken",
    );
  } else {
    assertWebSocketUrl(options.url);
  }
  if (!options.fixture) {
    throw new Error("fixture is required");
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new Error("timeoutMs must be greater than zero");
  }
}

function assertWebSocketUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid WebSocket URL: ${value}`);
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Invalid WebSocket URL: ${value}`);
  }
}

function connect(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => {
      cleanup();
      socket.terminate();
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error: Error) => {
      cleanup();
      socket.terminate();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };

    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function sendProtocolMessage(
  socket: WebSocket,
  message: PinOpMessage,
): Promise<void> {
  const payload = JSON.stringify(PinOpMessageSchema.parse(message));

  return new Promise((resolve, reject) => {
    socket.send(payload, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function waitForMessage<T extends PinOpMessage>(
  socket: WebSocket,
  predicate: (message: PinOpMessage) => message is T,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for bridge response"));
    }, timeoutMs);
    const onMessage = (data: RawData) => {
      let message: PinOpMessage;
      try {
        message = PinOpMessageSchema.parse(JSON.parse(data.toString()));
      } catch (error) {
        cleanup();
        reject(new Error("Bridge sent an invalid protocol message", { cause: error }));
        return;
      }

      if (message.type === "error") {
        cleanup();
        reject(new Error(sanitizedBridgeError(message.code)));
        return;
      }
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Bridge closed before sending a response"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function sanitizedBridgeError(code: string): string {
  if (code === "auth.instanceChanged" || code === "auth.tokenRejected") {
    return `${code}: Bridge authentication failed`;
  }
  return `${code}: Bridge rejected the request`;
}

async function closeSocket(socket: WebSocket, timeoutMs: number): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  if (socket.readyState !== WebSocket.OPEN) {
    socket.terminate();
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, timeoutMs);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLinkMode(
  options: SendInspectOptions,
): options is LinkSendInspectOptions {
  return typeof options.linkCode === "string";
}

function resolveConnectionMode(options: SendInspectOptions): ConnectionMode {
  if (isLinkMode(options)) {
    return { kind: "link", ...parseLinkCode(options.linkCode) };
  }
  return {
    kind: "credentials",
    url: options.url,
    credentials: {
      sessionId: options.sessionId,
      bridgeInstanceId: options.bridgeInstanceId,
      authToken: options.authToken,
    },
  };
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
