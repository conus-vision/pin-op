export interface DevtoolsPanelHandle {
  addShownListener(listener: () => void): void;
  removeShownListener(listener: () => void): void;
}

export interface DevtoolsRuntimeOptions {
  readonly inspectedTabId: number;
  readonly channelId: string;
  readonly sourceId: string;
  createPanel(
    title: string,
    icon: string,
    page: string,
  ): Promise<DevtoolsPanelHandle>;
  addRuntimeMessageListener(listener: (message: unknown) => void): () => void;
  sendRuntimeMessage(message: unknown): Promise<unknown>;
  readonly onError?: (error: unknown) => void;
}

export interface DevtoolsAdapterRuntimeOptions {
  readonly inspectedTabId: number;
  readonly sourcePrefix: string;
  readonly createId: () => string;
  readonly createPanel: DevtoolsRuntimeOptions["createPanel"];
  readonly subscribeRuntimeMessages: (
    listener: (message: unknown) => void,
  ) => () => void;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly subscribeUnload: (listener: () => void) => () => void;
  readonly onError?: (error: unknown) => void;
}

export interface DevtoolsAdapterRuntime {
  readonly ready: Promise<void>;
  dispose(): void;
}

export async function registerDevtoolsPanel(
  options: DevtoolsRuntimeOptions,
): Promise<{ dispose(): void }> {
  assertRegistrationOptions(options);
  const announce = async (): Promise<void> => {
    await options.sendRuntimeMessage({
      type: "pin-op.registerDevtools",
      channel: options.channelId,
      tabId: options.inspectedTabId,
      sourceId: options.sourceId,
    });
  };
  const onShown = (): void => {
    void announce().catch((error) => reportError(options, error));
  };
  const removeRuntimeListener = options.addRuntimeMessageListener((message) => {
    if (isPanelReadyMessage(message, options.channelId)) {
      void announce().catch((error) => reportError(options, error));
    }
  });
  let panel: DevtoolsPanelHandle;
  try {
    panel = await options.createPanel(
      "Pin-op",
      "/dist/pin-op.svg",
      `/dist/panel.html?channel=${encodeURIComponent(options.channelId)}`,
    );
    panel.addShownListener(onShown);
  } catch (error) {
    removeRuntimeListener();
    throw error;
  }

  try {
    await announce();
  } catch (error) {
    reportError(options, error);
  }

  let disposed = false;

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      panel.removeShownListener(onShown);
      removeRuntimeListener();
    },
  };
}

export function startDevtoolsRuntime(
  options: DevtoolsAdapterRuntimeOptions,
): DevtoolsAdapterRuntime {
  const channelId = options.createId();
  const sourceId = `${options.sourcePrefix}-${options.createId()}`;
  let disposed = false;
  let registration: { dispose(): void } | undefined;
  let removeUnload: (() => void) | undefined;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    const remove = removeUnload;
    removeUnload = undefined;
    remove?.();
    registration?.dispose();
    registration = undefined;
  };
  const unloadSubscription = options.subscribeUnload(dispose);
  if (disposed) {
    unloadSubscription();
  } else {
    removeUnload = unloadSubscription;
  }

  const ready = registerDevtoolsPanel({
    inspectedTabId: options.inspectedTabId,
    channelId,
    sourceId,
    createPanel: options.createPanel,
    addRuntimeMessageListener: options.subscribeRuntimeMessages,
    sendRuntimeMessage: options.sendRuntimeMessage,
    onError: options.onError,
  }).then(
    (created) => {
      if (disposed) {
        created.dispose();
      } else {
        registration = created;
      }
    },
    (error) => reportAdapterError(options, error),
  );

  return { ready, dispose };
}

function assertRegistrationOptions(options: DevtoolsRuntimeOptions): void {
  if (
    !Number.isSafeInteger(options.inspectedTabId) ||
    options.inspectedTabId < 0 ||
    !isIdentifier(options.channelId) ||
    !isIdentifier(options.sourceId)
  ) {
    throw new Error("Invalid DevTools panel registration");
  }
}

function isPanelReadyMessage(value: unknown, channel: string): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.type === "pin-op.panelReady" &&
    value.channel === channel
  );
}

function isIdentifier(value: string): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function reportError(
  options: DevtoolsRuntimeOptions,
  error: unknown,
): void {
  try {
    options.onError?.(error);
  } catch {
    // Error reporting cannot break panel registration recovery.
  }
}

function reportAdapterError(
  options: DevtoolsAdapterRuntimeOptions,
  error: unknown,
): void {
  try {
    options.onError?.(error);
  } catch {
    // Error reporting cannot break adapter startup.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
