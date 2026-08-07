import { describe, expect, it } from "vitest";
import {
  classifyActiveDocumentSource,
  VsCodeSourceWorkspace,
  type UriLike,
  type WorkspaceHost,
} from "../src/sourcePlugins/sourceWorkspace.js";

describe("VsCodeSourceWorkspace", () => {
  it("classifies source resolution without exposing candidate paths", () => {
    const activeUri = "file:///workspace/dist/app.css";

    expect(classifyActiveDocumentSource(
      { uris: [activeUri], status: "exact" },
      activeUri,
    )).toBe("active-document");
    expect(classifyActiveDocumentSource(
      { uris: [], status: "not-found" },
      activeUri,
    )).toBe("not-found");
    expect(classifyActiveDocumentSource(
      { uris: ["file:///workspace/other.css"], status: "exact" },
      activeUri,
    )).toBe("other-document");
    expect(classifyActiveDocumentSource(
      { uris: [], status: "ambiguous" },
      activeUri,
    )).toBe("ambiguous");
    expect(classifyActiveDocumentSource(
      {
        uris: [activeUri, "file:///workspace/other.css"],
        status: "exact",
      },
      activeUri,
    )).toBe("ambiguous");
  });

  it("does not treat malformed not-found results with candidates as fallback", () => {
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/other.css"],
        status: "not-found",
      },
      "file:///workspace/dist/app.css",
    )).toBe("other-document");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/dist/app.css"],
        status: "not-found",
      },
      "file:///workspace/dist/app.css",
    )).toBe("other-document");
  });

  it("uses canonical URI equality for encoded and Windows file paths", () => {
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/My%20Card.css"],
        status: "exact",
      },
      "file:///workspace/My Card.css",
    )).toBe("active-document");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///C:/WORKSPACE/My%20Card.css"],
        status: "exact",
      },
      "file:///c:/workspace/my card.css",
    )).toBe("active-document");
  });

  it("does not grant exact authority to a unique basename", () => {
    const activeUri = "file:///workspace/dist/app.css";

    expect(classifyActiveDocumentSource(
      { uris: [activeUri], status: "unique-basename" },
      activeUri,
    )).toBe("not-found");
    expect(classifyActiveDocumentSource(
      {
        uris: ["file:///workspace/other/app.css"],
        status: "unique-basename",
      },
      activeUri,
    )).toBe("other-document");
  });

  it("resolves an exact URL suffix and rejects ambiguous basenames", async () => {
    const workspace = sourceWorkspace({
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
    });
    await expect(
      workspace.resolveSourceUri("/app.css", "http://localhost:4173/"),
    ).resolves.toEqual({ uris: [], status: "ambiguous" });
  });

  it("rejects the same exact suffix in multiple workspace roots", async () => {
    const workspace = sourceWorkspace(
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
    ).resolves.toEqual({ uris: [], status: "ambiguous" });
  });

  it("decodes URL paths and returns a unique basename fallback", async () => {
    const workspace = sourceWorkspace({
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
    });
    await expect(
      workspace.resolveSourceUri(
        "My%20Card.scss",
        "http://localhost:4173/assets/",
      ),
    ).resolves.toEqual({
      uris: ["file:///workspace/src/My%20Card.scss"],
      status: "unique-basename",
    });
  });

  it("resolves relative map URIs", () => {
    const workspace = sourceWorkspace({});

    expect(
      workspace.resolveRelativeUri(
        "file:///workspace/dist/app.css",
        "maps/app.css.map",
      ),
    ).toBe("file:///workspace/dist/maps/app.css.map");
  });

  it("reads UTF-8 only inside configured workspace folders", async () => {
    const workspace = sourceWorkspace({
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

function sourceWorkspace(
  files: Readonly<Record<string, string>>,
  folders: readonly string[] = ["file:///workspace"],
): VsCodeSourceWorkspace {
  const encoder = new TextEncoder();
  const host: WorkspaceHost = {
    workspaceFolders: folders.map((folder) => ({ uri: uri(folder) })),
    async findFiles(pattern, exclude) {
      expect(exclude).toBe("**/{node_modules,.git}/**");
      const suffix = unescapeGlob(pattern.replace(/^\*\*\//, ""));
      return Object.keys(files)
        .filter((candidate) =>
          decodeURIComponent(new URL(candidate).pathname).endsWith(`/${suffix}`),
        )
        .map(uri);
    },
    parseUri: uri,
    async readFile(value) {
      const text = files[value.toString()];
      if (text === undefined) throw new Error("missing fixture file");
      return encoder.encode(text);
    },
  };
  return new VsCodeSourceWorkspace(host);
}

function uri(value: string): UriLike {
  return { toString: () => value };
}

function unescapeGlob(value: string): string {
  return value.replace(/\[([^\]])\]/g, "$1");
}
