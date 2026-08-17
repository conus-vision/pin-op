import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import * as chromeSmokeModule from "../smoke-packaged-chrome.mjs";
import {
  CHROME_ARCHIVE_FILES,
  assertLinuxGraphicalSession,
  buildChromeArguments,
  buildChromeSpawnOptions,
  chromeExecutableCandidates,
  findProductServiceWorker,
  isProductManifest,
  openCdp,
  verifyFixturePageInChrome,
  shutdownOwnedChildTree,
  validatePackagedChromeArchive,
} from "../smoke-packaged-chrome.mjs";

const panelHtmlFixture = readFileSync(
  new URL(
    "../../packages/browser-extension-core/assets/panel.html",
    import.meta.url,
  ),
  "utf8",
);
const panelCssFixture = readFileSync(
  new URL(
    "../../packages/browser-extension-core/assets/panel.css",
    import.meta.url,
  ),
  "utf8",
);

const panelBundleFixture = [
  'const sourcePresentationCapability = "source-presentation";',
  'const sourceMatchesType = "source.matches";',
  'const sourceOpenType = "source.open";',
  'const sourceNavigateType = "source.navigate";',
  'const navigationStateType = "source.navigationState";',
  'const opaqueMatchIdentity = "matchId";',
  'const resolveLocatorType = "dom.resolveLocator";',
].join("\n");

function createArchive(paths = CHROME_ARCHIVE_FILES) {
  const files = new Map(paths.map((path) => [path, Buffer.from(path)]));
  files.set(
    "manifest.json",
    Buffer.from(
      JSON.stringify({
        name: "Pin-op",
        version: "0.3.0",
        manifest_version: 3,
        background: { service_worker: "dist/background.js" },
      }),
    ),
  );
  files.set("dist/panel.html", Buffer.from(panelHtmlFixture));
  files.set("dist/panel.css", Buffer.from(panelCssFixture));
  files.set("dist/panel.js", Buffer.from(panelBundleFixture));
  files.set("dist/background.js", Buffer.from("packaged background runtime"));
  files.set("dist/contentScript.js", Buffer.from("packaged content runtime"));
  files.set("dist/devtools.js", Buffer.from("packaged DevTools runtime"));
  files.set(
    "dist/runtime-metadata.json",
    Buffer.from('{"schemaVersion":1,"protocolVersion":6}\n'),
  );
  return { files, paths: [...paths] };
}

test("accepts only the exact validated Chrome runtime archive", () => {
  assert.equal(
    validatePackagedChromeArchive(createArchive()).name,
    "Pin-op",
  );
  assert.throws(
    () =>
      validatePackagedChromeArchive(
        createArchive([...CHROME_ARCHIVE_FILES, "unexpected.txt"]),
      ),
    /unexpected archive path unexpected\.txt/,
  );
});

test("rejects a packaged runtime downgraded to protocol version 5", () => {
  const archive = createArchive();
  archive.files.set(
    "dist/runtime-metadata.json",
    Buffer.from('{"schemaVersion":1,"protocolVersion":5}\n'),
  );

  assert.throws(
    () => validatePackagedChromeArchive(archive),
    /runtime metadata protocolVersion expected 6 but found 5/i,
  );
});

test("rejects malformed or extended packaged runtime metadata", () => {
  for (const [metadata, expectedError] of [
    ["not-json", /runtime metadata is not valid JSON/i],
    [
      '{"schemaVersion":1,"protocolVersion":6,"marker":"test"}',
      /runtime metadata has unexpected keys: marker/i,
    ],
  ]) {
    const archive = createArchive();
    archive.files.set("dist/runtime-metadata.json", Buffer.from(metadata));
    assert.throws(() => validatePackagedChromeArchive(archive), expectedError);
  }
});

