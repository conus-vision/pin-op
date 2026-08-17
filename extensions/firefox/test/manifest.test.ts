import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Firefox extension manifest", () => {
  it("declares a Firefox-first MV3 DevTools adapter with inspected-page access", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    ) as Record<string, any>;

    expect(manifest).toMatchObject({
      manifest_version: 3,
      name: "Pin-op",
      description:
        "Highlights styles and source code in your IDE for the DOM element selected in the browser.",
      devtools_page: "dist/devtools.html",
      background: { scripts: ["dist/background.js"] },
      browser_specific_settings: {
        gecko: {
          id: "info@conus.vision",
          strict_min_version: "142.0",
          data_collection_permissions: {
            required: ["websiteContent", "websiteActivity"],
          },
        },
      },
    });
    expect(manifest.background.service_worker).toBeUndefined();
    expect(manifest.icons).toEqual({
      16: "dist/icons/pin-op-16.png",
      32: "dist/icons/pin-op-32.png",
      48: "dist/icons/pin-op-48.png",
      96: "dist/icons/pin-op-96.png",
      128: "dist/icons/pin-op-128.png",
    });
    expect(manifest.permissions).toEqual([
      "activeTab",
      "clipboardRead",
      "scripting",
      "storage",
      "tabs",
    ]);
    expect(manifest.permissions).not.toEqual(
      expect.arrayContaining([
        "webNavigation",
        "debugger",
        "nativeMessaging",
        "unlimitedStorage",
      ]),
    );
    expect(manifest.host_permissions).toEqual([
      "http://localhost/*",
      "http://127.0.0.1/*",
      "<all_urls>",
    ]);
    expect(manifest).not.toHaveProperty("optional_host_permissions");

    const csp = manifest.content_security_policy.extension_pages as string;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' ws://127.0.0.1:* ws://localhost:*");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });
});
