import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("VS Code extension manifest", () => {
  it("declares the PinOp commands and settings", () => {
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
      homepage: string;
      icon: string;
      private?: boolean;
      type: string;
      main: string;
      activationEvents: string[];
      extensionKind: string[];
      scripts: Record<string, string>;
      contributes: {
        commands: Array<{ command: string }>;
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
      name: "pinop",
      displayName: "PinOp",
      description: "Connect browser DevTools to your source code.",
      publisher: "conus-vision",
      version: "0.3.0",
      license: "MIT",
      repository: "https://github.com/conus-vision/PinOp.git",
      homepage: "https://pinop.conus.vision",
      icon: "resources/pinop.png",
      extensionKind: ["ui"],
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest.scripts["vscode:prepublish"]).toBe("pnpm run build");
    expect(manifest.scripts.package).toBe("node ./package-vsix.mjs");
    expect(manifest.extensionKind).toEqual(["ui"]);

    expect(manifest.contributes.commands.map(({ command }) => command)).toEqual([
      "pinop.start",
      "pinop.stop",
      "pinop.copyLinkCode",
      "pinop.openDiagnostics",
      "pinop.revealSourceMatch",
    ]);
    expect(manifest.contributes.configuration.properties).toEqual({
      "pinop.sessionId": { type: "string", default: "default" },
    });

    expect(manifest.contributes.viewsContainers.activitybar).toContainEqual({
      id: "pinop",
      title: "PinOp",
      icon: "resources/pinop.svg",
    });
    expect(manifest.contributes.views.pinop).toContainEqual({
      id: "pinop.applicableRules",
      name: "Applicable Sources",
    });
    expect(manifest.contributes.colors.map(({ id }) => id)).toEqual([
      "pinop.selectedRuleBackground",
      "pinop.selectedRuleBorder",
      "pinop.parentRuleBackground",
      "pinop.parentRuleBorder",
    ]);
    const activityIcon = new URL("../resources/pinop.svg", import.meta.url);
    expect(existsSync(activityIcon)).toBe(true);
    if (existsSync(activityIcon)) {
      const svg = readFileSync(activityIcon, "utf8");
      expect(svg).toContain('viewBox="-84 -84 1389 1389"');
      expect(svg).toContain('fill="currentColor"');
    }

    const marketplaceIcon = new URL("../resources/pinop.png", import.meta.url);
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