test("requires packaged inspector assets and semantic static markers", () => {
  const cases = [
    ["dist/panel.html", 'class="panel-toolbar"', /toolbar/i],
    ["dist/panel.html", 'id="inspect-mode"', /picker/i],
    ["dist/panel.html", "Auto Refresh", /Auto Refresh/i],
    ["dist/panel.html", "IDE Highlight", /IDE Highlight/i],
    ["dist/panel.html", 'id="link-code"', /connection controls/i],
    ["dist/panel.html", 'id="disconnect-button"', /connection controls/i],
    ["dist/panel.html", 'id="panel-workspace"', /workspace/i],
    ["dist/panel.html", 'id="dom-pane"', /DOM workspace/i],
    ["dist/panel.html", 'id="source-pane"', /Source workspace/i],
    ["dist/panel.html", 'id="source-pane-root"', /source pane/i],
    [
      "dist/panel.html",
      "Extensions are incompatible",
      /incompatibility copy/i,
    ],
    [
      "dist/panel.html",
      "Update the Pin-op browser and IDE extensions to compatible versions, then reconnect.",
      /incompatibility copy/i,
    ],
    ["dist/panel.html", 'id="panel-branding"', /branded footer/i],
    [
      "dist/panel.html",
      'href="mailto:info@conus.vision"',
      /branded footer/i,
    ],
    [
      "dist/panel.html",
      'href="https://conus.vision"',
      /branded footer/i,
    ],
    [
      "dist/panel.html",
      "source-navigation-footer",
      /source navigation footer/i,
    ],
    ["dist/panel.css", ".panel-toolbar-scroll", /responsive toolbar/i],
    ["dist/panel.css", '[data-layout="split"]', /responsive split layout/i],
    ["dist/panel.css", '[data-layout="stack"]', /responsive stack layout/i],
    ["dist/panel.css", '[data-layout="tabs"]', /responsive tab layout/i],
    ["dist/panel.css", ".workspace-pane", /workspace style/i],
    ["dist/panel.css", ".source-pane-excerpt", /source excerpt style/i],
    ["dist/panel.css", ".panel-branding", /branded footer style/i],
    [
      "dist/panel.css",
      ".source-navigation-controls",
      /source navigation controls/i,
    ],
    [
      "dist/panel.js",
      "source.matches",
      /source matches/i,
    ],
    [
      "dist/panel.js",
      "source.open",
      /source open/i,
    ],
    [
      "dist/panel.js",
      "source.navigate",
      /source navigation intent/i,
    ],
    [
      "dist/panel.js",
      "source.navigationState",
      /source navigation state/i,
    ],
    ["dist/panel.js", "matchId", /opaque match identity/i],
    [
      "dist/panel.js",
      "dom.resolveLocator",
      /locator recovery/i,
    ],
  ];

  for (const [path, marker, expectedError] of cases) {
    const archive = createArchive();
    const original = archive.files.get(path).toString("utf8");
    archive.files.set(path, Buffer.from(original.replaceAll(marker, "")));

    assert.throws(
      () => validatePackagedChromeArchive(archive),
      expectedError,
      `${path} must retain ${marker}`,
    );
  }
});

test("requires exactly one packaged toolbar", () => {
  const archive = createArchive();
  const panel = archive.files.get("dist/panel.html").toString("utf8");
  archive.files.set(
    "dist/panel.html",
    Buffer.from(
      `${panel}\n<header class="panel-toolbar secondary"></header>\n`,
    ),
  );

  assert.throws(
    () => validatePackagedChromeArchive(archive),
    /toolbar.*exactly one/i,
  );
});

test("rejects an entity-encoded duplicate packaged toolbar", () => {
  const archive = createArchive();
  const panel = archive.files.get("dist/panel.html").toString("utf8");
  archive.files.set(
    "dist/panel.html",
    Buffer.from(
      `${panel}\n<header class="secondary panel&#45;toolbar"></header>\n`,
    ),
  );

  assert.throws(
    () => validatePackagedChromeArchive(archive),
    /toolbar.*exactly one/i,
  );
});

test("rejects packaged stylesheets that hide the link code", () => {
  for (const rule of [
    "#link-code { display : none !important; }",
    "#link-code { --hide:none; display:var(--hide)!important }",
    "#link-code { visibility:collapse!important }",
  ]) {
    const archive = createArchive();
    const css = archive.files.get("dist/panel.css").toString("utf8");
    archive.files.set(
      "dist/panel.css",
      Buffer.from(`${css}\n${rule}\n`),
    );

    assert.throws(
      () => validatePackagedChromeArchive(archive),
      /connection controls.*visible/i,
      rule,
    );
  }
});

test("rejects inline style blocks that hide the link code", () => {
  const archive = createArchive();
  const panel = archive.files.get("dist/panel.html").toString("utf8");
  archive.files.set(
    "dist/panel.html",
    Buffer.from(
      panel.replace(
        "</head>",
        "<style>#link-code{display:none!important}</style>\n</head>",
      ),
    ),
  );

  assert.throws(
    () => validatePackagedChromeArchive(archive),
    /connection controls.*visible/i,
  );
});

