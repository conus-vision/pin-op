import {
  PeerStateMessageSchema,
  ResolutionMessageSchema,
  SourceNavigationStateMessageSchema,
} from "@pinop/protocol";
import {
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  isDomResponseForRequest,
  isSelectionRevision,
  parseDomEvent,
  parseDomRequest,
  parseDomResponse,
  type DomRequest,
  type DomResponse,
} from "./domProtocol.js";
import {
  parseInspectControllerCommand,
  parseInspectPortInvalidated,
  parseInspectPortResult,
  parsePanelSourceNavigateCommand,
  type InspectPortRequest,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";
import { parseLinkCode } from "./linkCode.js";

const DOM_WIRE_REQUEST_ID_PREFIX = "domq-";

export class PanelInspectTransport {
  private readonly pendingInspect = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(reason: unknown): void;
    }
  >();
  private readonly pendingDom = new Map<
    string,
    {
      readonly callerRequest: DomQuery;
      readonly wireRequest: DomQuery;
      resolve(value: DomResponse): void;
      reject(reason: unknown): void;
    }
  >();
  private readonly pendingDomCallerIds = new Set<string>();
  private nextRequestId = 1;
  private connection: PortConnection | undefined;
  private disposed = false;

  public constructor(
    private readonly createPort: () => PanelInspectPort,
    private readonly onUnexpectedDisconnect: () => void = () => {},
    private readonly onUnhandledMessage: (message: unknown) => void = () => {},
  ) {}

  public connect(): void {
    if (this.disposed) {
      throw new Error("Inspect connection is closed");
    }
    if (!this.connection) {
      this.openConnection();
    }
  }

  public send(message: unknown): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Inspect connection is closed"));
    }
    const command = parseInspectControllerCommand(message);
    if (!command) {
      return Promise.reject(new Error("Invalid inspect mode command"));
    }
    let connection: PortConnection;
    try {
      connection = this.connection ?? this.openConnection();
    } catch {
      return Promise.reject(new Error("Inspect connection is closed"));
    }

    const requestId = String(this.nextRequestId);
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      this.pendingInspect.set(requestId, { resolve, reject });
      try {
        connection.port.postMessage({
          type: "pinop.inspect.setEnabled",
          requestId,
          enabled: command.type === "enableInspectMode",
        } satisfies InspectPortRequest);
      } catch {
        this.closeConnection(connection, true);
      }
    });
  }

  public requestDom(message: unknown): Promise<DomResponse> {
    if (this.disposed) {
      return Promise.reject(new Error("Inspect connection is closed"));
    }
    const request = validatedDomRequest(message);
    if (!request || !isDomQuery(request)) {
      return Promise.reject(new Error("Invalid DOM request"));
    }
    if (this.pendingDomCallerIds.has(request.requestId)) {
      return Promise.reject(new Error("Duplicate DOM request"));
    }
    let connection: PortConnection;
    try {
      connection = this.connection ?? this.openConnection();
    } catch {
      return Promise.reject(new Error("Inspect connection is closed"));
    }
    const wireRequestId = nextDomWireRequestId(connection);
    if (!wireRequestId) {
      return Promise.reject(new Error("DOM request ID space exhausted"));
    }
    const wireRequest = cloneDomQueryWithRequestId(request, wireRequestId);

    return new Promise((resolve, reject) => {
      this.pendingDomCallerIds.add(request.requestId);
      this.pendingDom.set(wireRequestId, {
        callerRequest: request,
        wireRequest,
        resolve,
        reject,
      });
      try {
        connection.port.postMessage(wireRequest);
      } catch {
        this.closeConnection(connection, true);
      }
    });
  }

  public dispatchDom(message: unknown): void {
    if (this.disposed) {
      throw new Error("Inspect connection is closed");
    }
    const request = validatedDomRequest(message);
    if (!request || isDomQuery(request)) {
      throw new Error("Invalid DOM request");
    }

    let connection: PortConnection | undefined;
    try {
      connection = this.connection ?? this.openConnection();
      connection.port.postMessage(request);
    } catch {
      if (connection) {
        this.closeConnection(connection, true);
      }
      throw new Error("Inspect connection is closed");
    }
  }

  public dispatchSourceNavigation(message: unknown): void {
    if (this.disposed) {
      throw new Error("Inspect connection is closed");
    }
    const command = parsePanelSourceNavigateCommand(message);
    if (!command) {
      throw new Error("Invalid source navigation command");
    }

    let connection: PortConnection | undefined;
    try {
      connection = this.connection ?? this.openConnection();
      connection.port.postMessage(command);
    } catch {
      if (connection) {
        this.closeConnection(connection, true);
      }
      throw new Error("Inspect connection is closed");
    }
  }

  public cancelDomRequests(reason = "DOM session changed"): void {
    const error = new Error(reason);
    for (const pending of this.pendingDom.values()) {
      pending.reject(error);
    }
    this.pendingDom.clear();
    this.pendingDomCallerIds.clear();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const connection = this.connection;
    if (!connection) {
      this.rejectPending();
      return;
    }
    this.closeConnection(connection, false);
    try {
      connection.port.disconnect();
    } catch {
      // The browser may already have closed the port.
    }
  }

  private openConnection(): PortConnection {
    const port = this.createPort();
    const connection: PortConnection = {
      port,
      nextDomRequestSequence: 1,
      onMessage: (message) => this.handleMessage(connection, message),
      onDisconnect: () => this.handleDisconnect(connection),
    };
    this.connection = connection;
    port.onMessage.addListener(connection.onMessage);
    port.onDisconnect.addListener(connection.onDisconnect);
    return connection;
  }

  private handleMessage(
    connection: PortConnection,
    message: unknown,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    const result = parseInspectPortResult(message);
    if (result) {
      const pending = this.pendingInspect.get(result.requestId);
      if (!pending) {
        return;
      }
      this.pendingInspect.delete(result.requestId);
      if (result.ok) {
        pending.resolve({ ok: true });
      } else {
        pending.reject(new Error(result.error));
      }
      return;
    }

    const domResponse = validatedDomResponse(message);
    if (domResponse) {
      const requestId = domResponse.requestId;
      const pending = requestId
        ? this.pendingDom.get(requestId)
        : undefined;
      if (
        pending &&
        requestId &&
        isDomResponseForRequest(pending.wireRequest, domResponse)
      ) {
        this.pendingDom.delete(requestId);
        this.pendingDomCallerIds.delete(pending.callerRequest.requestId);
        pending.resolve(normalizeDomResponseRequestId(
          domResponse,
          pending.callerRequest.requestId,
        ));
      } else if (
        domResponse.type === "dom.error" &&
        (pending ||
          !requestId ||
          !requestId.startsWith(DOM_WIRE_REQUEST_ID_PREFIX))
      ) {
        this.forwardUnhandled(domResponse);
      }
      return;
    }

    const pushMessage = validatedPushMessage(message);
    if (pushMessage) {
      this.forwardUnhandled(pushMessage);
    }
  }

  private forwardUnhandled(message: unknown): void {
    try {
      this.onUnhandledMessage(message);
    } catch {
      // Panel presentation cannot break inspect request ownership.
    }
  }

  private handleDisconnect(connection: PortConnection): void {
    this.closeConnection(connection, true);
  }

  private closeConnection(
    connection: PortConnection,
    unexpected: boolean,
  ): void {
    if (this.connection !== connection) {
      return;
    }
    this.connection = undefined;
    connection.port.onMessage.removeListener(connection.onMessage);
    connection.port.onDisconnect.removeListener(connection.onDisconnect);
    this.rejectPending();
    if (unexpected && !this.disposed) {
      this.onUnexpectedDisconnect();
    }
  }

  private rejectPending(): void {
    for (const pending of this.pendingInspect.values()) {
      pending.reject(new Error("Inspect connection is closed"));
    }
    this.pendingInspect.clear();
    this.cancelDomRequests("Inspect connection is closed");
  }
}

