import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import postcss from "postcss";
import ts from "typescript";
import {
  assertBrowserPackageRuntimeContract,
  TRUSTED_ZOD_V3_BUNDLE_PROVENANCE,
} from "../../tools/browser-package-contract.mjs";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

type Listener = (...args: unknown[]) => unknown;

export interface BrowserAdapterContractOptions {
  readonly platformName: string;
  readonly extensionOrigin: string;
  readonly sourcePrefix: string;
  readonly extensionRoot: URL;
  readonly importBackground: () => Promise<unknown>;
  readonly importContentScript: () => Promise<unknown>;
  readonly importDevtools: () => Promise<unknown>;
  readonly importPanel: () => Promise<unknown>;
  readonly importInspectorPanel: () => Promise<unknown>;
  readonly expectedMatchedStylesRequestType: "styles.getMatched";
}

export interface BrowserPackageContractOptions {
  readonly platformName: string;
  readonly extensionRoot: URL;
  readonly buildTarget: string;
  readonly expectedInspectorAssets: readonly string[];
  readonly expectedInspectorBundleMarkers: readonly string[];
  readonly expectedChromiumCssScope: ".pin-op-elements-inspector";
  readonly expectedNoticePackages: readonly string[];
}

export function createBrowserAdapterHarness() {
  const event = () => ({
    addListener: vi.fn<(listener: Listener) => void>(),
    removeListener: vi.fn<(listener: Listener) => void>(),
  });
  const runtimeMessage = event();
  const runtimeConnect = event();
  const windowRemoved = event();
  const tabDetached = event();
  const tabAttached = event();
  const tabActivated = event();
  const tabRemoved = event();
  const tabUpdated = event();
  const panelShown = event();
  const runtimeOrigin = { value: "" };
  const runtimePort = {
    name: "pin-op.devtools.test-channel",
    onMessage: event(),
    onDisconnect: event(),
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  };

  return {
    starts: {
      background: vi.fn(() => ({ dispose: vi.fn() })),
      contentScript: vi.fn(() => ({ dispose: vi.fn() })),
      contentRefresh: vi.fn(() => ({ dispose: vi.fn() })),
      devtools: vi.fn(() => ({ dispose: vi.fn() })),
      panel: vi.fn(() => ({ dispose: vi.fn() })),
      inspectorPanel: vi.fn(() => ({ dispose: vi.fn() })),
    },
    sanitize: vi.fn((_error: unknown) => "sanitized error"),
    runtimeMessage,
    runtimeConnect,
    windowRemoved,
    tabDetached,
    tabAttached,
    tabActivated,
    tabRemoved,
    tabUpdated,
    panelShown,
    runtimeOrigin,
    runtimePort,
    browser: {
      scripting: {
        executeScript: vi.fn(async (_details: unknown) => []),
      },
      tabs: {
        query: vi.fn(async (_query: unknown) => [{ id: 91, windowId: 17 }]),
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          windowId: 17,
          title: "must not cross the adapter",
        })),
        sendMessage: vi.fn(async (
          _tabId: number,
          _message: unknown,
          _options?: unknown,
        ) => undefined),
        reload: vi.fn(async (_tabId: number) => undefined),
        onDetached: tabDetached,
        onAttached: tabAttached,
        onActivated: tabActivated,
        onRemoved: tabRemoved,
        onUpdated: tabUpdated,
      },
      storage: {
        session: {
          get: vi.fn(async (_key: string) => ({})),
          set: vi.fn(async (_values: Record<string, unknown>) => undefined),
          remove: vi.fn(async (_key: string) => undefined),
        },
      },
      runtime: {
        getURL: vi.fn((path: string) => `${runtimeOrigin.value}/${path}`),
        sendMessage: vi.fn(async (_message: unknown) => undefined),
        connect: vi.fn((_options: { name: string }) => runtimePort),
        onMessage: runtimeMessage,
        onConnect: runtimeConnect,
      },
      windows: {
        onRemoved: windowRemoved,
      },
      devtools: {
        inspectedWindow: { tabId: 91 },
        panels: {
          create: vi.fn(async () => ({ onShown: panelShown })),
        },
      },
    },
  };
}

export type BrowserAdapterHarness = ReturnType<
  typeof createBrowserAdapterHarness
>;