test("accepts the packaged toolbar class token with additional classes", () => {
  const archive = createArchive();
  const panel = archive.files.get("dist/panel.html").toString("utf8");
  archive.files.set(
    "dist/panel.html",
    Buffer.from(
      panel.replace(
        'class="panel-toolbar"',
        'class="primary panel-toolbar secondary"',
      ),
    ),
  );

  assert.doesNotThrow(() => validatePackagedChromeArchive(archive));
});

test("verifies fixture CSSOM access and multiline geometry through CDP", async () => {
  const calls = [];
  let runtimeEvaluations = 0;
  const cdp = {
    async send(method, params, sessionId) {
      calls.push([method, params, sessionId]);
      if (method === "Target.createTarget") return { targetId: "fixture-page" };
      if (method === "Target.attachToTarget") return { sessionId: "fixture-session" };
      if (method === "Page.navigate") return { frameId: "fixture-frame" };
      if (method === "Runtime.evaluate") {
        runtimeEvaluations += 1;
        return {
          result: {
            value: {
              ready: true,
              locationHref: runtimeEvaluations === 1
                ? "about:blank"
                : "http://127.0.0.1:4173/",
              vendor: { found: true, readable: true, ruleCount: 1 },
              inaccessible: {
                found: true,
                readable: false,
                errorName: "SecurityError",
              },
              vendorCrossOrigin: "anonymous",
              inaccessibleHasCrossOrigin: false,
              multilineRectCount: 2,
              pathMiss: { property: "outline-style", value: "dashed" },
            },
          },
        };
      }
      if (method === "Target.closeTarget") return { success: true };
      return {};
    },
  };

  const result = await verifyFixturePageInChrome(
    cdp,
    "http://127.0.0.1:4173/",
  );

  assert.equal(result.multilineRectCount, 2);
  assert.equal(result.locationHref, "http://127.0.0.1:4173/");
  assert.equal(runtimeEvaluations, 2);
  assert.ok(calls.some(([method]) => method === "Page.navigate"));
  assert.deepEqual(calls.at(-1)?.slice(0, 2), [
    "Target.closeTarget",
    { targetId: "fixture-page" },
  ]);
});

test("rejects fixture CSSOM access or single-line geometry and closes the target", async () => {
  for (const [overrides, expectedError] of [
    [
      { vendor: { found: true, readable: false, errorName: "SecurityError" } },
      /vendor stylesheet cssRules must be readable/i,
    ],
    [
      { inaccessible: { found: true, readable: true, ruleCount: 1 } },
      /inaccessible stylesheet cssRules unexpectedly readable/i,
    ],
    [{ multilineRectCount: 1 }, /exactly 2 client rects/i],
    [{ multilineRectCount: 3 }, /exactly 2 client rects/i],
    [
      { pathMiss: { property: "outline-style", value: "rgb(217, 119, 6)" } },
      /path-miss CSSOM evidence/i,
    ],
  ]) {
    let closed = false;
    const cdp = {
      async send(method) {
        if (method === "Target.createTarget") return { targetId: "fixture-page" };
        if (method === "Target.attachToTarget") return { sessionId: "fixture-session" };
        if (method === "Page.navigate") return { frameId: "fixture-frame" };
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                ready: true,
                locationHref: "http://127.0.0.1:4173/",
                vendor: { found: true, readable: true, ruleCount: 1 },
                inaccessible: {
                  found: true,
                  readable: false,
                  errorName: "SecurityError",
                },
                vendorCrossOrigin: "anonymous",
                inaccessibleHasCrossOrigin: false,
                multilineRectCount: 2,
                pathMiss: { property: "outline-style", value: "dashed" },
                ...overrides,
              },
            },
          };
        }
        if (method === "Target.closeTarget") {
          closed = true;
          return { success: true };
        }
        return {};
      },
    };

    await assert.rejects(
      verifyFixturePageInChrome(cdp, "http://127.0.0.1:4173/"),
      expectedError,
    );
    assert.equal(closed, true);
  }
});