interface PortConnection {
  readonly port: PanelInspectPort;
  nextDomRequestSequence: number | undefined;
  readonly onMessage: (message: unknown) => void;
  readonly onDisconnect: () => void;
}

function validatedDomRequest(message: unknown): DomRequest | undefined {
  try {
    return parseDomRequest(message);
  } catch {
    return undefined;
  }
}

function validatedDomResponse(message: unknown): DomResponse | undefined {
  try {
    return parseDomResponse(message);
  } catch {
    return undefined;
  }
}

function isDomQuery(
  request: DomRequest,
): request is DomQuery {
  return request.type === "dom.getRoot" ||
    request.type === "dom.getChildren" ||
    request.type === "dom.resolveLocator";
}

type DomQuery = Extract<DomRequest, { readonly requestId: string }>;

function nextDomWireRequestId(
  connection: PortConnection,
): string | undefined {
  const sequence = connection.nextDomRequestSequence;
  if (
    sequence === undefined ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1
  ) {
    return undefined;
  }
  const requestId = `${DOM_WIRE_REQUEST_ID_PREFIX}${sequence}`;
  if (requestId.length > DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH) {
    connection.nextDomRequestSequence = undefined;
    return undefined;
  }
  connection.nextDomRequestSequence = sequence === Number.MAX_SAFE_INTEGER
    ? undefined
    : sequence + 1;
  return requestId;
}

