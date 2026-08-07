import assert from "node:assert/strict";
import {
  BackgroundRouter,
  BackgroundInspectCoordinator,
  BrowserBridgeClient,
  BrowserWindowLinkStore,
  collectCssFacts,
  ContentInspectLease,
  createPanelIcons,
  createBackgroundRouter,
  createDevtoolsPanelPortName,
  createInspectPayload,
  DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH,
  DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH,
  DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES,
  DOM_PROTOCOL_MAX_LABEL_LENGTH,
  DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES,
  DOM_PROTOCOL_MAX_SUMMARY_LENGTH,
  DomNodeRegistry,
  DomPanelView,
  DomTreeController,
  DomTreeProvider,
  DomTreeProviderError,
  DomTreeView,
  DomProtocolError,
  FrameRegistry,
  InspectMode,
  PAGE_INSPECTION_SELECTION_INTERVAL_MS,
  PageInspectionSession,
  PageOverlay,
  PanelController,
  ResolutionPresenter,
  formatResolutionFooter,
  presentResolution,
  parseLinkCode,
  parseDomEvent,
  parseDomRequest,
  parseDomResponse,
  PanelInspectTransport,
  registerDevtoolsPanel,
  sanitizeErrorMessage,
  startBackgroundRuntime,
  startContentScriptRuntime,
  startDevtoolsRuntime,
  startPanelRuntime,
  virtualTreeRows,
  WindowConnectionCoordinator,
} from "@browser2ide/browser-extension-core";

assert.equal(typeof BrowserBridgeClient, "function");
assert.equal(typeof BackgroundInspectCoordinator, "function");
assert.equal(typeof BackgroundRouter, "function");
assert.equal(typeof BrowserWindowLinkStore, "function");
assert.equal(typeof collectCssFacts, "function");
assert.equal(typeof ContentInspectLease, "function");
assert.equal(typeof createPanelIcons, "function");
assert.equal(typeof createBackgroundRouter, "function");
assert.equal(typeof createDevtoolsPanelPortName, "function");
assert.equal(typeof createInspectPayload, "function");
assert.equal(DOM_PROTOCOL_MAX_ANCESTOR_PATH_LENGTH, 64);
assert.equal(DOM_PROTOCOL_MAX_CHILDREN_PAGE_LENGTH, 100);
assert.equal(DOM_PROTOCOL_MAX_IDENTIFIER_LENGTH, 128);
assert.equal(DOM_PROTOCOL_MAX_INVALIDATION_BRANCHES, 128);
assert.equal(DOM_PROTOCOL_MAX_LABEL_LENGTH, 512);
assert.equal(DOM_PROTOCOL_MAX_SERIALIZED_MESSAGE_BYTES, 64 * 1024);
assert.equal(DOM_PROTOCOL_MAX_SUMMARY_LENGTH, 512);
assert.equal(typeof DomNodeRegistry, "function");
assert.equal(typeof DomPanelView, "function");
assert.equal(typeof DomTreeController, "function");
assert.equal(typeof DomTreeProvider, "function");
assert.equal(typeof DomTreeProviderError, "function");
assert.equal(typeof DomTreeView, "function");
assert.equal(typeof DomProtocolError, "function");
assert.equal(typeof FrameRegistry, "function");
assert.equal(typeof InspectMode, "function");
assert.equal(PAGE_INSPECTION_SELECTION_INTERVAL_MS, 100);
assert.equal(typeof PageInspectionSession, "function");
assert.equal(typeof PageOverlay, "function");
assert.equal(typeof PanelController, "function");
assert.equal(typeof ResolutionPresenter, "function");
assert.equal(typeof formatResolutionFooter, "function");
assert.equal(typeof presentResolution, "function");
assert.equal(typeof parseLinkCode, "function");
assert.equal(typeof parseDomEvent, "function");
assert.equal(typeof parseDomRequest, "function");
assert.equal(typeof parseDomResponse, "function");
assert.equal(typeof PanelInspectTransport, "function");
assert.equal(typeof registerDevtoolsPanel, "function");
assert.equal(typeof sanitizeErrorMessage, "function");
assert.equal(typeof startBackgroundRuntime, "function");
assert.equal(typeof startContentScriptRuntime, "function");
assert.equal(typeof startDevtoolsRuntime, "function");
assert.equal(typeof startPanelRuntime, "function");
assert.equal(typeof virtualTreeRows, "function");
assert.equal(typeof WindowConnectionCoordinator, "function");
