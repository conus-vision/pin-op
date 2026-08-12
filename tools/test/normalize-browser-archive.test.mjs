import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { withTemporaryDirectory } from "./test-helpers.mjs";
import { normalizeBrowserArchive } from "../normalize-browser-archive.mjs";

test("browser archive normalization sorts files and fixes timestamps", async () => {
  await withTemporaryDirectory("pinop-normalize-", async (directory) => {
    const path = resolve(directory, "extension.zip");
    const zip = new AdmZip();
    zip.addFile("z.txt", Buffer.from("last"));
    zip.addFile("dist/", Buffer.alloc(0));
    zip.addFile("dist/a.txt", Buffer.from("first"));
    zip.writeZip(path);

    await normalizeBrowserArchive(path);
    const first = await readFile(path);
    const entries = new AdmZip(path).getEntries();
    assert.deepEqual(entries.map((entry) => entry.entryName), ["dist/a.txt", "z.txt"]);
    assert.deepEqual(
      entries.map((entry) => entry.header.time.toISOString()),
      ["2024-01-01T00:00:00.000Z", "2024-01-01T00:00:00.000Z"],
    );
    assert.deepEqual(
      entries.map((entry) => entry.attr),
      [0x81a40000, 0x81a40000],
    );

    await normalizeBrowserArchive(path);
    assert.deepEqual(await readFile(path), first);
  });
});

test("browser archive normalization canonicalizes text line endings only", async () => {
  await withTemporaryDirectory("pinop-normalize-text-", async (directory) => {
    const path = resolve(directory, "extension.zip");
    const binary = Buffer.from([0x00, 0x0d, 0x0a, 0xff]);
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from("{\r\n  \"version\": 1\r\n}\r\r\n"));
    zip.addFile("dist/mappings.wasm", binary);
    zip.writeZip(path);

    await normalizeBrowserArchive(path);
    const first = await readFile(path);

    const normalized = new AdmZip(path);
    assert.equal(
      normalized.readAsText("manifest.json"),
      "{\n  \"version\": 1\n}\n\n",
    );
    assert.deepEqual(normalized.readFile("dist/mappings.wasm"), binary);

    await normalizeBrowserArchive(path);
    assert.deepEqual(await readFile(path), first);
  });
});

test("browser archive normalization rejects invalid UTF-8 text atomically", async () => {
  await withTemporaryDirectory("pinop-normalize-utf8-", async (directory) => {
    const path = resolve(directory, "extension.zip");
    const zip = new AdmZip();
    zip.addFile("manifest.json", Buffer.from([0xc3, 0x28]));
    zip.addFile("dist/mappings.wasm", Buffer.from([0xc3, 0x28]));
    zip.writeZip(path);
    const before = await readFile(path);

    await assert.rejects(
      normalizeBrowserArchive(path),
      /invalid UTF-8 text entry manifest\.json/,
    );
    assert.deepEqual(await readFile(path), before);
  });
});
