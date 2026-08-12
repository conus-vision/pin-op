import {
  LinkAuthenticator,
  createBridgeServer,
  type BridgeServer,
  type BridgeServerOptions,
  type LinkAuthenticatorOptions,
} from "@pinop/bridge";
import type { BridgeConfiguration } from "./config.js";

export const MANAGED_PORT_START = 48_735;
export const MANAGED_PORT_COUNT = 100;

export type BridgeManagerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";

export interface BridgeSnapshot {
  readonly state: BridgeManagerState;
  readonly url?: string;
  readonly port?: number;
  readonly pin?: string;
  readonly linkCode?: string;
  readonly bridgeInstanceId?: string;
  readonly sessionId: string;
  readonly linkedBrowserCount: number;
}

export interface IdeCredentials {
  readonly sessionId: string;
  readonly bridgeInstanceId: string;
  readonly authToken: string;
}

type ManagedBridge = Pick<
  BridgeServer,
  "start" | "stop" | "getUrl" | "getLinkInfo" | "onClientCountChanged"
>;

interface DisposableLike {
  dispose(): void;
}

export interface BridgeManagerOptions {
  readonly configuration: BridgeConfiguration;
  readonly managedPortStart?: number;
  readonly managedPortCount?: number;
  readonly createAuthenticator?: (
    options: LinkAuthenticatorOptions,
  ) => LinkAuthenticator;
  readonly createBridge?: (options: BridgeServerOptions) => ManagedBridge;
}

