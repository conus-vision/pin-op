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
const activeIdentityPaths = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "PRIVACY.md",
  "SECURITY.md",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
  ".github/ISSUE_TEMPLATE/feature-request.yml",
  ".github/pull_request_template.md",
  "docs/architecture.md",
  "docs/firefox-source-submission.md",
  "docs/installed-verification.md",
  "docs/mvp-usage.md",
  "docs/mvp-verification.md",
  "docs/protocol.md",
  "docs/release.md",
  "docs/security.md",
  "docs/source-plugin-authoring.md",
  "extensions/source-plugin-fixture/README.md",
  "extensions/vscode/README.md",
  "examples/basic-css/index.html",
  "examples/basic-css/server.mjs",
];
const activeIdentityDocuments = await Promise.all(
  activeIdentityPaths.map(async (path) => ({
    path,
    content: await readFile(path, "utf8"),
  })),
);
const legacyProductDisplay = ["Pin", "Op"].join("");
const legacyTechnicalSlug = ["pin", "op"].join("");
const legacyTechnicalTitle = ["Pin", "op"].join("");
const legacyTechnicalUpper = ["PIN", "OP"].join("");
const legacyOriginalDisplay = ["Browser", "2", "IDE"].join("");
const legacyOriginalSlug = ["browser", "2", "ide"].join("");
const recordHeading = "## 0.3.0 Candidate Verification Record";
const [primaryPath, verificationRecord] = installedGuide.split(recordHeading);
const installedRunbookHeading = "## Installed Product Verification";
const sourceWorkflowHeading = "## Development And Source Workflow";
const [, installedAndSourceWorkflow] = developmentGuide.split(
  installedRunbookHeading,
);
const [installedProductRunbook, sourceWorkflow] = (
  installedAndSourceWorkflow ?? ""
).split(sourceWorkflowHeading);
const [, sourceNavigationAndLater] = protocolGuide.split("## Source Navigation");
const [sourceNavigationSection] = (sourceNavigationAndLater ?? "").split(
  "## Peer State",
);
const [, sourcePresentationAndLater] = protocolGuide.split(
  "## Source Presentation And Settings",
);
const [sourcePresentationSection] = (sourcePresentationAndLater ?? "").split(
  "## Source Navigation",
);
const [, readOnlySecuritySection] = protocolGuide.split(
  "## Read-Only Security Model",
);
const securityDisclosureContracts = [
  {
    name: "temporary overlay insertion",
    message: "temporary isolated overlay insertion disclosure is required",
    pattern: completeClause(
      String.raw`(?:For|During) visual (?:inspection|highlighting), `,
      String.raw`(?:the (?:browser )?extension|Pin-op) temporarily `,
      String.raw`(?:inserts|adds) an isolated Pin-op `,
      String.raw`(?:inspection )?overlay DOM(?: subtree)?`,
      String.raw`(?: under (?:a|the) dedicated pointer-inert host`,
      String.raw`(?: with a closed shadow root)?)?`,
    ),
    negation: [/temporarily (?:inserts|adds)/i, "does not insert"],
  },
  {
    name: "inspection and locator exclusion",
    message: "overlay inspection and locator exclusion disclosure is required",
    pattern: completeClause(
      String.raw`(?:All )?(?:Pin-op )?overlay-owned nodes `,
      String.raw`(?:are|remain) excluded from Pin-op `,
      String.raw`(?:DOM tree )?inspection and (?:from )?stable locator capture`,
    ),
    negation: [/(?:are|remain) excluded/i, "are not excluded"],
  },
  {
    name: "inspection disable cleanup",
    message: "inspection disable overlay cleanup disclosure is required",
    pattern: completeClause(
      String.raw`(?:When|Once) visual inspection is disabled(?: or cleared)?, `,
      String.raw`the rendered overlay is (?:removed|cleared)`,
    ),
    negation: [/overlay is (?:removed|cleared)/i, "overlay is not removed"],
  },
  {
    name: "disconnect and session disposal cleanup",
    message: "disconnect and session disposal cleanup disclosure is required",
    pattern: completeClause(
      String.raw`(?:Disconnecting|A disconnect) (?:disposes|closes) `,
      String.raw`the inspection session; (?:that )?disposal `,
      String.raw`(?:removes|cleans up) (?:its|the) (?:overlay )?host and `,
      String.raw`(?:any|all) remaining overlay DOM`,
    ),
    negation: [/disposal (?:removes|cleans up)/i, "disposal does not remove"],
  },
  {
    name: "arbitrary page writes and source immutability",
    message: "arbitrary page write and source immutability disclosure is required",
    pattern: completeClause(
      String.raw`Pin-op exposes no arbitrary page-owned DOM write `,
      String.raw`and does not modify source code`,
    ),
    negation: [
      /no arbitrary page-owned DOM write and does not modify source code/i,
      "may arbitrarily modify page-owned DOM and source code",
    ],
  },
];

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
  assert.match(primaryPath, /click the Pin-op status item/i);
  assert.match(primaryPath, /five-digit port[\s\S]*two-digit PIN/i);
});