export function describeBrowserAdapterContract(
  contract: BrowserAdapterContractOptions,
  harness: BrowserAdapterHarness,
): void {
  describe(`${contract.platformName} platform adapters`, () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.resetModules();
      vi.clearAllMocks();
      harness.runtimeOrigin.value = contract.extensionOrigin;
      consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      installBrowserGlobals();
    });

    afterEach(() => {
      consoleError.mockRestore();
      delete (
        globalThis as typeof globalThis & {
          __pinOpContentScript?: unknown;
        }
      ).__pinOpContentScript;
      vi.unstubAllGlobals();
    });

    it("starts the shared background runtime through narrow wrappers", async () => {
      await contract.importBackground();

      expect(harness.starts.background).toHaveBeenCalledOnce();
      const options = calledOptions(harness.starts.background);
      expectOptionKeys(options, [
        "executeScript",
        "expectedDevtoolsUrl",
        "expectedPanelUrl",
        "getActiveTabId",
        "getTab",
        "onError",
        "reloadTab",
        "sendTabMessage",
        "sendTopFrameMessage",
        "storage",
        "subscribeRuntimeMessages",
        "subscribeRuntimePorts",
        "subscribeTabActivated",
        "subscribeTabAttached",
        "subscribeTabDetached",
        "subscribeTabRemoved",
        "subscribeTabUpdated",
        "subscribeWindowRemoved",
      ]);
      expect(options.expectedDevtoolsUrl).toBe(
        `${contract.extensionOrigin}/dist/devtools.html`,
      );
      expect(options.expectedPanelUrl).toBe(
        `${contract.extensionOrigin}/dist/panel.html`,
      );

      const storage = options.storage as Record<string, unknown>;
      await callAsync(storage.get, "window-link.17");
      await callAsync(storage.set, { "window-link.17": { port: 48735 } });
      await callAsync(storage.remove, "window-link.17");
      expect(harness.browser.storage.session.get).toHaveBeenCalledWith(
        "window-link.17",
      );
      expect(harness.browser.storage.session.set).toHaveBeenCalledWith({
        "window-link.17": { port: 48735 },
      });
      expect(harness.browser.storage.session.remove).toHaveBeenCalledWith(
        "window-link.17",
      );

      await callAsync(options.executeScript, {
        target: { tabId: 91 },
        files: ["dist/contentScript.js"],
      });
      await callAsync(options.sendTabMessage, 91, { type: "enableInspectMode" });
      await callAsync(options.sendTopFrameMessage, 91, {
        type: "pin-op.refresh.content.execute",
      });
      expect(harness.browser.tabs.sendMessage).toHaveBeenLastCalledWith(
        91,
        { type: "pin-op.refresh.content.execute" },
        { frameId: 0 },
      );
      await callAsync(options.reloadTab, 91);
      expect(harness.browser.tabs.reload).toHaveBeenCalledWith(91);
      await expect(callAsync(options.getTab, 91)).resolves.toEqual({
        id: 91,
        windowId: 17,
      });
      await expect(callAsync(options.getActiveTabId, 17)).resolves.toBe(91);
      expect(harness.browser.tabs.query).toHaveBeenCalledWith({
        active: true,
        windowId: 17,
      });

      const runtimeListener = vi.fn();
      const removeRuntime = call(
        options.subscribeRuntimeMessages,
        runtimeListener,
      );
      const wrappedRuntime = lastRegistered(harness.runtimeMessage);
      const registration = { type: "pin-op.registerDevtools" };
      await callAsync(wrappedRuntime, registration, {
        url: `${contract.extensionOrigin}/dist/devtools.html`,
        tab: { id: 91, windowId: 17, title: "not forwarded" },
        frameId: 0,
      });
      expect(runtimeListener).toHaveBeenCalledWith(registration, {
        url: `${contract.extensionOrigin}/dist/devtools.html`,
        tab: { id: 91, windowId: 17 },
        frameId: 0,
      });
      call(removeRuntime);
      expect(harness.runtimeMessage.removeListener).toHaveBeenCalledWith(
        wrappedRuntime,
      );

      const portListener = vi.fn();
      const removePorts = call(options.subscribeRuntimePorts, portListener);
      const removeWindows = call(options.subscribeWindowRemoved, vi.fn());
      const detachedListener = vi.fn();
      const attachedListener = vi.fn();
      const removeDetached = call(
        options.subscribeTabDetached,
        detachedListener,
      );
      const removeAttached = call(
        options.subscribeTabAttached,
        attachedListener,
      );
      const activatedListener = vi.fn();
      const removedListener = vi.fn();
      const updatedListener = vi.fn();
      const removeActivated = call(
        options.subscribeTabActivated,
        activatedListener,
      );
      const removeRemoved = call(options.subscribeTabRemoved, removedListener);
      const removeUpdated = call(options.subscribeTabUpdated, updatedListener);
      const wrappedPort = lastRegistered(harness.runtimeConnect);
      call(wrappedPort, harness.runtimePort);
      expect(portListener).toHaveBeenCalledWith(harness.runtimePort);
      call(lastRegistered(harness.tabDetached), 91, {
        oldWindowId: 17,
        oldPosition: 2,
      });
      call(lastRegistered(harness.tabAttached), 91, {
        newWindowId: 23,
        newPosition: 4,
      });
      expect(detachedListener).toHaveBeenCalledWith(91, 17);
      expect(attachedListener).toHaveBeenCalledWith(91, 23);
      call(lastRegistered(harness.tabActivated), {
        tabId: 91,
        windowId: 17,
      });
      call(lastRegistered(harness.tabRemoved), 91, {
        windowId: 17,
        isWindowClosing: false,
      });
      call(
        lastRegistered(harness.tabUpdated),
        91,
        { status: "complete", url: "https://example.test/next", title: "drop" },
        { id: 91, windowId: 17, title: "drop" },
      );
      expect(activatedListener).toHaveBeenCalledWith(91, 17);
      expect(removedListener).toHaveBeenCalledWith(91);
      expect(updatedListener).toHaveBeenCalledWith(91, {
        status: "complete",
        url: "https://example.test/next",
        windowId: 17,
      });
      updatedListener.mockClear();
      call(
        lastRegistered(harness.tabUpdated),
        91,
        { status: "complete" },
        {
          id: 91,
          windowId: 17,
          url: "https://example.test/reloaded",
          title: "drop",
        },
      );
      expect(updatedListener).toHaveBeenCalledWith(91, {
        status: "complete",
        url: "https://example.test/reloaded",
        windowId: 17,
      });
      call(removePorts);
      call(removeWindows);
      call(removeDetached);
      call(removeAttached);
      call(removeActivated);
      call(removeRemoved);
      call(removeUpdated);
      expect(harness.runtimeConnect.removeListener).toHaveBeenCalledWith(
        wrappedPort,
      );
      expect(harness.windowRemoved.removeListener).toHaveBeenCalledOnce();
      expect(harness.tabDetached.removeListener).toHaveBeenCalledWith(
        lastRegistered(harness.tabDetached),
      );
      expect(harness.tabAttached.removeListener).toHaveBeenCalledWith(
        lastRegistered(harness.tabAttached),
      );
      expect(harness.tabActivated.removeListener).toHaveBeenCalledWith(
        lastRegistered(harness.tabActivated),
      );
      expect(harness.tabRemoved.removeListener).toHaveBeenCalledWith(
        lastRegistered(harness.tabRemoved),
      );
      expect(harness.tabUpdated.removeListener).toHaveBeenCalledWith(
        lastRegistered(harness.tabUpdated),
      );

      const secret = new Error("secret background stack");
      call(options.onError, secret);
      expectSanitizedLog(consoleError, "background", secret, harness);
    });

    it("fails closed when active-tab lookup is missing or ambiguous", async () => {
      await contract.importBackground();
      const options = calledOptions(harness.starts.background);

      for (const tabs of [
        [],
        [{ windowId: 17 }],
        [{ id: -1, windowId: 17 }],
        [{ id: 91, windowId: 17 }, { id: 92, windowId: 17 }],
      ]) {
        harness.browser.tabs.query.mockResolvedValueOnce(tabs as never);
        await expect(callAsync(options.getActiveTabId, 17)).resolves.toBeUndefined();
      }
    });

    it("starts the shared content runtime through narrow wrappers", async () => {
      const options = await loadContentOptions(contract, harness);

      expect(harness.starts.contentRefresh).toHaveBeenCalledOnce();
      expect(harness.starts.contentRefresh.mock.invocationCallOrder[0]).toBeLessThan(
        harness.starts.contentScript.mock.invocationCallOrder[0] ?? Infinity,
      );
      const refreshOptions = calledOptions(harness.starts.contentRefresh);

      expectOptionKeys(options, [
        "connectRuntimePort",
        "document",
        "globalScope",
        "location",
        "onError",
        "sendRuntimeMessage",
        "subscribeRuntimeMessages",
      ]);
      expectOptionKeys(refreshOptions, [
        "document",
        "globalScope",
        "location",
        "onError",
        "sendRuntimeMessage",
        "subscribeRuntimeMessages",
        "view",
      ]);
      expect(refreshOptions.view).toBe(globalThis.window);
      expect(options).not.toHaveProperty("createPageInspectionSession");
      expect(options.document).toBe(globalThis.document);
      expect(options.location).toBe(globalThis.location);
      expect(options.globalScope).toBe(globalThis);

      call(options.connectRuntimePort, "pin-op.inspect.contentLease");
      expect(harness.browser.runtime.connect).toHaveBeenCalledWith({
        name: "pin-op.inspect.contentLease",
      });
      await callAsync(options.sendRuntimeMessage, { type: "elementSelected" });
      expect(harness.browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "elementSelected",
      });

      const secret = new Error("secret content stack");
      call(options.onError, secret);
      expectSanitizedLog(consoleError, "content script", secret, harness);
    });

    it("normalizes a synchronous content response to a Promise", async () => {
      const options = await loadContentOptions(contract, harness);
      const response = { type: "dom.root.result" };
      const { wrapped } = subscribeContent(
        options,
        vi.fn(() => response),
        harness,
      );

      const wrappedResponse = call(wrapped, { type: "dom.getRoot" });

      expect(wrappedResponse).toBeInstanceOf(Promise);
      await expect(wrappedResponse).resolves.toBe(response);
    });

    it("preserves a Promise content response", async () => {
      const options = await loadContentOptions(contract, harness);
      const response = Promise.resolve({ type: "dom.children.result" });
      const { wrapped } = subscribeContent(
        options,
        vi.fn(() => response),
        harness,
      );

      const wrappedResponse = call(wrapped, { type: "dom.getChildren" });

      expect(wrappedResponse).toBe(response);
      await expect(wrappedResponse).resolves.toEqual({
        type: "dom.children.result",
      });
    });

    it("preserves undefined for an unhandled content message", async () => {
      const options = await loadContentOptions(contract, harness);
      const listener = vi.fn(() => undefined);
      const { wrapped } = subscribeContent(options, listener, harness);

      const wrappedResponse = call(wrapped, { type: "not-handled" });

      expect(wrappedResponse).toBeUndefined();
      expect(listener).toHaveBeenCalledWith({ type: "not-handled" });
    });

    it("preserves a synchronously thrown content handler error", async () => {
      const options = await loadContentOptions(contract, harness);
      const error = new Error("content handler failed");
      const { wrapped } = subscribeContent(
        options,
        vi.fn(() => {
          throw error;
        }),
        harness,
      );

      expect(() => call(wrapped, { type: "dom.getRoot" })).toThrow(error);
    });

    it("preserves a rejected content handler response", async () => {
      const options = await loadContentOptions(contract, harness);
      const error = new Error("content handler rejected");
      const response = Promise.reject(error);
      const { wrapped } = subscribeContent(
        options,
        vi.fn(() => response),
        harness,
      );

      const wrappedResponse = call(wrapped, { type: "dom.getRoot" });

      expect(wrappedResponse).toBe(response);
      await expect(wrappedResponse).rejects.toBe(error);
    });

    it("removes the exact registered content wrapper", async () => {
      const options = await loadContentOptions(contract, harness);
      const { remove, wrapped } = subscribeContent(
        options,
        vi.fn(),
        harness,
      );

      call(remove);

      expect(harness.runtimeMessage.removeListener).toHaveBeenCalledOnce();
      expect(harness.runtimeMessage.removeListener).toHaveBeenCalledWith(wrapped);
    });

    it("starts the shared DevTools runtime through narrow wrappers", async () => {
      await contract.importDevtools();

      expect(harness.starts.devtools).toHaveBeenCalledOnce();
      const options = calledOptions(harness.starts.devtools);
      expectOptionKeys(options, [
        "createId",
        "createPanel",
        "inspectedTabId",
        "onError",
        "panelPage",
        "sendRuntimeMessage",
        "sourcePrefix",
        "subscribeRuntimeMessages",
        "subscribeUnload",
      ]);
      expect(options.inspectedTabId).toBe(91);
      expect(options.sourcePrefix).toBe(contract.sourcePrefix);
      expect(options.panelPage).toBe("/dist/panel.html");
      expect(call(options.createId)).toBe("test-runtime-id");

      const panel = (await callAsync(
        options.createPanel,
        "Pin-op",
        "/dist/pin-op.svg",
        "/dist/panel.html?channel=test",
      )) as Record<string, unknown>;
      const shownListener = vi.fn();
      call(panel.addShownListener, shownListener);
      call(panel.removeShownListener, shownListener);
      expect(harness.panelShown.addListener).toHaveBeenCalledWith(shownListener);
      expect(harness.panelShown.removeListener).toHaveBeenCalledWith(shownListener);
      await callAsync(options.sendRuntimeMessage, { type: "panelReady" });
      expect(harness.browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "panelReady",
      });

      const removeMessages = call(options.subscribeRuntimeMessages, vi.fn());
      const registeredMessage = lastRegistered(harness.runtimeMessage);
      const removeUnload = call(options.subscribeUnload, vi.fn());
      call(removeMessages);
      call(removeUnload);
      expect(harness.runtimeMessage.removeListener).toHaveBeenCalledWith(
        registeredMessage,
      );
      expect(globalEvents.removeEventListener).toHaveBeenCalledWith(
        "unload",
        expect.any(Function),
      );

      const secret = new Error("secret DevTools stack");
      call(options.onError, secret);
      expectSanitizedLog(consoleError, "DevTools", secret, harness);
    });

    it("uses one fixed Inspector page for DevTools registration and background sender authority", async () => {
      vi.stubGlobal("__PIN_OP_PANEL_PAGE__", "/dist/inspector-panel.html");

      await contract.importBackground();
      await contract.importDevtools();

      const background = calledOptions(harness.starts.background);
      const devtools = calledOptions(harness.starts.devtools);
      expect(background.expectedPanelUrl).toBe(
        `${contract.extensionOrigin}/dist/inspector-panel.html`,
      );
      expect(devtools.panelPage).toBe("/dist/inspector-panel.html");
    });

    it("starts the separate Inspector entry through the shared runtime only", async () => {
      await contract.importInspectorPanel();

      expect(harness.starts.inspectorPanel).toHaveBeenCalledOnce();
      expect(harness.starts.panel).not.toHaveBeenCalled();
      const options = calledOptions(harness.starts.inspectorPanel);
      expectOptionKeys(options, [
        "connectRuntimePort",
        "document",
        "locationSearch",
        "onError",
        "readClipboard",
        "sendRuntimeMessage",
        "subscribeUnload",
      ]);

      const matchedStylesModel = readFileSync(
        new URL(
          "../../packages/browser-extension-core/src/matchedStylesModel.ts",
          import.meta.url,
        ),
        "utf8",
      );
      expect(matchedStylesModel).toContain(
        `type: "${contract.expectedMatchedStylesRequestType}"`,
      );
      expect(
        readFileSync(new URL("src/inspectorPanel.ts", contract.extensionRoot), "utf8"),
      ).not.toContain(contract.expectedMatchedStylesRequestType);
    });

    it("starts the shared panel runtime through narrow wrappers", async () => {
      await contract.importPanel();

      expect(harness.starts.panel).toHaveBeenCalledOnce();
      expect(clipboard.readText).not.toHaveBeenCalled();
      const options = calledOptions(harness.starts.panel);
      expectOptionKeys(options, [
        "connectRuntimePort",
        "document",
        "locationSearch",
        "onError",
        "readClipboard",
        "sendRuntimeMessage",
        "subscribeUnload",
      ]);
      expect(options.locationSearch).toBe("?channel=test-channel");
      expect(options.document).toBe(globalThis.document);

      call(options.connectRuntimePort, "pin-op.devtools.test-channel");
      expect(harness.browser.runtime.connect).toHaveBeenCalledWith({
        name: "pin-op.devtools.test-channel",
      });
      await callAsync(options.readClipboard);
      expect(clipboard.readText).toHaveBeenCalledOnce();
      await callAsync(options.sendRuntimeMessage, { type: "panelReady" });
      expect(harness.browser.runtime.sendMessage).toHaveBeenCalledWith({
        type: "panelReady",
      });
      const removeUnload = call(options.subscribeUnload, vi.fn());
      call(removeUnload);
      expect(globalEvents.removeEventListener).toHaveBeenCalledWith(
        "unload",
        expect.any(Function),
      );

      const secret = new Error("secret panel stack");
      call(options.onError, secret);
      expectSanitizedLog(consoleError, "panel", secret, harness);
    });

    it("enforces adapter and shared-runtime module boundaries", () => {
      const sharedSourceDirectory = new URL(
        "../../packages/browser-extension-core/src/",
        import.meta.url,
      );
      for (const name of readdirSync(sharedSourceDirectory)) {
        if (name.endsWith(".ts")) {
          expect(
            platformImportEdges(
              name,
              readFileSync(new URL(name, sharedSourceDirectory), "utf8"),
            ),
          ).toEqual([]);
        }
      }

      for (const name of [
        "background.ts",
        "contentScript.ts",
        "devtools.ts",
        "panel.ts",
        "inspectorPanel.ts",
      ]) {
        const source = readFileSync(
          new URL(`src/${name}`, contract.extensionRoot),
          "utf8",
        );
        expect(
          adapterImportBoundaryViolations(name, source),
        ).toEqual([]);
        expect(
          moduleImportEdges(name, source).some(
            ({ moduleName }) => moduleName === SHARED_RUNTIME_MODULE,
          ),
        ).toBe(true);
        expect(source).not.toContain("dom.resolveLocator");
        expect(source).not.toContain("source.navigate");
        expect(source).not.toContain("source.navigationState");
        expect(source).not.toContain("DomStableLocator");
        expect(source).not.toContain("SourceNavigationController");
      }

      const decoySource = `
        const implementationName = "DomTreeController";
        const importExample = "import { PageOverlay } from './pageOverlay.js'";
        // import { PageInspectionSession } from "./pageInspectionSession.js";
      `;
      expect(adapterImportBoundaryViolations("decoy.ts", decoySource)).toEqual(
        [],
      );

      const forbiddenSource = `
        import { DomTreeController } from "@pin-op/browser-extension-core";
        import { PageOverlay } from "@pin-op/browser-extension-core/pageOverlay.js";
        import type { ResultFormatter } from "./resultFormatter.js";
      `;
      expect(
        adapterImportBoundaryViolations("forbidden.ts", forbiddenSource),
      ).toEqual([
        "forbidden.ts imports unsupported shared symbol DomTreeController",
        "forbidden.ts imports disallowed module @pin-op/browser-extension-core/pageOverlay.js",
        "forbidden.ts imports disallowed module ./resultFormatter.js",
      ]);
    });
  });
}

