import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VS Code extension manifest", () => {
  it("declares the Pin-op commands and settings", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      name: string;
      displayName: string;
      description: string;
      publisher: string;
      version: string;
      license: string;
      repository: string;
      bugs: string;
      homepage: string;
      icon: string;
      private?: boolean;
      type: string;
      main: string;
      activationEvents: string[];
      extensionKind: string[];
      scripts: Record<string, string>;
      contributes: {
        commands: Array<{ command: string; title: string }>;
        configuration: { properties: Record<string, { default: unknown }> };
        viewsContainers: {
          activitybar: Array<{ id: string; title: string; icon: string }>;
        };
        views: Record<string, Array<{ id: string; name: string }>>;
        colors: Array<{
          id: string;
          defaults: { dark: string; light: string; highContrast: string };
        }>;
      };
    };

    expect(manifest.type).toBe("module");
    expect(manifest.main).toBe("./dist/extension.cjs");
    expect(manifest.activationEvents).toContain("onStartupFinished");
    expect(manifest).toMatchObject({
      name: "pin-op",
      displayName: "Pin-op",
      description: "Connect browser DevTools to your source code.",
      publisher: "conus-vision",
      version: "0.3.0",
      license: "MIT",
      repository: "https://github.com/conus-vision/pin-op",
      bugs: "https://github.com/conus-vision/pin-op/issues",
      homepage: "https://pin-op.conus.vision",
      icon: "resources/pin-op.png",
      extensionKind: ["ui"],
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest.scripts["vscode:prepublish"]).toBe("pnpm run build");
    expect(manifest.scripts.package).toBe("node ./package-vsix.mjs");
    expect(manifest.extensionKind).toEqual(["ui"]);

    expect(`${manifest.publisher}.${manifest.name}`).toBe("conus-vision.pin-op");
    expect(manifest.contributes.commands).toEqual([
      { command: "pin-op.start", title: "Pin-op: Start" },
      { command: "pin-op.stop", title: "Pin-op: Stop" },
      { command: "pin-op.copyLinkCode", title: "Pin-op: Copy Link Code" },
      { command: "pin-op.openDiagnostics", title: "Pin-op: Open Diagnostics" },
      { command: "pin-op.revealSourceMatch", title: "Pin-op: Reveal Source Match" },
    ]);
    expect(manifest.contributes.configuration.properties).toEqual({
      "pin-op.sessionId": { type: "string", default: "default" },
    });

    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual({
      id: "pin-op",
      title: "Pin-op",
      icon: "resources/pin-op.svg",
    });
    expect(manifest.contributes.views["pin-op"]).toContainEqual({
      id: "pin-op.applicableRules",
      name: "Applicable Sources",
    });
    const colorIds = manifest.contributes.colors.map(({ id }) => id);
    expect(colorIds).toEqual([
      "pinOp.selectedRuleBackground",
      "pinOp.selectedRuleBorder",
      "pinOp.parentRuleBackground",
      "pinOp.parentRuleBorder",
    ]);
    for (const colorId of colorIds) {
      expect(colorId).toMatch(/^[A-Za-z0-9.]+$/);
      expect(colorId.startsWith(".")).toBe(false);
    }
    expect(manifest.contributes.configuration).toMatchObject({ title: "Pin-op" });
    const activityIcon = new URL("../resources/pin-op.svg", import.meta.url);
    expect(existsSync(activityIcon)).toBe(true);
    if (existsSync(activityIcon)) {
      const svg = readFileSync(activityIcon, "utf8");
      expect(svg).toContain('viewBox="-84 -84 1389 1389"');
      expect(svg).toContain('fill="currentColor"');
    }

    const marketplaceIcon = new URL("../resources/pin-op.png", import.meta.url);
    expect(existsSync(marketplaceIcon)).toBe(true);
    if (existsSync(marketplaceIcon)) {
      const png = readFileSync(marketplaceIcon);
      expect(png.subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(png.readUInt32BE(16)).toBe(128);
      expect(png.readUInt32BE(20)).toBe(128);
    }
  });
});