test("MVP runbook leads with installed-product UX and explicit window association", () => {
  assert.ok(installedAndSourceWorkflow, "installed-product heading is required");
  assert.ok(sourceWorkflow, "separate development/source heading is required");
  for (const prohibited of [
    "--extensionDevelopmentPath",
    "--pairing-code",
    "web-ext run",
    "corepack",
    "pnpm",
    "terminal 1",
    "terminal 2",
  ]) {
    assert.equal(installedProductRunbook.includes(prohibited), false, prohibited);
  }
  assert.match(installedProductRunbook, /no source (?:checkout or )?terminal/i);
  assert.match(installedProductRunbook, /starts automatically/i);
  assert.match(installedProductRunbook, /status bar/i);
  assert.match(
    installedProductRunbook,
    /browser window[\s\S]*VS Code window[\s\S]*(?:port|five-digit)[\s\S]*(?:code|PIN)/i,
  );
});

test("MVP runbook uses flat downloaded filenames for installed packages", () => {
  assert.doesNotMatch(installedProductRunbook, /artifacts[\\/]/i);
  assert.match(
    installedProductRunbook,
    /`pin-op-vscode-0\.3\.0\.vsix`/,
  );
  assert.match(
    installedProductRunbook,
    /`pin-op-chrome-0\.3\.0\.zip`/,
  );
  assert.match(installedProductRunbook, /Load unpacked/);
  assert.match(
    installedProductRunbook,
    /`pin-op-firefox-0\.3\.0\.zip`/,
  );
  assert.match(installedProductRunbook, /Temporary Add-on|about:debugging/i);
  assert.match(
    installedProductRunbook,
    /signed[\s\S]*`pin-op-firefox-0\.3\.0\.xpi`/i,
  );
});

test("normal Inspector workflow is explicit and scoped to one browser window", () => {
  const normalFlow = `${installedProductRunbook}\n${primaryPath}\n${usageGuide}\n${vscodeReadme}`;
  assert.match(normalFlow, /open the project/i);
  assert.match(normalFlow, /Pin-op DevTools panel/i);
  assert.match(normalFlow, /Paste[\s\S]*Link/i);
  assert.match(normalFlow, /same displayed code/i);
  assert.match(normalFlow, /picker/i);
  assert.match(normalFlow, /DOM tree/i);
  assert.match(normalFlow, /active (?:CSS|SCSS)[\s\S]*(?:file|document)/i);
  assert.match(normalFlow, /exact footer outcome/i);
  assert.match(normalFlow, /Disconnect[\s\S]*only (?:the )?(?:current|linked|that) browser window/i);
  assert.doesNotMatch(normalFlow, /Change IDE|\bUnlink\b/);
});

