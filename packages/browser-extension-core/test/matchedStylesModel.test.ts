import { describe, expect, it, vi } from "vitest";
import {
  MatchedStylesModel,
  type MatchedStylesModelSelection,
} from "../src/matchedStylesModel.js";
import type {
  StylesGetMatchedRequest,
  StylesResponse,
} from "../src/stylesProtocol.js";

describe("MatchedStylesModel", () => {
  it("retains an idle invalidation and adopts the exact response revision pair", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        return matchedResponse({
          request,
          stylesRevision: 9,
          stylesheetRevision: 3,
        });
      },
    });

    model.invalidate(stylesInvalidated(9, 3));
    await model.select(selectionIdentity());

    expect(requests).toEqual([{
      type: "styles.getMatched",
      requestId: "styles-model-1",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
    }]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        documentEpoch: 4,
        nodeRef: "node-1",
        selectionRevision: 7,
        stylesRevision: 9,
        stylesheetRevision: 3,
      },
    });
  });

  it("adopts a strictly newer raced response pair without restarting the initial load", async () => {
    const pending = deferred<StylesResponse>();
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        return pending.promise;
      },
    });
    model.invalidate(stylesInvalidated(9, 3));

    const load = model.select(selectionIdentity());
    model.invalidate(stylesInvalidated(10, 4));
    pending.resolve(matchedResponse({
      request: requests[0],
      stylesRevision: 11,
      stylesheetRevision: 4,
      partial: true,
      diagnostics: ["stylesheet-inaccessible"],
    }));
    await load;
    await flushAsync();

    expect(requests).toHaveLength(1);
    expect(model.snapshot()).toMatchObject({
      state: "partial",
      key: { stylesRevision: 11, stylesheetRevision: 4 },
      styles: { partial: true },
    });
  });

  it("rejects a response revision pair below retained authority", async () => {
    const model = new MatchedStylesModel({
      async request(request) {
        return matchedResponse({
          request,
          stylesRevision: 9,
          stylesheetRevision: 3,
        });
      },
    });
    model.invalidate(stylesInvalidated(9, 3));
    model.invalidate(stylesInvalidated(10, 4));

    await model.select(selectionIdentity());

    expect(model.snapshot()).toMatchObject({
      state: "error",
      errorCode: "internal-error",
    });
  });

  it("loads independently of IDE state and exposes idle/loading/ready/partial/error", async () => {
    const pending = deferred<StylesResponse>();
    const model = new MatchedStylesModel({
      createRequestId: () => "styles-1",
      request: vi.fn(() => pending.promise),
    });
    expect(model.snapshot().state).toBe("idle");

    const load = model.select(selection());
    expect(model.snapshot()).toMatchObject({ state: "loading", key: selection() });
    pending.resolve(matchedResponse());
    await load;
    expect(model.snapshot()).toMatchObject({ state: "ready", styles: { partial: false } });

    const partial = new MatchedStylesModel({
      createRequestId: () => "styles-1",
      request: async () => matchedResponse({ partial: true, diagnostics: ["stylesheet-inaccessible"] }),
    });
    await partial.select(selection());
    expect(partial.snapshot()).toMatchObject({ state: "partial", styles: { partial: true } });

    const error = new MatchedStylesModel({
      createRequestId: () => "styles-1",
      request: async (request) => ({
        type: "styles.error",
        requestId: request.requestId,
        code: "inaccessible",
      }),
    });
    await error.select(selection());
    expect(error.snapshot()).toMatchObject({ state: "error", errorCode: "inaccessible" });
  });

  it("fences stale results from an advanced selection and cancels old work", async () => {
    const requests: Array<{
      request: StylesGetMatchedRequest;
      signal: AbortSignal;
      pending: ReturnType<typeof deferred<StylesResponse>>;
    }> = [];
    const model = new MatchedStylesModel({
      request(request, signal) {
        const pending = deferred<StylesResponse>();
        requests.push({ request, signal, pending });
        return pending.promise;
      },
    });
    const first = model.select(selection());
    const secondSelection = selection({ nodeRef: "node-2", selectionRevision: 8 });
    const second = model.select(secondSelection);
    expect(requests[0]!.signal.aborted).toBe(true);

    requests[0]!.pending.resolve(matchedResponse());
    requests[1]!.pending.resolve(matchedResponse({
      request: requests[1]!.request,
      nodeRef: "node-2",
      selectionRevision: 8,
    }));
    await Promise.all([first, second]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: secondSelection,
      styles: { nodeRef: "node-2", selectionRevision: 8 },
    });
  });

  it("rejects mismatched response identities and stale/caller request-ID confusion", async () => {
    const variants = [
      { requestId: "caller-id" },
      { documentEpoch: 9 },
      { nodeRef: "wrong" },
      { selectionRevision: 9 },
      { stylesRevision: 9 },
      { stylesheetRevision: 4 },
    ];
    for (const variant of variants) {
      const model = new MatchedStylesModel({
        createRequestId: () => "wire-id",
        request: async () => ({ ...matchedResponse(), ...variant }),
      });
      await model.select(selection());
      expect(model.snapshot()).toMatchObject({ state: "error", errorCode: "internal-error" });
    }
  });

  it("coalesces strictly newer same-document invalidations into one reload", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      createRequestId: () => `wire-${requests.length + 1}`,
      async request(request) {
        requests.push(request);
        return matchedResponse({
          request,
          stylesRevision: requests.length === 1 ? 8 : 11,
          stylesheetRevision: requests.length === 1 ? 3 : 4,
        });
      },
    });
    await model.select(selection());
    model.invalidate(stylesInvalidated(9, 3));
    model.invalidate(stylesInvalidated(10, 4));
    model.invalidate(stylesInvalidated(11, 4));
    expect(requests).toHaveLength(1);
    await flushAsync();
    expect(requests).toHaveLength(2);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: { stylesRevision: 11, stylesheetRevision: 4 },
    });
  });

  it("ignores stale, cross-document, and non-monotonic invalidations", async () => {
    const request = vi.fn(async (message: StylesGetMatchedRequest) =>
      matchedResponse({ request: message })
    );
    const model = new MatchedStylesModel({ request });
    await model.select(selection());
    model.invalidate(stylesInvalidated(7, 3));
    model.invalidate(stylesInvalidated(9, 2));
    model.invalidate({ ...stylesInvalidated(9, 3), documentEpoch: 5 });
    await flushAsync();
    expect(request).toHaveBeenCalledOnce();
  });

  it("preserves stylesheet identity on applicability-only invalidation and resets it only when stylesheet advances", async () => {
    const onStylesheetReset = vi.fn();
    let responseStylesRevision = 8;
    let responseStylesheetRevision = 3;
    const model = new MatchedStylesModel({
      onStylesheetReset,
      async request(request) {
        return matchedResponse({
          request,
          stylesRevision: responseStylesRevision,
          stylesheetRevision: responseStylesheetRevision,
        });
      },
    });
    await model.select(selection());
    responseStylesRevision = 9;
    model.invalidate(stylesInvalidated(9, 3));
    await flushAsync();
    expect(onStylesheetReset).not.toHaveBeenCalled();
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: { stylesRevision: 9, stylesheetRevision: 3 },
    });
    responseStylesRevision = 10;
    responseStylesheetRevision = 4;
    model.invalidate(stylesInvalidated(10, 4));
    await flushAsync();
    expect(onStylesheetReset).toHaveBeenCalledWith({
      documentEpoch: 4,
      stylesheetRevision: 4,
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: { stylesRevision: 10, stylesheetRevision: 4 },
    });
  });

  it("resets and cancels on recovery, inspect-port invalidation, navigation, lease replacement, compatibility failure, and disposal", async () => {
    for (const reason of [
      "recovery",
      "inspect-port-invalidated",
      "navigation",
      "content-lease-replaced",
      "compatibility-failure",
    ] as const) {
      const pending = deferred<StylesResponse>();
      let signal: AbortSignal | undefined;
      const model = new MatchedStylesModel({
        request(_request, nextSignal) {
          signal = nextSignal;
          return pending.promise;
        },
      });
      const load = model.select(selection());
      model.reset(reason);
      expect(signal?.aborted).toBe(true);
      expect(model.snapshot().state).toBe("idle");
      pending.resolve(matchedResponse());
      await load;
      expect(model.snapshot().state).toBe("idle");
    }

    const pending = deferred<StylesResponse>();
    let signal: AbortSignal | undefined;
    const model = new MatchedStylesModel({
      request(_request, nextSignal) {
        signal = nextSignal;
        return pending.promise;
      },
    });
    const load = model.select(selection());
    model.dispose();
    expect(signal?.aborted).toBe(true);
    expect(model.snapshot().state).toBe("idle");
    await expect(model.select(selection())).rejects.toThrow(/disposed/i);
    pending.resolve(matchedResponse());
    await load;
  });

  it("notifies subscribers with immutable snapshots and makes unsubscribe/dispose inert", async () => {
    const states: string[] = [];
    const model = new MatchedStylesModel({
      createRequestId: () => "styles-1",
      request: async () => matchedResponse(),
    });
    const remove = model.subscribe((snapshot) => {
      states.push(snapshot.state);
      expect(Object.isFrozen(snapshot)).toBe(true);
    });
    await model.select(selection());
    remove();
    model.reset("recovery");
    model.dispose();
    expect(states).toEqual(["idle", "loading", "ready"]);
  });
});