export class BridgeManager {
  private readonly createAuthenticator: (
    options: LinkAuthenticatorOptions,
  ) => LinkAuthenticator;
  private readonly createBridge: (options: BridgeServerOptions) => ManagedBridge;
  private readonly stateListeners = new Set<(snapshot: BridgeSnapshot) => void>();
  private bridge: ManagedBridge | undefined;
  private authenticator: LinkAuthenticator | undefined;
  private clientCountSubscription: DisposableLike | undefined;
  private credentials: IdeCredentials | undefined;
  private state: BridgeManagerState = "stopped";
  private url: string | undefined;
  private port: number | undefined;
  private pin: string | undefined;
  private linkCode: string | undefined;
  private bridgeInstanceId: string | undefined;
  private linkedBrowserCount = 0;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: BridgeManagerOptions) {
    this.createAuthenticator =
      options.createAuthenticator ??
      ((authenticatorOptions) => new LinkAuthenticator(authenticatorOptions));
    this.createBridge = options.createBridge ?? createBridgeServer;
  }

  start(): Promise<void> {
    if (this.stopPromise) {
      const pendingStop = this.stopPromise;
      return pendingStop.catch(() => undefined).then(() => this.start());
    }
    if (this.state === "running") {
      return Promise.resolve();
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const operation = this.operationTail.then(async () => {
      if (this.state !== "running") {
        await this.startBridge();
      }
    });
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (this.startPromise === tracked) {
        this.startPromise = undefined;
      }
    });
    this.startPromise = tracked;
    this.operationTail = tracked.catch(() => undefined);
    return tracked;
  }

  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.startPromise && this.state === "stopped") {
      return Promise.resolve();
    }

    const operation = this.operationTail.then(async () => {
      if (this.state !== "stopped") {
        await this.stopBridge();
      }
    });
    let tracked: Promise<void>;
    tracked = operation.finally(() => {
      if (this.stopPromise === tracked) {
        this.stopPromise = undefined;
      }
    });
    this.stopPromise = tracked;
    this.operationTail = tracked.catch(() => undefined);
    return tracked;
  }

  snapshot(): BridgeSnapshot {
    return {
      state: this.state,
      ...(this.url === undefined ? {} : { url: this.url }),
      ...(this.port === undefined ? {} : { port: this.port }),
      ...(this.pin === undefined ? {} : { pin: this.pin }),
      ...(this.linkCode === undefined ? {} : { linkCode: this.linkCode }),
      ...(this.bridgeInstanceId === undefined
        ? {}
        : { bridgeInstanceId: this.bridgeInstanceId }),
      sessionId: this.options.configuration.sessionId,
      linkedBrowserCount: this.linkedBrowserCount,
    };
  }

  getIdeCredentials(): IdeCredentials | undefined {
    if (this.state !== "running" || !this.credentials) {
      return undefined;
    }
    return { ...this.credentials };
  }

  onStateChanged(
    listener: (snapshot: BridgeSnapshot) => void,
  ): DisposableLike {
    this.stateListeners.add(listener);
    return {
      dispose: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  private async startBridge(): Promise<void> {
    this.transitionTo("starting");
    let authenticator: LinkAuthenticator | undefined;
    let startedBridge: ManagedBridge | undefined;

    try {
      const sessionId = this.options.configuration.sessionId;
      authenticator = this.createAuthenticator({ sessionId });
      const started = await this.startOnAvailablePort(authenticator);
      startedBridge = started.bridge;
      const ideToken = authenticator.issueTrustedToken("ide");
      const linkInfo = started.bridge.getLinkInfo();

      this.bridge = started.bridge;
      this.authenticator = authenticator;
      this.url = started.bridge.getUrl();
      this.port = started.port;
      this.pin = linkInfo.pin;
      this.linkCode = `${String(started.port).padStart(5, "0")}${linkInfo.pin}`;
      this.bridgeInstanceId = linkInfo.bridgeInstanceId;
      this.linkedBrowserCount = 0;
      this.credentials = {
        sessionId: ideToken.sessionId,
        bridgeInstanceId: ideToken.bridgeInstanceId,
        authToken: ideToken.value,
      };
      this.clientCountSubscription = started.bridge.onClientCountChanged(
        (counts) => {
          if (this.bridge !== started.bridge) {
            return;
          }
          this.linkedBrowserCount = counts.browser;
          this.notifyStateListeners();
        },
      );
      this.transitionTo("running");
    } catch (error) {
      this.disposeClientCountSubscription();
      if (startedBridge) {
        await startedBridge.stop().catch(() => undefined);
      }
      try {
        authenticator?.revokeAll();
      } finally {
        this.clearRuntime();
        this.transitionTo("error");
      }
      throw error;
    }
  }

  private async startOnAvailablePort(
    authenticator: LinkAuthenticator,
  ): Promise<{ readonly bridge: ManagedBridge; readonly port: number }> {
    let lastError: NodeJS.ErrnoException | undefined;
    const managedPortStart = this.options.managedPortStart ?? MANAGED_PORT_START;
    const managedPortCount = this.options.managedPortCount ?? MANAGED_PORT_COUNT;

    for (let offset = 0; offset < managedPortCount; offset += 1) {
      const port = managedPortStart + offset;
      let bridge: ManagedBridge | undefined;
      try {
        bridge = this.createBridge({
          host: "127.0.0.1",
          port,
          sessionId: this.options.configuration.sessionId,
          authenticator,
        });
        await bridge.start();
        return { bridge, port };
      } catch (error) {
        await bridge?.stop().catch(() => undefined);
        if (!isAddressInUse(error)) {
          throw error;
        }
        lastError = error;
      }
    }

    throw lastError ?? addressInUseError();
  }

  private async stopBridge(): Promise<void> {
    this.transitionTo("stopping");
    const bridge = this.bridge;
    const authenticator = this.authenticator;
    this.disposeClientCountSubscription();

    try {
      await bridge?.stop();
    } finally {
      try {
        authenticator?.revokeAll();
      } finally {
        this.clearRuntime();
        this.transitionTo("stopped");
      }
    }
  }

  private transitionTo(state: BridgeManagerState): void {
    if (this.state === state) {
      return;
    }
    this.state = state;
    this.notifyStateListeners();
  }

  private notifyStateListeners(): void {
    for (const listener of [...this.stateListeners]) {
      try {
        listener(this.snapshot());
      } catch {
        // A listener cannot interrupt lifecycle or other listeners.
      }
    }
  }

  private disposeClientCountSubscription(): void {
    const subscription = this.clientCountSubscription;
    this.clientCountSubscription = undefined;
    try {
      subscription?.dispose();
    } catch {
      // Server shutdown and credential revocation must still run.
    }
  }

  private clearRuntime(): void {
    this.bridge = undefined;
    this.authenticator = undefined;
    this.credentials = undefined;
    this.url = undefined;
    this.port = undefined;
    this.pin = undefined;
    this.linkCode = undefined;
    this.bridgeInstanceId = undefined;
    this.linkedBrowserCount = 0;
  }
}

function isAddressInUse(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "EADDRINUSE",
  );
}

function addressInUseError(): NodeJS.ErrnoException {
  const error = new Error("All PinOp managed ports are in use") as NodeJS.ErrnoException;
  error.code = "EADDRINUSE";
  return error;
}
