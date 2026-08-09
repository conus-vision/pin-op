import { describe, expect, it } from "vitest";
import { classifyActiveDocumentSource } from "../src/sourcePlugins/sourceWorkspace.js";
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