export function describeBrowserPackageContract(
  contract: BrowserPackageContractOptions,
): void {
  describe(`${contract.platformName} emitted package contract`, () => {
    let packaged: PackagedExtension;

    beforeAll(() => {
      packaged = buildPackagedExtension(contract);
    }, 30_000);

    afterAll(() => {
      packaged?.dispose();
    });

    it.each(["", "attacker", "Inspector"])(
      "rejects panel variant %j before mutating build output",
      (panelVariant) => {
        const workspaceRoot = resolve(
          fileURLToPath(new URL("../../", import.meta.url)),
        );
        const temporaryDirectory = mkdtempSync(
          join(tmpdir(), ".pin-op-panel-variant-"),
        );
        try {
          const buildRoot = stageBrowserExtensionProject(
            workspaceRoot,
            fileURLToPath(contract.extensionRoot),
            temporaryDirectory,
          );
          const output = join(buildRoot, "dist");
          const sentinel = join(output, "sentinel.txt");
          mkdirSync(output, { recursive: true });
          writeFileSync(sentinel, "retained", "utf8");

          expect(() => execFileSync(
            process.execPath,
            [join(buildRoot, "esbuild.mjs")],
            {
              cwd: buildRoot,
              env: { ...process.env, PIN_OP_PANEL_VARIANT: panelVariant },
              stdio: "pipe",
              timeout: 30_000,
            },
          )).toThrow();
          expect(readFileSync(sentinel, "utf8")).toBe("retained");
        } finally {
          rmSync(temporaryDirectory, { recursive: true, force: true });
        }
      },
    );

    it("ships the shared inspector panel from the real package", () => {
      const panel = packagedText(packaged, "dist/panel.html");
      const inspectorPanel = packagedText(packaged, "dist/inspector-panel.html");
      const panelCss = packagedText(packaged, "dist/panel.css");
      const elementsCss = packagedText(packaged, "dist/devtools-elements.css");
      const panelBundle = packagedText(packaged, "dist/panel.js");
      const inspectorPanelBundle = packagedText(packaged, "dist/inspectorPanel.js");

      expect(panel).toBe(sharedAsset("panel.html"));
      expect(inspectorPanel).toBe(sharedAsset("inspector-panel.html"));
      expect(elementsCss).toBe(sharedElementsAsset("devtools-elements.css"));
      expect(inspectorPanel).toContain('./inspectorPanel.js');
      expect(
        [...inspectorPanel.matchAll(
          /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g,
        )].map((match) => match[1]),
      ).toEqual(["./panel.css", "./devtools-elements.css"]);
      expect(inspectorPanelBundle).toContain("inspector-workspace");
      for (const marker of contract.expectedInspectorBundleMarkers) {
        expect(inspectorPanelBundle, marker).toContain(marker);
      }
      expect(panelCss).toBe(sharedAsset("panel.css"));
      expect(packagedBytes(packaged, "dist/pin-op.svg")).toEqual(
        Buffer.from(sharedAsset("pin-op.svg")),
      );
      for (const size of [16, 32, 48, 96, 128]) {
        expect(packagedBytes(packaged, `dist/icons/pin-op-${size}.png`)).toEqual(
          sharedAssetBytes(`icons/pin-op-${size}.png`),
        );
      }
      expect(panel.match(/class="panel-toolbar"/g)).toHaveLength(1);
      expect(openingTag(panel, "dom-tree")).toMatch(/role="tree"/);
      expect(openingTag(panel, "linked-code")).toMatch(/^<output\b/);
      expect(panel).toMatch(
        /id="disconnect-button"[^>]*>\s*Disconnect\s*<\/button>/,
      );
      expect(openingTag(panel, "inspect-mode")).toMatch(
        /aria-label="Select an element"/,
      );
      expect(panel).toContain('data-lucide="mouse-pointer-2"');
      expect(openingTag(panel, "auto-refresh-enabled")).toMatch(
        /type="checkbox"/,
      );
      expect(openingTag(panel, "ide-highlight-enabled")).toMatch(
        /type="checkbox"/,
      );
      expect(panel).toMatch(
        /id="auto-refresh-enabled"[^>]*>[\s\S]*?Auto Refresh\s*<\/label>/,
      );
      expect(panel).toMatch(
        /id="ide-highlight-enabled"[^>]*>[\s\S]*?IDE Highlight\s*<\/label>/,
      );
      for (const id of [
        "connection-status",
        "linked-code",
        "link-controls",
        "link-code",
        "paste-button",
        "link-button",
        "disconnect-button",
      ]) {
        expect(panel.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
      }
      for (const id of [
        "panel-workspace",
        "workspace-tabs",
        "dom-tab",
        "source-tab",
        "dom-pane",
        "pane-separator",
        "source-pane",
        "source-pane-root",
      ]) {
        expect(panel.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
      }
      expect(openingTag(panel, "workspace-tabs")).toMatch(/role="tablist"/);
      expect(openingTag(panel, "dom-tab")).toMatch(/role="tab"/);
      expect(openingTag(panel, "source-tab")).toMatch(/role="tab"/);
      expect(openingTag(panel, "pane-separator")).toMatch(/role="separator"/);
      expect(openingTag(panel, "source-pane-root")).toMatch(
        /aria-label="Source matches"/,
      );
      expect(panel).toContain("Extensions are incompatible");
      expect(panel).toContain(
        "Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.",
      );
      expect(openingTag(panel, "resolution-status")).toMatch(/role="status"/);
      expect(panel).toMatch(
        /<footer\b[^>]*class="panel-footer"[^>]*>[\s\S]*id="resolution-status"[\s\S]*<\/footer>/,
      );
      expect(panel).toContain("source-navigation-footer");
      expect(panel).toContain('id="panel-branding"');
      expect(panel).toContain('href="mailto:info@conus.vision"');
      expect(panel).toContain('href="https://conus.vision"');
      expect(panelCss).toContain(".panel-toolbar-scroll");
      expect(panelCss).toContain('[data-layout="split"]');
      expect(panelCss).toContain('[data-layout="stack"]');
      expect(panelCss).toContain('[data-layout="tabs"]');
      expect(panelCss).toContain(".workspace-pane");
      expect(panelCss).toContain(".source-pane-excerpt");
      expect(panelCss).toContain(".panel-branding");
      expect(panelCss).toContain(".source-navigation-controls");
      for (const marker of [
        "source-presentation",
        "source.matches",
        "source.open",
        "source.navigate",
        "source.navigationState",
        "matchId",
        "dom.resolveLocator",
      ]) {
        expect(panelBundle).toContain(marker);
      }
    });

    it("passes the common runtime contract with the real emitted bundles", () => {
      expect(() => assertBrowserPackageRuntimeContract(
        { files: new Map(packaged.files) },
        {
          artifactLabel: `${contract.platformName} real emitted package`,
          metadataLabel: `${contract.platformName} real emitted metadata`,
          platform: contract.platformName === "Chrome" ? "chrome" : "firefox",
        },
      )).not.toThrow();
    });

    it("hashes the raw emitted legacy bundle bytes used for Zod provenance", () => {
      const browser = contract.platformName === "Chrome" ? "chrome" : "firefox";
      const expected = TRUSTED_ZOD_V3_BUNDLE_PROVENANCE.filter(
        (entry) => entry.browser === browser,
      );
      const actual = expected.map(({ path }) => ({
        browser,
        path,
        sha256: createHash("sha256").update(packagedBytes(packaged, path)).digest("hex"),
      }));

      expect(actual).toEqual(expected.map(({ browser, path, sha256 }) => ({
        browser,
        path,
        sha256,
      })));
      for (const entry of expected) {
        expect(entry.inspectorSha256).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it("rejects byte drift and copied constructor code in a real emitted bundle", () => {
      const path = "dist/background.js";
      const original = packagedBytes(packaged, path);
      const copiedExploit = Buffer.from(
        "\nclass CopiedSchema {" +
        "describe(description) {" +
        "const Constructor = this.constructor;" +
        "return new Constructor({...this._def, description});" +
        "}}" +
        "function LocalFunction() {}" +
        "LocalFunction._def = {" +
        "toString() { return 'return 1'; }" +
        "};" +
        "CopiedSchema.prototype.describe.call(LocalFunction, 'x')();\n",
      );
      const constructorCloneExploit = Buffer.from(
        "\nfunction cloneAttacker(value, parent) {" +
        "const cloned = new value.constructor();" +
        "for (const key in value) cloned[key] = value[key];" +
        "return cloned;" +
        "}\ncloneAttacker({ constructor: Function }, null);\n",
      );

      for (const mutation of [
        Buffer.from(" "),
        copiedExploit,
        constructorCloneExploit,
      ]) {
        const files = new Map(packaged.files);
        files.set(path, Buffer.concat([original, mutation]));
        expect(() => assertBrowserPackageRuntimeContract(
          { files },
          {
            artifactLabel: `${contract.platformName} altered emitted package`,
            metadataLabel: `${contract.platformName} altered emitted metadata`,
            platform: contract.platformName === "Chrome" ? "chrome" : "firefox",
          },
        )).toThrow(/dynamic code evaluation/i);
      }
    });

    it("centralizes browser panel assets and builds dependencies in fixed order", () => {
      const build = readFileSync(
        new URL("esbuild.mjs", contract.extensionRoot),
        "utf8",
      );
      expect(build).toContain("../../tools/browser-panel-assets.mjs");
      expect(build).toContain("copyBrowserPanelAssets");
      expect(build).toContain("assertNoChromiumUpstreamInputs");
      expect(build).toContain("assertNoChromiumUpstreamInputs(result.metafile");

      const manifest = JSON.parse(
        readFileSync(new URL("package.json", contract.extensionRoot), "utf8"),
      ) as { readonly scripts?: Record<string, string> };
      expect(manifest.scripts?.["build:deps"]).toBe(
        "pnpm --filter @pin-op/protocol build && " +
          "pnpm --filter @pin-op/devtools-elements-ui build && " +
          "pnpm --filter @pin-op/browser-extension-core build",
      );
    });

    it("declares the shared browser panel assets in deterministic copy order", async () => {
      const helperUrl = new URL(
        "../../tools/browser-panel-assets.mjs",
        import.meta.url,
      );
      expect(existsSync(fileURLToPath(helperUrl))).toBe(true);
      const helper = await import(helperUrl.href) as {
        readonly BROWSER_PANEL_ASSET_PATHS?: readonly string[];
        readonly assertNoChromiumUpstreamInputs?: (
          metafile: unknown,
          label?: string,
        ) => void;
      };
      expect(helper.BROWSER_PANEL_ASSET_PATHS).toEqual([
        "panel.html",
        "inspector-panel.html",
        "panel.css",
        "devtools-elements.css",
        "pin-op.svg",
        "icons/pin-op-16.png",
        "icons/pin-op-32.png",
        "icons/pin-op-48.png",
        "icons/pin-op-96.png",
        "icons/pin-op-128.png",
      ]);
      expect(typeof helper.assertNoChromiumUpstreamInputs).toBe("function");
      expect(() => helper.assertNoChromiumUpstreamInputs?.({
        inputs: {
          "src/panel.ts": {},
          "../../packages/devtools-elements-ui/src/index.ts": {},
        },
      }, contract.platformName)).not.toThrow();

      for (const resolvedInput of [
        "../../third_party/chromium-devtools-frontend/upstream/front_end/panels/elements/ElementsTreeOutline.ts",
        "..\\..\\third_party\\chromium-devtools-frontend\\upstream\\front_end\\panels\\elements\\ElementsTreeOutline.ts",
      ]) {
        expect(
          () => helper.assertNoChromiumUpstreamInputs?.({
            inputs: {
              "src/reexport.ts": {},
              [resolvedInput]: {},
            },
          }, contract.platformName),
          resolvedInput,
        ).toThrow(/upstream snapshot input/i);
      }
    });

    it("keeps both panel entrypoints free of inline and remote UI resources", () => {
      for (const path of ["dist/panel.html", "dist/inspector-panel.html"]) {
        const html = packagedText(packaged, path);
        expect(html, path).not.toMatch(/<style\b/i);
        expect(html, path).not.toMatch(/\sstyle\s*=/i);
        expect(html, path).not.toMatch(/<script\b(?![^>]*\bsrc=)/i);
        for (const match of html.matchAll(
          /<(?:script|link|img)\b[^>]*\b(?:src|href)="([^"]+)"/gi,
        )) {
          expect(match[1], `${path}: ${match[0]}`).toMatch(/^\.\/[A-Za-z0-9._/-]+$/);
        }
      }
    });

    it("keeps Chromium-derived CSS scoped and upstream snapshots out of production", () => {
      const elementsCss = packagedText(packaged, "dist/devtools-elements.css");
      postcss.parse(elementsCss).walkRules((rule) => {
        for (const selector of rule.selectors) {
          expect(selector.trim(), rule.toString()).toMatch(
            new RegExp(
              `^${contract.expectedChromiumCssScope.replaceAll(".", "\\.")}` +
                "(?:\\b|\\s|\\.|#|:|\\[|>|\\+|~)",
            ),
          );
        }
      });

      const productionSources = [
        ...readProductionSources(new URL("src/", contract.extensionRoot)),
        ...readProductionSources(
          new URL("../../packages/browser-extension-core/src/", import.meta.url),
        ),
        ...readProductionSources(
          new URL("../../packages/devtools-elements-ui/src/", import.meta.url),
        ),
      ].join("\n");
      expect(productionSources).not.toContain(
        "third_party/chromium-devtools-frontend/upstream",
      );
      expect(productionSources).not.toContain(
        "chromium-devtools-frontend/upstream",
      );

      for (const path of ["dist/panel.js", "dist/inspectorPanel.js"]) {
        expect(packagedText(packaged, path), path).not.toMatch(/\beval\s*\(/);
      }
    });

    it("emits exact structured protocol metadata without live marker logic", () => {
      const metadata = JSON.parse(
        packagedText(packaged, "dist/runtime-metadata.json"),
      ) as unknown;
      expect(metadata).toEqual({
        schemaVersion: 1,
        protocolVersion: 6,
      });

      const adapter = readFileSync(
        new URL("src/panel.ts", contract.extensionRoot),
        "utf8",
      );
      expect(adapter).not.toContain("PROTOCOL_VERSION");
      expect(adapter).not.toContain("pin-op.protocolVersion");
      expect(adapter).not.toContain("document.documentElement");
      const sharedRuntime = readFileSync(
        new URL(
          "../../packages/browser-extension-core/src/panelRuntime.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const sharedView = readFileSync(
        new URL(
          "../../packages/browser-extension-core/src/panelView.ts",
          import.meta.url,
        ),
        "utf8",
      );
      expect(sharedRuntime).not.toContain("setProtocolVersionMarker");
      expect(sharedView).not.toContain("setProtocolVersionMarker");
      const build = readFileSync(
        new URL("esbuild.mjs", contract.extensionRoot),
        "utf8",
      );
      expect(build).toContain("PROTOCOL_VERSION");
      expect(build).toContain("serializeRuntimeMetadata(PROTOCOL_VERSION)");
    });

    it("builds and packages without changing checkout artifacts", () => {
      const checkoutRoot = fileURLToPath(contract.extensionRoot);

      expect(packaged.buildRoot).toBeDefined();
      expect(
        packaged.buildRoot && pathIsWithin(packaged.buildRoot, checkoutRoot),
      ).toBe(false);
      expect(packaged.checkoutBefore).toBeDefined();
      expect(packaged.checkoutAfter).toEqual(packaged.checkoutBefore);
    });

    it("packages only the expected runtime surface", () => {
      const paths = [...packaged.files.keys()];
      for (const path of [
        "manifest.json",
        "dist/background.js",
        "dist/contentScript.js",
        "dist/devtools.js",
        "dist/panel.js",
        "dist/devtools.html",
        "dist/panel.html",
        "dist/panel.css",
        ...contract.expectedInspectorAssets,
        "dist/pin-op.svg",
        "dist/icons/pin-op-16.png",
        "dist/icons/pin-op-32.png",
        "dist/icons/pin-op-48.png",
        "dist/icons/pin-op-96.png",
        "dist/icons/pin-op-128.png",
        "dist/runtime-metadata.json",
        "LICENSE",
        "THIRD_PARTY_NOTICES",
      ]) {
        expect(paths).toContain(path);
      }
      expect(paths.some((path) => path.endsWith(".map"))).toBe(false);
      expect(paths.some((path) => /^(?:src|test)\//.test(path))).toBe(false);

      const build = readFileSync(
        new URL("esbuild.mjs", contract.extensionRoot),
        "utf8",
      );
      expect(build).toMatch(
        new RegExp(`target:\\s*(?:\\[\\s*)?["']${contract.buildTarget}["']`),
      );
    });

    it("contains the exact approved manifest permissions and CSP", () => {
      const manifest = JSON.parse(
        packagedText(packaged, "manifest.json"),
      ) as PackagedManifest;

      expect(manifest.permissions).toEqual([
        "activeTab",
        "clipboardRead",
        "scripting",
        "storage",
        "tabs",
      ]);
      expect(manifest.permissions).not.toEqual(
        expect.arrayContaining([
          "webNavigation",
          "debugger",
          "nativeMessaging",
          "unlimitedStorage",
        ]),
      );
      expect(manifest.host_permissions).toEqual([
        "http://localhost/*",
        "http://127.0.0.1/*",
        "<all_urls>",
      ]);
      expect(manifest).not.toHaveProperty("optional_permissions");
      expect(manifest).not.toHaveProperty("optional_host_permissions");
      expect(manifest.content_security_policy.extension_pages).toBe(
        "script-src 'self'; object-src 'none'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
      );
    });

    it("keeps packaged product transport HTTP-free and loopback WebSocket-only", () => {
      const scripts = [
        "dist/background.js",
        "dist/contentScript.js",
        "dist/devtools.js",
        "dist/panel.js",
        "dist/inspectorPanel.js",
      ]
        .map((path) => packagedText(packaged, path))
        .join("\n");

      expect(executableNetworkFetchPrimitives(scripts)).toEqual([]);
      expect(disallowedPackagedHttpUrls(scripts)).toEqual([]);
      expect(scripts).toContain("WebSocket");
      const websocketUrls = scripts.match(/wss?:\/\/[^"'`\s${}]+/g) ?? [];
      expect(websocketUrls.length).toBeGreaterThan(0);
      expect(new Set(websocketUrls)).toEqual(new Set(["ws://127.0.0.1:"]));
    });

    it("checks in the generated runtime dependency notices", () => {
      const emittedNotices = packagedText(packaged, "THIRD_PARTY_NOTICES");
      const checkedInNotices = readFileSync(
        new URL("THIRD_PARTY_NOTICES", contract.extensionRoot),
        "utf8",
      );

      expect(checkedInNotices).toBe(emittedNotices);
      for (const packageName of contract.expectedNoticePackages) {
        expect(emittedNotices).toContain(`## ${packageName}`);
      }
    });

    it("keeps stylesheet inventory CSSOM-only without a network fallback", () => {
      const repositoryRoot = resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../..",
      );
      const stylesheetRuntime = [
        "stylesheetRegistry.ts",
        "stylesheetFingerprint.ts",
        "matchedStylesApplicabilityObserver.ts",
      ].map((fileName) => readFileSync(resolve(
        repositoryRoot,
        "packages/browser-extension-core/src",
        fileName,
      ), "utf8")).join("\n");

      expect(executableNetworkFetchPrimitives(stylesheetRuntime)).toEqual([]);
      expect(stylesheetRuntime).not.toContain("host_permissions");
      expect(stylesheetRuntime).not.toContain("optional_host_permissions");
      expect(executableNetworkFetchPrimitives([
        "const docs = 'https://example.test/postcss-migration';",
        "fetch('https://example.test/inaccessible.css');",
        "globalThis.fetch('/proxied.css');",
        "new XMLHttpRequest();",
      ].join("\n"))).toEqual(["XMLHttpRequest", "fetch"]);
      for (const [primitive, bypass] of [
        ["fetch", "const load = globalThis.fetch; load('/alias.css');"],
        ["fetch", "globalThis.fetch.call(globalThis, '/call.css');"],
        ["fetch", "const load = globalThis['fetch']; load('/computed.css');"],
        ["XMLHttpRequest", "const Request = window.XMLHttpRequest; new Request();"],
      ] as const) {
        expect(executableNetworkFetchPrimitives(bypass), bypass).toContain(primitive);
      }
      expect(disallowedPackagedHttpUrls([
        "// https://comment.example.test/postcss-docs",
        "const svg = 'http://www.w3.org/2000/svg';",
        "const localSelectorBase = 'http://localhost/';",
        "const sentinel = 'https://pin-op.invalid/';",
        "const endpoint = 'https://attacker.example.test/rules.css';",
      ].join("\n"))).toEqual([
        "https://attacker.example.test/rules.css",
      ]);
    });
  });
}

const PACKAGED_HTTP_URL_ALLOWLIST = new Set([
  "http://www.w3.org/2000/svg",
  "http://localhost/",
  "https://pin-op.invalid/",
]);

function disallowedPackagedHttpUrls(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "packaged-url-scan.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && !isConsoleDocumentationLiteral(node)) {
      for (const match of node.text.matchAll(/https?:\/\/[^\s"'`\\<>]+/g)) {
        const candidate = match[0];
        if (!PACKAGED_HTTP_URL_ALLOWLIST.has(candidate)) found.add(candidate);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found].sort();
}

function isConsoleDocumentationLiteral(node: ts.StringLiteralLike): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current)) {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      ts.isIdentifier(current.expression.expression) &&
      current.expression.expression.text === "console" &&
      ["debug", "error", "info", "log", "warn"].includes(
        current.expression.name.text,
      )
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function executableNetworkFetchPrimitives(source: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    "packaged-network-scan.js",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const found = new Set<string>();
  const aliases = new Map<string, "fetch" | "XMLHttpRequest">();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const primitive = globalNetworkFetchPrimitive(node.initializer, aliases);
      if (primitive) aliases.set(node.name.text, primitive);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      const primitive = globalNetworkFetchPrimitive(node.right, aliases);
      if (primitive) aliases.set(node.left.text, primitive);
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const primitive = globalNetworkFetchPrimitive(node.expression, aliases);
      if (primitive) found.add(primitive);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...found].sort();
}

function globalNetworkFetchPrimitive(
  expression: ts.Expression,
  aliases: ReadonlyMap<string, "fetch" | "XMLHttpRequest"> = new Map(),
): "fetch" | "XMLHttpRequest" | undefined {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  ) {
    return globalNetworkFetchPrimitive(expression.expression, aliases);
  }
  if (ts.isIdentifier(expression)) {
    if (expression.text === "fetch" || expression.text === "XMLHttpRequest") {
      return expression.text;
    }
    return aliases.get(expression.text);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    if (
      isGlobalObjectIdentifier(expression.expression) &&
      (expression.name.text === "fetch" || expression.name.text === "XMLHttpRequest")
    ) {
      return expression.name.text;
    }
    if (["apply", "bind", "call"].includes(expression.name.text)) {
      return globalNetworkFetchPrimitive(expression.expression, aliases);
    }
    return undefined;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const name = expression.argumentExpression.text;
    if (
      isGlobalObjectIdentifier(expression.expression) &&
      (name === "fetch" || name === "XMLHttpRequest")
    ) {
      return name;
    }
    if (["apply", "bind", "call"].includes(name)) {
      return globalNetworkFetchPrimitive(expression.expression, aliases);
    }
  }
  return undefined;
}

function isGlobalObjectIdentifier(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) &&
    ["globalThis", "window", "self"].includes(expression.text);
}

const globalEvents = {
  addEventListener: vi.fn<(type: string, listener: Listener) => void>(),
  removeEventListener: vi.fn<(type: string, listener: Listener) => void>(),
};

const clipboard = {
  readText: vi.fn(async () => "4873507"),
};

function installBrowserGlobals(): void {
  globalEvents.addEventListener.mockReset();
  globalEvents.removeEventListener.mockReset();
  clipboard.readText.mockClear();
  const elements = new Map<string, FakeElement>();
  vi.stubGlobal("window", globalEvents);
  vi.stubGlobal("document", {
    styleSheets: [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    getElementById(id: string) {
      const existing = elements.get(id);
      if (existing) {
        return existing;
      }
      const created = new FakeElement();
      elements.set(id, created);
      return created;
    },
  });
  vi.stubGlobal("location", {
    href: "https://example.test/page",
    origin: "https://example.test",
    pathname: "/page",
    search: "?channel=test-channel",
    hash: "",
  });
  vi.stubGlobal("navigator", { clipboard });
  vi.stubGlobal("crypto", { randomUUID: () => "test-runtime-id" });
}

class FakeElement {
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public readonly dataset: Record<string, string> = {};
  public addEventListener(): void {}
  public removeEventListener(): void {}
}

async function loadContentOptions(
  contract: BrowserAdapterContractOptions,
  harness: BrowserAdapterHarness,
): Promise<Record<string, unknown>> {
  await contract.importContentScript();
  expect(harness.starts.contentScript).toHaveBeenCalledOnce();
  return calledOptions(harness.starts.contentScript);
}

function subscribeContent(
  options: Record<string, unknown>,
  listener: Listener,
  harness: BrowserAdapterHarness,
): { readonly remove: unknown; readonly wrapped: Listener } {
  const remove = call(options.subscribeRuntimeMessages, listener);
  return { remove, wrapped: lastRegistered(harness.runtimeMessage) };
}

function calledOptions(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const options = mock.mock.calls[0]?.[0];
  expect(options).toBeDefined();
  return options as Record<string, unknown>;
}

function expectOptionKeys(
  options: Record<string, unknown>,
  expected: readonly string[],
): void {
  expect(Object.keys(options).sort()).toEqual([...expected].sort());
}

function expectSanitizedLog(
  consoleError: ReturnType<typeof vi.spyOn>,
  scope: string,
  secret: Error,
  harness: BrowserAdapterHarness,
): void {
  expect(harness.sanitize).toHaveBeenCalledWith(secret);
  expect(consoleError).toHaveBeenCalledWith(
    expect.stringContaining(scope),
    "sanitized error",
  );
  expect(consoleError.mock.calls.flat()).not.toContain(secret);
}

function lastRegistered(event: {
  readonly addListener: ReturnType<typeof vi.fn>;
}): Listener {
  const listener = event.addListener.mock.calls.at(-1)?.[0];
  expect(listener).toBeTypeOf("function");
  return listener as Listener;
}

function call(value: unknown, ...args: unknown[]): any {
  expect(value).toBeTypeOf("function");
  return (value as (...callArgs: unknown[]) => unknown)(...args);
}

async function callAsync(value: unknown, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(call(value, ...args));
}

interface PackagedExtension {
  readonly files: ReadonlyMap<string, Buffer>;
  readonly buildRoot: string;
  readonly checkoutBefore: CheckoutSnapshot;
  readonly checkoutAfter: CheckoutSnapshot;
  dispose(): void;
}

interface CheckoutSnapshot {
  readonly artifacts: readonly CheckoutArtifact[];
  readonly gitStatus: string;
}

interface CheckoutArtifact {
  readonly path: string;
  readonly kind: "directory" | "file" | "missing";
  readonly mode?: number;
  readonly modifiedAt?: number;
  readonly bytes?: Buffer;
}

interface PackagedManifest {
  readonly permissions: string[];
  readonly host_permissions: string[];
  readonly content_security_policy: {
    readonly extension_pages: string;
  };
}

function buildPackagedExtension(
  contract: BrowserPackageContractOptions,
): PackagedExtension {
  const extensionRoot = fileURLToPath(contract.extensionRoot);
  const workspaceRoot = resolve(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const temporaryBase =
    process.platform === "win32" ? dirname(workspaceRoot) : tmpdir();
  const temporaryDirectory = mkdtempSync(
    join(temporaryBase, `.pin-op-${contract.platformName.toLowerCase()}-`),
  );
  const archiveName = "pin-op-contract.zip";
  const archivePath = join(temporaryDirectory, archiveName);

  try {
    const checkoutBefore = snapshotCheckout(workspaceRoot, extensionRoot);
    const buildRoot = stageBrowserExtensionProject(
      workspaceRoot,
      extensionRoot,
      temporaryDirectory,
    );
    execFileSync(process.execPath, [join(buildRoot, "esbuild.mjs")], {
      cwd: buildRoot,
      stdio: "pipe",
      timeout: 30_000,
    });
    execFileSync(
      process.execPath,
      [
        join(workspaceRoot, "node_modules", "web-ext", "bin", "web-ext.js"),
        "build",
        "--overwrite-dest",
        "--artifacts-dir",
        temporaryDirectory,
        "--filename",
        archiveName,
        "--ignore-files",
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "esbuild.mjs",
        "src",
        "test",
        "src/**",
        "test/**",
      ],
      {
        cwd: buildRoot,
        stdio: "pipe",
        timeout: 30_000,
      },
    );

    const archive = new AdmZip(archivePath);
    const files = new Map<string, Buffer>();
    for (const entry of archive.getEntries()) {
      if (!entry.isDirectory) {
        files.set(entry.entryName, entry.getData());
      }
    }
    return {
      files,
      buildRoot,
      checkoutBefore,
      checkoutAfter: snapshotCheckout(workspaceRoot, extensionRoot),
      dispose: () => rmSync(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function packagedBytes(packaged: PackagedExtension, path: string): Buffer {
  const data = packaged.files.get(path);
  expect(data, `missing packaged path ${path}`).toBeDefined();
  return data ?? Buffer.alloc(0);
}

function packagedText(packaged: PackagedExtension, path: string): string {
  return packagedBytes(packaged, path).toString("utf8");
}

function sharedAsset(name: string): string {
  return readFileSync(
    new URL(`../../packages/browser-extension-core/assets/${name}`, import.meta.url),
    "utf8",
  );
}

function sharedElementsAsset(name: string): string {
  return readFileSync(
    new URL(`../../packages/devtools-elements-ui/assets/${name}`, import.meta.url),
    "utf8",
  );
}

function sharedAssetBytes(name: string): Buffer {
  return readFileSync(
    new URL(`../../packages/browser-extension-core/assets/${name}`, import.meta.url),
  );
}

function readProductionSources(root: URL): string[] {
  const rootPath = fileURLToPath(root);
  const sources: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        visit(child);
      } else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) {
        sources.push(readFileSync(child, "utf8"));
      }
    }
  };
  visit(rootPath);
  return sources;
}

function openingTag(panel: string, id: string): string {
  const match = new RegExp(`<[^>]+\\bid="${id}"[^>]*>`).exec(panel);
  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

const SHARED_RUNTIME_MODULE = "@pin-op/browser-extension-core";
const PLATFORM_API_MODULE = "webextension-polyfill";
const ALLOWED_SHARED_ADAPTER_IMPORTS = new Set([
  "BackgroundMessageSender",
  "BackgroundRuntimePort",
  "ContentInspectPort",
  "ContentScriptDocument",
  "DevtoolsPanelPage",
  "PanelInspectPort",
  "sanitizeErrorMessage",
  "startBackgroundRuntime",
  "startContentScriptRuntime",
  "startContentRefreshBootstrapRuntime",
  "startDevtoolsRuntime",
  "startInspectorPanelRuntime",
  "startPanelRuntime",
]);

interface ModuleImportEdge {
  readonly moduleName: string;
  readonly importedNames: readonly string[];
}

function platformImportEdges(fileName: string, source: string): string[] {
  return moduleImportEdges(fileName, source)
    .filter(
      ({ moduleName }) =>
        moduleName === PLATFORM_API_MODULE ||
        moduleName.startsWith(`${PLATFORM_API_MODULE}/`),
    )
    .map(
      ({ moduleName }) =>
        `${fileName} imports platform API module ${moduleName}`,
    );
}

function adapterImportBoundaryViolations(
  fileName: string,
  source: string,
): string[] {
  const violations: string[] = [];
  for (const edge of moduleImportEdges(fileName, source)) {
    if (edge.moduleName === PLATFORM_API_MODULE) {
      continue;
    }
    if (edge.moduleName === SHARED_RUNTIME_MODULE) {
      for (const importedName of edge.importedNames) {
        if (!ALLOWED_SHARED_ADAPTER_IMPORTS.has(importedName)) {
          violations.push(
            `${fileName} imports unsupported shared symbol ${importedName}`,
          );
        }
      }
      continue;
    }
    violations.push(`${fileName} imports disallowed module ${edge.moduleName}`);
  }
  return violations;
}

function pathIsWithin(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function moduleImportEdges(fileName: string, source: string): ModuleImportEdge[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const edges: ModuleImportEdge[] = [];

  const addEdge = (
    moduleSpecifier: ts.Expression | undefined,
    importedNames: readonly string[],
  ): void => {
    if (moduleSpecifier && ts.isStringLiteralLike(moduleSpecifier)) {
      edges.push({ moduleName: moduleSpecifier.text, importedNames });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      addEdge(node.moduleSpecifier, importClauseNames(node.importClause));
    } else if (ts.isExportDeclaration(node)) {
      addEdge(node.moduleSpecifier, exportClauseNames(node.exportClause));
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      addEdge(node.moduleReference.expression, ["*"]);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteralLike(argument.literal)
      ) {
        addEdge(argument.literal, ["*"]);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        addEdge(node.arguments[0], ["*"]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edges;
}

function importClauseNames(
  clause: ts.ImportClause | undefined,
): readonly string[] {
  if (!clause) {
    return ["<side-effect>"];
  }
  const names: string[] = [];
  if (clause.name) {
    names.push("default");
  }
  if (clause.namedBindings) {
    if (ts.isNamespaceImport(clause.namedBindings)) {
      names.push("*");
    } else {
      names.push(
        ...clause.namedBindings.elements.map(
          (element) => (element.propertyName ?? element.name).text,
        ),
      );
    }
  }
  return names;
}

function exportClauseNames(
  clause: ts.NamedExportBindings | undefined,
): readonly string[] {
  if (!clause || ts.isNamespaceExport(clause)) {
    return ["*"];
  }
  return clause.elements.map(
    (element) => (element.propertyName ?? element.name).text,
  );
}

function stageBrowserExtensionProject(
  workspaceRoot: string,
  extensionRoot: string,
  temporaryDirectory: string,
): string {
  const stagedWorkspace = join(temporaryDirectory, "project");
  const stagedExtensionRoot = join(
    stagedWorkspace,
    "extensions",
    basename(extensionRoot),
  );
  mkdirSync(stagedExtensionRoot, { recursive: true });

  for (const path of [
    "esbuild.mjs",
    "manifest.json",
    "package.json",
    "src",
    "tsconfig.json",
  ]) {
    cpSync(join(extensionRoot, path), join(stagedExtensionRoot, path), {
      recursive: true,
    });
  }
  copyWorkspacePath(workspaceRoot, stagedWorkspace, "LICENSE");
  copyWorkspacePath(workspaceRoot, stagedWorkspace, "tsconfig.base.json");
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("tools", "browser-bundle-notices.mjs"),
  );
  const panelAssetsHelper = join("tools", "browser-panel-assets.mjs");
  if (existsSync(join(workspaceRoot, panelAssetsHelper))) {
    copyWorkspacePath(workspaceRoot, stagedWorkspace, panelAssetsHelper);
  }
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("tools", "runtime-metadata.mjs"),
  );
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("third_party", "chromium-devtools-frontend", "UPSTREAM.json"),
  );
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("third_party", "chromium-devtools-frontend", "LICENSE"),
  );
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("packages", "browser-extension-core", "assets"),
  );
  copyWorkspacePath(
    workspaceRoot,
    stagedWorkspace,
    join("packages", "devtools-elements-ui", "assets"),
  );
  symlinkSync(
    join(workspaceRoot, "node_modules"),
    join(temporaryDirectory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  symlinkSync(
    join(extensionRoot, "node_modules"),
    join(stagedExtensionRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  return stagedExtensionRoot;
}

function copyWorkspacePath(
  workspaceRoot: string,
  stagedWorkspace: string,
  path: string,
): void {
  const destination = join(stagedWorkspace, path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  cpSync(join(workspaceRoot, path), destination, { recursive: true });
}

function snapshotCheckout(
  workspaceRoot: string,
  extensionRoot: string,
): CheckoutSnapshot {
  const artifacts: CheckoutArtifact[] = [];
  for (const path of ["LICENSE", "THIRD_PARTY_NOTICES", "dist"]) {
    snapshotArtifact(extensionRoot, path, artifacts);
  }
  return {
    artifacts,
    gitStatus: execFileSync(
      "git",
      [
        "-c",
        `safe.directory=${workspaceRoot.replaceAll("\\", "/")}`,
        "status",
        "--short",
        "--untracked-files=all",
      ],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ),
  };
}

function snapshotArtifact(
  extensionRoot: string,
  path: string,
  artifacts: CheckoutArtifact[],
): void {
  const absolutePath = join(extensionRoot, path);
  if (!existsSync(absolutePath)) {
    artifacts.push({ path, kind: "missing" });
    return;
  }

  const status = statSync(absolutePath);
  if (status.isDirectory()) {
    artifacts.push({
      path,
      kind: "directory",
      mode: status.mode,
      modifiedAt: status.mtimeMs,
    });
    for (const entry of readdirSync(absolutePath).sort()) {
      snapshotArtifact(extensionRoot, join(path, entry), artifacts);
    }
    return;
  }

  artifacts.push({
    path,
    kind: "file",
    mode: status.mode,
    modifiedAt: status.mtimeMs,
    bytes: readFileSync(absolutePath),
  });
}
