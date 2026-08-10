import { describe, expect, it } from "vitest";
import {
  classifyActiveDocumentSource,
  VsCodeSourceWorkspace,
} from "../src/sourcePlugins/sourceWorkspace.js";
import { memorySourceWorkspace } from "./support/memorySourceWorkspace.js";

describe("VsCodeSourceWorkspace", () => {
  it("classifies source resolution without exposing candidate paths", () => {
    const activeUri = "file:///workspace/dist/app.css";

    expect(classifyActiveDocumentSource(
      { uris: [activeUri], status: "exact", strategy: "automatic" },
      activeUri,
    )).toBe("active-document");
    expect(classifyActiveDocumentSource(
      { uris: [], status: "not-found", strategy: "automatic" },
      activeUri,
    )).toBe("not-found");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/other.css"],
        status: "exact",
        strategy: "automatic",
      },
      activeUri,
    )).toBe("other-document");
    expect(classifyActiveDocumentSource(
      { uris: [], status: "ambiguous", strategy: "automatic" },
      activeUri,
    )).toBe("ambiguous");
    expect(classifyActiveDocumentSource(
      {
        uris: [activeUri, "file:///workspace/other.css"],
        status: "exact",
        strategy: "automatic",
      },
      activeUri,
    )).toBe("ambiguous");
  });

  it("does not treat malformed not-found results with candidates as fallback", () => {
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/other.css"],
        status: "not-found",
        strategy: "automatic",
      },
      "file:///workspace/dist/app.css",
    )).toBe("other-document");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "not-found",
        strategy: "automatic",
      },
      "file:///workspace/dist/app.css",
    )).toBe("other-document");
  });

  it("uses canonical URI equality for encoded and Windows file paths", () => {
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/My%20Card.css"],
        status: "exact",
        strategy: "automatic",
      },
      "file:///workspace/My Card.css",
    )).toBe("active-document");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///C:/WORKSPACE/My%20Card.css"],
        status: "exact",
        strategy: "automatic",
      },
      "file:///c:/workspace/my card.css",
    )).toBe("active-document");
  });

  it("ignores file query and fragment in active-document equality", () => {
    const activeUri = "file:///workspace/src/app.css";

    expect(classifyActiveDocumentSource(
      {
        uris: [`${activeUri}?v=7#rule`],
        status: "exact",
        strategy: "workspace-bound",
        workspaceFolderUri: "file:///workspace",
      },
      activeUri,
    )).toBe("active-document");
  });

  it("does not grant exact authority to a unique basename", () => {
    const activeUri = "file:///workspace/dist/app.css";

    expect(classifyActiveDocumentSource(
      {
        uris: [activeUri],
        status: "unique-basename",
        strategy: "automatic",
      },
      activeUri,
    )).toBe("not-found");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/other/app.css"],
        status: "unique-basename",
        strategy: "automatic",
      },
      activeUri,
    )).toBe("other-document");
  });

  it("resolves an exact URL suffix and rejects ambiguous basenames", async () => {
    const workspace = memorySourceWorkspace({
      "file:///workspace/public/dist/app.css": "a{}",
      "file:///workspace/packages/demo/app.css": "b{}",
    });

    await expect(
      workspace.resolveSourceUri(
        "/public/dist/app.css",
        "http://localhost:4173/",
      ),
    ).resolves.toEqual({
      uris: ["file:///workspace/public/dist/app.css"],
      status: "exact",
      strategy: "automatic",
    });
    await expect(
      workspace.resolveSourceUri("/app.css", "http://localhost:4173/"),
    ).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "automatic",
    });
  });

  it("binds an _ORB URL to the _ORB root before basename fallback", async () => {
    const intended = "file:///D:/sites/_ORB/wp-content/themes/orbiter/style.css";
    const workspace = memorySourceWorkspace(
      {
        [intended]: "body {}",
        "file:///D:/sites/_ORB/wp-includes/css/style.css": "a {}",
        "file:///D:/sites/_ORB/wp-admin/css/style.css": "b {}",
        "file:///D:/sites/OTHER/wp-content/themes/orbiter/style.css": "c {}",
      },
      ["file:///D:/sites/_ORB", "file:///D:/sites/OTHER"],
    );

    await expect(workspace.resolveSourceUri(
      "/_ORB/wp-content/themes/orbiter/style.css?v=7",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [intended],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("probes a workspace-bound exact path without a global file search", async () => {
    const root = "file:///D:/sites/_ORB";
    const intended = `${root}/wp-content/themes/orbiter/style.css`;
    let findCalls = 0;
    let statCalls = 0;
    const uri = (value: string) => ({ toString: () => value });
    const workspace = new VsCodeSourceWorkspace({
      workspaceFolders: [{ uri: uri(root) }],
      async findFiles() {
        findCalls += 1;
        throw Object.assign(new Error("too many open files"), {
          code: "EMFILE",
        });
      },
      parseUri: uri,
      async readFile() {
        return new Uint8Array();
      },
      joinPath(base: { toString(): string }, ...segments: string[]) {
        return uri(`${base.toString()}/${segments.join("/")}`);
      },
      async stat(value: { toString(): string }) {
        statCalls += 1;
        expect(value.toString()).toBe(intended);
        return {};
      },
    });

    await expect(workspace.resolveSourceUri(
      "/_ORB/wp-content/themes/orbiter/style.css?v=7",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [intended],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: root,
    });
    expect(statCalls).toBe(1);
    expect(findCalls).toBe(0);
  });

  it("isolates basename fallback to the workspace-bound root", async () => {
    const workspace = memorySourceWorkspace(
      { "file:///D:/sites/OTHER/assets/style.css": "a {}" },
      ["file:///D:/sites/_ORB", "file:///D:/sites/OTHER"],
    );

    await expect(workspace.resolveSourceUri(
      "/_ORB/missing/style.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("rejects conflicting workspace identities", async () => {
    const workspace = memorySourceWorkspace({}, [
      "file:///sites/_ORB",
      "file:///sites/OTHER",
    ]);

    await expect(workspace.resolveSourceUri(
      "/OTHER/style.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "workspace-bound",
    });
  });

  it("rejects duplicate workspace root basenames", async () => {
    const workspace = memorySourceWorkspace({}, [
      "file:///work/a/_ORB",
      "file:///work/b/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      "/_ORB/style.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "workspace-bound",
    });
  });

  it("matches Windows workspace URL prefixes case-insensitively", async () => {
    const sourceUri = "file:///C:/sites/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///C:/sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      "/_orb/styles/app.css",
      "http://localhost/_orb/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///C:/sites/_ORB",
    });
  });

  it("keeps non-Windows workspace URL prefixes case-sensitive", async () => {
    const workspace = memorySourceWorkspace(
      {
        "file:///sites/_ORB/styles/app.css": "a {}",
        "file:///sites/OTHER/assets/app.css": "b {}",
      },
      ["file:///sites/_ORB", "file:///sites/OTHER"],
    );

    await expect(workspace.resolveSourceUri(
      "/_orb/styles/app.css",
      "http://localhost/_orb/",
    )).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "automatic",
    });
  });

  it("removes a matching workspace prefix at most once", async () => {
    const sourceUri = "file:///sites/_ORB/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      "/_ORB/_ORB/styles/app.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///sites/_ORB",
    });
  });

  it("rejects the same exact suffix in multiple workspace roots", async () => {
    const workspace = memorySourceWorkspace(
      {
        "file:///workspace-a/public/dist/app.css": "a{}",
        "file:///workspace-b/public/dist/app.css": "b{}",
      },
      ["file:///workspace-a", "file:///workspace-b"],
    );

    await expect(
      workspace.resolveSourceUri(
        "/public/dist/app.css",
        "http://localhost:4173/",
      ),
    ).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "automatic",
    });
  });

  it("ignores memory files with a different workspace URI scheme", async () => {
    const workspace = memorySourceWorkspace({
      "vscode-remote://host/workspace/src/app.css": "a {}",
    });

    await expect(workspace.resolveSourceUri(
      "/src/app.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("ignores memory files with a different workspace URI authority", async () => {
    const workspace = memorySourceWorkspace(
      { "vscode-remote://host-b/workspace/src/app.css": "a {}" },
      ["vscode-remote://host-a/workspace"],
    );

    await expect(workspace.resolveSourceUri(
      "/src/app.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("excludes memory files inside .git and node_modules", async () => {
    const workspace = memorySourceWorkspace({
      "file:///workspace/.git/cache/app.css": "a {}",
      "file:///workspace/node_modules/package/app.css": "b {}",
    });

    await expect(workspace.resolveSourceUri(
      "/app.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("decodes URL paths and uses automatic unique basename fallback", async () => {
    const workspace = memorySourceWorkspace({
      "file:///workspace/src/My%20Card.scss": ".card {}",
    });

    await expect(
      workspace.resolveSourceUri(
        "/src/My%20Card.scss?coverage=100%#rule%",
        "http://localhost:4173/",
      ),
    ).resolves.toEqual({
      uris: ["file:///workspace/src/My%20Card.scss"],
      status: "exact",
      strategy: "automatic",
    });
    await expect(
      workspace.resolveSourceUri(
        "My%20Card.scss",
        "http://localhost:4173/assets/",
      ),
    ).resolves.toEqual({
      uris: ["file:///workspace/src/My%20Card.scss"],
      status: "unique-basename",
      strategy: "automatic",
    });
  });

  it("matches every escaped glob character as a literal filename", async () => {
    const sourceUri =
      "file:///workspace/src/literal%3F%2A%5B%5D%7B%7D.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" });

    await expect(workspace.resolveSourceUri(
      "/src/literal%3F%2A%5B%5D%7B%7D.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "automatic",
    });
  });

  it("deduplicates canonical candidate URIs", async () => {
    const encoded = "file:///workspace/src/My%20Card.css";
    const workspace = memorySourceWorkspace({
      [encoded]: "a {}",
      "file:///workspace/src/My Card.css": "a {}",
    });

    await expect(workspace.resolveSourceUri(
      "/src/My%20Card.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [encoded],
      status: "exact",
      strategy: "automatic",
    });
  });

  it("returns file URIs inside a workspace as workspace-bound", async () => {
    const sourceUri = "file:///workspace/src/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" });

    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///workspace",
    });
  });

  it("chooses a file document workspace only by containment", async () => {
    const sourceUri = "file:///home/project/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///home/project",
      "file:///else/home",
    ]);

    await expect(workspace.resolveSourceUri(
      "../styles/app.css",
      "file:///home/project/dist/app.css",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///home/project",
    });
  });

  it("chooses a direct file source workspace only by containment", async () => {
    const sourceUri = "file:///home/project/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///home/project",
      "file:///else/home",
    ]);

    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///home/project",
    });
  });

  it("rejects a nested-root file when the document is bound to its parent", async () => {
    const sourceUri = "file:///D:/sites/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///D:/sites",
      "file:///D:/sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/sites/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites",
    });
  });

  it("uses the most-specific direct file owner without document identity", async () => {
    const sourceUri = "file:///D:/sites/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///D:/sites",
      "file:///D:/sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("ignores query and fragment when resolving a direct file URI", async () => {
    const sourceUri = "file:///workspace/src/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" });

    await expect(workspace.resolveSourceUri(
      `${sourceUri}?v=7#rule`,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///workspace",
    });
  });

  it("rejects file URIs outside the workspace-bound root", async () => {
    const otherSource = "file:///D:/sites/OTHER/styles/app.css";
    const workspace = memorySourceWorkspace({ [otherSource]: "a {}" }, [
      "file:///D:/sites/_ORB",
      "file:///D:/sites/OTHER",
    ]);

    await expect(workspace.resolveSourceUri(
      otherSource,
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("preserves a file base URL workspace binding for relative sources", async () => {
    const otherSource = "file:///D:/sites/OTHER/styles/app.css";
    const workspace = memorySourceWorkspace({ [otherSource]: "a {}" }, [
      "file:///D:/sites/_ORB",
      "file:///D:/sites/OTHER",
    ]);

    await expect(workspace.resolveSourceUri(
      "../../OTHER/styles/app.css",
      "file:///D:/sites/_ORB/dist/app.css",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("uses the most-specific workspace owner for a file base URL", async () => {
    const sourceUri = "file:///D:/sites/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///D:/sites",
      "file:///D:/sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      "../styles/app.css",
      "file:///D:/sites/_ORB/dist/app.css",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///D:/sites/_ORB",
    });
  });

  it("rejects duplicate equal owners for a file base URL", async () => {
    const root = "file:///D:/sites/_ORB";
    const sourceUri = `${root}/styles/app.css`;
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      root,
      root,
    ]);

    await expect(workspace.resolveSourceUri(
      "../styles/app.css",
      `${root}/dist/app.css`,
    )).resolves.toEqual({
      uris: [],
      status: "ambiguous",
      strategy: "workspace-bound",
    });
  });

  it("keeps filesystem-root workspaces available for file containment", async () => {
    const sourceUri = "file:///project/src/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///",
    ]);

    expect(workspace.isWorkspaceUri(sourceUri)).toBe(true);
    await expect(workspace.readText(sourceUri)).resolves.toBe("a {}");
    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///",
    });
  });

  it("contains children under uppercase Windows drive roots", async () => {
    const sourceUri = "file:///c:/sites/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///C:/",
    ]);

    expect(workspace.isWorkspaceUri(sourceUri)).toBe(true);
    await expect(workspace.readText(sourceUri)).resolves.toBe("a {}");
    await expect(workspace.resolveSourceUri(
      sourceUri,
      "http://localhost/",
    )).resolves.toEqual({
      uris: [sourceUri],
      status: "exact",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///C:/",
    });
  });

  it("rejects encoded path separators at the workspace read boundary", async () => {
    const escaped = "file:///C:/sites/_ORB%5C..%5COTHER/private.scss";
    const workspace = memorySourceWorkspace({ [escaped]: "secret" }, [
      "file:///C:/sites/_ORB",
    ]);

    expect(workspace.isWorkspaceUri(escaped)).toBe(false);
    await expect(workspace.readText(escaped)).rejects.toThrow(
      /outside the workspace/,
    );
  });

  it("rejects encoded separators before automatic basename fallback", async () => {
    const sourceUri = "file:///C:/sites/_ORB/styles/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" }, [
      "file:///C:/sites/_ORB",
    ]);

    await expect(workspace.resolveSourceUri(
      "/_ORB%2fstyles/app.css",
      "http://localhost/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("preserves document scope when encoded separators invalidate the source", async () => {
    const workspace = memorySourceWorkspace({}, ["file:///sites/_ORB"]);

    await expect(workspace.resolveSourceUri(
      "/assets%2Fapp.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///sites/_ORB",
    });
  });

  it("returns bound not-found for malformed encoded paths", async () => {
    const workspace = memorySourceWorkspace({}, ["file:///sites/_ORB"]);

    await expect(workspace.resolveSourceUri(
      "/_ORB/%E0%A4%A.css",
      "http://localhost/_ORB/",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///sites/_ORB",
    });
  });

  it("retains a safe document root before rejecting its malformed path", async () => {
    const workspace = memorySourceWorkspace(
      { "file:///sites/_ORB/styles/app.css": "a {}" },
      ["file:///sites/_ORB"],
    );

    await expect(workspace.resolveSourceUri(
      "http://cdn.example/styles/app.css",
      "http://localhost/_ORB/%E0%A4%A/page",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "workspace-bound",
      workspaceFolderUri: "file:///sites/_ORB",
    });
  });

  it("rejects malformed document paths without a safe root identity", async () => {
    const workspace = memorySourceWorkspace(
      { "file:///sites/_ORB/styles/app.css": "a {}" },
      ["file:///sites/_ORB"],
    );

    await expect(workspace.resolveSourceUri(
      "http://cdn.example/styles/app.css",
      "http://localhost/%E0%A4%A/_ORB/page",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("returns automatic not-found for malformed URLs", async () => {
    const workspace = memorySourceWorkspace({});

    await expect(workspace.resolveSourceUri(
      "app.css",
      "not a URL",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("rejects a valid absolute source when the base URL is invalid", async () => {
    const sourceUri = "file:///workspace/src/app.css";
    const workspace = memorySourceWorkspace({ [sourceUri]: "a {}" });

    await expect(workspace.resolveSourceUri(
      sourceUri,
      "not a URL",
    )).resolves.toEqual({
      uris: [],
      status: "not-found",
      strategy: "automatic",
    });
  });

  it("resolves relative map URIs", () => {
    const workspace = memorySourceWorkspace({});

    expect(
      workspace.resolveRelativeUri(
        "file:///workspace/dist/app.css",
        "maps/app.css.map",
      ),
    ).toBe("file:///workspace/dist/maps/app.css.map");
  });

  it("reads UTF-8 only inside configured workspace folders", async () => {
    const workspace = memorySourceWorkspace({
      "file:///workspace/src/card.scss": ".card { content: 'Привіт'; }",
      "file:///outside/private.scss": "secret",
    });

    await expect(
      workspace.readText("file:///workspace/src/card.scss"),
    ).resolves.toContain("Привіт");
    await expect(
      workspace.readText("file:///outside/private.scss"),
    ).rejects.toThrow(/outside the workspace/);
    expect(workspace.isWorkspaceUri("file:///workspace-other/card.scss")).toBe(
      false,
    );
  });
});
