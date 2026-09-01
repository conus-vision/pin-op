import { describe, expect, it, vi } from "vitest";
import {
  MatchedStylesModel,
  type MatchedStylesModelSelection,
} from "../src/matchedStylesModel.js";
import type {
  StylesGetMatchedRequest,
  StylesRequest,
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
      pseudoStateRevision: 0,
      pseudoStates: [],
    }]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        documentEpoch: 4,
        nodeRef: "node-1",
        selectionRevision: 7,
        stylesRevision: 9,
        stylesheetRevision: 3,
        pseudoStateRevision: 0,
        pseudoStates: [],
      },
    });
  });

  it("retries a cancelled load the resizing page has already moved past", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request as StylesGetMatchedRequest);
        // The first collect races the page's own revision advance; the second
        // lands on the settled authority.
        return requests.length === 1
          ? { type: "styles.error", requestId: request.requestId, code: "cancelled" }
          : matchedResponse({
            request,
            stylesRevision: 10,
            stylesheetRevision: 3,
          });
      },
    });

    vi.useFakeTimers();
    try {
      await model.select(selectionIdentity());
      await flushAsync();
      await vi.advanceTimersByTimeAsync(200);
      await flushAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(requests).toHaveLength(2);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: { stylesRevision: 10, stylesheetRevision: 3 },
    });
  });

  it("stops retrying a page whose style authority never settles", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request as StylesGetMatchedRequest);
        return { type: "styles.error", requestId: request.requestId, code: "cancelled" };
      },
    });

    vi.useFakeTimers();
    try {
      await model.select(selectionIdentity());
      await flushAsync();
      for (let attempt = 0; attempt < 13; attempt += 1) {
        await vi.advanceTimersByTimeAsync(200);
        await flushAsync();
      }
    } finally {
      vi.useRealTimers();
    }

    expect(requests).toHaveLength(13);
    expect(model.snapshot()).toMatchObject({
      state: "error",
      errorCode: "cancelled",
    });
  });

  it("refills the cancelled budget whenever the page reports progress", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request as StylesGetMatchedRequest);
        return { type: "styles.error", requestId: request.requestId, code: "cancelled" };
      },
    });

    vi.useFakeTimers();
    try {
      await model.select(selectionIdentity());
      await flushAsync();
      for (let attempt = 0; attempt < 13; attempt += 1) {
        await vi.advanceTimersByTimeAsync(200);
        await flushAsync();
      }
      const spent = requests.length;

      // A stylesheet swap that keeps replacing sheets keeps cancelling, but
      // each invalidation is the page moving on, not the same race repeating.
      model.invalidate(stylesInvalidated(20, 6));
      await flushAsync();
      await vi.advanceTimersByTimeAsync(200);
      await flushAsync();

      expect(requests.length).toBeGreaterThan(spent + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("atomically adopts pseudo-state authority and fences a delayed pre-preview response", async () => {
    const requests: StylesRequest[] = [];
    const staleRefresh = deferred<StylesResponse>();
    let getCount = 0;
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return Promise.resolve({
            type: "styles.pseudoStates",
            requestId: request.requestId,
            documentEpoch: request.documentEpoch,
            nodeRef: request.nodeRef,
            selectionRevision: request.selectionRevision,
            stylesRevision: 9,
            stylesheetRevision: 3,
            pseudoStateRevision: 1,
            states: ["hover"],
            unsupportedRuleCount: 1,
            inaccessibleStylesheetCount: 0,
            approximateRuleCount: 1,
          });
        }
        getCount += 1;
        if (getCount === 2) return staleRefresh.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: getCount === 1 ? 8 : 9,
          pseudoStateRevision: getCount === 1 ? 0 : 1,
          pseudoStates: getCount === 1 ? [] : ["hover"],
        }));
      },
    });

    await model.select(selection());
    const refresh = model.refresh();
    const preview = model.setPseudoStates(["hover"]);
    staleRefresh.resolve(matchedResponse({
      request: requests[1] as StylesGetMatchedRequest,
      stylesRevision: 8,
      pseudoStateRevision: 0,
      pseudoStates: [],
    }));
    await Promise.all([refresh, preview]);
    await flushAsync();

    expect(requests.map((request) => request.type)).toEqual([
      "styles.getMatched",
      "styles.getMatched",
      "styles.setPseudoStates",
      "styles.getMatched",
    ]);
    expect(requests[2]).toEqual({
      type: "styles.setPseudoStates",
      requestId: "styles-model-3",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      expectedStylesRevision: 8,
      expectedPseudoStateRevision: 0,
      states: ["hover"],
    });
    expect(requests[3]).toMatchObject({
      type: "styles.getMatched",
      pseudoStateRevision: 1,
      pseudoStates: ["hover"],
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        stylesRevision: 9,
        stylesheetRevision: 3,
        pseudoStateRevision: 1,
        pseudoStates: ["hover"],
      },
      styles: { pseudoStateRevision: 1, pseudoStates: ["hover"] },
    });
  });

  it("does not issue an atomic command for an identical canonical pseudo-state set", async () => {
    const requests: StylesRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        return matchedResponse({ request: request as StylesGetMatchedRequest });
      },
    });
    await model.select(selection());
    await model.setPseudoStates([]);
    expect(requests.map((request) => request.type)).toEqual(["styles.getMatched"]);
  });

  it.each([
    { stylesRevision: 8, stylesheetRevision: 3, pseudoStateRevision: 1 },
    { stylesRevision: 10, stylesheetRevision: 3, pseudoStateRevision: 1 },
    { stylesRevision: 9, stylesheetRevision: 4, pseudoStateRevision: 1 },
    { stylesRevision: 9, stylesheetRevision: 3, pseudoStateRevision: 2 },
  ])("rejects non-exact pseudo CAS success authority %#", async (variant) => {
    const model = new MatchedStylesModel({
      async request(request) {
        if (request.type === "styles.getMatched") {
          return matchedResponse({ request });
        }
        return {
          type: "styles.pseudoStates",
          requestId: request.requestId,
          documentEpoch: request.documentEpoch,
          nodeRef: request.nodeRef,
          selectionRevision: request.selectionRevision,
          states: request.states,
          unsupportedRuleCount: 0,
          inaccessibleStylesheetCount: 0,
          approximateRuleCount: 0,
          ...variant,
        };
      },
    });
    await model.select(selection());
    await model.setPseudoStates(["hover"]);
    expect(model.snapshot()).toMatchObject({
      state: "error",
      errorCode: "internal-error",
      key: {
        stylesRevision: 8,
        stylesheetRevision: 3,
        pseudoStateRevision: 0,
        pseudoStates: [],
      },
    });
  });

  it.each([
    "success",
    "error",
    "lost",
    "correlation-failure",
  ] as const)(
    "converges on one matched reload when a newer floor races pseudo set %s",
    async (outcome) => {
      const requests: StylesRequest[] = [];
      const pendingSet = deferred<StylesResponse>();
      const states: string[] = [];
      const model = new MatchedStylesModel({
        request(request) {
          requests.push(request);
          if (request.type === "styles.setPseudoStates") {
            return pendingSet.promise;
          }
          if (requests.length === 1) {
            return Promise.resolve(matchedResponse({ request }));
          }
          return Promise.resolve(matchedResponse({
            request,
            stylesRevision: 10,
            stylesheetRevision: 3,
            pseudoStateRevision: 2,
            pseudoStates: [],
          }));
        },
      });
      model.subscribe((snapshot) => states.push(snapshot.state));
      await model.select(selection());

      const update = model.setPseudoStates(["hover"]);
      const setRequest = requests[1];
      if (setRequest?.type !== "styles.setPseudoStates") {
        throw new Error("missing pseudo-state request");
      }
      model.invalidate(stylesInvalidated(10, 3, 2, []));
      if (outcome === "lost") {
        pendingSet.reject(new Error("lost pseudo-state response"));
      } else if (outcome === "correlation-failure") {
        pendingSet.resolve({
          type: "styles.error",
          requestId: "wrong-request",
          code: "cancelled",
        });
      } else if (outcome === "error") {
        pendingSet.resolve({
          type: "styles.error",
          requestId: setRequest.requestId,
          code: "stale-styles",
        });
      } else {
        pendingSet.resolve(pseudoStatesResponse(setRequest));
      }
      await update;
      await flushAsync();

      expect(requests.map((request) => request.type)).toEqual([
        "styles.getMatched",
        "styles.setPseudoStates",
        "styles.getMatched",
      ]);
      expect(requests[2]).toMatchObject({
        type: "styles.getMatched",
        pseudoStateRevision: 2,
        pseudoStates: [],
      });
      expect(states).not.toContain("error");
      expect(model.snapshot()).toMatchObject({
        state: "ready",
        key: {
          stylesRevision: 10,
          stylesheetRevision: 3,
          pseudoStateRevision: 2,
          pseudoStates: [],
        },
      });
    },
  );

  it("loads from the freshest same-document pseudo authority", async () => {
    const requests: StylesRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return pseudoStatesResponse(request);
        }
        if (request.pseudoStateRevision === 2) {
          return matchedResponse({
            request,
            stylesRevision: 10,
            pseudoStateRevision: 2,
            pseudoStates: [],
          });
        }
        return matchedResponse({
          request,
          stylesRevision: request.pseudoStateRevision === 1 ? 9 : 8,
          pseudoStateRevision: request.pseudoStateRevision,
          pseudoStates: request.pseudoStates,
        });
      },
    });
    await model.select(selection());
    await model.setPseudoStates(["hover"]);

    model.invalidate(stylesInvalidated(10, 3, 2, []));
    await model.refresh();
    await flushAsync();

    expect(requests[3]).toMatchObject({
      type: "styles.getMatched",
      pseudoStateRevision: 2,
      pseudoStates: [],
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        stylesRevision: 10,
        pseudoStateRevision: 2,
        pseudoStates: [],
      },
    });
  });

  it("loads a queued newer floor before issuing the requested pseudo CAS", async () => {
    const requests: StylesRequest[] = [];
    const pendingFloor = deferred<StylesResponse>();
    let getCount = 0;
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return Promise.resolve(pseudoStatesResponse(request));
        }
        getCount += 1;
        if (getCount === 2) return pendingFloor.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: getCount === 1 ? 8 : 10,
          pseudoStateRevision: getCount === 1 ? 0 : 1,
          pseudoStates: getCount === 1 ? [] : ["hover", "focus"],
        }));
      },
    });
    await model.select(selection());
    model.invalidate(stylesInvalidated(9, 3));

    const updating = model.setPseudoStates(["hover", "focus"]);

    expect(requests.map((request) => request.type)).toEqual([
      "styles.getMatched",
      "styles.getMatched",
    ]);
    const floorRequest = requests[1];
    if (floorRequest?.type !== "styles.getMatched") {
      throw new Error("missing floor reload");
    }
    pendingFloor.resolve(matchedResponse({
      request: floorRequest,
      stylesRevision: 9,
      pseudoStateRevision: 0,
      pseudoStates: [],
    }));
    await updating;
    await flushAsync();

    expect(requests.map((request) => request.type)).toEqual([
      "styles.getMatched",
      "styles.getMatched",
      "styles.setPseudoStates",
      "styles.getMatched",
    ]);
    expect(requests[2]).toMatchObject({
      type: "styles.setPseudoStates",
      expectedStylesRevision: 9,
      expectedPseudoStateRevision: 0,
      states: ["hover", "focus"],
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        stylesRevision: 10,
        pseudoStateRevision: 1,
        pseudoStates: ["hover", "focus"],
      },
    });
  });

  it.each([
    {
      accepted: ["hover"] as const,
      floor: [] as const,
      desired: ["hover"] as const,
    },
    {
      accepted: [] as const,
      floor: ["hover"] as const,
      desired: [] as const,
    },
  ])(
    "reapplies same-key user intent after opposite queued floor %#",
    async ({ accepted, floor, desired }) => {
      const requests: StylesRequest[] = [];
      const pendingFloor = deferred<StylesResponse>();
      let getCount = 0;
      const model = new MatchedStylesModel({
        request(request) {
          requests.push(request);
          if (request.type === "styles.setPseudoStates") {
            return Promise.resolve(pseudoStatesResponse(request));
          }
          getCount += 1;
          if (getCount === 2) return pendingFloor.promise;
          return Promise.resolve(matchedResponse({
            request,
            stylesRevision: getCount === 1 ? 8 : 10,
            pseudoStateRevision: getCount === 1 ? 1 : 3,
            pseudoStates: getCount === 1 ? accepted : desired,
          }));
        },
      });
      model.invalidate(stylesInvalidated(8, 3, 1, accepted));
      await model.select(selection());
      model.invalidate(stylesInvalidated(9, 3, 2, floor));

      const updating = model.setPseudoStates(desired);

      expect(requests.map((request) => request.type)).toEqual([
        "styles.getMatched",
        "styles.getMatched",
      ]);
      const floorRequest = requests[1];
      if (floorRequest?.type !== "styles.getMatched") {
        throw new Error("missing opposite-floor reload");
      }
      pendingFloor.resolve(matchedResponse({
        request: floorRequest,
        stylesRevision: 9,
        pseudoStateRevision: 2,
        pseudoStates: floor,
      }));
      await updating;
      await flushAsync();

      expect(requests.map((request) => request.type)).toEqual([
        "styles.getMatched",
        "styles.getMatched",
        "styles.setPseudoStates",
        "styles.getMatched",
      ]);
      expect(requests[2]).toMatchObject({
        type: "styles.setPseudoStates",
        expectedStylesRevision: 9,
        expectedPseudoStateRevision: 2,
        states: desired,
      });
      expect(model.snapshot()).toMatchObject({
        state: "ready",
        key: {
          stylesRevision: 10,
          pseudoStateRevision: 3,
          pseudoStates: desired,
        },
      });
    },
  );

  it("preserves pseudo intent through an automatic newer-floor reload", async () => {
    const requests: StylesRequest[] = [];
    const pendingFloor = deferred<StylesResponse>();
    let getCount = 0;
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return Promise.resolve(pseudoStatesResponse(request));
        }
        getCount += 1;
        if (getCount === 2) return pendingFloor.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: request.pseudoStateRevision === 1
            ? 11
            : getCount === 1 ? 8 : 10,
          pseudoStateRevision: request.pseudoStateRevision,
          pseudoStates: request.pseudoStates,
        }));
      },
    });
    await model.select(selection());
    model.invalidate(stylesInvalidated(9, 3));
    const updating = model.setPseudoStates(["hover"]);
    const floorRequest = requests[1];
    if (floorRequest?.type !== "styles.getMatched") {
      throw new Error("missing first floor reload");
    }
    model.invalidate(stylesInvalidated(10, 3));

    pendingFloor.resolve(matchedResponse({
      request: floorRequest,
      stylesRevision: 9,
    }));
    await updating;
    await flushAsync();

    expect(requests.filter((request) => (
      request.type === "styles.setPseudoStates"
    ))).toEqual([expect.objectContaining({
      expectedStylesRevision: 10,
      expectedPseudoStateRevision: 0,
      states: ["hover"],
    })]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        stylesRevision: 11,
        pseudoStateRevision: 1,
        pseudoStates: ["hover"],
      },
    });
  });

  it("lets a newer pseudo intent supersede one awaiting floor convergence", async () => {
    const requests: StylesRequest[] = [];
    const oldFloor = deferred<StylesResponse>();
    const newFloor = deferred<StylesResponse>();
    let getCount = 0;
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return Promise.resolve(pseudoStatesResponse(request));
        }
        getCount += 1;
        if (getCount === 2) return oldFloor.promise;
        if (getCount === 3) return newFloor.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: request.pseudoStateRevision === 1 ? 11 : 8,
          pseudoStateRevision: request.pseudoStateRevision,
          pseudoStates: request.pseudoStates,
        }));
      },
    });
    await model.select(selection());
    model.invalidate(stylesInvalidated(9, 3));
    const oldIntent = model.setPseudoStates(["hover"]);
    const oldRequest = requests[1];
    if (oldRequest?.type !== "styles.getMatched") {
      throw new Error("missing old intent floor reload");
    }
    model.invalidate(stylesInvalidated(10, 3));
    const newIntent = model.setPseudoStates(["focus"]);
    const newRequest = requests[2];
    if (newRequest?.type !== "styles.getMatched") {
      throw new Error("missing new intent floor reload");
    }

    oldFloor.resolve(matchedResponse({
      request: oldRequest,
      stylesRevision: 9,
    }));
    newFloor.resolve(matchedResponse({
      request: newRequest,
      stylesRevision: 10,
    }));
    await Promise.all([oldIntent, newIntent]);
    await flushAsync();

    expect(requests.filter((request) => (
      request.type === "styles.setPseudoStates"
    ))).toEqual([expect.objectContaining({
      expectedStylesRevision: 10,
      states: ["focus"],
    })]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        stylesRevision: 11,
        pseudoStateRevision: 1,
        pseudoStates: ["focus"],
      },
    });
  });

  it.each(["dispose", "selection-change"] as const)(
    "does not replay a requested pseudo CAS after its floor load loses authority to %s",
    async (interruption) => {
      const requests: StylesRequest[] = [];
      const pendingFloor = deferred<StylesResponse>();
      const nextSelection = selection({ nodeRef: "node-2", selectionRevision: 8 });
      let getCount = 0;
      const model = new MatchedStylesModel({
        request(request) {
          requests.push(request);
          if (request.type === "styles.setPseudoStates") {
            return Promise.resolve(pseudoStatesResponse(request));
          }
          getCount += 1;
          if (getCount === 2 && request.nodeRef === "node-1") {
            return pendingFloor.promise;
          }
          return Promise.resolve(matchedResponse({
            request,
            stylesRevision: getCount === 1 ? 8 : 9,
          }));
        },
      });
      await model.select(selection());
      model.invalidate(stylesInvalidated(9, 3));
      const updating = model.setPseudoStates(["hover"]);
      const floorRequest = requests[1];

      const selecting = interruption === "selection-change"
        ? model.select(nextSelection)
        : undefined;
      if (interruption === "dispose") model.dispose();
      if (floorRequest?.type === "styles.getMatched") {
        pendingFloor.resolve(matchedResponse({
          request: floorRequest,
          stylesRevision: 9,
        }));
      }
      await updating;
      await selecting;

      expect(requests.filter((request) => (
        request.type === "styles.setPseudoStates"
      ))).toEqual([]);
      expect(model.snapshot()).toMatchObject(
        interruption === "dispose"
          ? { state: "idle" }
          : { state: "ready", key: nextSelection },
      );
    },
  );

  it("converges on an empty cleanup key when selection changes before cleanup invalidation", async () => {
    const requests: StylesRequest[] = [];
    const pendingSelection = deferred<StylesResponse>();
    let getCount = 0;
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return Promise.resolve(pseudoStatesResponse(request));
        }
        getCount += 1;
        if (getCount === 3) return pendingSelection.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: getCount === 1 ? 8 : getCount === 2 ? 9 : 10,
          pseudoStateRevision: getCount === 1 ? 0 : getCount === 2 ? 1 : 2,
          pseudoStates: getCount === 2 ? ["hover"] : [],
        }));
      },
    });
    await model.select(selection());
    await model.setPseudoStates(["hover"]);

    const nextSelection = selection({ nodeRef: "node-2", selectionRevision: 8 });
    const changing = model.select(nextSelection);
    const staleRequest = requests[3];
    if (staleRequest?.type !== "styles.getMatched") {
      throw new Error("missing replacement selection request");
    }
    model.invalidate(stylesInvalidated(10, 3, 2, []));
    pendingSelection.resolve({
      type: "styles.error",
      requestId: staleRequest.requestId,
      code: "stale-pseudo-state",
    });
    await changing;
    await flushAsync();

    expect(requests.map((request) => request.type)).toEqual([
      "styles.getMatched",
      "styles.setPseudoStates",
      "styles.getMatched",
      "styles.getMatched",
      "styles.getMatched",
    ]);
    expect(requests[4]).toMatchObject({
      documentEpoch: 4,
      nodeRef: "node-2",
      selectionRevision: 8,
      pseudoStateRevision: 2,
      pseudoStates: [],
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        nodeRef: "node-2",
        selectionRevision: 8,
        stylesRevision: 10,
        pseudoStateRevision: 2,
        pseudoStates: [],
      },
    });
  });

  it("does not send a pseudo mutation after a loading listener resets authority", async () => {
    const requests: StylesRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return pseudoStatesResponse(request);
        }
        return matchedResponse({ request });
      },
    });
    await model.select(selection());
    let armed = true;
    model.subscribe((snapshot) => {
      if (!armed || snapshot.state !== "loading") return;
      armed = false;
      model.reset("advanced-selection");
    });

    await model.setPseudoStates(["hover"]);

    expect(requests.map((request) => request.type)).toEqual([
      "styles.getMatched",
    ]);
    expect(model.snapshot().state).toBe("idle");
  });

  it("lets a nested pseudo mutation own the command after loading publication", async () => {
    const requests: StylesRequest[] = [];
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        if (request.type === "styles.setPseudoStates") {
          return pseudoStatesResponse(request);
        }
        return matchedResponse({
          request,
          stylesRevision: request.pseudoStateRevision === 1 ? 9 : 8,
          pseudoStateRevision: request.pseudoStateRevision,
          pseudoStates: request.pseudoStates,
        });
      },
    });
    await model.select(selection());
    let nestedStarted = false;
    let nested: Promise<void> | undefined;
    model.subscribe((snapshot) => {
      if (nestedStarted || snapshot.state !== "loading") return;
      nestedStarted = true;
      nested = model.setPseudoStates(["focus"]);
    });

    await model.setPseudoStates(["hover"]);
    await nested;

    expect(requests.filter((request) => request.type === "styles.setPseudoStates"))
      .toEqual([expect.objectContaining({ states: ["focus"] })]);
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: { pseudoStateRevision: 1, pseudoStates: ["focus"] },
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

  it("discards a below-floor response and coalesces one follow-up for the current selection", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    const pending: Array<ReturnType<typeof deferred<StylesResponse>>> = [];
    const states: string[] = [];
    const model = new MatchedStylesModel({
      request(request) {
        requests.push(request);
        const next = deferred<StylesResponse>();
        pending.push(next);
        return next.promise;
      },
    });
    model.subscribe((snapshot) => states.push(snapshot.state));

    const first = model.select(selectionIdentity());
    model.invalidate(stylesInvalidated(9, 3));
    model.invalidate(stylesInvalidated(10, 4));
    model.invalidate(stylesInvalidated(11, 4));
    pending[0]!.resolve(matchedResponse({
      request: requests[0],
      stylesRevision: 10,
      stylesheetRevision: 4,
    }));
    await first;
    await flushAsync();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      type: "styles.getMatched",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
    });
    expect(requests[1]!.requestId).not.toBe(requests[0]!.requestId);
    expect(model.snapshot()).toMatchObject({ state: "loading" });
    expect(states).not.toContain("error");
    expect(states).not.toContain("ready");
    expect(states).not.toContain("partial");

    pending[1]!.resolve(matchedResponse({
      request: requests[1],
      stylesRevision: 11,
      stylesheetRevision: 4,
      partial: true,
      diagnostics: ["stylesheet-inaccessible"],
    }));
    await flushAsync();

    expect(model.snapshot()).toMatchObject({
      state: "partial",
      key: { stylesRevision: 11, stylesheetRevision: 4 },
    });
    expect(requests).toHaveLength(2);
  });

  it.each([
    "rejected-request",
    "cancelled-error",
    "internal-error",
  ] as const)(
    "retries one coalesced newer-floor load after %s",
    async (outcome) => {
      const requests: StylesGetMatchedRequest[] = [];
      const pending: Array<ReturnType<typeof deferred<StylesResponse>>> = [];
      const states: string[] = [];
      const model = new MatchedStylesModel({
        request(request) {
          requests.push(request);
          const next = deferred<StylesResponse>();
          pending.push(next);
          return next.promise;
        },
      });
      model.subscribe((snapshot) => states.push(snapshot.state));

      const first = model.select(selectionIdentity());
      model.invalidate(stylesInvalidated(9, 3));
      model.invalidate(stylesInvalidated(10, 3));
      if (outcome === "rejected-request") {
        pending[0]!.reject(new Error("lost styles response"));
      } else {
        pending[0]!.resolve({
          type: "styles.error",
          requestId: requests[0]!.requestId,
          code: outcome === "cancelled-error" ? "cancelled" : "internal-error",
        });
      }
      await first;
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(model.snapshot().state).toBe("loading");
      expect(states).not.toContain("error");
      pending[1]!.resolve(matchedResponse({
        request: requests[1],
        stylesRevision: 10,
        stylesheetRevision: 3,
      }));
      await flushAsync();

      expect(requests).toHaveLength(2);
      expect(model.snapshot()).toMatchObject({
        state: "ready",
        key: { stylesRevision: 10, stylesheetRevision: 3 },
      });
    },
  );

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
        code: "node-unavailable",
      }),
    });
    await error.select(selection());
    expect(error.snapshot()).toMatchObject({ state: "error", errorCode: "node-unavailable" });
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
    model.invalidate(stylesInvalidated(9, 3));
    const secondSelection = selection({ nodeRef: "node-2", selectionRevision: 8 });
    const second = model.select(secondSelection);
    expect(requests[0]!.signal.aborted).toBe(true);

    requests[0]!.pending.resolve(matchedResponse());
    requests[1]!.pending.resolve(matchedResponse({
      request: requests[1]!.request,
      nodeRef: "node-2",
      selectionRevision: 8,
      stylesRevision: 9,
      stylesheetRevision: 3,
    }));
    await Promise.all([first, second]);
    await flushAsync();
    expect(requests).toHaveLength(2);
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
      { pseudoStateRevision: 1 },
      { pseudoStates: ["hover"] },
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

  it("does not accept a load after its stylesheet-reset callback resets the model", async () => {
    let model!: MatchedStylesModel;
    let resetOnStylesheetAdvance = false;
    let stylesRevision = 8;
    let stylesheetRevision = 3;
    model = new MatchedStylesModel({
      onStylesheetReset() {
        if (!resetOnStylesheetAdvance) return;
        resetOnStylesheetAdvance = false;
        model.reset("advanced-selection");
      },
      async request(request) {
        return matchedResponse({
          request: request as StylesGetMatchedRequest,
          stylesRevision,
          stylesheetRevision,
        });
      },
    });
    await model.select(selection());
    stylesRevision = 9;
    stylesheetRevision = 4;
    resetOnStylesheetAdvance = true;

    await model.refresh();

    expect(model.snapshot()).toEqual({
      state: "idle",
      generation: 3,
    });
  });

  it("does not publish an old load after its stylesheet-reset callback selects a new node", async () => {
    const pendingNext = deferred<StylesResponse>();
    const requests: StylesGetMatchedRequest[] = [];
    const nextSelection = selection({ nodeRef: "node-2", selectionRevision: 8 });
    let model!: MatchedStylesModel;
    let selectOnStylesheetAdvance = false;
    let nextLoad: Promise<void> | undefined;
    model = new MatchedStylesModel({
      onStylesheetReset() {
        if (!selectOnStylesheetAdvance) return;
        selectOnStylesheetAdvance = false;
        nextLoad = model.select(nextSelection);
      },
      request(request) {
        if (request.type !== "styles.getMatched") {
          throw new Error("unexpected pseudo-state command");
        }
        requests.push(request);
        if (request.nodeRef === nextSelection.nodeRef) return pendingNext.promise;
        return Promise.resolve(matchedResponse({
          request,
          stylesRevision: requests.length === 1 ? 8 : 9,
          stylesheetRevision: requests.length === 1 ? 3 : 4,
        }));
      },
    });
    await model.select(selection());
    selectOnStylesheetAdvance = true;

    await model.refresh();

    expect(model.snapshot()).toMatchObject({
      state: "loading",
      key: nextSelection,
    });
    const nextRequest = requests[2];
    if (!nextRequest) throw new Error("missing new-selection load");
    pendingNext.resolve(matchedResponse({
      request: nextRequest,
      stylesRevision: 9,
      stylesheetRevision: 4,
    }));
    await nextLoad;
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        ...nextSelection,
        stylesRevision: 9,
        stylesheetRevision: 4,
      },
    });
  });

  it("requeries the exact current selection on manual refresh and is inert without one", async () => {
    const requests: StylesGetMatchedRequest[] = [];
    let stylesRevision = 8;
    let stylesheetRevision = 3;
    const model = new MatchedStylesModel({
      async request(request) {
        requests.push(request);
        return matchedResponse({
          request,
          stylesRevision,
          stylesheetRevision,
        });
      },
    });

    await model.refresh();
    expect(requests).toEqual([]);

    await model.select(selectionIdentity());
    stylesRevision = 9;
    await model.refresh();

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual({
      type: "styles.getMatched",
      requestId: "styles-model-2",
      documentEpoch: 4,
      nodeRef: "node-1",
      selectionRevision: 7,
      pseudoStateRevision: 0,
      pseudoStates: [],
      manualRefresh: true,
    });
    expect(model.snapshot()).toMatchObject({
      state: "ready",
      key: {
        documentEpoch: 4,
        nodeRef: "node-1",
        selectionRevision: 7,
        stylesRevision: 9,
        stylesheetRevision: 3,
        pseudoStateRevision: 0,
        pseudoStates: [],
      },
    });

    model.reset("advanced-selection");
    await model.refresh();
    expect(requests).toHaveLength(2);
  });

  it("generation-fences concurrent manual refreshes and disposal", async () => {
    const pending: Array<ReturnType<typeof deferred<StylesResponse>>> = [];
    const signals: AbortSignal[] = [];
    let initial = true;
    const requests: StylesGetMatchedRequest[] = [];
    const model = new MatchedStylesModel({
      request(request, signal) {
        requests.push(request);
        signals.push(signal);
        if (initial) {
          initial = false;
          return Promise.resolve(matchedResponse({ request }));
        }
        const next = deferred<StylesResponse>();
        pending.push(next);
        return next.promise;
      },
    });
    await model.select(selectionIdentity());
    expect(requests[0]).not.toHaveProperty("manualRefresh");

    const first = model.refresh();
    const second = model.refresh();
    expect(signals[1]?.aborted).toBe(true);
    expect(requests.slice(1)).toEqual([
      expect.objectContaining({ manualRefresh: true }),
      expect.objectContaining({ manualRefresh: true }),
    ]);

    pending[0]!.resolve(matchedResponse({ request: requests[1] }));
    model.dispose();
    expect(signals[2]?.aborted).toBe(true);
    pending[1]!.reject(new Error("disposed refresh"));
    await Promise.all([first, second]);

    expect(model.snapshot().state).toBe("idle");
    await model.refresh();
    expect(requests).toHaveLength(3);
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
      let requestCount = 0;
      const model = new MatchedStylesModel({
        request(_request, nextSignal) {
          requestCount += 1;
          signal = nextSignal;
          return pending.promise;
        },
      });
      const load = model.select(selection());
      model.invalidate(stylesInvalidated(9, 3));
      model.reset(reason);
      expect(signal?.aborted).toBe(true);
      expect(model.snapshot().state).toBe("idle");
      pending.reject(new Error("reset styles request"));
      await load;
      await flushAsync();
      expect(model.snapshot().state).toBe("idle");
      expect(requestCount).toBe(1);
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
    pending.reject(new Error("disposed styles request"));
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

function stylesInvalidated(
  stylesRevision: number,
  stylesheetRevision: number,
  pseudoStateRevision = 0,
  pseudoStates: readonly ("hover" | "focus")[] = [],
) {
  return {
    type: "styles.invalidated" as const,
    documentEpoch: 4,
    stylesRevision,
    stylesheetRevision,
    pseudoStateRevision,
    pseudoStates,
  };
}

function matchedResponse(options: {
  readonly request?: StylesGetMatchedRequest;
  readonly nodeRef?: string;
  readonly selectionRevision?: number;
  readonly stylesRevision?: number;
  readonly stylesheetRevision?: number;
  readonly pseudoStateRevision?: number;
  readonly pseudoStates?: readonly ("hover" | "focus")[];
  readonly partial?: boolean;
  readonly diagnostics?: readonly string[];
} = {}): Extract<StylesResponse, { readonly type: "styles.matched" }> {
  const request = options.request;
  const documentEpoch = request?.documentEpoch ?? 4;
  const nodeRef = options.nodeRef ?? request?.nodeRef ?? "node-1";
  const selectionRevision = options.selectionRevision ?? request?.selectionRevision ?? 7;
  const stylesRevision = options.stylesRevision ?? 8;
  const stylesheetRevision = options.stylesheetRevision ?? 3;
  const pseudoStateRevision = options.pseudoStateRevision ?? request?.pseudoStateRevision ?? 0;
  const pseudoStates = options.pseudoStates ?? request?.pseudoStates ?? [];
  return {
    type: "styles.matched",
    requestId: request?.requestId ?? "styles-1",
    documentEpoch,
    nodeRef,
    selectionRevision,
    stylesRevision,
    stylesheetRevision,
    pseudoStateRevision,
    pseudoStates,
    styles: {
      documentEpoch,
      nodeRef,
      selectionRevision,
      stylesRevision,
      stylesheetRevision,
      pseudoStateRevision,
      pseudoStates,
      rules: [],
      inherited: [],
      inaccessibleStylesheetCount: 0,
      unsupportedRuleCount: 0,
      approximateRuleCount: 0,
      partial: options.partial ?? false,
      diagnostics: options.diagnostics ?? [],
    },
  };
}

function pseudoStatesResponse(
  request: Extract<StylesRequest, { readonly type: "styles.setPseudoStates" }>,
): Extract<StylesResponse, { readonly type: "styles.pseudoStates" }> {
  return {
    type: "styles.pseudoStates",
    requestId: request.requestId,
    documentEpoch: request.documentEpoch,
    nodeRef: request.nodeRef,
    selectionRevision: request.selectionRevision,
    stylesRevision: request.expectedStylesRevision + 1,
    stylesheetRevision: 3,
    pseudoStateRevision: request.expectedPseudoStateRevision + 1,
    states: request.states,
    unsupportedRuleCount: 0,
    inaccessibleStylesheetCount: 0,
    approximateRuleCount: 0,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, reject, resolve };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
