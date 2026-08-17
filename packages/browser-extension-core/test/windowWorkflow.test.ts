import type {
  ClientSource,
  PeerStateMessage,
  PageRefreshMessage,
  ResolutionMessage,
  SourceNavigateMessage,
  SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import {
  BrowserWindowLinkStore,
  WindowConnectionCoordinator,
  type BrowserBridgeClientOptions,
  type BrowserConnectionState,
  type BrowserCredentials,
  type BrowserProtocolMismatch,
  type BrowserWindowLink,
  type InspectPayload,
  type SessionStorage,
  type WindowConnectionClient,
} from "../src/index.js";
import type {
  InspectSendOutcome,
  SourceNavigationSendOutcome,
  TrustedIdeMessageListener,
} from "../src/bridgeClient.js";

const INSTANCE_A = "2d7856f5-8218-4ba6-9f6c-7aa459333ee1";
const INSTANCE_B = "e76bb54e-f1fc-4d76-844c-554a283b5291";

describe("browser-window workflow", () => {
  it("isolates two linked browser windows while reusing each window connection", async () => {
    const storage = new MemorySessionStorage();
    const store = new BrowserWindowLinkStore(storage);
    const instanceA = new FakeBridgeInstance({
      port: 48_735,
      pin: "07",
      credentials: credentials("session-a", INSTANCE_A, "a"),
    });
    const instanceB = new FakeBridgeInstance({
      port: 48_736,
      pin: "08",
      credentials: credentials("session-b", INSTANCE_B, "b"),
    });
    const instances = new Map([
      [instanceA.url, instanceA],
      [instanceB.url, instanceB],
    ]);
    const coordinator = new WindowConnectionCoordinator({
      store,
      createClient: (options) => {
        const instance = instances.get(options.url);
        if (!instance) {
          throw new Error(`Unexpected bridge endpoint: ${options.url}`);
        }
        return instance.createClient(options);
      },
    });

    await coordinator.linkWindow(10, "4873507", browserSource("window-10"));
    await coordinator.linkWindow(20, "4873608", browserSource("window-20"));

    const panel101 = coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
    });
    let panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    const panel201 = coordinator.registerPanel({
      windowId: 20,
      tabId: 201,
      sourceId: "panel-201",
    });
    const panel202 = coordinator.registerPanel({
      windowId: 20,
      tabId: 202,
      sourceId: "panel-202",
    });
    await flushMicrotasks();

    expect(coordinator.state(10)).toBe("linked");
    expect(coordinator.state(20)).toBe("linked");
    expect(instanceA.clients).toHaveLength(1);
    expect(instanceB.clients).toHaveLength(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceB.linkPins).toEqual(["08"]);
    expect(storage.values).toEqual({
      "pin-op.windowLink.10": savedLink(instanceA),
      "pin-op.windowLink.20": savedLink(instanceB),
    });

    for (const [windowId, tabId] of [
      [10, 101],
      [10, 102],
      [20, 201],
      [20, 202],
    ] as const) {
      expect(
        coordinator.publishInspect(
          windowId,
          `inspect-${tabId}`,
          `panel-${tabId}`,
          selection(tabId),
        ),
      ).toBe("sent");
    }

    expect(instanceA.sourceIds).toEqual(["panel-101", "panel-102"]);
    expect(instanceB.sourceIds).toEqual(["panel-201", "panel-202"]);
    expect(instanceA.sourceIds).not.toContain("panel-201");
    expect(instanceB.sourceIds).not.toContain("panel-101");
    expect(instanceA.received.map(({ payload }) => payload.metadata)).toEqual([
      {},
      {},
    ]);
    expect(instanceB.received.map(({ payload }) => payload.metadata)).toEqual([
      {},
      {},
    ]);
    expect(
      coordinator.publishInspect(
        10,
        "inspect-wrong-window-a",
        "panel-201",
        selection(201),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        20,
        "inspect-wrong-window-b",
        "panel-101",
        selection(101),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-unknown-source",
        "unknown-source",
        selection(101),
      ),
    ).toBe("not-connected");

    panel102.dispose();
    panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    expect(
      coordinator.publishInspect(
        10,
        "inspect-panel-102-reused",
        "panel-102",
        selection(102),
      ),
    ).toBe("sent");

    expect(instanceA.clients).toHaveLength(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceA.connectCredentials).toEqual([]);
    await expect(store.load(10)).resolves.toEqual(savedLink(instanceA));

    panel101.dispose();
    panel102.dispose();
    expect(instanceA.activeClientCount).toBe(0);
    expect(instanceA.clients[0]?.disconnectCalls).toBe(1);
    await expect(store.load(10)).resolves.toEqual(savedLink(instanceA));

    panel102 = coordinator.registerPanel({
      windowId: 10,
      tabId: 102,
      sourceId: "panel-102",
    });
    await flushMicrotasks();

    expect(instanceA.clients).toHaveLength(2);
    expect(instanceA.activeClientCount).toBe(1);
    expect(instanceA.linkPins).toEqual(["07"]);
    expect(instanceA.connectCredentials).toEqual([instanceA.credentials]);
    expect(
      coordinator.publishInspect(
        10,
        "inspect-panel-102-reconnected",
        "panel-102",
        selection(102),
      ),
    ).toBe("sent");

    await coordinator.removeWindow(10);

    expect(instanceA.activeClientCount).toBe(0);
    expect(instanceA.clients[0]?.unlinkCalls).toBe(0);
    expect(instanceA.clients[1]?.unlinkCalls).toBe(1);
    expect(coordinator.state(10)).toBe("notLinked");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-removed-panel-101",
        "panel-101",
        selection(101),
      ),
    ).toBe("not-connected");
    expect(
      coordinator.publishInspect(
        10,
        "inspect-removed-panel-102",
        "panel-102",
        selection(102),
      ),
    ).toBe("not-connected");
    await expect(store.load(10)).resolves.toBeUndefined();

    const reusedRegistrationStates: string[] = [];
    const reusedRegistration = coordinator.registerPanel({
      windowId: 10,
      tabId: 101,
      sourceId: "panel-101",
      onStateChanged: (state) => reusedRegistrationStates.push(state),
    });
    await flushMicrotasks();
    expect(reusedRegistrationStates).toEqual(["notLinked"]);
    expect(instanceA.clients).toHaveLength(2);
    reusedRegistration.dispose();

    expect(coordinator.state(20)).toBe("linked");
    expect(instanceB.activeClientCount).toBe(1);
    expect(
      coordinator.publishInspect(
        20,
        "inspect-panel-202-final",
        "panel-202",
        selection(202),
      ),
    ).toBe("sent");
    await expect(store.load(20)).resolves.toEqual(savedLink(instanceB));
    expect(storage.values).toEqual({
      "pin-op.windowLink.20": savedLink(instanceB),
    });

    panel102.dispose();
    panel201.dispose();
    panel202.dispose();
    coordinator.dispose();
  });
});