test("launch arguments always isolate Chrome in the supplied temporary profile", () => {
  const profile = resolve("tmp/pin-op-smoke/profile");
  const args = buildChromeArguments(profile);

  assert.ok(args.includes(`--user-data-dir=${profile}`));
  assert.ok(args.includes("--remote-debugging-port=0"));
  assert.ok(args.includes("--disable-gpu"));
  assert.equal(args.some((argument) => argument.startsWith("--profile-directory")), false);
  assert.equal(args.some((argument) => argument.includes("User Data")), false);
});

test("Chrome candidates never become relative when environment roots are absent", () => {
  const candidates = chromeExecutableCandidates("win32", {});
  assert.deepEqual(candidates, []);
  assert.deepEqual(chromeExecutableCandidates("linux", {}), [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]);
});

test("Linux packaged smoke requires a graphical session or Xvfb", () => {
  assert.throws(
    () => assertLinuxGraphicalSession("linux", {}),
    /graphical session or Xvfb/,
  );
  assert.doesNotThrow(() => assertLinuxGraphicalSession("linux", { DISPLAY: ":99" }));
  assert.doesNotThrow(() =>
    assertLinuxGraphicalSession("linux", { WAYLAND_DISPLAY: "wayland-0" }),
  );
  assert.doesNotThrow(() => assertLinuxGraphicalSession("win32", {}));
});

test("Chrome spawn owns a POSIX process group without detaching on Windows", () => {
  assert.equal(buildChromeSpawnOptions("linux").detached, true);
  assert.equal(buildChromeSpawnOptions("darwin").detached, true);
  assert.equal(buildChromeSpawnOptions("win32").detached, false);
});

test("smoke operation preserves primary and cleanup failures in that order", async () => {
  assert.equal(
    typeof chromeSmokeModule.runSmokeOperationWithCleanup,
    "function",
    "smoke cleanup orchestration must be independently testable",
  );
  const primaryError = new Error("primary smoke failure");
  const cleanupError = new Error("cleanup failure");

  await assert.rejects(
    chromeSmokeModule.runSmokeOperationWithCleanup(
      async () => {
        throw primaryError;
      },
      async () => {
        throw cleanupError;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /smoke failed.*cleanup also failed/i);
      assert.ok(error.message.includes(primaryError.message));
      assert.ok(error.message.includes(cleanupError.message));
      assert.ok(
        error.message.indexOf(primaryError.message) <
          error.message.indexOf(cleanupError.message),
      );
      assert.deepEqual(error.errors, [primaryError, cleanupError]);
      return true;
    },
  );
});

test("owned Windows child shutdown escalates to its exact PID tree", async () => {
  const child = mockRunningChild(4321);
  const calls = [];
  let waits = 0;
  const cdp = {
    async send(method) {
      calls.push(["cdp", method]);
    },
    close() {
      calls.push(["cdp-close"]);
    },
  };

  await shutdownOwnedChildTree({
    child,
    cdp,
    platform: "win32",
    timeoutMs: 10,
    waitForExitFn: async () => {
      waits += 1;
      calls.push(["wait", waits]);
      if (waits === 1) throw new Error("still running");
      child.exitCode = 0;
    },
    spawnSyncFn(command, arguments_, options) {
      calls.push(["force", command, arguments_, options]);
      return { status: 0, signal: null, stderr: Buffer.alloc(0) };
    },
  });

  assert.deepEqual(calls.slice(0, 4), [
    ["cdp", "Browser.close"],
    ["cdp-close"],
    ["wait", 1],
    ["force", "taskkill", ["/PID", "4321", "/T", "/F"], {
      encoding: "utf8",
      timeout: 10,
      windowsHide: true,
    }],
  ]);
  assert.deepEqual(calls.at(-1), ["wait", 2]);
});

test("owned POSIX child shutdown targets only its detached process group", async () => {
  const child = mockRunningChild(7654);
  const kills = [];
  let waits = 0;

  await shutdownOwnedChildTree({
    child,
    platform: "linux",
    timeoutMs: 10,
    waitForExitFn: async () => {
      waits += 1;
      if (waits === 1) throw new Error("still running");
      child.signalCode = "SIGKILL";
    },
    killFn(pid, signal) {
      kills.push([pid, signal]);
    },
  });

  assert.deepEqual(kills, [[-7654, "SIGKILL"]]);
});

