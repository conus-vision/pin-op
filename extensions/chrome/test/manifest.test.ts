import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Chrome extension manifest", () => {
  it("uses a Chrome MV3 service worker and DevTools page", () => {
    const manifest = readManifest();

    expect(manifest).toMatchObject({
      manifest_version: 3,
      name: "Pin-op",
      description: "Connect browser DevTools to your source code.",
      version: "0.3.0",
      minimum_chrome_version: "116",
      devtools_page: "dist/devtools.html",
      background: { service_worker: "dist/background.js" },
    });
    expect(manifest.background).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("browser_specific_settings");
    expect(manifest.icons).toEqual({
      16: "dist/icons/pin-op-16.png",
      32: "dist/icons/pin-op-32.png",
      48: "dist/icons/pin-op-48.png",
      96: "dist/icons/pin-op-96.png",
      128: "dist/icons/pin-op-128.png",
    });
  });

  it("declares only the local runtime permissions", () => {
    const manifest = readManifest();

    expect(manifest.permissions).toEqual([
      "activeTab",
      "clipboardRead",
      "scripting",
      "storage",
      "tabs",
    ]);
    expect(manifest.permissions).not.toEqual(
      expect.arrayContaining(["nativeMessaging", "debugger"]),
    );
    const hostPermissions = manifest.host_permissions as string[];
    expect(hostPermissions).toEqual([
      "http://localhost/*",
      "http://127.0.0.1/*",
      "<all_urls>",
    ]);
    expect(
      hostPermissions.some((permission) => /^wss?:\/\//.test(permission)),
    ).toBe(false);
    expect(manifest).not.toHaveProperty("optional_host_permissions");
  });

  it("allows extension pages to connect only to loopback WebSockets", () => {
    const manifest = readManifest();
    const contentSecurityPolicy = manifest.content_security_policy as {
      extension_pages: string;
    };

    expect(contentSecurityPolicy.extension_pages).toContain("script-src 'self'");
    expect(contentSecurityPolicy.extension_pages).toContain(
      "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    );
    expect(contentSecurityPolicy.extension_pages).not.toContain(
      "upgrade-insecure-requests",
    );
  });
});

function readManifest(): Record<string, any> {
  return JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as Record<string, any>;
}