test("installed runbook covers source navigation and fail-closed recovery", () => {
  const scenario = installedProductRunbook;
  assert.match(scenario, /connect/i);
  assert.match(scenario, /expand\s+(?:a|one)\s+branch/i);
  assert.match(
    scenario,
    /at least\s+two\s+Selected\s+matches|>=\s*2\s+selected\s+matches/i,
  );
  assert.match(scenario, /row[\s\S]*footer[\s\S]*(?:same|sync)/i);
  assert.match(scenario, /selection itself does not move[\s\S]*VS Code cursor/i);
  assert.match(
    scenario,
    /first (?:Previous|Next|previous|next)[\s\S]*(?:moves|move)[\s\S]*(?:centers|center)/,
  );
  assert.match(scenario, /- \/ N/);
  assert.match(scenario, /Parent ranges[\s\S]*distinct[\s\S]*excluded from navigation/i);
  assert.match(
    scenario,
    /reload[\s\S]*identity is unchanged[\s\S]*without (?:a )?root-only flash/i,
  );
  assert.match(
    scenario,
    /identity\s+is\s+changed\s+or\s+ambiguous[\s\S]*safely\s+resets/i,
  );
  assert.match(scenario, /second invalidation[\s\S]*manual selection wins/i);
  assert.match(
    scenario,
    /Disconnect[\s\S]*controls (?:are )?disabled[\s\S]*no stale route/i,
  );
  assert.match(scenario, /expected (?:manual )?(?:acceptance )?steps/i);
  assert.match(scenario, /does not claim[\s\S]*performed/i);
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

test("protocol materials pin exact version 6 and terminal v5 rejection", () => {
  const publicMaterials = `${readme}\n${changelog}\n${architectureGuide}\n${protocolGuide}`;
  assert.match(protocolGuide, /current protocol version is `6`/i);
  assert.match(protocolGuide, /`protocolVersion: 6`/);
  assert.match(protocolGuide, /source-navigation/);
  assert.match(protocolGuide, /source-presentation/);
  assert.match(protocolGuide, /capabilit(?:y|ies)[\s\S]*hello/i);
  assert.match(protocolGuide, /exact version[\s\S]*no downgrade/i);
  assert.match(protocolGuide, /v5 peer[\s\S]*1002[\s\S]*no[\s\S]*fallback/i);
  assert.match(protocolGuide, /targeted resolution repl(?:y|ies)/i);
  assert.match(protocolGuide, /peer state/i);
  assert.match(protocolGuide, /browser-local node refs/i);
  assert.match(protocolGuide, /channel/i);
  assert.match(protocolGuide, /document epoch/i);
  assert.match(protocolGuide, /branch revision/i);
  assert.doesNotMatch(
    publicMaterials,
    /current protocol version is `[45]`|`protocolVersion: [45]`|protocol v[45] router/i,
  );
});

test("protocol guide contains strict source navigation examples", () => {
  assert.deepEqual(jsonExample("source.navigate"), {
    protocolVersion: 6,
    type: "source.navigate",
    messageId: "navigate-19",
    sessionId: "default",
    inspectMessageId: "inspect-42",
    resolutionGeneration: 3,
    direction: "next",
    metadata: {},
  });
  assert.deepEqual(jsonExample("source.navigationState"), {
    protocolVersion: 6,
    type: "source.navigationState",
    messageId: "navigation-state-20",
    sessionId: "default",
    inspectMessageId: "inspect-42",
    source: { role: "ide", id: "vscode-window-1" },
    resolutionGeneration: 3,
    selectedMatchCount: 2,
    activeMatchIndex: 0,
    metadata: {},
  });
});

test("protocol guide exposes only bounded excerpts and opaque source-open authority", () => {
  assert.ok(sourcePresentationSection, "Source Presentation section is required");
  const matches = jsonExample("source.matches");
  assert.equal(matches.protocolVersion, 6);
  assert.equal(matches.type, "source.matches");
  assert.deepEqual(Object.keys(matches).sort(), [
    "document",
    "inspectMessageId",
    "matches",
    "messageId",
    "metadata",
    "omittedMatchCount",
    "protocolVersion",
    "resolutionGeneration",
    "sessionId",
    "source",
    "type",
  ]);
  assert.equal(matches.matches.length, 1);
  assert.deepEqual(Object.keys(matches.matches[0]).sort(), [
    "confidence",
    "endLine",
    "kind",
    "label",
    "matchId",
    "relation",
    "startLine",
    "targetRole",
    "text",
    "truncated",
  ]);
  assert.equal(matches.matches[0].matchId, "opaque-match-1");
  assert.match(sourcePresentationSection, /at most 32 excerpts/i);
  assert.match(sourcePresentationSection, /at most 256 KiB/i);
  assert.match(sourcePresentationSection, /at most 80 logical lines and 8 KiB/i);
  assert.match(
    sourcePresentationSection,
    /no workspace path, source URI, browser tab ID, editor range, or full source\s+document/i,
  );

  const [, sourceOpenAndLater = ""] = sourcePresentationSection.split(
    "Clicking an excerpt sends `source.open`",
  );
  const [sourceOpenWireContract = ""] = sourceOpenAndLater.split(".");
  assert.match(
    sourceOpenWireContract,
    /only `inspectMessageId`,\s*`resolutionGeneration`, and the opaque `matchId`/i,
  );
  assert.doesNotMatch(
    sourceOpenWireContract,
    /\b(?:command|file|line|path|range|source map|uri)\b/i,
  );
});

test("protocol guide documents targeted repeated selected-only navigation state", () => {
  assert.ok(sourceNavigationSection, "Source Navigation section is required");
  assert.match(
    sourceNavigationSection,
    /source\.navigate[\s\S]*same inspect reply route[\s\S]*same browser connection/i,
  );
  assert.match(
    sourceNavigationSection,
    /source\.navigate[\s\S]*(?:has no|does not carry)[\s\S]*`source` field/i,
  );
  assert.match(
    sourceNavigationSection,
    /bridge[\s\S]*authenticated\s+sender[\s\S]*role[\s\S]*source[\s\S]*client\s+identity[\s\S]*exact\s+(?:inspect\s+)?reply\s+route/i,
  );
  assert.match(
    sourceNavigationSection,
    /endpoint correlation[\s\S]*session[\s\S]*window[\s\S]*channel[\s\S]*inspectMessageId[\s\S]*resolutionGeneration/i,
  );
  assert.match(
    sourceNavigationSection,
    /browser[\s\S]*does not[\s\S]*(?:compare|correlate)[\s\S]*(?:IDE )?source ID/i,
  );
  assert.match(
    sourceNavigationSection,
    /repeated\s+`?source\.navigationState`?[\s\S]*same\s+resolution\s+generation/i,
  );
  assert.match(sourceNavigationSection, /selected-only/i);
  assert.match(
    sourceNavigationSection,
    /Parent ranges[\s\S]*never[\s\S]*navigation/i,
  );
  assert.match(
    sourceNavigationSection,
    /activeMatchIndex[\s\S]*omitted[\s\S]*(?:before navigation|outside (?:all )?matches)/i,
  );
  assert.doesNotMatch(
    sourceNavigationSection,
    /browser and IDE[^.]*correlate[^.]*source ID/i,
  );
});

test("protocol guide bounds browser-local locator recovery and keeps it off WebSocket", () => {
  assert.match(protocolGuide, /dom\.resolveLocator/);
  assert.match(protocolGuide, /stable locator/i);
  assert.match(protocolGuide, /total depth[\s\S]*64/i);
  assert.match(protocolGuide, /16[\s\S]*(?:shadow|frame)[\s\S]*boundar/i);
  assert.match(protocolGuide, /8\s+classes[\s\S]*8\s+(?:approved\s+)?attributes/i);
  assert.match(protocolGuide, /128[\s\S]*token/i);
  assert.match(protocolGuide, /fingerprint/i);
  assert.match(protocolGuide, /identity/i);
  assert.match(protocolGuide, /fail(?:s)? closed/i);
  assert.match(protocolGuide, /locators never cross (?:the )?WebSocket/i);
});

test("protocol guide states the read-only browser and IDE execution boundary", () => {
  assert.ok(readOnlySecuritySection, "Read-Only Security Model section is required");
  assertReadOnlySecurityDisclosure(readOnlySecuritySection);
  assert.match(readOnlySecuritySection, /browser[\s\S]*read[\s\S]*(?:DOM|CSS)/i);
  assert.match(readOnlySecuritySection, /does\s+not\s+execute page commands/i);
  assert.match(readOnlySecuritySection, /IDE[\s\S]*read[\s\S]*workspace/i);
  assert.match(
    readOnlySecuritySection,
    /IDE extension[\s\S]*move[\s\S]*cursor[\s\S]*(?:Previous\/Next|source\.open)/i,
  );
  assert.match(readOnlySecuritySection, /cannot[\s\S]*edit or write source files/i);
  assert.match(readOnlySecuritySection, /cannot[\s\S]*shell[\s\S]*workspace command/i);
  assert.match(readOnlySecuritySection, /cannot[\s\S]*execute page scripts/i);
  assert.match(
    readOnlySecuritySection,
    /bounded active-document excerpts[\s\S]*cross[\s\S]*WebSocket/i,
  );
  assert.match(
    readOnlySecuritySection,
    /Browser-local locators and node refs never[\s\S]*cross/i,
  );
  assert.match(
    readOnlySecuritySection,
    /Full source documents[\s\S]*local file paths and URIs[\s\S]*source maps[\s\S]*never cross/i,
  );
  assert.doesNotMatch(
    readOnlySecuritySection,
    /cannot (?:write or modify|modify) the page DOM/i,
  );
});

test("protocol overlay disclosure rejects negated or missing clauses", async (t) => {
  assert.ok(readOnlySecuritySection, "Read-Only Security Model section is required");
  const clauses = securityClauses(readOnlySecuritySection);

  for (const contract of securityDisclosureContracts) {
    const clauseIndex = clauses.findIndex((clause) => contract.pattern.test(clause));
    assert.notEqual(
      clauseIndex,
      -1,
      `source clause is required for ${contract.name} mutation coverage`,
    );

    await t.test(`rejects negated ${contract.name}`, () => {
      const mutated = [...clauses];
      mutated[clauseIndex] = replaceRequired(
        mutated[clauseIndex],
        ...contract.negation,
      );
      assertDisclosureFailure(mutated, contract.message);
    });

    await t.test(`rejects missing ${contract.name}`, () => {
      const mutated = clauses.filter((_, index) => index !== clauseIndex);
      assertDisclosureFailure(mutated, contract.message);
    });
  }
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

test("README points to the canonical Pin-op product and repository", () => {
  assert.match(readme, /^# Pin-op\r?\n/);
  assert.match(
    readme,
    /Highlights styles and source code in your IDE for the DOM element selected in\s+the browser\./,
  );
  assert.match(readme, /https:\/\/pin-op\.conus\.vision/);
  assert.match(
    readme,
    /\[Repository\]\(https:\/\/github\.com\/conus-vision\/pin-op\)/,
  );
  assert.match(readme, /https:\/\/github\.com\/conus-vision\/pin-op\/issues/);
  assert.match(readme, /`conus-vision\.pin-op`/);
  assert.match(readme, /`@pin-op\//);
  assert.match(readme, /`pin-op-vscode-0\.3\.0\.vsix`/);
  assert.match(readme, /`pin-op-chrome-0\.3\.0\.zip`/);
  assert.match(readme, /`pin-op-firefox-0\.3\.0\.zip`/);
  assert.match(readme, /`pin-op-firefox-0\.3\.0\.xpi`/);
  assert.match(readme, /`pin-op-firefox-source-0\.3\.0\.zip`/);
  assert.match(readme, /six public assets/i);
  assert.match(readme, /`SHA256SUMS`/);
  assert.match(
    readme,
    /`SHA256SUMS`[\s\S]*verify[\s\S]*(?:downloaded|release) artifacts/i,
  );
  assert.match(readme, /docs\/installed-verification\.md/);
  assert.match(readme, /docs\/mvp-usage\.md/);
  assert.match(readme, /docs\/architecture\.md/);
  assert.match(readme, /docs\/protocol\.md/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /SECURITY\.md/);
  assert.match(readme, /MIT License/);
  assert.doesNotMatch(readme, /pin-op-(?:linking\.png|inspect\.gif)/);
  assert.match(
    developmentGuide,
    /^# Pin-op MVP Verification\r?\n/,
  );
  assert.match(developmentGuide, /## Installed Product Verification/);
  assert.match(developmentGuide, /## Development And Source Workflow/);
  assert.match(sourceWorkflow, /optional|development|source checkout/i);
  assert.match(sourceWorkflow, /corepack pnpm/);
  assert.match(sourceWorkflow, /smoke:chrome-package[\s\S]*Linux[\s\S]*Xvfb/);
  assert.doesNotMatch(sourceWorkflow, /terminal [1-9]|--pairing-code/i);
});

test("active documentation uses only the canonical Pin-op identity", () => {
  for (const { path, content } of activeIdentityDocuments) {
    for (const pattern of legacyIdentityPatterns()) {
      assert.doesNotMatch(content, pattern, `${path}: ${pattern}`);
    }
  }
});

for (const mutation of [
  legacyTechnicalSlug,
  legacyTechnicalTitle,
  legacyTechnicalUpper,
  legacyProductDisplay,
  `corepack pnpm --filter ${legacyTechnicalSlug} build`,
  `corepack pnpm --filter ${legacyTechnicalTitle} build`,
  `https://github.com/conus-vision/${legacyTechnicalSlug}`,
  `https://${legacyTechnicalSlug}.conus.vision`,
  `artifacts/${legacyTechnicalSlug}-vscode-0.3.0.vsix`,
  `docs/${legacyTechnicalSlug}/setup.md`,
]) {
  test(`legacy identity detector rejects ${JSON.stringify(mutation)}`, () => {
    assert.equal(hasLegacyIdentity(mutation), true, mutation);
  });
}

test("legacy identity detector allows real PascalCase API symbols", () => {
  for (const identifier of [
    "PinOpApi",
    "PinOpMessage",
    "PinOpMessageSchema",
    "createPinOpApi",
    "pinOpClient",
  ]) {
    assert.equal(hasLegacyIdentity(identifier), false, identifier);
  }
});

function jsonExample(type) {
  for (const match of protocolGuide.matchAll(/```json\s*([\s\S]*?)```/g)) {
    const value = JSON.parse(match[1]);
    if (value?.type === type) return value;
  }
  assert.fail(`Missing JSON example for ${type}`);
}

function hasLegacyIdentity(content) {
  return legacyIdentityPatterns().some((pattern) => pattern.test(content));
}

function legacyIdentityPatterns() {
  return [
    new RegExp(`\\b${legacyProductDisplay}\\b`),
    new RegExp(
      `(?:^|[^A-Za-z0-9])${legacyTechnicalSlug}(?=$|[^A-Za-z0-9])`,
      "i",
    ),
    new RegExp(`\\b${legacyOriginalDisplay}\\b`),
    new RegExp(`${legacyOriginalSlug}(?=[._/-]|\\b)`, "i"),
    new RegExp(
      `formerly\\s+(?:${legacyProductDisplay}|${legacyOriginalDisplay})`,
      "i",
    ),
  ];
}

function completeClause(...fragments) {
  return new RegExp(`^${fragments.join("")}\\.$`, "i");
}

function assertReadOnlySecurityDisclosure(section) {
  for (const { pattern, message } of securityDisclosureContracts) {
    assertCompletePositiveClause(section, pattern, message);
  }
}

function assertCompletePositiveClause(section, pattern, message) {
  assert.ok(
    securityClauses(section).some((clause) => pattern.test(clause)),
    message,
  );
}

function securityClauses(section) {
  return section
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
}

function assertDisclosureFailure(clauses, message) {
  assert.throws(
    () => assertReadOnlySecurityDisclosure(clauses.join(" ")),
    new RegExp(escapeRegex(message)),
  );
}

function replaceRequired(value, search, replacement) {
  const mutated = value.replace(search, replacement);
  assert.notEqual(mutated, value, `mutation source is missing: ${search}`);
  return mutated;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