function selection(overrides: Partial<MatchedStylesModelSelection> = {}): MatchedStylesModelSelection {
  return {
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
    ...overrides,
  };
}

function selectionIdentity() {
  return {
    documentEpoch: 4,
    nodeRef: "node-1",
    selectionRevision: 7,
  };
}

function stylesInvalidated(stylesRevision: number, stylesheetRevision: number) {
  return {
    type: "styles.invalidated" as const,
    documentEpoch: 4,
    stylesRevision,
    stylesheetRevision,
  };
}

function matchedResponse(options: {
  readonly request?: StylesGetMatchedRequest;
  readonly nodeRef?: string;
  readonly selectionRevision?: number;
  readonly stylesRevision?: number;
  readonly stylesheetRevision?: number;
  readonly partial?: boolean;
  readonly diagnostics?: readonly string[];
} = {}): Extract<StylesResponse, { readonly type: "styles.matched" }> {
  const request = options.request;
  const documentEpoch = request?.documentEpoch ?? 4;
  const nodeRef = options.nodeRef ?? request?.nodeRef ?? "node-1";
  const selectionRevision = options.selectionRevision ?? request?.selectionRevision ?? 7;
  const stylesRevision = options.stylesRevision ?? 8;
  const stylesheetRevision = options.stylesheetRevision ?? 3;
  return {
    type: "styles.matched",
    requestId: request?.requestId ?? "styles-1",
    documentEpoch,
    nodeRef,
    selectionRevision,
    stylesRevision,
    stylesheetRevision,
    styles: {
      documentEpoch,
      nodeRef,
      selectionRevision,
      stylesRevision,
      stylesheetRevision,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      partial: options.partial ?? false,
      diagnostics: options.diagnostics ?? [],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