interface FakeBridgeConfiguration {
  readonly port: number;
  readonly pin: string;
  readonly credentials: BrowserCredentials;
}

class FakeBridgeInstance {
  public readonly url: string;
  public readonly pin: string;
  public readonly credentials: BrowserCredentials;
  public readonly clients: FakeWindowClient[] = [];
  public readonly linkPins: string[] = [];
  public readonly connectCredentials: BrowserCredentials[] = [];
  public readonly received: Array<{
    inspectMessageId: string;
    payload: InspectPayload;
    sourceId: string;
  }> = [];

  public constructor(configuration: FakeBridgeConfiguration) {
    this.url = `ws://127.0.0.1:${configuration.port}`;
    this.pin = configuration.pin;
    this.credentials = configuration.credentials;
  }

  public get sourceIds(): string[] {
    return this.received.map(({ sourceId }) => sourceId);
  }

  public get activeClientCount(): number {
    return this.clients.filter((client) => client.active).length;
  }

  public createClient(options: BrowserBridgeClientOptions): FakeWindowClient {
    const client = new FakeWindowClient(this, options);
    this.clients.push(client);
    return client;
  }

  public acceptLink(client: FakeWindowClient, pin: string): void {
    this.linkPins.push(pin);
    if (pin !== this.pin) {
      throw new Error("Unexpected PIN");
    }
    client.activate();
    client.emitCredentials(this.credentials);
    client.emitState("connected");
  }