test("owned child shutdown reports a final cleanup failure", async () => {
  const child = mockRunningChild(2468);
  await assert.rejects(
    shutdownOwnedChildTree({
      child,
      platform: "win32",
      timeoutMs: 10,
      waitForExitFn: async () => {
        throw new Error("still running");
      },
      spawnSyncFn: () => ({ status: 0, signal: null, stderr: Buffer.alloc(0) }),
    }),
    /Chrome cleanup failed: owned child tree PID 2468 is still running/,
  );
});

test("owned child shutdown detaches surviving child handles before failing", async () => {
  const child = mockRunningChild(9753);
  const calls = [];
  for (const name of ["stdin", "stdout", "stderr"]) {
    child[name] = {
      destroy() {
        calls.push(["destroy", name]);
      },
    };
  }
  child.unref = () => calls.push(["unref"]);

  await assert.rejects(
    shutdownOwnedChildTree({
      child,
      platform: "win32",
      timeoutMs: 10,
      waitForExitFn: async () => {
        throw new Error("still running");
      },
      spawnSyncFn: () => ({ status: 0, signal: null, stderr: Buffer.alloc(0) }),
    }),
    /Chrome cleanup failed: owned child tree PID 9753 is still running/,
  );
  assert.deepEqual(calls, [
    ["destroy", "stdin"],
    ["destroy", "stdout"],
    ["destroy", "stderr"],
    ["unref"],
  ]);
});

test("surviving owned child cannot keep the smoke parent command alive", {
  timeout: 10_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pin-op-survivor-test-"));
  const pidFile = join(root, "owned-child.pid");
  const releaseFile = join(root, "release-owned-child");
  const moduleUrl = pathToFileURL(
    resolve("tools/smoke-packaged-chrome.mjs"),
  ).href;
  const script = `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    import { shutdownOwnedChildTree } from ${JSON.stringify(moduleUrl)};

    const fixtureScript = ${JSON.stringify(`
      const { existsSync } = require("node:fs");
      const releaseFile = process.argv[1];
      const poll = setInterval(() => {
        if (existsSync(releaseFile)) {
          clearInterval(poll);
          process.exit(0);
        }
      }, 20);
      setTimeout(() => process.exit(0), 2000);
    `)};
    const ownedChild = spawn(
      process.execPath,
      ["--eval", fixtureScript, ${JSON.stringify(releaseFile)}],
      {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    writeFileSync(${JSON.stringify(pidFile)}, String(ownedChild.pid));
    try {
      await shutdownOwnedChildTree({
        child: ownedChild,
        platform: process.platform,
        timeoutMs: 10,
        waitForExitFn: async () => {
          throw new Error("fixture deliberately survives");
        },
        spawnSyncFn: () => ({
          status: 0,
          signal: null,
          stderr: Buffer.alloc(0),
        }),
        killFn: () => {},
      });
    } catch (error) {
      console.error("EXPECTED_OWNED_CHILD_FAILURE " + error.message);
      process.exitCode = 23;
    }
  `;
  const parent = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  let ownedPid;

  try {
    const result = await waitForSubprocess(parent, 750);
    ownedPid = await readOwnedPid(pidFile);
    assert.equal(result.code, 23, result.stderr);
    assert.match(result.stderr, /EXPECTED_OWNED_CHILD_FAILURE/);
  } finally {
    ownedPid ??= await readOwnedPid(pidFile, 500).catch(() => undefined);
    await writeFile(releaseFile, "release");
    if (ownedPid) {
      const fixtureExited = await waitForPidExit(ownedPid, 3_000);
      if (!fixtureExited) {
        forceKillExactPid(ownedPid, process.platform !== "win32");
      }
      assert.equal(fixtureExited, true, `owned fixture PID ${ownedPid} leaked`);
    }
    if (isPidAlive(parent.pid)) {
      const parentExited = await waitForPidExit(parent.pid, 1_000);
      if (!parentExited) forceKillExactPid(parent.pid, false);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("CDP connection and commands have bounded timeouts", async () => {
  let unopenedSocket;
  class UnopenedSocket extends EventTarget {
    readyState = 0;

    constructor() {
      super();
      unopenedSocket = this;
    }

    close() {
      this.readyState = 3;
    }
  }

  await assert.rejects(
    openCdp("ws://127.0.0.1:1/devtools/browser/test", {
      WebSocketClass: UnopenedSocket,
      timeoutMs: 10,
    }),
    /Timed out opening/,
  );
  assert.equal(unopenedSocket.readyState, 3);

  class UnresponsiveSocket extends EventTarget {
    readyState = 0;

    constructor() {
      super();
      queueMicrotask(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {}

    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event("close"));
    }
  }

  const cdp = await openCdp("ws://127.0.0.1:1/devtools/browser/test", {
    WebSocketClass: UnresponsiveSocket,
    timeoutMs: 10,
  });
  await assert.rejects(cdp.send("Browser.getVersion"), /timed out/);
  cdp.close();
});

test("CDP runtime errors dispose listeners and reject pending requests", async () => {
  let socket;
  class TrackingSocket {
    readyState = 0;
    closeCalls = 0;
    listeners = new Map();

    constructor() {
      socket = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.emit("open", {});
      });
    }

    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type, event) {
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
    }

    send() {}

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
      this.emit("close", {});
    }

    listenerCount(type) {
      return this.listeners.get(type)?.size ?? 0;
    }
  }

  const cdp = await openCdp("ws://127.0.0.1:1/devtools/browser/test", {
    WebSocketClass: TrackingSocket,
    timeoutMs: 50,
  });
  const pending = cdp.send("Browser.getVersion");
  socket.emit("error", {});

  await assert.rejects(pending, /WebSocket error/);
  await assert.rejects(cdp.send("Target.getTargets"), /WebSocket is not open/);
  assert.equal(socket.closeCalls, 1);
  assert.equal(socket.listenerCount("message"), 0);
  assert.equal(socket.listenerCount("close"), 0);
  assert.equal(socket.listenerCount("error"), 0);
  cdp.close();
  assert.equal(socket.closeCalls, 1);
});