function cloneDomQueryWithRequestId(
  request: DomQuery,
  requestId: string,
): DomQuery {
  const cloned = parseDomRequest({ ...request, requestId });
  if (!isDomQuery(cloned)) {
    throw new Error("Invalid DOM request");
  }
  return cloned;
}

function normalizeDomResponseRequestId(
  response: DomResponse,
  requestId: string,
): DomResponse {
  return Object.freeze({ ...response, requestId });
}

function validatedPushMessage(message: unknown): unknown | undefined {
  try {
    return parseDomEvent(message);
  } catch {
    // Continue through the other strict message families.
  }
  const resolution = ResolutionMessageSchema.safeParse(message);
  if (resolution.success) {
    return resolution.data;
  }
  const sourceNavigationState =
    SourceNavigationStateMessageSchema.safeParse(message);
  if (sourceNavigationState.success) {
    return sourceNavigationState.data;
  }
  const peerState = PeerStateMessageSchema.safeParse(message);
  if (peerState.success) {
    return peerState.data;
  }
  const invalidated = parseInspectPortInvalidated(message);
  if (invalidated) {
    return invalidated;
  }
  return validatedLocalPanelState(message);
}

function validatedLocalPanelState(message: unknown): unknown | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const keys = Object.keys(message).sort();
  if (
    (keys.length === 2 || keys.length === 3) &&
    keys.includes("state") &&
    keys.includes("type") &&
    message.type === "pinop.windowState" &&
    typeof message.state === "string" &&
    WINDOW_STATES.has(message.state)
  ) {
    if (keys.length === 2) {
      return { type: message.type, state: message.state };
    }
    if (
      keys[0] !== "displayLinkCode" ||
      typeof message.displayLinkCode !== "string" ||
      !LINKED_WINDOW_STATES.has(message.state) ||
      !isFormattedLinkCode(message.displayLinkCode)
    ) {
      return undefined;
    }
    return {
      type: message.type,
      state: message.state,
      displayLinkCode: message.displayLinkCode,
    };
  }
  if (
    keys.length === 3 &&
    keys[0] === "inspectMessageId" &&
    keys[1] === "selectionRevision" &&
    keys[2] === "type" &&
    message.type === "pinop.inspect.started" &&
    isOpaqueId(message.inspectMessageId) &&
    isSelectionRevision(message.selectionRevision)
  ) {
    return {
      type: message.type,
      inspectMessageId: message.inspectMessageId,
      selectionRevision: message.selectionRevision,
    };
  }
  if (
    keys.length === 3 &&
    keys[0] === "inspectMessageId" &&
    keys[1] === "status" &&
    keys[2] === "type" &&
    message.type === "pinop.ideState" &&
    message.status === "ide-disconnected" &&
    isOpaqueId(message.inspectMessageId)
  ) {
    return {
      type: message.type,
      status: message.status,
      inspectMessageId: message.inspectMessageId,
    };
  }
  return undefined;
}

const WINDOW_STATES = new Set([
  "notLinked",
  "linking",
  "linked",
  "reconnecting",
  "offline",
  "rateLimited",
  "error",
]);

const LINKED_WINDOW_STATES = new Set([
  "linking",
  "linked",
  "reconnecting",
  "offline",
  "error",
]);

function isFormattedLinkCode(value: string): boolean {
  try {
    const parsed = parseLinkCode(value);
    return value === `${parsed.value.slice(0, 5)} ${parsed.value.slice(5)}`;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}
