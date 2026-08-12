import type { BridgeClientOptions } from "./bridgeClient.js";
import type {
  BridgeSnapshot,
  IdeCredentials,
} from "./bridgeManager.js";

interface DisposableLike {
  dispose(): void;
}

export interface RuntimeManagerLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): BridgeSnapshot;
  getIdeCredentials(): IdeCredentials | undefined;
  onStateChanged(
    listener: (snapshot: BridgeSnapshot) => void,
  ): DisposableLike;
}

export interface RuntimeStatusLike {
  render(snapshot: BridgeSnapshot): void;
  dispose(): void;
}

export interface RuntimeClientLike {
  connect(): void;
  dispose(): void;
}

export interface ExtensionRuntimeControllerOptions {
  readonly manager: RuntimeManagerLike;
  readonly status: RuntimeStatusLike;
  readonly createClient: (options: BridgeClientOptions) => RuntimeClientLike;
  readonly writeClipboard: (value: string) => PromiseLike<unknown>;
  readonly showInformationMessage: (message: string) => PromiseLike<unknown>;
  readonly showWarningMessage: (message: string) => PromiseLike<unknown>;
}

export class ExtensionRuntimeController {
  private readonly stateSubscription: DisposableLike;
  private client: RuntimeClientLike | undefined;
  private operationTail: Promise<void> = Promise.resolve();
  private disposePromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: ExtensionRuntimeControllerOptions) {
    options.status.render(options.manager.snapshot());
    this.stateSubscription = options.manager.onStateChanged((snapshot) => {
      options.status.render(snapshot);
    });
  }

  start(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    return this.enqueue(() => this.startNow());
  }

  stop(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    return this.enqueue(() => this.stopNow());
  }

  async copyLinkCode(): Promise<void> {
    const snapshot = this.options.manager.snapshot();
    if (snapshot.state !== "running" || !snapshot.linkCode) {
      await this.options.showWarningMessage("PinOp is not running.");
      return;
    }

    await this.options.writeClipboard(snapshot.linkCode);
    await this.options.showInformationMessage(
      "PinOp link code copied.",
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    this.disposed = true;
    const operation = this.enqueue(() => this.stopNow());
    this.disposePromise = operation.finally(() => {
      this.stateSubscription.dispose();
      this.options.status.dispose();
    });
    return this.disposePromise;
  }

  private async startNow(): Promise<void> {
    if (this.disposed || this.client) {
      return;
    }

    await this.options.manager.start();
    if (this.disposed) {
      await this.options.manager.stop();
      return;
    }

    const snapshot = this.options.manager.snapshot();
    const credentials = this.options.manager.getIdeCredentials();
    if (!snapshot.url || !credentials) {
      await this.options.manager.stop();
      throw new Error("PinOp bridge did not provide IDE credentials");
    }

    let nextClient: RuntimeClientLike | undefined;
    try {
      nextClient = this.options.createClient({
        url: snapshot.url,
        sessionId: credentials.sessionId,
        bridgeInstanceId: credentials.bridgeInstanceId,
        authToken: credentials.authToken,
      });
      this.client = nextClient;
      nextClient.connect();
    } catch (error) {
      nextClient?.dispose();
      this.client = undefined;
      await this.options.manager.stop().catch(() => undefined);
      throw error;
    }
  }

  private async stopNow(): Promise<void> {
    this.disposeClient();
    if (this.options.manager.snapshot().state === "stopped") {
      return;
    }
    await this.options.manager.stop();
  }

  private disposeClient(): void {
    const client = this.client;
    this.client = undefined;
    client?.dispose();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.operationTail.then(operation);
    this.operationTail = queued.catch(() => undefined);
    return queued;
  }
}

export interface RuntimeCommandHost {
  registerCommand(command: string, callback: () => unknown): DisposableLike;
  reportError(error: unknown): void;
}

export function registerRuntimeCommands(
  host: RuntimeCommandHost,
  controller: Pick<
    ExtensionRuntimeController,
    "start" | "stop" | "copyLinkCode"
  >,
): DisposableLike {
  const registrations = [
    host.registerCommand("pinop.start", () =>
      runCommand(() => controller.start(), host.reportError),
    ),
    host.registerCommand("pinop.stop", () =>
      runCommand(() => controller.stop(), host.reportError),
    ),
    host.registerCommand("pinop.copyLinkCode", () =>
      runCommand(() => controller.copyLinkCode(), host.reportError),
    ),
  ];
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const registration of registrations) {
        registration.dispose();
      }
    },
  };
}

async function runCommand(
  command: () => Promise<void>,
  reportError: (error: unknown) => void,
): Promise<void> {
  try {
    await command();
  } catch (error) {
    reportError(error);
  }
}
