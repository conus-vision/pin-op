import {
  PROTOCOL_VERSION,
  type InspectRuleEvidenceBatch,
  type ResolutionMessage,
  type RulesSourcesMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it } from "vitest";
import {
  InspectCorrelationStore,
} from "../src/inspectCorrelationStore.js";
import {
  createTransportTrustedIdePeerContext,
  type TrustedIdePeerContext,
} from "../src/trustedIdePeerContext.js";

describe("InspectCorrelationStore", () => {
  it("routes only increasing resolution generations to the recorded channel", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();

    expect(store.accept(resolution("inspect-a", 2), trusted)).toBe("panel-a");
    expect(store.accept(resolution("inspect-a", 2), trusted)).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 1), trusted)).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3), trusted)).toBe("panel-a");
    expect(store.accept(resolution("inspect-missing", 1), trusted)).toBeUndefined();
  });

  it("removes a failed send without disturbing other correlations", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    store.record("panel-b", "inspect-b", 8, 20, serializedRuleEvidence());

    store.discard("inspect-a");

    expect(store.accept(resolution("inspect-a", 1), trustedPeer())).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1), trustedPeer({ windowId: 20 }))).toBe("panel-b");
  });

  it("keeps only the newest inspect correlation for each panel channel", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a-old", 7, 10, serializedRuleEvidence());
    store.record("panel-b", "inspect-b", 8, 20, serializedRuleEvidence());

    store.record("panel-a", "inspect-a-current", 7, 10, serializedRuleEvidence());

    expect(store.accept(resolution("inspect-a-old", 1), trustedPeer())).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1), trustedPeer({ windowId: 20 }))).toBe("panel-b");
    expect(store.accept(resolution("inspect-a-current", 1), trustedPeer())).toBe("panel-a");
  });

  it("returns an immutable local route without granting IDE authority", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());

    const route = store.routeForInspect("inspect-a");

    expect(route).toEqual({
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      tabId: 7,
      windowId: 10,
      expectedRuleRefs: new Set(),
    });
    expect(Object.isFrozen(route)).toBe(true);
    expect(store.routeForInspect("inspect-missing")).toBeUndefined();
    expect(store.routeForInspect({ toString: () => "inspect-a" }))
      .toBeUndefined();
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toBeUndefined();
  });

  it("is bounded by least-recently-used correlations", () => {
    const store = new InspectCorrelationStore(2);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    store.record("panel-b", "inspect-b", 8, 20, serializedRuleEvidence());
    expect(store.accept(resolution("inspect-a", 1), trustedPeer())).toBe("panel-a");

    store.record("panel-c", "inspect-c", 9, 30, serializedRuleEvidence());

    expect(store.accept(resolution("inspect-b", 1), trustedPeer({ windowId: 20 }))).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 2), trustedPeer())).toBe("panel-a");
    expect(store.accept(resolution("inspect-c", 1), trustedPeer({ windowId: 30 }))).toBe("panel-c");
  });

  it("drops every correlation owned by a disposed panel channel", () => {
    const store = new InspectCorrelationStore(256);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    store.record("panel-a", "inspect-b", 7, 10, serializedRuleEvidence());
    store.record("panel-b", "inspect-c", 8, 20, serializedRuleEvidence());

    store.disposeChannel("panel-a");

    expect(store.accept(resolution("inspect-a", 1), trustedPeer())).toBeUndefined();
    expect(store.accept(resolution("inspect-b", 1), trustedPeer())).toBeUndefined();
    expect(store.accept(resolution("inspect-c", 1), trustedPeer({ windowId: 20 }))).toBe("panel-b");
  });

  it("repeatedly accepts navigation state only at the current resolution generation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();
    expect(store.accept(resolution("inspect-a", 2), trusted)).toBe("panel-a");
    const current = sourceNavigationState("inspect-a", 2, 0);

    expect(store.acceptNavigationState(current, trusted)).toBe("panel-a");
    expect(store.acceptNavigationState(current, trusted)).toBe("panel-a");
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-a", 1), trusted),
    ).toBeUndefined();
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-missing", 2), trusted),
    ).toBeUndefined();
    expect(store.acceptNavigationState({
      ...current,
      activeMatchIndex: 2,
    } as SourceNavigationStateMessage, trusted)).toBeUndefined();

    expect(store.accept(resolution("inspect-a", 2), trusted)).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3), trusted)).toBe("panel-a");
    expect(store.acceptNavigationState(current, trusted)).toBeUndefined();
    expect(
      store.acceptNavigationState(sourceNavigationState("inspect-a", 3), trusted),
    ).toBe("panel-a");
  });

  it("repeatedly authorizes only the exact current navigation correlation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();
    expect(store.accept(resolution("inspect-a", 2), trusted)).toBe("panel-a");
    const current = {
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 2,
      tabId: 7,
    };

    expect(store.authorizeNavigation(current)).toBe(true);
    expect(store.authorizeNavigation(current)).toBe(true);
    expect(store.authorizeNavigation({
      ...current,
      inspectMessageId: "inspect-missing",
    })).toBe(false);
    expect(store.authorizeNavigation({
      ...current,
      resolutionGeneration: 1,
    })).toBe(false);
    expect(store.authorizeNavigation({
      ...current,
      channel: "panel-b",
    })).toBe(false);
    expect(store.authorizeNavigation({ ...current, tabId: 8 })).toBe(false);

    expect(store.accept(resolution("inspect-a", 2), trusted)).toBeUndefined();
    expect(store.accept(resolution("inspect-a", 3), trusted)).toBe("panel-a");
  });

  it("authorizes source open only for the exact published IDE match authority", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const resolutionContext = trustedPeer();
    const matchesContext = trustedPeer();
    expect(store.accept(matchedResolution("inspect-a", 1), resolutionContext)).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1), matchesContext)).toBe(
      "panel-a",
    );
    const current = sourceOpenRoute();

    const authority = store.authorizeSourceOpen(current);
    expect(authority).toMatchObject(current);
    expect(authority?.context).toBe(matchesContext);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(store.authorizeSourceOpen(current)?.context).toBe(matchesContext);
    expect(store.authorizeSourceOpen({ ...current, matchId: "unknown" })).toBeUndefined();
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 0,
    })).toBeUndefined();
    expect(store.authorizeSourceOpen({ ...current, channel: "panel-b" })).toBeUndefined();
    expect(store.authorizeSourceOpen({ ...current, tabId: 8 })).toBeUndefined();
    expect(store.authorizeSourceOpen({ ...current, windowId: 11 })).toBeUndefined();
    expect(store.authorizeSourceOpen(
      { ...current, uri: "file:///card.scss" },
    )).toBeUndefined();
  });

  it("authorizes presentation settings only from exact local routing facts", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const resolutionContext = trustedPeer();
    const route = presentationSettingsRoute();

    expect(store.authorizePresentationSettings(route)).toBeUndefined();
    expect(store.accept(matchedResolution("inspect-a", 1), resolutionContext)).toBe(
      "panel-a",
    );

    const resolutionAuthority = store.authorizePresentationSettings(route);
    expect(resolutionAuthority).toMatchObject({
      ...route,
      resolutionGeneration: 1,
    });
    expect(resolutionAuthority?.context).toBe(resolutionContext);
    expect(Object.isFrozen(resolutionAuthority)).toBe(true);

    const matchesContext = trustedPeer();
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      matchesContext,
    )).toBe("panel-a");
    expect(store.authorizePresentationSettings(route)?.context).toBe(
      matchesContext,
    );
    expect(store.authorizePresentationSettings({
      ...route,
      inspectMessageId: "inspect-missing",
    })).toBeUndefined();
    expect(store.authorizePresentationSettings({
      ...route,
      channel: "panel-b",
    })).toBeUndefined();
    expect(store.authorizePresentationSettings({ ...route, tabId: 8 }))
      .toBeUndefined();
    expect(store.authorizePresentationSettings({ ...route, windowId: 11 }))
      .toBeUndefined();
    expect(store.authorizePresentationSettings({
      ...route,
      sourceId: "panel-spoof",
    })).toBeUndefined();
  });

  it("requires a current resolution for nonempty matches and accepts empty pre-resolution invalidation without authority", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 9, {
      matches: [],
    }), trusted)).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBeUndefined();
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toBeUndefined();

    expect(store.accept(matchedResolution("inspect-a", 1), trusted)).toBe("panel-a");
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1), trusted)).toBe(
      "panel-a",
    );
    expect(store.authorizeSourceOpen(sourceOpenRoute())?.context).toBe(trusted);

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [],
    }), trusted)).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBeUndefined();
    expect(store.authorizePresentationSettings(presentationSettingsRoute())?.context)
      .toBe(trusted);
  });

  it("rejects foreign pre-resolution match invalidation after Rules pins the owner", () => {
    const store = new InspectCorrelationStore(4);
    store.record(
      "panel-a",
      "inspect-a",
      7,
      10,
      serializedRuleEvidence("rule-a"),
    );
    const owner = trustedPeer();
    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 1, ["rule-a"]),
      owner,
    )).toBe("panel-a");
    const rulesAuthority = store.authorizeRulesOpen(rulesOpenRoute());
    expect(rulesAuthority).toBeDefined();
    if (!rulesAuthority) {
      throw new Error("Expected current Rules authority");
    }
    const sourceOpenBefore = store.authorizeSourceOpen(sourceOpenRoute());
    const presentationBefore = store.authorizePresentationSettings(
      presentationSettingsRoute(),
    );
    expect(sourceOpenBefore).toBeUndefined();
    expect(presentationBefore).toBeUndefined();
    const foreignPeer = trustedPeer({ sourceId: "vscode-b" });

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      sourceId: "vscode-b",
      matches: [],
    }), foreignPeer)).toBeUndefined();

    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBe(sourceOpenBefore);
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toBe(presentationBefore);
    expect(store.authorizeRulesOpen(rulesOpenRoute())?.context).toBe(owner);
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [],
    }), owner)).toBe("panel-a");
    expect(store.discardRulesOpenAuthority(rulesAuthority)).toBe(true);
  });

  it("rejects stale, foreign, and duplicate match publications atomically", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    expect(store.accept(matchedResolution("inspect-a", 1), trustedPeer())).toBe(
      "panel-a",
    );
    const acceptedContext = trustedPeer();
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      acceptedContext,
    )).toBe("panel-a");
    const current = sourceOpenRoute();
    const trusted = trustedPeer();

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 0), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-b", 1), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      sourceId: "vscode-b",
    }), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      sessionId: "session-b",
    }), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      documentLabel: "other.scss",
    }), trusted)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [excerpt("selected-1"), excerpt("selected-1")],
    }), trusted)).toBeUndefined();

    expect(store.authorizeSourceOpen(current)?.context).toBe(acceptedContext);
  });

  it("revokes pinned authority on a new resolution, inspect, discard, channel, tab, or window disposal", () => {
    const store = readySourceStore();
    const current = sourceOpenRoute();
    const trusted = trustedPeer();

    expect(store.accept(matchedResolution("inspect-a", 2), trusted)).toBe("panel-a");
    expect(store.authorizeSourceOpen(current)).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 2), trusted)).toBe(
      "panel-a",
    );
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 2,
    })?.context).toBe(trusted);

    store.record("panel-a", "inspect-b", 7, 10, serializedRuleEvidence());
    expect(store.authorizeSourceOpen({
      ...current,
      resolutionGeneration: 2,
    })).toBeUndefined();

    populateSourceStore(store, trusted);
    store.discard("inspect-a");
    expect(store.authorizeSourceOpen(current)).toBeUndefined();

    populateSourceStore(store, trusted);
    store.disposeTab(7);
    expect(store.authorizeSourceOpen(current)).toBeUndefined();

    populateSourceStore(store, trusted);
    store.disposeChannel("panel-a");
    expect(store.authorizeSourceOpen(current)).toBeUndefined();

    populateSourceStore(store, trusted);
    store.disposeWindow(10);
    expect(store.authorizeSourceOpen(current)).toBeUndefined();
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toBeUndefined();
  });

  it("discards only the exact still-current source presentation authority", () => {
    const store = readySourceStore();
    const oldAuthority = store.authorizePresentationSettings(
      presentationSettingsRoute(),
    );
    expect(oldAuthority).toBeDefined();
    if (!oldAuthority) {
      throw new Error("Expected initial source presentation authority");
    }
    const nextContext = trustedPeer();
    expect(store.accept(matchedResolution("inspect-a", 2), nextContext)).toBe(
      "panel-a",
    );
    const currentAuthority = store.authorizePresentationSettings(
      presentationSettingsRoute(),
    );
    expect(currentAuthority?.context).toBe(nextContext);
    if (!currentAuthority) {
      throw new Error("Expected replacement source presentation authority");
    }
    expect(store.discardSourcePresentationAuthority(oldAuthority)).toBe(false);
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toMatchObject({ resolutionGeneration: 2, context: nextContext });
    expect(store.discardSourcePresentationAuthority(currentAuthority)).toBe(
      true,
    );
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toBeUndefined();
  });

  it("preserves a correlation changed by same-generation match invalidation", () => {
    const store = readySourceStore();
    const authority = store.authorizeSourceOpen(sourceOpenRoute());
    expect(authority).toBeDefined();
    if (!authority) {
      throw new Error("Expected current source open authority");
    }

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [],
    }), authority.context)).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBeUndefined();
    expect(store.discardSourcePresentationAuthority(authority)).toBe(false);
    expect(store.authorizePresentationSettings(presentationSettingsRoute()))
      .toMatchObject({
        resolutionGeneration: 1,
        context: authority.context,
      });
  });

  it("rejects accessor-backed source authority without invoking it", () => {
    const store = readySourceStore();
    let getterCalls = 0;
    const hostile = sourceOpenRoute() as unknown as Record<string, unknown>;
    Object.defineProperty(hostile, "matchId", {
      enumerable: true,
      get() {
        getterCalls += 1;
        throw new Error("getter must not run");
      },
    });

    expect(() => store.authorizeSourceOpen(hostile)).not.toThrow();
    expect(store.authorizeSourceOpen(hostile)).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  it("requires an opaque trusted peer context before resolution authority mutation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const spoof = {
      windowId: 10,
      sessionId: "session-a",
      source: { role: "ide", id: "vscode-a" },
    } as unknown as TrustedIdePeerContext;

    expect(store.accept(matchedResolution("inspect-a", 1), spoof)).toBeUndefined();

    const trusted = trustedPeer();
    expect(Object.isFrozen(trusted)).toBe(true);
    expect(Object.isFrozen(trusted.source)).toBe(true);
    expect(store.accept(matchedResolution("inspect-a", 1), trusted)).toBe(
      "panel-a",
    );
  });

  it("rejects payload identity spoofing without consuming the resolution generation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();
    const spoofed = {
      ...matchedResolution("inspect-a", 1),
      source: { role: "ide", id: "vscode-b" },
    } as ResolutionMessage;

    expect(store.accept(spoofed, trusted)).toBeUndefined();
    expect(store.accept(matchedResolution("inspect-a", 1), trusted)).toBe(
      "panel-a",
    );
  });

  it("requires the same trusted route for matches and navigation", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const trusted = trustedPeer();
    const otherWindow = trustedPeer({ windowId: 11 });
    expect(store.accept(matchedResolution("inspect-a", 1), trusted)).toBe(
      "panel-a",
    );

    expect(
      store.acceptSourceMatches(sourceMatches("inspect-a", 1), otherWindow),
    ).toBeUndefined();
    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1), trusted)).toBe(
      "panel-a",
    );
    expect(
      store.acceptNavigationState(
        sourceNavigationState("inspect-a", 1),
        otherWindow,
      ),
    ).toBeUndefined();
    expect(
      store.acceptNavigationState(
        sourceNavigationState("inspect-a", 1),
        trusted,
      ),
    ).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())?.context).toBe(trusted);
  });

  it("does not replace pinned authority for stale or spoofed match contexts", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const firstResolutionContext = trustedPeer();
    expect(store.accept(
      matchedResolution("inspect-a", 1),
      firstResolutionContext,
    )).toBe("panel-a");
    const firstMatchesContext = trustedPeer();
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      firstMatchesContext,
    )).toBe("panel-a");

    const currentResolutionContext = trustedPeer();
    expect(store.accept(
      matchedResolution("inspect-a", 2),
      currentResolutionContext,
    )).toBe("panel-a");
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      firstMatchesContext,
    )).toBeUndefined();
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 2),
      trustedPeer({ sessionId: "session-b" }),
    )).toBeUndefined();

    expect(store.authorizePresentationSettings(presentationSettingsRoute())?.context)
      .toBe(currentResolutionContext);
    expect(store.authorizeSourceOpen({
      ...sourceOpenRoute(),
      resolutionGeneration: 2,
    })).toBeUndefined();
  });

  it("does not route pre-resolution invalidation from a spoofed context", () => {
    const store = new InspectCorrelationStore(4);
    store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
    const spoof = {
      windowId: 10,
      sessionId: "session-a",
      source: { role: "ide", id: "vscode-a" },
    } as unknown as TrustedIdePeerContext;

    expect(store.acceptSourceMatches(sourceMatches("inspect-a", 1, {
      matches: [],
    }), spoof)).toBeUndefined();
    expect(store.authorizeSourceOpen(sourceOpenRoute())).toBeUndefined();
  });

  it("snapshots the exact expected refs from the final serialized evidence batch", () => {
    const store = new InspectCorrelationStore(4);
    const evidence = serializedRuleEvidence("rule-a", "rule-b");
    store.record("panel-a", "inspect-a", 7, 10, evidence);

    const route = store.routeForInspect("inspect-a");
    expect(route).toMatchObject({
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      tabId: 7,
      windowId: 10,
      expectedRuleRefs: new Set(["rule-a", "rule-b"]),
    });
    expect(Object.isFrozen(route)).toBe(true);

    (evidence.rules as { ruleRef: string }[]).splice(0);
    (route?.expectedRuleRefs as Set<string> | undefined)?.clear();
    expect(store.routeForInspect("inspect-a")?.expectedRuleRefs).toEqual(
      new Set(["rule-a", "rule-b"]),
    );
  });

  it("keeps Rules authority current across active-editor Source resolution and navigation", () => {
    const store = new InspectCorrelationStore(4);
    store.record(
      "panel-a",
      "inspect-a",
      7,
      10,
      serializedRuleEvidence("rule-a"),
    );
    const rulesContext = trustedPeer();
    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 1, ["rule-a"]),
      rulesContext,
    )).toBe("panel-a");
    const current = rulesOpenRoute();
    const authority = store.authorizeRulesOpen(current);
    expect(authority).toMatchObject(current);
    expect(authority?.context).toBe(rulesContext);
    expect(Object.isFrozen(authority)).toBe(true);

    const sourceContext = trustedPeer();
    expect(store.accept(matchedResolution("inspect-a", 40), sourceContext)).toBe(
      "panel-a",
    );
    expect(store.acceptNavigationState(
      sourceNavigationState("inspect-a", 40, 0),
      sourceContext,
    )).toBe("panel-a");
    expect(store.authorizeNavigation({
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 40,
      tabId: 7,
    })).toBe(true);
    expect(store.authorizeRulesOpen(current)?.context).toBe(rulesContext);
  });

  it("keeps Source authority current across newer Rules source generations", () => {
    const store = new InspectCorrelationStore(4);
    store.record(
      "panel-a",
      "inspect-a",
      7,
      10,
      serializedRuleEvidence("rule-a"),
    );
    const sourceContext = trustedPeer();
    expect(store.accept(matchedResolution("inspect-a", 1), sourceContext)).toBe(
      "panel-a",
    );
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      sourceContext,
    )).toBe("panel-a");
    expect(store.authorizeSourceOpen(sourceOpenRoute())?.context).toBe(
      sourceContext,
    );

    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 1, ["rule-a"]),
      trustedPeer(),
    )).toBe("panel-a");
    const secondRulesContext = trustedPeer();
    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 2, ["rule-a"]),
      secondRulesContext,
    )).toBe("panel-a");

    expect(store.authorizeSourceOpen(sourceOpenRoute())?.context).toBe(
      sourceContext,
    );
    expect(store.authorizeNavigation({
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      tabId: 7,
    })).toBe(true);
    expect(store.authorizeRulesOpen({
      ...rulesOpenRoute(),
      rulesGeneration: 2,
    })?.context).toBe(secondRulesContext);
  });

  it("fences a prepared Rules commit behind the current authority revision", () => {
    const store = readyRulesStore();
    const context = trustedPeer();
    const prepared = store.prepareRulesSources(
      rulesSources("inspect-a", 2, ["rule-a"]),
      context,
    );
    expect(prepared?.channel).toBe("panel-a");

    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 3, ["rule-a"]),
      context,
    )).toBe("panel-a");
    expect(prepared?.commit()).toBe(false);
    expect(store.authorizeRulesOpen({
      ...rulesOpenRoute(),
      rulesGeneration: 2,
    })).toBeUndefined();
    expect(store.authorizeRulesOpen({
      ...rulesOpenRoute(),
      rulesGeneration: 3,
    })).toBeDefined();
  });

  it("rejects invalid Rules publications without mutating either namespace", () => {
    const store = new InspectCorrelationStore(4);
    store.record(
      "panel-a",
      "inspect-a",
      7,
      10,
      serializedRuleEvidence("rule-a"),
    );
    const sourceContext = trustedPeer();
    expect(store.accept(matchedResolution("inspect-a", 1), sourceContext)).toBe(
      "panel-a",
    );
    expect(store.acceptSourceMatches(
      sourceMatches("inspect-a", 1),
      sourceContext,
    )).toBe("panel-a");
    const rulesContext = trustedPeer();
    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 1, ["rule-a"]),
      rulesContext,
    )).toBe("panel-a");

    const foreignContext = trustedPeer({ sourceId: "vscode-b" });
    const foreignPublication = {
      ...rulesSources("inspect-a", 2, ["rule-a"]),
      source: { role: "ide", id: "vscode-b" },
    } as RulesSourcesMessage;
    for (const [message, context] of [
      [rulesSources("inspect-a", 1, ["rule-a"]), rulesContext],
      [rulesSources("inspect-a", 2, ["unexpected-rule"]), rulesContext],
      [rulesSources("inspect-a", 2, []), rulesContext],
      [foreignPublication, foreignContext],
    ] as const) {
      expect(store.acceptRulesSources(message, context)).toBeUndefined();
    }

    expect(store.authorizeSourceOpen(sourceOpenRoute())?.context).toBe(
      sourceContext,
    );
    expect(store.authorizeNavigation({
      channel: "panel-a",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      tabId: 7,
    })).toBe(true);
    expect(store.authorizeRulesOpen(rulesOpenRoute())?.context).toBe(
      rulesContext,
    );
  });

  it("fences same-selection Rules renewal behind a new inspect route", () => {
    const store = readyRulesStore();
    const stale = store.authorizeRulesOpen(rulesOpenRoute());
    expect(stale).toBeDefined();

    store.record(
      "panel-a",
      "inspect-renewed",
      7,
      10,
      serializedRuleEvidence("rule-renewed"),
    );

    expect(store.routeForInspect("inspect-a")).toBeUndefined();
    expect(store.authorizeRulesOpen(rulesOpenRoute())).toBeUndefined();
    expect(stale && store.discardRulesOpenAuthority(stale)).toBe(false);
    expect(store.routeForInspect("inspect-renewed")).toMatchObject({
      channel: "panel-a",
      inspectMessageId: "inspect-renewed",
      tabId: 7,
      windowId: 10,
      expectedRuleRefs: new Set(["rule-renewed"]),
    });
    expect(store.acceptRulesSources(
      rulesSources("inspect-a", 2, ["rule-a"]),
      trustedPeer(),
    )).toBeUndefined();
  });

  it.each([
    ["selection", (store: InspectCorrelationStore) => store.record(
      "panel-a",
      "inspect-next",
      7,
      10,
      serializedRuleEvidence("rule-next"),
    )],
    ["stylesheet refresh", (store: InspectCorrelationStore) =>
      store.disposeWindow(10)],
    ["page refresh", (store: InspectCorrelationStore) =>
      store.disposeWindow(10)],
    ["document navigation", (store: InspectCorrelationStore) =>
      store.disposeTab(7)],
    ["frame navigation", (store: InspectCorrelationStore) =>
      store.disposeChannel("panel-a")],
    ["disconnect", (store: InspectCorrelationStore) =>
      store.disposeWindow(10)],
    ["protocol mismatch", (store: InspectCorrelationStore) =>
      store.disposeWindow(10)],
    ["disposal", (store: InspectCorrelationStore) =>
      store.discard("inspect-a")],
  ] as const)("revokes Rules authority on %s", (_reason, revoke) => {
    const store = readyRulesStore();
    const authority = store.authorizeRulesOpen(rulesOpenRoute());
    expect(authority).toBeDefined();

    revoke(store);

    expect(store.authorizeRulesOpen(rulesOpenRoute())).toBeUndefined();
    expect(authority && store.discardRulesOpenAuthority(authority)).toBe(false);
  });
});

function resolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: `resolution-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    status: "no-active-editor",
    selectedMatchCount: 0,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function matchedResolution(
  inspectMessageId: string,
  resolutionGeneration: number,
): ResolutionMessage {
  return {
    ...resolution(inspectMessageId, resolutionGeneration),
    status: "matched",
    document: { label: "card.scss", languageId: "scss" },
    selectedMatchCount: 1,
  };
}

function sourceMatches(
  inspectMessageId: string,
  resolutionGeneration: number,
  overrides: {
    readonly sourceId?: string;
    readonly sessionId?: string;
    readonly documentLabel?: string;
    readonly matches?: readonly SourceExcerpt[];
  } = {},
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: overrides.sessionId ?? "session-a",
    source: { role: "ide", id: overrides.sourceId ?? "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    document: {
      label: overrides.documentLabel ?? "card.scss",
      languageId: "scss",
    },
    matches: overrides.matches ?? [excerpt("selected-1")],
    omittedMatchCount: 0,
    metadata: {},
  };
}

function excerpt(matchId: string): SourceExcerpt {
  return {
    matchId,
    targetRole: "selected",
    label: `${matchId}.scss:1`,
    kind: "rule",
    relation: "selected",
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: `.${matchId} {\n  color: red;\n}`,
    truncated: false,
  };
}

function sourceOpenRoute() {
  return {
    channel: "panel-a",
    tabId: 7,
    windowId: 10,
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    matchId: "selected-1",
  } as const;
}

function presentationSettingsRoute() {
  return {
    channel: "panel-a",
    tabId: 7,
    windowId: 10,
    inspectMessageId: "inspect-a",
  } as const;
}

function trustedPeer(
  overrides: {
    readonly windowId?: number;
    readonly sessionId?: string;
    readonly sourceId?: string;
  } = {},
): TrustedIdePeerContext {
  return createTransportTrustedIdePeerContext(
    overrides.windowId ?? 10,
    overrides.sessionId ?? "session-a",
    overrides.sourceId ?? "vscode-a",
  );
}

function readySourceStore(): InspectCorrelationStore {
  const store = new InspectCorrelationStore(4);
  populateSourceStore(store, trustedPeer());
  return store;
}

function populateSourceStore(
  store: InspectCorrelationStore,
  context: TrustedIdePeerContext,
): void {
  store.record("panel-a", "inspect-a", 7, 10, serializedRuleEvidence());
  store.accept(matchedResolution("inspect-a", 1), context);
  store.acceptSourceMatches(sourceMatches("inspect-a", 1), context);
}

function sourceNavigationState(
  inspectMessageId: string,
  resolutionGeneration: number,
  activeMatchIndex?: number,
): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `source-state-${inspectMessageId}-${resolutionGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    resolutionGeneration,
    selectedMatchCount: activeMatchIndex === undefined ? 0 : 2,
    ...(activeMatchIndex === undefined ? {} : { activeMatchIndex }),
    metadata: {},
  };
}

