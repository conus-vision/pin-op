import {
  PROTOCOL_VERSION,
  type ResolutionMessage,
  type SourceExcerpt,
  type SourceMatchesMessage,
  type SourceNavigationStateMessage,
} from "@pin-op/protocol";
import { describe, expect, it, vi } from "vitest";
import { SourcePaneController } from "../src/sourcePaneController.js";
import {
  SourcePaneView,
  type SourcePaneViewState,
} from "../src/sourcePaneView.js";

describe("SourcePaneView", () => {
  it("renders hostile document and excerpt strings as text without creating markup", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected", {
        label: "<img src=x onerror=alert(1)>",
        text: "</code><script>alert(1)</script>",
      }),
    ], {
      documentLabel: "<svg/onload=alert(1)>",
      languageId: "scss<script>",
    });

    expect(harness.root.text()).toContain("<svg/onload=alert(1)>");
    expect(harness.root.text()).toContain("scss<script>");
    expect(harness.root.text()).toContain("<img src=x onerror=alert(1)>");
    expect(harness.root.text()).toContain("</code><script>alert(1)</script>");
    expect(harness.dom.createdTags()).not.toContain("script");
    expect(harness.dom.createdTags()).not.toContain("img");
    expect(harness.dom.innerHtmlWrites).toBe(0);
  });

  it("renders only model document metadata and bounded excerpt details", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected", {
        label: "card.scss rule",
        startLine: 7,
        endLine: 11,
        truncated: true,
      }),
    ], { omittedMatchCount: 3 });

    expect(harness.root.text()).toContain("card.scss");
    expect(harness.root.text()).toContain("scss");
    expect(harness.root.text()).toContain("Lines 7-11");
    expect(harness.root.text()).toContain("Excerpt truncated");
    expect(harness.root.text()).toContain("3 additional matches omitted");
    expect(harness.root.text()).not.toContain("file://");
    const item = harness.item("selected-1");
    expect(item.findTag("pre")?.findTag("code")?.text()).toContain("color: red");
  });

  it("uses semantic list items with concise Open buttons outside excerpts", () => {
    const longExcerpt = "x".repeat(8 * 1024);
    const harness = createHarness([
      excerpt("selected-1", "selected", {
        label: "card.scss rule",
        startLine: 7,
        endLine: 11,
        text: longExcerpt,
      }),
    ]);

    const list = harness.groupList("selected");
    const item = harness.item("selected-1");
    const button = harness.openButton("selected-1");
    const code = item.findTag("code");

    expect(list.tagName).toBe("ul");
    expect(list.getAttribute("role")).toBeNull();
    expect(item.tagName).toBe("li");
    expect(item.getAttribute("role")).toBeNull();
    expect(item.tabIndex).toBe(-1);
    expect(button.tagName).toBe("button");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.text()).toBe("Open");
    expect(button.getAttribute("aria-label")).toBe(
      "Open card.scss rule, Lines 7-11",
    );
    expect(button.getAttribute("aria-label")).not.toContain(longExcerpt);
    expect(button.findTag("code")).toBeUndefined();
    expect(code?.text()).toBe(longExcerpt);
    expect(code?.parentElement?.tagName).toBe("pre");
    expect(code?.parentElement?.parentElement).toBe(item);
  });

  it("opens an exact match ID and never constructs a path or range command", () => {
    const dispatch = vi.fn();
    const harness = createHarness([
      excerpt("opaque-match", "selected", {
        label: "hostile/path.scss:300",
        startLine: 300,
        endLine: 400,
      }),
    ], { dispatch });

    harness.root.dispatch("click", {
      target: harness.item("opaque-match").findTag("code"),
    });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({
      type: "pin-op.source.open",
      inspectMessageId: "inspect-a",
      resolutionGeneration: 1,
      matchId: "opaque-match",
    });
    expect(Object.keys(dispatch.mock.calls[0]![0]).sort()).toEqual([
      "inspectMessageId",
      "matchId",
      "resolutionGeneration",
      "type",
    ]);
  });

  it("limits keyboard activation to the concise Open button", () => {
    const dispatch = vi.fn();
    const harness = createHarness([
      excerpt("opaque-match", "selected"),
    ], { dispatch });

    harness.root.dispatch("keydown", {
      target: harness.item("opaque-match"),
      key: "Enter",
    });
    expect(dispatch).not.toHaveBeenCalled();

    const event = harness.root.dispatch("keydown", {
      target: harness.openButton("opaque-match"),
      key: "Enter",
    });
    expect(event.defaultPrevented).toBe(true);
    expect(dispatch.mock.calls.map(([message]) => message.matchId)).toEqual([
      "opaque-match",
    ]);
  });

  it("starts Selected expanded and Parent collapsed, then toggles accessibly", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
    ]);

    expect(harness.row("selected-1")).toBeDefined();
    expect(harness.root.findByData("matchId", "parent-1")).toBeUndefined();
    const parentToggle = harness.groupToggle("parent");
    expect(parentToggle.getAttribute("aria-expanded")).toBe("false");

    const event = harness.root.dispatch("keydown", {
      target: parentToggle,
      key: "Enter",
    });

    expect(event.defaultPrevented).toBe(true);
    expect(harness.groupToggle("parent").getAttribute("aria-expanded")).toBe("true");
    expect(harness.row("parent-1")).toBeDefined();

    harness.root.dispatch("keydown", {
      target: harness.groupToggle("selected"),
      key: " ",
    });
    expect(harness.root.findByData("matchId", "selected-1")).toBeUndefined();
  });

  it("restores focus to the equivalent disclosure after toggling", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
    ]);
    const previousToggle = harness.groupToggle("parent");
    previousToggle.focus();

    harness.root.dispatch("click", { target: previousToggle });

    const currentToggle = harness.groupToggle("parent");
    expect(currentToggle).not.toBe(previousToggle);
    expect(harness.dom.activeElement).toBe(currentToggle);
  });

  it("restores focus to the equivalent Open button after navigation rerenders", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);
    const previousButton = harness.openButton("selected-1");
    previousButton.focus();

    harness.controller.acceptNavigationState(navigationState("selected-2"));

    const currentButton = harness.openButton("selected-1");
    expect(currentButton).not.toBe(previousButton);
    expect(harness.dom.activeElement).toBe(currentButton);
  });

  it("does not steal outside focus during source rerenders", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);
    const outsideButton = harness.dom.createElement("button");
    outsideButton.focus();

    harness.controller.acceptNavigationState(navigationState("selected-2"));

    expect(harness.dom.activeElement).toBe(outsideButton);
  });

  it("safely leaves focus unset when the focused match vanishes", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
    ]);
    harness.openButton("selected-1").focus();

    expect(() => harness.controller.acceptMatches(sourceMatches([
      excerpt("selected-2", "selected"),
    ]))).not.toThrow();

    expect(harness.dom.activeElement).toBeUndefined();
  });

  it("contains focus restoration failures", () => {
    const errors: unknown[] = [];
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ], { onError: (error) => errors.push(error) });
    harness.openButton("selected-1").focus();
    harness.dom.throwOnFocus = true;

    expect(() => {
      harness.controller.acceptNavigationState(navigationState("selected-2"));
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(harness.dom.activeElement).toBeUndefined();
  });

  it("preserves disclosure state across navigation updates and resets it for new matches", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
    ]);
    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    expect(harness.row("parent-1")).toBeDefined();

    harness.controller.acceptNavigationState(navigationState("parent-1"));
    expect(harness.row("parent-1")).toBeDefined();

    harness.controller.acceptMatches(sourceMatches([
      excerpt("selected-2", "selected"),
      excerpt("parent-2", "parent"),
    ]));
    expect(harness.root.findByData("matchId", "parent-2")).toBeUndefined();
  });

  it("does not report empty when authoritative matches exist only in collapsed Parent", () => {
    const harness = createHarness([
      excerpt("parent-1", "parent"),
    ]);

    expect(harness.root.findByData("matchId", "parent-1")).toBeUndefined();
    expect(harness.root.findByData("state", "empty")).toBeUndefined();
    expect(harness.root.text()).not.toContain("No source matches");
  });

  it("reports empty when no authoritative matches exist", () => {
    const harness = createHarness([]);

    expect(harness.root.findByData("state", "empty")?.text()).toBe(
      "No source matches",
    );
  });

  it("marks only the active match as selected", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);

    harness.controller.acceptNavigationState(navigationState("selected-2"));

    expect(harness.openButton("selected-1").getAttribute("aria-current")).toBeNull();
    expect(harness.openButton("selected-2").getAttribute("aria-current")).toBe("true");
    expect(harness.item("selected-2").className).toContain("is-active");
  });

  it("provides exactly one roving Open button in each expanded group", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("selected-3", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("parent-2", "parent"),
    ], { activeMatchId: "selected-2" });

    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
      -1,
    ]);
    expect(harness.groupRows("parent")).toEqual([]);

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    expect(harness.groupRows("parent").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);
    expect(harness.groupRows("selected").filter((row) => row.tabIndex === 0)).toHaveLength(1);
    expect(harness.groupRows("parent").filter((row) => row.tabIndex === 0)).toHaveLength(1);
  });

  it("uses the active Parent match as its initial roving target when expanded", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("parent-2", "parent"),
    ], { activeMatchId: "parent-2" });

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });

    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([0]);
    expect(harness.groupRows("parent").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
    ]);
  });

  it("lets a late active match replace the automatic first-button fallback", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);

    harness.controller.acceptNavigationState(navigationState("selected-2"));

    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
    ]);
  });

  it("remembers a clicked non-roving Open button across controller rerenders", () => {
    const dispatch = vi.fn();
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ], { dispatch });

    harness.root.dispatch("click", { target: harness.row("selected-2") });
    expect(harness.row("selected-2").tabIndex).toBe(0);
    expect(dispatch.mock.calls.map(([message]) => message.matchId)).toEqual([
      "selected-2",
    ]);

    harness.controller.acceptNavigationState(navigationState("selected-1"));
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
    ]);
  });

  it.each<SourcePaneViewState>([
    { kind: "loading", statusText: "Loading source excerpts" },
    { kind: "empty", statusText: "No source matches" },
    { kind: "error", statusText: "Could not load <source>" },
    { kind: "incompatible", statusText: "Update <extensions>" },
  ])("renders and disables interactions in $kind state", (state) => {
    const dispatch = vi.fn();
    const harness = createHarness([excerpt("selected-1", "selected")], { dispatch });

    harness.view.setState(state);
    expect(harness.root.text()).toContain(state.statusText);
    expect(harness.root.findByData("state", state.kind)).toBeDefined();

    const staleRow = harness.previousRow ?? harness.root;
    harness.root.dispatch("click", { target: staleRow });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("supports ArrowUp, ArrowDown, Home, End, Enter, and Space among visible entries", () => {
    const dispatch = vi.fn();
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("parent-1", "parent"),
    ], { dispatch });
    const first = harness.row("selected-1");

    harness.root.dispatch("keydown", { target: first, key: "ArrowDown" });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-2");
    harness.root.dispatch("keydown", {
      target: harness.row("selected-2"),
      key: "ArrowUp",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-1");
    harness.root.dispatch("keydown", { target: first, key: "End" });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-2");
    harness.root.dispatch("keydown", {
      target: harness.row("selected-2"),
      key: "Home",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-1");

    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "Enter",
    });
    harness.root.dispatch("keydown", {
      target: harness.row("selected-2"),
      key: " ",
    });
    expect(dispatch.mock.calls.map(([message]) => message.matchId)).toEqual([
      "selected-1",
      "selected-2",
    ]);
  });

  it("keeps Arrow, Home, and End navigation inside the current group", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("selected-3", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("parent-2", "parent"),
    ]);
    harness.root.dispatch("click", { target: harness.groupToggle("parent") });

    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-2");
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
      -1,
    ]);

    harness.root.dispatch("keydown", {
      target: harness.row("selected-2"),
      key: "End",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-3");
    harness.root.dispatch("keydown", {
      target: harness.row("selected-3"),
      key: "ArrowDown",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-3");
    expect(harness.row("parent-1").tabIndex).toBe(0);

    harness.root.dispatch("keydown", {
      target: harness.row("parent-1"),
      key: "End",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("parent-2");
    harness.root.dispatch("keydown", {
      target: harness.row("parent-2"),
      key: "Home",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("parent-1");
    expect(harness.row("selected-3").tabIndex).toBe(0);
    expect(harness.row("parent-1").tabIndex).toBe(0);
  });

  it("preserves a valid roving target across rerenders and drops stale targets", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("selected-3", "selected"),
    ]);
    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });
    expect(harness.row("selected-2").tabIndex).toBe(0);

    harness.controller.acceptNavigationState(navigationState("selected-3"));
    expect(harness.row("selected-2").tabIndex).toBe(0);
    expect(harness.openButton("selected-3").getAttribute("aria-current")).toBe("true");

    harness.controller.acceptMatches(sourceMatches([
      excerpt("selected-2", "selected", { text: ".replacement {}" }),
      excerpt("selected-4", "selected"),
    ]));
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);

    harness.controller.acceptMatches(sourceMatches([
      excerpt("selected-new", "selected"),
    ]));
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([0]);
    expect(harness.row("selected-new").dataset.matchId).toBe("selected-new");
  });

  it("keeps an explicit keyboard target ahead of a late active match", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("selected-3", "selected"),
    ]);
    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });

    harness.controller.acceptNavigationState(navigationState("selected-3"));

    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
      -1,
    ]);
    expect(harness.openButton("selected-3").getAttribute("aria-current")).toBe("true");
  });

  it("drops a removed explicit target and lets the next active match lead", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);
    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });

    harness.controller.acceptMatches(sourceMatches([
      excerpt("replacement-1", "selected"),
      excerpt("replacement-2", "selected"),
    ]));
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);
    harness.controller.acceptNavigationState(navigationState("replacement-2"));
    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
    ]);
  });

  it("clears explicit intent for a newly published match set even when an ID is reused", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
    ]);
    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });
    expect(harness.row("selected-2").tabIndex).toBe(0);

    harness.controller.acceptMatches(sourceMatches([
      excerpt("selected-2", "selected", { text: ".new-authority {}" }),
      excerpt("selected-3", "selected"),
    ]));
    harness.controller.acceptNavigationState(navigationState("selected-3"));

    expect(harness.groupRows("selected").map((row) => row.tabIndex)).toEqual([
      -1,
      0,
    ]);
  });

  it("keeps group choices independent and clears only a collapsed group's intent", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("selected-2", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("parent-2", "parent"),
    ]);
    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "ArrowDown",
    });
    harness.root.dispatch("keydown", {
      target: harness.row("parent-1"),
      key: "ArrowDown",
    });
    expect(harness.row("selected-2").tabIndex).toBe(0);
    expect(harness.row("parent-2").tabIndex).toBe(0);

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    harness.controller.acceptNavigationState(navigationState("parent-1"));
    expect(harness.row("selected-2").tabIndex).toBe(0);
    expect(harness.groupRows("parent")).toEqual([]);

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    expect(harness.groupRows("parent").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);
    expect(harness.row("selected-2").tabIndex).toBe(0);
  });

  it("excludes collapsed Parent entries from keyboard navigation", () => {
    const harness = createHarness([
      excerpt("selected-1", "selected"),
      excerpt("parent-1", "parent"),
      excerpt("parent-2", "parent"),
    ]);

    harness.root.dispatch("keydown", {
      target: harness.row("selected-1"),
      key: "End",
    });
    expect(harness.dom.activeElement?.dataset.matchId).toBe("selected-1");

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    harness.root.dispatch("keydown", {
      target: harness.row("parent-1"),
      key: "ArrowDown",
    });
    expect(harness.row("parent-2").tabIndex).toBe(0);
    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    expect(harness.groupRows("parent")).toEqual([]);
    expect(harness.row("selected-1").tabIndex).toBe(0);

    harness.root.dispatch("click", { target: harness.groupToggle("parent") });
    expect(harness.groupRows("parent").map((row) => row.tabIndex)).toEqual([
      0,
      -1,
    ]);
  });

  it("rejects stale row handlers after model replacement even when an ID is reused", () => {
    const dispatch = vi.fn();
    const harness = createHarness([excerpt("same-match", "selected")], { dispatch });
    const staleRow = harness.row("same-match");

    harness.controller.acceptMatches(sourceMatches([
      excerpt("same-match", "selected", { text: ".replacement {}" }),
    ]));
    harness.root.dispatch("click", { target: staleRow });

    expect(dispatch).not.toHaveBeenCalled();
    harness.root.dispatch("click", { target: harness.row("same-match") });
    expect(dispatch.mock.calls.map(([message]) => message.matchId)).toEqual([
      "same-match",
    ]);
  });

  it("renders idempotently and prevents all stale interaction after dispose", () => {
    const dispatch = vi.fn();
    const harness = createHarness([excerpt("selected-1", "selected")], { dispatch });
    const staleRow = harness.row("selected-1");
    const listenersBefore = harness.root.listenerCount();

    harness.view.render();
    harness.view.render();
    expect(harness.root.listenerCount()).toBe(listenersBefore);

    harness.view.dispose();
    harness.view.dispose();
    expect(harness.root.listenerCount()).toBe(0);
    expect(harness.root.children).toHaveLength(0);
    harness.root.dispatch("click", { target: staleRow });
    harness.controller.acceptNavigationState(navigationState("selected-1"));
    expect(dispatch).not.toHaveBeenCalled();
    expect(harness.root.children).toHaveLength(0);
  });

  it("contains listener and fake-DOM failures", () => {
    const errors: unknown[] = [];
    const harness = createHarness([excerpt("selected-1", "selected")], {
      onError: (error) => errors.push(error),
    });
    harness.root.throwOnReplace = true;

    expect(() => harness.view.render()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

function createHarness(
  matches: readonly SourceExcerpt[],
  options: {
    readonly dispatch?: ReturnType<typeof vi.fn>;
    readonly documentLabel?: string;
    readonly languageId?: string;
    readonly omittedMatchCount?: number;
    readonly onError?: (error: unknown) => void;
    readonly activeMatchId?: string;
  } = {},
) {
  const dom = new FakeDom();
  const dispatch = options.dispatch ?? vi.fn();
  const controller = new SourcePaneController(dispatch);
  controller.setCompatible(true);
  controller.beginInspect("inspect-a");
  controller.acceptResolution(resolution(
    options.documentLabel ?? "card.scss",
    options.languageId ?? "scss",
  ));
  controller.acceptMatches(sourceMatches(matches, options));
  if (options.activeMatchId) {
    controller.acceptNavigationState(navigationState(options.activeMatchId));
  }
  const root = dom.createElement("section");
  const view = new SourcePaneView({
    document: dom as unknown as Document,
    root: root as unknown as HTMLElement,
    controller,
    onError: options.onError,
  });
  const previousRow = root.findByData("matchId", matches[0]?.matchId ?? "");
  return {
    dom,
    root,
    view,
    controller,
    previousRow,
    item(matchId: string): FakeElement {
      const item = root.findByData("matchId", matchId);
      if (!item) throw new Error(`Missing item ${matchId}`);
      return item;
    },
    openButton(matchId: string): FakeElement {
      const button = root.findByData("openMatchId", matchId);
      if (!button) throw new Error(`Missing Open button ${matchId}`);
      return button;
    },
    row(matchId: string): FakeElement {
      const button = root.findByData("openMatchId", matchId);
      if (!button) throw new Error(`Missing row Open button ${matchId}`);
      return button;
    },
    groupToggle(group: "selected" | "parent"): FakeElement {
      const toggle = root.findByData("group", group);
      if (!toggle) throw new Error(`Missing group ${group}`);
      return toggle;
    },
    groupRows(group: "selected" | "parent"): FakeElement[] {
      const list = root.findByData("groupList", group);
      if (!list) return [];
      return list.children.flatMap((child) => {
        if (!(child instanceof FakeElement)) return [];
        const matchId = child.dataset.matchId;
        return matchId
          ? [child.findByData("openMatchId", matchId) ?? child]
          : [];
      });
    },
    groupList(group: "selected" | "parent"): FakeElement {
      const list = root.findByData("groupList", group);
      if (!list) throw new Error(`Missing group list ${group}`);
      return list;
    },
  };
}

function resolution(label: string, languageId: string): ResolutionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "resolution",
    messageId: "resolution-a",
    sessionId: "session-a",
    source: { role: "ide", id: "ide-a" },
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    document: { label, languageId },
    status: "matched",
    selectedMatchCount: 1,
    parentMatchCount: 0,
    inaccessibleStylesheetCount: 0,
    diagnosticCodes: [],
    metadata: {},
  };
}

function sourceMatches(
  matches: readonly SourceExcerpt[],
  options: {
    readonly documentLabel?: string;
    readonly languageId?: string;
    readonly omittedMatchCount?: number;
  } = {},
): SourceMatchesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.matches",
    messageId: `matches-${matches.map((match) => match.matchId).join("-") || "empty"}`,
    sessionId: "session-a",
    source: { role: "ide", id: "ide-a" },
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    document: {
      label: options.documentLabel ?? "card.scss",
      languageId: options.languageId ?? "scss",
    },
    matches,
    omittedMatchCount: options.omittedMatchCount ?? 0,
    metadata: {},
  };
}