test("finds the packaged Pin-op MV3 service worker", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  const target = findProductServiceWorker([
    { type: "page", url: "about:blank" },
    {
      targetId: "worker-1",
      type: "service_worker",
      url: `chrome-extension://${extensionId}/dist/background.js`,
    },
  ], extensionId);

  assert.equal(target?.targetId, "worker-1");
});

test("ignores unrelated workers and non-extension targets", () => {
  const extensionId = "abcdefghijklmnopabcdefghijklmnop";
  assert.equal(
    findProductServiceWorker([
      {
        targetId: "worker-1",
        type: "service_worker",
        url: "https://example.test/service-worker.js",
      },
      {
        targetId: "worker-2",
        type: "worker",
        url: `chrome-extension://${extensionId}/dist/background.js`,
      },
    ], extensionId),
    undefined,
  );
});

test("rejects ambiguous Pin-op service workers", () => {
  const extensionId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  assert.throws(
    () =>
      findProductServiceWorker([
        {
          targetId: "worker-1",
          type: "service_worker",
          url: `chrome-extension://${extensionId}/dist/background.js`,
        },
        {
          targetId: "worker-2",
          type: "service_worker",
          url: `chrome-extension://${extensionId}/dist/background.js`,
        },
      ], extensionId),
    /multiple Pin-op service workers/,
  );
});

test("recognizes Pin-op by the manifest exposed inside its worker", () => {
  assert.equal(
    isProductManifest({
      name: "Pin-op",
      version: "0.3.0",
      manifest_version: 3,
      background: { service_worker: "dist/background.js" },
    }),
    true,
  );
  assert.equal(
    isProductManifest({
      name: "Unrelated extension",
      version: "0.3.0",
      manifest_version: 3,
      background: { service_worker: "dist/background.js" },
    }),
    false,
  );
});

function mockRunningChild(pid) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
  });
}

function waitForSubprocess(child, timeoutMs) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve_, reject) => {
    const finish = (callback) => {
      clearTimeout(timer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      callback();
    };
    const onError = (error) => finish(() => reject(error));
    const onExit = (code, signal) =>
      finish(() => resolve_({ code, signal, stdout, stderr }));
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new Error(
            `subprocess did not exit within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        ),
      );
    }, timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function readOwnedPid(path, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number(await readFile(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
      throw new Error(`fixture wrote invalid PID ${String(pid)}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
  throw new Error("fixture PID was not written in time");
}

function forceKillExactPid(pid, processGroup) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(processGroup ? -pid : pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((resolve_) => setTimeout(resolve_, 20));
  }
  return !isPidAlive(pid);
}
