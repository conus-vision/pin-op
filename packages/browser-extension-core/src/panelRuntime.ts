import {
  createPanelIcons,
  PanelController,
  type PanelCommand,
} from "./panelController.js";
import { DomTreeController } from "./domTreeController.js";
import { parseDomEvent } from "./domProtocol.js";
import { DomTreeView, type DomTreeDocument } from "./domTreeView.js";
import { PanelInspectController } from "./panelInspectController.js";
import { PanelInspectTransport } from "./panelInspectTransport.js";
import { DomPanelView, type PanelDocument } from "./panelView.js";
import {
  createDevtoolsPanelPortName,
  isValidDevtoolsChannel,
  parseInspectPortInvalidated,
  type PanelInspectPort,
} from "./inspectPortProtocol.js";

export interface PanelRuntimeOptions {
  readonly locationSearch: string;
  readonly document: PanelDocument & DomTreeDocument;
  readonly connectRuntimePort: (name: string) => PanelInspectPort;
  readonly sendRuntimeMessage: (message: unknown) => Promise<unknown>;
  readonly readClipboard: () => Promise<string>;
  readonly subscribeUnload: (listener: () => void) => () => void;
  readonly initializeIcons?: () => void;
  readonly onError?: (error: unknown) => void;
}

export interface PanelRuntime {
  readonly ready: Promise<void>;
  readonly closed: Promise<void>;
  dispose(): void;
}

export function startPanelRuntime(options: PanelRuntimeOptions): PanelRuntime {
  const channel = new URLSearchParams(options.locationSearch).get("channel") ?? "";
  if (!isValidDevtoolsChannel(channel)) {
    throw new Error("Invalid DevTools panel channel");
  }
  const reportError = (error: unknown): void => {
    try {
      options.onError?.(error);
    } catch {
      // Diagnostics cannot break panel ownership.
    }
  };
  const view = new DomPanelView(options.document, reportError);
  const stateListeners = new Set<(message: unknown) => void | Promise<void>>();
  let disposed = false;
  let recovery: Promise<void> | undefined;
  let removeUnload: (() => void) | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closePromise: Promise<void> | undefined;
  let controller: PanelController;
  let treeController: DomTreeController;
  let treeSessionActive = false;

  const inspectTransport = new PanelInspectTransport(
    () => options.connectRuntimePort(createDevtoolsPanelPortName(channel)),
    () => {
      deactivateTreeSession();
      void controller.handleTransportDisconnect().catch(reportError);
      void ensurePanelPort();
    },
    (message) => routePanelMessage(message),
  );
  treeController = new DomTreeController({
    transport: {
      request: (request) => inspectTransport.requestDom(request),
      dispatch: (request) => inspectTransport.dispatchDom(request),
      cancelPending: (reason) => inspectTransport.cancelDomRequests(reason),
    },
    onError: reportError,
  });
  const treeView = new DomTreeView({
    document: options.document,
    controller: treeController,
    onError: reportError,
  });
  const inspectController = new PanelInspectController((message) =>
    inspectTransport.send(message),
  );
  controller = new PanelController({
    channel,
    view,
    inspectController,
    readClipboard: options.readClipboard,
    sendCommand: sendPanelCommand,
    subscribeWindowState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
  });

  function ensurePanelPort(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (recovery) {
      return recovery;
    }
    const pending = options
      .sendRuntimeMessage({
        type: "browser2ide.panelReady",
        channel,
      })
      .then(() => {
        if (!disposed) {
          inspectTransport.connect();
        }
      })
      .catch(async (error) => {
        reportError(error);
        await controller.handleTransportDisconnect();
      });
    let tracked: Promise<void>;
    tracked = pending.finally(() => {
      if (recovery === tracked) {
        recovery = undefined;
      }
    });
    recovery = tracked;
    return tracked;
  }

  function routePanelMessage(message: unknown): void {
    const domEvent = validatedDomEvent(message);
    if (domEvent) {
      treeController.handleEvent(domEvent);
    } else if (
      isWindowState(message, "linked") ||
      isWindowState(message, "offline") ||
      isWindowState(message, "reconnecting")
    ) {
      treeSessionActive = true;
      void treeController.loadRoot();
    } else if (parseInspectPortInvalidated(message)) {
      const shouldRecover = treeSessionActive;
      treeController.reset();
      if (shouldRecover) {
        queueMicrotask(() => {
          if (!disposed && treeSessionActive) {
            void treeController.loadRoot();
          }
        });
      }
    } else if (
      isWindowState(message, "notLinked") ||
      isWindowState(message, "linking") ||
      isWindowState(message, "rateLimited") ||
      isWindowState(message, "error")
    ) {
      deactivateTreeSession();
    }
    for (const listener of [...stateListeners]) {
      void Promise.resolve(listener(message)).catch(reportError);
    }
  }

  async function sendPanelCommand(message: PanelCommand): Promise<unknown> {
    deactivateTreeSession();
    return options.sendRuntimeMessage(message);
  }

  function deactivateTreeSession(): void {
    treeSessionActive = false;
    treeController.reset();
  }

  function dispose(): void {
    if (closePromise) {
      return;
    }
    disposed = true;
    const remove = removeUnload;
    removeUnload = undefined;
    remove?.();
    stateListeners.clear();
    treeView.dispose();
    treeController.dispose();
    closePromise = controller
      .dispose()
      .catch(reportError)
      .finally(resolveClosed);
    inspectTransport.dispose();
  }

  const unloadSubscription = options.subscribeUnload(dispose);
  if (disposed) {
    unloadSubscription();
  } else {
    removeUnload = unloadSubscription;
  }

  const ready = Promise.resolve()
    .then(() => {
      try {
        (options.initializeIcons ?? createPanelIcons)();
      } catch (error) {
        reportError(error);
      }
    })
    .then(() => controller.initialize())
    .then(ensurePanelPort)
    .catch(reportError);

  return { ready, closed, dispose };
}

function validatedDomEvent(message: unknown) {
  try {
    return parseDomEvent(message);
  } catch {
    return undefined;
  }
}

function isWindowState(message: unknown, state: string): boolean {
  return Boolean(
    message &&
    typeof message === "object" &&
    (message as Record<string, unknown>).type === "browser2ide.windowState" &&
    (message as Record<string, unknown>).state === state,
  );
}