function excerpt(
  matchId: string,
  targetRole: "selected" | "parent",
  overrides: Partial<SourceExcerpt> = {},
): SourceExcerpt {
  return {
    matchId,
    targetRole,
    label: `${matchId}.scss:1`,
    kind: "rule",
    relation: targetRole,
    confidence: "exact",
    startLine: 1,
    endLine: 3,
    text: `.${matchId} {\n  color: red;\n}`,
    truncated: false,
    ...overrides,
  };
}

function navigationState(activeMatchId: string): SourceNavigationStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "source.navigationState",
    messageId: `navigation-${activeMatchId}`,
    sessionId: "session-a",
    source: { role: "ide", id: "ide-a" },
    inspectMessageId: "inspect-a",
    resolutionGeneration: 1,
    selectedMatchCount: 2,
    activeMatchId,
    metadata: {},
  };
}

class FakeDom {
  public activeElement: FakeElement | undefined;
  public innerHtmlWrites = 0;
  public throwOnFocus = false;
  private readonly tags: string[] = [];

  public createElement(tagName: string): FakeElement {
    this.tags.push(tagName.toLowerCase());
    return new FakeElement(this, tagName.toLowerCase());
  }

  public createTextNode(text: string): FakeTextNode {
    return new FakeTextNode(text);
  }

