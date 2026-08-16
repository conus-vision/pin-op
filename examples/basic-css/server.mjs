import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixtureRoot = dirname(fileURLToPath(import.meta.url));
const virtualCss = [
  ".pin-op-virtual-unmapped {",
  "  border: 2px dashed #1769aa;",
  "}",
  "",
].join("\n");
const vendorCss = [
  ".pin-op-external-readable {",
  "  box-sizing: border-box;",
  "  border-inline-end: 4px solid #267a4b;",
  "}",
  "",
].join("\n");
const inaccessibleCss = [
  ".pin-op-inaccessible-external {",
  "  text-decoration: underline wavy #b42318;",
  "}",
  "",
].join("\n");
const cssomOnlyPrelude = [
  ".pin-op-cssom-only {",
  "  --pin-op-fixture-source: cssom;",
  "}",
  "",
].join("\n");
const pageStaticFiles = new Map([
  ["/dist/app.css", ["dist/app.css", "text/css; charset=utf-8"]],
  ["/dist/app.css.map", ["dist/app.css.map", "application/json; charset=utf-8"]],
  ["/src/app.scss", ["src/app.scss", "text/x-scss; charset=utf-8"]],
  ["/src/card.scss", ["src/card.scss", "text/x-scss; charset=utf-8"]],
  ["/src/layout.scss", ["src/layout.scss", "text/x-scss; charset=utf-8"]],
  [
    "/frames/same-origin.html",
    ["frames/same-origin.html", "text/html; charset=utf-8"],
  ],
  [
    "/frames/same-origin.css",
    ["frames/same-origin.css", "text/css; charset=utf-8"],
  ],
]);
const externalStaticFiles = new Map([
  [
    "/frames/cross-origin.html",
    ["frames/cross-origin.html", "text/html; charset=utf-8"],
  ],
  [
    "/frames/cross-origin.css",
    ["frames/cross-origin.css", "text/css; charset=utf-8"],
  ],
]);

export async function startExampleServers(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const vendorServer = createServer(async (request, response) => {
    try {
      const pathname = requestPathname(request);
      if (pathname === "/vendor.css") {
        send(response, 200, vendorCss, "text/css; charset=utf-8", {
          "Access-Control-Allow-Origin": "*",
        });
        return;
      }
      if (pathname === "/inaccessible.css") {
        send(response, 200, inaccessibleCss, "text/css; charset=utf-8");
        return;
      }
      const staticFile = externalStaticFiles.get(pathname);
      if (!staticFile) {
        send(response, 404, "Not found\n", "text/plain; charset=utf-8");
        return;
      }
      await sendFixtureFile(response, staticFile);
    } catch (error) {
      sendServerError(response, error);
    }
  });
  await listen(vendorServer, host, options.vendorPort ?? 4_174);
  const externalOrigin = `http://${host}:${listeningPort(vendorServer)}`;
  const vendorCssUrl = `${externalOrigin}/vendor.css`;
  const inaccessibleCssUrl = `${externalOrigin}/inaccessible.css`;
  const crossOriginFrameUrl = `${externalOrigin}/frames/cross-origin.html`;

  const pageServer = createServer(async (request, response) => {
    try {
      const pathname = requestPathname(request);
      if (pathname === "/" || pathname === "/index.html") {
        const template = await readFile(resolve(fixtureRoot, "index.html"), "utf8");
        send(
          response,
          200,
          template
            .replaceAll("__VENDOR_CSS_URL__", vendorCssUrl)
            .replaceAll("__INACCESSIBLE_CSS_URL__", inaccessibleCssUrl)
            .replaceAll("__CROSS_ORIGIN_FRAME_URL__", crossOriginFrameUrl),
          "text/html; charset=utf-8",
        );
        return;
      }
      if (pathname === "/virtual.css") {
        send(response, 200, virtualCss, "text/css; charset=utf-8");
        return;
      }
      if (pathname === "/fallback.css") {
        const fallbackCss = await readFile(
          resolve(fixtureRoot, "fallback.css"),
          "utf8",
        );
        send(
          response,
          200,
          `${cssomOnlyPrelude}\n@layer pin-op-cssom-fixture {\n${fallbackCss}\n}\n`,
          "text/css; charset=utf-8",
        );
        return;
      }
      const staticFile = pageStaticFiles.get(pathname);
      if (!staticFile) {
        send(response, 404, "Not found\n", "text/plain; charset=utf-8");
        return;
      }
      await sendFixtureFile(response, staticFile);
    } catch (error) {
      sendServerError(response, error);
    }
  });

  try {
    await listen(pageServer, host, options.pagePort ?? 4_173);
  } catch (error) {
    await close(vendorServer);
    throw error;
  }

  let stopped = false;
  return {
    pageUrl: `http://${host}:${listeningPort(pageServer)}/`,
    vendorCssUrl,
    async stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      await Promise.all([close(pageServer), close(vendorServer)]);
    },
  };
}

async function sendFixtureFile(response, staticFile) {
  const [relativePath, contentType] = staticFile;
  const body = await readFile(resolve(fixtureRoot, relativePath));
  send(response, 200, body, contentType);
}

function sendServerError(response, error) {
  send(
    response,
    500,
    `${error instanceof Error ? error.message : String(error)}\n`,
    "text/plain; charset=utf-8",
  );
}

function requestPathname(request) {
  return new URL(request.url ?? "/", "http://localhost").pathname;
}

function send(response, status, body, contentType, headers = {}) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(body);
}

function listen(server, host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}

function listeningPort(server) {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Example server has no TCP address");
  }
  return address.port;
}

const entryPath = process.argv[1];
if (entryPath && pathToFileURL(resolve(entryPath)).href === import.meta.url) {
  const servers = await startExampleServers();
  console.log(`Pin-op example: ${servers.pageUrl}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void servers.stop().finally(() => process.exit(0));
    });
  }
}