function serializedRuleEvidence(
  ...ruleRefs: readonly string[]
): InspectRuleEvidenceBatch {
  return JSON.parse(JSON.stringify({
    rules: ruleRefs.map((ruleRef) => ({
      ruleRef,
      selector: `.${ruleRef}`,
      declarations: [],
      declarationsTruncated: false,
    })),
    omittedRuleCount: 0,
  })) as InspectRuleEvidenceBatch;
}

function rulesSources(
  inspectMessageId: string,
  rulesGeneration: number,
  ruleRefs: readonly string[],
): RulesSourcesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "rules.sources",
    messageId: `rules-sources-${inspectMessageId}-${rulesGeneration}`,
    sessionId: "session-a",
    source: { role: "ide", id: "vscode-a" },
    inspectMessageId,
    rulesGeneration,
    sources: ruleRefs.map((ruleRef) => ({
      ruleRef,
      openAuthorityId: `open-${ruleRef}`,
      document: { label: `${ruleRef}.scss`, languageId: "scss" },
      startLine: 1,
      startColumn: 1,
      confidence: "exact",
    })),
    unresolvedRuleCount: 0,
    metadata: {},
  };
}

function rulesOpenRoute() {
  return {
    channel: "panel-a",
    tabId: 7,
    windowId: 10,
    inspectMessageId: "inspect-a",
    rulesGeneration: 1,
    openAuthorityId: "open-rule-a",
  } as const;
}

function readyRulesStore(): InspectCorrelationStore {
  const store = new InspectCorrelationStore(4);
  store.record(
    "panel-a",
    "inspect-a",
    7,
    10,
    serializedRuleEvidence("rule-a"),
  );
  const accepted = store.acceptRulesSources(
    rulesSources("inspect-a", 1, ["rule-a"]),
    trustedPeer(),
  );
  if (accepted !== "panel-a") {
    throw new Error("Expected current Rules authority");
  }
  return store;
}