  public acceptCredentials(
    client: FakeWindowClient,
    supplied: BrowserCredentials,
  ): void {
    this.connectCredentials.push(supplied);
    if (JSON.stringify(supplied) !== JSON.stringify(this.credentials)) {
      throw new Error("Unexpected credentials");
    }
    client.activate();
    client.emitState("connected");
  }

  public receive(
    client: FakeWindowClient,
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    if (!client.active) {
      return "not-connected";
    }
    this.received.push({ inspectMessageId, payload, sourceId });
    return "sent";
  }
}

class FakeWindowClient implements WindowConnectionClient {
  public active = false;
  public disconnectCalls = 0;
  public unlinkCalls = 0;

  public constructor(
    private readonly instance: FakeBridgeInstance,
    private readonly options: BrowserBridgeClientOptions,
  ) {}

  public link(pin: string): void {
    this.instance.acceptLink(this, pin);
  }

  public connect(credentials: BrowserCredentials): void {
    this.instance.acceptCredentials(this, credentials);
  }

  public disconnect(): void {
    this.disconnectCalls += 1;
    this.active = false;
  }

  public unlink(): void {
    this.unlinkCalls += 1;
    this.active = false;
  }

  public sendInspect(
    inspectMessageId: string,
    payload: InspectPayload,
    sourceId: string,
  ): InspectSendOutcome {
    return this.instance.receive(this, inspectMessageId, payload, sourceId);
  }

  public sendSourceNavigation(
    _input: Pick<
      SourceNavigateMessage,
      "inspectMessageId" | "resolutionGeneration" | "direction"
    >,
  ): SourceNavigationSendOutcome {
    return this.active ? "sent" : "not-connected";
  }

  public onResolution(
    _listener: TrustedIdeMessageListener<ResolutionMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onPeerState(_listener: (message: PeerStateMessage) => void) {
    return { dispose(): void {} };
  }

  public onSourceNavigationState(
    _listener: TrustedIdeMessageListener<SourceNavigationStateMessage>,
  ) {
    return { dispose(): void {} };
  }

  public onPageRefresh(_listener: (message: PageRefreshMessage) => void) {
    return { dispose(): void {} };
  }

  public onProtocolMismatch(
    _listener: (mismatch: BrowserProtocolMismatch) => void,
  ) {
    return { dispose(): void {} };
  }

  public activate(): void {
    this.active = true;
  }

  public emitCredentials(credentials: BrowserCredentials): void {
    this.options.onCredentials?.(credentials);
  }

  public emitState(state: BrowserConnectionState): void {
    this.options.onStateChanged?.(state);
  }
}

class MemorySessionStorage implements SessionStorage {
  public readonly values: Record<string, unknown> = {};

  public async get(key: string): Promise<Record<string, unknown>> {
    return Object.hasOwn(this.values, key) ? { [key]: this.values[key] } : {};
  }

  public async set(values: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, values);
  }

  public async remove(key: string): Promise<void> {
    delete this.values[key];
  }
}

function browserSource(id: string): ClientSource {
  return { role: "browser", id, metadata: {} };
}

function credentials(
  sessionId: string,
  bridgeInstanceId: string,
  tokenCharacter: string,
): BrowserCredentials {
  return {
    sessionId,
    bridgeInstanceId,
    authToken: tokenCharacter.repeat(32),
  };
}

function savedLink(instance: FakeBridgeInstance): BrowserWindowLink {
  return {
    url: instance.url,
    port: Number(new URL(instance.url).port),
    displayLinkCode: `${new URL(instance.url).port} ${instance.pin}`,
    ...instance.credentials,
  };
}

function selection(tabId: number): InspectPayload {
  return {
    ideHighlightEnabled: true,
    targets: [
      {
        role: "selected",
        depth: 0,
        subject: {
          selector: `.tab-${tabId}`,
          metadata: {},
        },
        facts: [],
        metadata: {},
      },
    ],
    context: {
      url: `http://localhost:${tabId}`,
      metadata: {},
    },
    metadata: {},
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
