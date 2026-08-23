import { describe, expect, it, vi } from "vitest";
import { DomTreeController } from "../src/domTreeController.js";
import { ElementsInspectorAdapter } from "../src/elementsInspectorAdapter.js";
import type {
  DomNodeView,
  DomRequest,
  DomResponse,
} from "../src/domProtocol.js";

describe("ElementsInspectorAdapter", () => {
  it("projects the one controller snapshot into immutable neutral rows", async () => {
    const root = node("root", "HTML", true);
    const child = node("child", "BODY");
    const controller = new DomTreeController({
      transport: {
        async request(request): Promise<DomResponse> {
          if (request.type === "dom.getRoot") {
            return {
              type: "dom.root",
              requestId: request.requestId,
              documentEpoch: 7,
              node: root,
              prologue: [],
              epilogue: [],
            };
          }
          return {
            type: "dom.children",
            requestId: request.requestId,
            documentEpoch: 7,
            nodeRef: "root",
            branchRevision: 1,
            nodes: [child],
          };
        },
        dispatch() {},
        cancelPending() {},
      },
    });
    const adapter = new ElementsInspectorAdapter(controller);
    let publications = 0;
    const unsubscribe = adapter.subscribe(() => {
      publications += 1;
    });

    await controller.loadRoot();
    await controller.expand("root");
    controller.focus("child");

    const snapshot = adapter.snapshot();
    expect(snapshot.rows).toBe(controller.rows());
    expect(adapter.snapshot().rows).toBe(controller.rows());
    expect(snapshot.rows.map((row) => ({
      type: row.type,
      nodeRef: row.nodeRef,
      parentRef: row.parentRef,
      depth: row.depth,
      expanded: row.expanded,
      expandable: row.expandable,
      selected: row.selected,
      focused: row.focused,
      hovered: row.hovered,
      nodeName: row.node?.nodeName,
    }))).toEqual([
      {
        type: "node",
        nodeRef: "root",
        parentRef: undefined,
        depth: 1,
        expanded: true,
        expandable: true,
        selected: false,
        focused: false,
        hovered: false,
        nodeName: "HTML",
      },
      {
        type: "node",
        nodeRef: "child",
        parentRef: "root",
        depth: 2,
        expanded: false,
        expandable: false,
        selected: false,
        focused: true,
        hovered: false,
        nodeName: "BODY",
      },
    ]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0]?.node)).toBe(true);
    expect(publications).toBeGreaterThan(0);

    unsubscribe();
    const before = publications;
    controller.focus("root");
    expect(publications).toBe(before);
  });

  it("delegates every tree action exactly once to the same controller", async () => {
    const controller = new DomTreeController({
      transport: {
        request: vi.fn<() => Promise<DomResponse>>(),
        dispatch: vi.fn<(request: DomRequest) => void>(),
        cancelPending: vi.fn(),
      },
    });
    const adapter = new ElementsInspectorAdapter(controller);
    const expand = vi.spyOn(controller, "expand").mockResolvedValue();
    const collapse = vi.spyOn(controller, "collapse").mockImplementation(() => {});
    const loadMore = vi.spyOn(controller, "loadMore").mockResolvedValue();
    const select = vi.spyOn(controller, "select").mockResolvedValue();
    const focus = vi.spyOn(controller, "focus").mockImplementation(() => {});
    const hover = vi.spyOn(controller, "hover").mockImplementation(() => {});

    await adapter.expand("node-1");
    adapter.collapse("node-1");
    await adapter.loadMore("node-1");
    await adapter.select("node-1");
    adapter.focus("node-1");
    adapter.hover("node-1");
    adapter.hover();

    expect(expand).toHaveBeenCalledTimes(1);
    expect(expand).toHaveBeenCalledWith("node-1");
    expect(collapse).toHaveBeenCalledTimes(1);
    expect(collapse).toHaveBeenCalledWith("node-1");
    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(loadMore).toHaveBeenCalledWith("node-1");
    expect(select).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith("node-1");
    expect(focus).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith("node-1");
    expect(hover).toHaveBeenNthCalledWith(1, "node-1");
    expect(hover).toHaveBeenNthCalledWith(2, undefined);
    expect(hover).toHaveBeenCalledTimes(2);
  });
});

function node(
  nodeRef: string,
  nodeName: string,
  expandable = false,
): DomNodeView {
  return Object.freeze({
    nodeRef,
    kind: "element",
    nodeType: 1,
    nodeName,
    attributes: Object.freeze([]),
    childCount: expandable ? 1 : 0,
    relationship: "dom",
    selectable: true,
    expandable,
    branchRevision: 1,
    label: nodeName.toLowerCase(),
  });
}
