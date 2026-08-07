import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const installedGuide = await readFile("docs/installed-verification.md", "utf8");
const readme = await readFile("README.md", "utf8");
const changelog = await readFile("CHANGELOG.md", "utf8");
const privacy = await readFile("PRIVACY.md", "utf8");
const securityPolicy = await readFile("SECURITY.md", "utf8");
const developmentGuide = await readFile("docs/mvp-verification.md", "utf8");
const usageGuide = await readFile("docs/mvp-usage.md", "utf8");
const architectureGuide = await readFile("docs/architecture.md", "utf8");
const protocolGuide = await readFile("docs/protocol.md", "utf8");
const securityGuide = await readFile("docs/security.md", "utf8");
const vscodeReadme = await readFile("extensions/vscode/README.md", "utf8");
const recordHeading = "## 0.3.0 Candidate Verification Record";
const [primaryPath, verificationRecord] = installedGuide.split(recordHeading);

test("installed primary path is terminal-free and starts automatically", () => {
  assert.ok(verificationRecord, "0.3.0 candidate verification record is required");
  for (const prohibited of [
    "--extensionDevelopmentPath",
    "web-ext run",
    "corepack",
    "pnpm",
  ]) {
    assert.equal(primaryPath.includes(prohibited), false, prohibited);
  }
  assert.match(primaryPath, /terminal-free/i);
  assert.match(primaryPath, /starts automatically/i);
  assert.match(primaryPath, /Install from VSIX/);
  assert.match(primaryPath, /Load unpacked/);
  assert.match(primaryPath, /Install Add-on From File/);
  assert.match(primaryPath, /click the Browser2IDE status item/i);
  assert.match(primaryPath, /five-digit port[\s\S]*two-digit PIN/i);
});

test("normal Inspector workflow is explicit and scoped to one browser window", () => {
  const normalFlow = `${primaryPath}\n${usageGuide}\n${vscodeReadme}`;
  assert.match(normalFlow, /open the project/i);
  assert.match(normalFlow, /Browser2IDE DevTools panel/i);
  assert.match(normalFlow, /Paste[\s\S]*Link/i);
  assert.match(normalFlow, /same displayed code/i);
  assert.match(normalFlow, /picker/i);
  assert.match(normalFlow, /DOM tree/i);
  assert.match(normalFlow, /active (?:CSS|SCSS)[\s\S]*(?:file|document)/i);
  assert.match(normalFlow, /exact footer outcome/i);
  assert.match(normalFlow, /Disconnect[\s\S]*only (?:the )?(?:current|linked|that) browser window/i);
  assert.doesNotMatch(normalFlow, /Change IDE|\bUnlink\b/);
});

test("Inspector materials cover the lazy DOM tree and box-model overlay", () => {
  const materials = `${readme}\n${usageGuide}\n${architectureGuide}\n${installedGuide}`;
  assert.match(materials, /lazy DOM tree/i);
  assert.match(materials, /box-model overlay/i);
  assert.match(materials, /open shadow root/i);
  assert.match(materials, /same-origin frame/i);
  assert.match(materials, /cross-origin[\s\S]*locked/i);
  assert.match(materials, /selected element[\s\S]*immediate parent/i);
  assert.match(materials, /multiple (?:source )?ranges/i);
});

test("source-resolution materials name fallback and fail-closed outcomes", () => {
  const materials = `${usageGuide}\n${architectureGuide}\n${installedGuide}`;
  assert.match(materials, /CSS fingerprint fallback/i);
  assert.match(materials, /SCSS[\s\S]*fail(?:s)? closed/i);
  assert.match(materials, /No active editor/);
  assert.match(materials, /SCSS source map missing/);
  assert.match(materials, /SCSS source map invalid/);
});

test("protocol materials pin version 4 and browser-local DOM authority", () => {
  const publicMaterials = `${readme}\n${changelog}\n${architectureGuide}\n${protocolGuide}`;
  assert.match(protocolGuide, /current protocol version is `4`/i);
  assert.match(protocolGuide, /`protocolVersion: 4`/);
  assert.match(protocolGuide, /targeted resolution repl(?:y|ies)/i);
  assert.match(protocolGuide, /peer state/i);
  assert.match(protocolGuide, /browser-local node refs/i);
  assert.match(protocolGuide, /channel/i);
  assert.match(protocolGuide, /document epoch/i);
  assert.match(protocolGuide, /branch revision/i);
  assert.match(protocolGuide, /no protocol v3 compatibility/i);
  assert.doesNotMatch(
    publicMaterials,
    /current protocol version is `3`|protocolVersion: 3|protocol v3 router/i,
  );
});

test("privacy and security materials describe the release trust boundaries", () => {
  const materials = `${privacy}\n${securityPolicy}\n${securityGuide}`;
  assert.match(materials, /loopback WebSocket/i);
  assert.match(materials, /no (?:product )?HTTP/i);
  assert.match(materials, /explicit (?:browser-)?window link/i);
  assert.match(materials, /two-digit PIN[\s\S]*accidental cross-link/i);
  assert.match(materials, /not strong authentication/i);
  assert.match(materials, /session storage/i);
  assert.match(materials, /bounded (?:inspection )?facts/i);
  assert.match(materials, /does not upload[\s\S]*source/i);
  assert.match(materials, /does not (?:write|edit)[\s\S]*execute/i);
  assert.match(materials, /DOM tree stays browser-local/i);
  assert.match(materials, /cross-origin[\s\S]*fail closed/i);
  assert.match(materials, /closed shadow[\s\S]*fail closed/i);
});

test("0.3.0 record marks unperformed external evidence pending", () => {
  assert.match(verificationRecord, /Pending external release evidence/);
  assert.match(verificationRecord, /No signed `0\.3\.0` XPI/i);
  assert.match(verificationRecord, /hashes?\s+(?:are|is)\s+pending/i);
  assert.match(verificationRecord, /screenshots? (?:and|or) GIF[\s\S]*pending/i);
  assert.doesNotMatch(verificationRecord, /[0-9a-f]{64}/i);
});

test("README points to concise repository and verification material", () => {
  assert.match(readme, /docs\/installed-verification\.md/);
  assert.match(readme, /docs\/mvp-usage\.md/);
  assert.match(readme, /docs\/architecture\.md/);
  assert.match(readme, /docs\/protocol\.md/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(readme, /MIT License/);
  assert.doesNotMatch(readme, /browser2ide-(?:linking\.png|inspect\.gif)/);
  assert.match(
    developmentGuide,
    /^# Browser2IDE Development Host Verification\r?\n/,
  );
  assert.match(developmentGuide, /installed-verification\.md/);
  assert.match(developmentGuide, /smoke:chrome-package[\s\S]*Linux[\s\S]*Xvfb/);
});
