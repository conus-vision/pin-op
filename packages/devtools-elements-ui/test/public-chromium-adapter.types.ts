import type {
  CreateElementsInspectorView,
} from "@pin-op/devtools-elements-ui";
import {
  createPinOpChromiumInspectorViewFactory,
  type PinOpChromiumInspectorAdapterOptions,
  type PinOpChromiumInspectorRuntime,
} from "@pin-op/devtools-elements-ui/chromium-adapter";

declare const runtime: PinOpChromiumInspectorRuntime;

const options: PinOpChromiumInspectorAdapterOptions = {
  onError: (_error: unknown): void => undefined,
};
const createView: CreateElementsInspectorView =
  createPinOpChromiumInspectorViewFactory(runtime, options);

void createView;