  public createdTags(): readonly string[] {
    return this.tags;
  }
}

class FakeTextNode {
  public parentElement: FakeElement | undefined;
  public constructor(public readonly textContent: string) {}
  public text(): string {
    return this.textContent;
  }
}

type FakeChild = FakeElement | FakeTextNode;

class FakeElement {
  public className = "";
  public hidden = false;
  public disabled = false;
  public tabIndex = -1;
  public textContent = "";
  public throwOnReplace = false;
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeChild[] = [];
  public parentElement: FakeElement | undefined;
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Set<(event: FakeEvent) => void>>();

  public constructor(
    private readonly owner: FakeDom,
    public readonly tagName: string,
  ) {}

  public set innerHTML(_value: string) {
    this.owner.innerHtmlWrites += 1;
    throw new Error("innerHTML is forbidden");
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "tabindex") this.tabIndex = Number(value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public append(...children: FakeChild[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  public replaceChildren(...children: FakeChild[]): void {
    if (this.throwOnReplace) throw new Error("hostile replaceChildren");
    if (this.owner.activeElement && this.contains(this.owner.activeElement)) {
      this.owner.activeElement = undefined;
    }
    for (const child of this.children) child.parentElement = undefined;
    this.children.length = 0;
    this.textContent = "";
    this.append(...children);
  }

  public addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: (event: FakeEvent) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  public dispatch(
    type: string,
    init: { readonly key?: string; readonly target?: FakeElement } = {},
  ): FakeEvent {
    const event = new FakeEvent(type, init.target ?? this, init.key);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    return event;
  }

  public focus(): void {
    if (this.owner.throwOnFocus) throw new Error("hostile focus");
    this.owner.activeElement = this;
  }

  public contains(element: FakeElement): boolean {
    let current: FakeElement | undefined = element;
    while (current) {
      if (current === this) return true;
      current = current.parentElement;
    }
    return false;
  }

  public text(): string {
    return this.textContent + this.children.map((child) => child.text()).join("");
  }

  public findByData(key: string, value: string): FakeElement | undefined {
    if (this.dataset[key] === value) return this;
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.findByData(key, value);
        if (found) return found;
      }
    }
    return undefined;
  }

  public findTag(tagName: string): FakeElement | undefined {
    if (this.tagName === tagName) return this;
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.findTag(tagName);
        if (found) return found;
      }
    }
    return undefined;
  }

  public listenerCount(): number {
    return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0);
  }
}

class FakeEvent {
  public defaultPrevented = false;
  public propagationStopped = false;

  public constructor(
    public readonly type: string,
    public readonly target: FakeElement,
    public readonly key?: string,
  ) {}

  public preventDefault(): void {
    this.defaultPrevented = true;
  }

  public stopPropagation(): void {
    this.propagationStopped = true;
  }
}
