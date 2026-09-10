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
const storeListings = await readFile("docs/store-listings.md", "utf8");
const releaseGuide = await readFile("docs/release.md", "utf8");
const firefoxSourceSubmission = await readFile(
  "docs/firefox-source-submission.md",
  "utf8",
);
const sourcePluginGuide = await readFile(
  "docs/source-plugin-authoring.md",
  "utf8",
);
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
const releaseArtifactNames = [
  "pin-op-vscode-0.4.2.vsix",
  "pin-op-chrome-0.4.2.zip",
  "pin-op-firefox-0.4.2.zip",
  "pin-op-firefox-source-0.4.2.zip",
  "SHA256SUMS",
];
const recordHeading = "## 0.4.2 Candidate Verification Record";
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
const [, rulesSourcesAndLater] = protocolGuide.split(
  "## Rules Source Navigation",
);
const [rulesSourcesSection] = (rulesSourcesAndLater ?? "").split(
  "## Auto Refresh",
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
  assert.ok(verificationRecord, "0.4.2 candidate verification record is required");
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
  assert.match(primaryPath, /addons.mozilla.org and add it to Firefox/);
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
    /`pin-op-vscode-0\.4\.2\.vsix`/,
  );
  assert.match(
    installedProductRunbook,
    /`pin-op-chrome-0\.4\.2\.zip`/,
  );
  assert.match(installedProductRunbook, /Load unpacked/);
  assert.match(
    installedProductRunbook,
    /`pin-op-firefox-0\.4\.2\.zip`/,
  );
  assert.match(installedProductRunbook, /Temporary Add-on|about:debugging/i);
  assert.match(
    installedProductRunbook,
    /signed[\s\S]*`pin-op-firefox-0\.4\.2\.xpi`/i,
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

test("ordinary installed artifacts use the shared Inspector by default", () => {
  const defaultParagraph = requireMarkdownParagraph(
    installedGuide,
    /ordinary\/store artifacts/i,
    "installed default panel disclosure",
  );
  assert.match(defaultParagraph, /default[\s\S]*Chromium-derived[\s\S]*Inspector/i);
  assert.match(defaultParagraph, /Rules origin/i);
  assert.doesNotMatch(defaultParagraph, /default[\s\S]*legacy rollback panel/i);

});

test("current rollout docs reject stale opt-in and store-default legacy claims", () => {
  const [, currentChangelogAndLater = ""] = changelog.split(
    "## [0.4.2]",
  );
  const [currentChangelog = ""] = currentChangelogAndLater.split("\n## ");
  const currentScopes = [
    ["README.md", readme],
    ["CHANGELOG.md 0.4.2", currentChangelog],
    ["PRIVACY.md", privacy],
    ["docs/architecture.md", architectureGuide],
    ["docs/security.md", securityGuide],
    ["docs/protocol.md", protocolGuide],
    ["docs/mvp-usage.md", usageGuide],
    ["docs/mvp-verification.md installed runbook", installedProductRunbook],
    ["docs/installed-verification.md current runbook", primaryPath],
    ["docs/release.md", releaseGuide],
    ["docs/store-listings.md", storeListings],
  ];

  for (const [name, content] of currentScopes) {
    const staleClaim = findStaleRolloutClaim(content);
    assert.equal(
      staleClaim,
      undefined,
      staleClaim
        ? `${name}: stale affirmative rollout claim: ${staleClaim}`
        : name,
    );
  }

  const [, checkpointOneAndLater = ""] = developmentGuide.split(
    "## Checkpoint 1 Development-Host Evidence (2026-08-24)",
  );
  const [checkpointOneEvidence = ""] = checkpointOneAndLater.split(
    "## Checkpoint 2 Rules Manual Gate",
  );
  assert.match(
    checkpointOneEvidence,
    /legacy panel remained the default rollback asset/i,
    "historical Checkpoint 1 evidence must remain historical",
  );
});

test("stale rollout detector distinguishes retirement text from current instructions", () => {
  for (const allowed of [
    "Store artifacts do not use the legacy rollback panel.",
    "Store artifacts no longer use the legacy rollback panel.",
    "The build does not default to legacy.",
    "The build no longer defaults to legacy.",
    "`PIN_OP_PANEL_VARIANT=inspector` is obsolete.",
    "`PIN_OP_PANEL_VARIANT=inspector` is no longer needed.",
    "The removed opt-in Inspector candidate remains only in historical evidence.",
    "The retired opt-in Inspector candidate is not a current package.",
    "The legacy panel is an explicit non-default rollback asset.",
    "The legacy rollback panel is not the store default.",
    "Store artifacts use the legacy page as an explicit non-default rollback.",
    "Store artifacts use the legacy page for an explicit non-default rollback.",
    "Store artifacts can use the legacy page only when the explicit legacy rollback flag is selected.",
  ]) {
    assert.equal(findStaleRolloutClaim(allowed), undefined, allowed);
  }

  for (const stale of [
    "The build defaults to legacy.",
    "The legacy rollback panel remains the store default.",
    "The store default is the legacy panel.",
    "Set `PIN_OP_PANEL_VARIANT=inspector` to enable the current UI.",
    "The opt-in Inspector candidate is the current package.",
    "Ordinary/store artifacts use the legacy rollback panel.",
    "Store artifacts load the legacy page by default.",
    "Do not remove the rollback asset; Store artifacts use the legacy rollback panel.",
  ]) {
    assert.ok(findStaleRolloutClaim(stale), stale);
  }
});

test("read-only Rules verification applies to installed Chrome and Firefox", () => {
  const rulesParagraph = requireMarkdownParagraph(
    installedGuide,
    /read-only Rules/i,
    "installed read-only Rules verification",
  );
  assert.match(rulesParagraph, /installed Chrome[\s\S]*installed Firefox/i);
  assert.doesNotMatch(rulesParagraph, /PIN_OP_PANEL_VARIANT=inspector|opt-in/i);
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

test("MVP usage scopes structured DOM values to the default Inspector", () => {
  const domTreeUsage = markdownSection(usageGuide, "Select From The DOM Tree");
  const defaultInspector = requireMarkdownParagraph(
    domTreeUsage,
    /default Inspector/i,
    "default Inspector structured DOM presentation",
  );
  assert.match(defaultInspector, /bounded attribute names and values/i);
  assert.match(defaultInspector, /bounded (?:text and comment|text\/comment) rows/i);
  assert.doesNotMatch(
    defaultInspector,
    /attribute values[^.]*do not appear|DOM text[^.]*do(?:es)? not appear/i,
  );

});

test("MVP usage preserves CORS-readable cross-origin stylesheet support", () => {
  for (const broadClaim of [
    "Cross-origin stylesheets are unavailable.",
    "Cross-origin stylesheets remain unsupported.",
    "Cross-origin stylesheets are inaccessible.",
  ]) {
    assert.equal(isBroadCrossOriginStylesheetClaim(broadClaim), true);
  }
  for (const boundedClaim of [
    "Only cross-origin stylesheets whose CSSOM is inaccessible are unavailable.",
    "Cross-origin stylesheets with unreadable CSSOM remain unsupported.",
    "CORS-readable cross-origin stylesheets remain supported.",
  ]) {
    assert.equal(isBroadCrossOriginStylesheetClaim(boundedClaim), false);
  }

  const limits = markdownSection(usageGuide, "Known Limits");
  const stylesheetLimit = requireMarkdownParagraph(
    limits,
    /cross-origin stylesheet/i,
    "cross-origin stylesheet CSSOM boundary",
  );
  assert.match(
    stylesheetLimit,
    /(?:only\s+cross-origin stylesheets? (?:whose|with) (?:an? )?inaccessible CSSOM|cross-origin stylesheets? whose CSSOM is inaccessible)[^.]*unavailable/i,
  );
  assert.match(
    stylesheetLimit,
    /CORS-readable(?: cross-origin stylesheets?| CSSOM)[^.]*(?:supported|available|inspectable|readable)/i,
  );
  assert.doesNotMatch(
    usageGuide,
    /cross-origin or otherwise inaccessible stylesheets/i,
  );

  assert.deepEqual(
    securityClauses(usageGuide).filter(isBroadCrossOriginStylesheetClaim),
    [],
    "cross-origin stylesheet limits must be qualified by inaccessible or unreadable CSSOM",
  );
});

test("release docs identify the shared Chromium-derived UI and auditable source", () => {
  for (const [name, document] of [
    ["README.md", readme],
    ["docs/architecture.md", architectureGuide],
  ]) {
    const paragraph = requireMarkdownParagraph(
      document,
      /Chromium-derived/i,
      `${name} shared Inspector disclosure`,
    );
    assert.match(paragraph, /(?:Chrome and Firefox|both browsers)/i, name);
    assert.match(paragraph, /one shared[\s\S]*read-only Inspector UI/i, name);
  }

  const provenance = requireMarkdownParagraph(
    firefoxSourceSubmission,
    /Chromium/i,
    "Firefox source-submission Chromium provenance",
  );
  assert.match(provenance, /BSD[\s-]*(?:licensed|attribution|notice)/i);
  assert.match(provenance, /pinned[\s\S]*source[\s\S]*(?:available|included)/i);
  assert.match(provenance, /UPSTREAM\.json[\s\S]*THIRD_PARTY_NOTICES/i);
});

test("product docs distinguish exact origin opening from pseudo preview", () => {
  const origin = requireMarkdownParagraph(
    usageGuide,
    /Rules origin click/i,
    "Rules origin opening disclosure",
  );
  assert.match(origin, /only (?:after|on)[\s\S]*explicit/i);
  assert.match(origin, /exact[\s\S]*CSS[\s\S]*(?:source-mapped|original) SCSS/i);

  const preview = requireMarkdownParagraph(
    usageGuide,
    /author-style pseudo preview/i,
    "pseudo-state preview disclosure",
  );
  assert.match(preview, /:hover[\s\S]*:focus/i);
  assert.match(preview, /not native (?:pseudo-state )?forc(?:e|ing)/i);

  const readOnly = requireMarkdownParagraph(
    securityGuide,
    /user-authored (?:CSS|DOM)/i,
    "read-only preview boundary",
  );
  assert.match(readOnly, /no user-authored CSS or DOM editing operations/i);
  assert.match(readOnly, /does not dispatch[^.]*\binput\b[^.]*events/i);
  assert.match(readOnly, /does not dispatch[^.]*\bfocus\b[^.]*events/i);
  assert.match(readOnly, /does not dispatch[^.]*\bmouse\b[^.]*events/i);
  assert.match(readOnly, /does not dispatch[^.]*\bpointer\b[^.]*events/i);
  assert.match(readOnly, /does not dispatch[^.]*\bkeyboard\b[^.]*events/i);
});

test("preview docs disclose observable artifacts, abrupt loss, and unsupported cases", () => {
  const observable = requireMarkdownParagraph(
    privacy,
    /temporary preview artifacts/i,
    "observable preview-artifact disclosure",
  );
  assert.match(observable, /page scripts[\s\S]*(?:may|can) observe/i);
  assert.match(observable, /while (?:the )?preview is enabled/i);

  const abruptLoss = requireMarkdownParagraph(
    installedGuide,
    /abrupt extension termination/i,
    "abrupt extension termination disclosure",
  );
  const abruptClause = requireMarkdownClause(
    abruptLoss,
    /abrupt extension termination/i,
    "abrupt extension artifact lifetime",
  );
  assertAbruptArtifactClause(abruptClause);

  const limits = markdownSection(usageGuide, "Known Limits");
  assert.match(limits, /UA and user styles/i);
  assert.match(
    limits,
    /inaccessible[\s\S]{0,180}stylesheet[\s\S]{0,180}(?:unavailable|PARTIAL)/i,
  );
  assertExplicitFidelityLimit(
    limits,
    /cross-origin frames?/i,
    "cross-origin frame fidelity limit",
  );
  assertExplicitFidelityLimit(
    limits,
    /closed shadow(?: roots?)?/i,
    "closed shadow fidelity limit",
  );
  assert.match(limits, /:not\(:hover\)[\s\S]{0,180}PARTIAL/i);
  assert.match(limits, /ancestor[\s\S]{0,180}(?:hover|focus)[\s\S]{0,180}PARTIAL/i);
  assert.match(limits, /unsupported[\s\S]{0,240}not guessed/i);
});


test("architecture and security document structured Inspector DOM data", () => {
  for (const [name, guide] of [
    ["architecture", architectureGuide],
    ["security", securityGuide],
  ]) {
    assert.match(guide, /structured (?:DOM )?(?:node )?(?:snapshots|fields)/i, name);
    assert.match(guide, /bounded attribute (?:names and values|values)/i, name);
    assert.match(guide, /bounded (?:text and comment|text\/comment) values/i, name);
    assert.match(
      guide,
      /document[- ]type[\s\S]{0,160}(?:public and system|public\/system) IDs/i,
      name,
    );
  }
});

test("Checkpoint 1 evidence assigns every listed Firefox check to its native Inspector panel", () => {
  const [, checkpointAndLater] = developmentGuide.split(
    "## Checkpoint 1 Development-Host Evidence (2026-08-24)",
  );
  const [checkpointEvidence] = (checkpointAndLater ?? "").split(
    "## Installed Product Verification",
  );

  assert.ok(checkpointEvidence, "Checkpoint 1 evidence is required");
  assert.match(
    checkpointEvidence,
    /Firefox[\s\S]{0,240}registered native\s+(?:Inspector panel|custom tab)[\s\S]{0,240}complete interactive checklist/i,
  );
  for (const check of [
    "mutation",
    "reload",
    "resize",
    "keyboard",
    "forced colors",
    "Disconnect",
  ]) {
    assert.match(
      checkpointEvidence,
      new RegExp(`native Firefox Inspector\\s+panel[^.]{0,500}${check}`, "i"),
      check,
    );
  }
  assert.match(
    checkpointEvidence,
    /add-on-scoped\s+DevTools harness[\s\S]{0,180}(?:supplementary|not a substitute)/i,
  );
});

test("source-resolution materials name fallback and fail-closed outcomes", () => {
  const materials = `${usageGuide}\n${architectureGuide}\n${installedGuide}`;
  assert.match(materials, /CSS fingerprint fallback/i);
  assert.match(materials, /SCSS[\s\S]*fail(?:s)? closed/i);
  assert.match(materials, /No active editor/);
  assert.match(materials, /SCSS source map missing/);
  assert.match(materials, /SCSS source map invalid/);
});

test("protocol materials pin exact version 7 and terminal v6 rejection", () => {
  const publicMaterials = `${readme}\n${changelog}\n${architectureGuide}\n${protocolGuide}`;
  assert.match(protocolGuide, /current protocol version is `7`/i);
  assert.match(protocolGuide, /`protocolVersion: 7`/);
  assert.match(protocolGuide, /source-navigation/);
  assert.match(protocolGuide, /source-presentation/);
  assert.match(protocolGuide, /capabilit(?:y|ies)[\s\S]*hello/i);
  assert.match(protocolGuide, /exact version[\s\S]*no downgrade/i);
  assert.match(protocolGuide, /v6 peer[\s\S]*1002[\s\S]*no[\s\S]*fallback/i);
  assert.match(protocolGuide, /targeted resolution repl(?:y|ies)/i);
  assert.match(protocolGuide, /peer state/i);
  assert.match(protocolGuide, /browser-local node refs/i);
  assert.match(protocolGuide, /channel/i);
  assert.match(protocolGuide, /document epoch/i);
  assert.match(protocolGuide, /branch revision/i);
  assert.doesNotMatch(
    publicMaterials,
    /current protocol version is `[456]`|`protocolVersion: [456]`|protocol v[456] router/i,
  );
  assert.doesNotMatch(
    publicMaterials,
    /protocol\s+[456]\s+exposes/i,
  );
});

test("protocol guide contains strict source navigation examples", () => {
  assert.deepEqual(jsonExample("source.navigate"), {
    protocolVersion: 7,
    type: "source.navigate",
    messageId: "navigate-19",
    sessionId: "default",
    inspectMessageId: "inspect-42",
    resolutionGeneration: 3,
    direction: "next",
    metadata: {},
  });
  assert.deepEqual(jsonExample("source.navigationState"), {
    protocolVersion: 7,
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

test("protocol guide publishes the strict current Rules source contract", () => {
  assert.ok(rulesSourcesSection, "Rules Source Navigation section is required");
  assert.deepEqual(jsonExample("rules.sources"), {
    protocolVersion: 7,
    type: "rules.sources",
    messageId: "rules-sources-1",
    sessionId: "default",
    source: { role: "ide", id: "vscode-window-1" },
    inspectMessageId: "inspect-42",
    rulesGeneration: 1,
    sources: [
      {
        ruleRef: "rule-1",
        openAuthorityId: "opaque-rule-open-1",
        document: { label: "card.scss", languageId: "scss" },
        startLine: 41,
        startColumn: 3,
        confidence: "sourcemap",
      },
    ],
    unresolvedRuleCount: 0,
    metadata: {},
  });
  const open = jsonExample("rules.open");
  assert.deepEqual(open, {
    protocolVersion: 7,
    type: "rules.open",
    messageId: "rules-open-1",
    sessionId: "default",
    inspectMessageId: "inspect-42",
    rulesGeneration: 1,
    openAuthorityId: "opaque-rule-open-1",
    metadata: {},
  });
  for (const forbidden of [
    "ruleRef",
    "uri",
    "path",
    "url",
    "line",
    "column",
    "range",
    "version",
    "command",
  ]) {
    assert.equal(Object.hasOwn(open, forbidden), false, forbidden);
  }
  assert.match(rulesSourcesSection, /`rules-sources`\s+capability/i);
  assert.match(rulesSourcesSection, /exact originating inspect reply route/i);
  assert.doesNotMatch(rulesSourcesSection, /dormant|future correlated/i);
});

test("current product wording describes explicit opaque Rules navigation", () => {
  const productMaterials = [
    readme,
    privacy,
    vscodeReadme,
    architectureGuide,
    securityGuide,
    protocolGuide,
    usageGuide,
    developmentGuide,
    installedGuide,
    storeListings,
    releaseGuide,
    sourcePluginGuide,
  ].join("\n");

  assert.match(
    productMaterials,
    /explicit Rules origin click[\s\S]*switch[\s\S]*VS Code[\s\S]*IDE-issued opaque authority/i,
  );
  assert.match(
    productMaterials,
    /no (?:workspace )?(?:URI|path)[\s\S]*full range[\s\S]*version[\s\S]*command[\s\S]*cross(?:es)? the (?:bridge|wire)/i,
  );
  assert.match(
    productMaterials,
    /missing or invalid source maps?[\s\S]*verified generated CSS[\s\S]*no (?:approximate|guessed) SCSS/i,
  );
  assert.match(
    productMaterials,
    /legacy rollback panel[\s\S]*Source[\s\S]*active-document-only/i,
  );
  assert.match(
    productMaterials,
    /new Inspector[\s\S]*no visible Source tab/i,
  );
  assert.match(
    productMaterials,
    /PHP[\s\S]*template[\s\S]*(?:future scope|future milestone)/i,
  );
  assert.doesNotMatch(
    productMaterials,
    /Rules works without an IDE link\. At this checkpoint generated origin labels are[\s\S]*not clickable/i,
  );
  assert.doesNotMatch(
    productMaterials,
    /Pin-op never switches source files automatically/i,
  );
});

test("README makes Rules-origin opening part of the default Inspector", () => {
  const [, quickStartAndLater = ""] = readme.split("## Quick Start");
  const [quickStart = ""] = quickStartAndLater.split("\n## ");

  assert.match(
    readme,
    /Chrome and Firefox[\s\S]*shared Chromium-derived[\s\S]*read-only Inspector/i,
  );
  assert.match(
    readme,
    /ordinary\/store artifacts[\s\S]*default[\s\S]*Inspector/i,
  );
  assert.match(quickStart, /explicit Rules origin click/i);
  assert.doesNotMatch(readme, /PIN_OP_PANEL_VARIANT=inspector[\s\S]*(?:candidate|opt-in)/i);
});

test("privacy wording accounts for the complete Rules publication envelope", () => {
  assert.match(
    privacy,
    /Rules origin publication[\s\S]*authenticated protocol envelope[\s\S]*ruleRef[\s\S]*rulesGeneration[\s\S]*unresolvedRuleCount/i,
  );
  assert.doesNotMatch(privacy, /For Rules origins, VS Code sends only/i);
  assert.match(privacy, /required empty metadata\s+object/i);
  assert.doesNotMatch(privacy, /completion metadata/i);
});

test("privacy docs disclose bounded browser-local DOM text processing", () => {
  for (const [name, document] of [
    ["PRIVACY.md", privacy],
    ["docs/installed-verification.md", installedGuide],
  ]) {
    assert.match(
      document,
      /bounded DOM text(?: and comments)?[\s\S]*(?:browser-local|private inspected-tab)[\s\S]*(?:does not|never|do not)[\s\S]*(?:product )?WebSocket/i,
      name,
    );
    assert.doesNotMatch(
      document,
      /does not deliberately (?:collect|read)[^.\n]*DOM text/i,
      name,
    );
  }
});

test("release verifies the packaged Inspector", () => {
  const [, installedAndLater = ""] = releaseGuide.split(
    "## Verify Installed Artifacts",
  );
  const [installedSection = ""] = installedAndLater.split("\n## ");

  assert.match(installedSection, /shared Chromium-derived[\s\S]*Inspector/i);
  assert.match(installedSection, /Rules origin/i);
  assert.doesNotMatch(installedSection, /legacy rollback panel/i);
});

test("installed guide contains the honest Chrome and Firefox Rules-origin matrix", () => {
  const [, matrixAndLater = ""] = installedGuide.split(
    "## Checkpoint 3 Rules-Origin Installed Matrix",
  );
  const [matrix = ""] = matrixAndLater.split("\n## ");
  assert.ok(matrix, "Checkpoint 3 Rules-Origin Installed Matrix is required");
  assert.match(matrix, /Chrome/);
  assert.match(matrix, /Firefox/);
  for (const scenario of [
    "Exact CSS",
    "Inline-map SCSS",
    "External-map SCSS",
    "Nested SCSS",
    "Selector/declaration split mapping",
    "Invalid-map CSS fallback",
    "Generated CSS edit",
    "Map edit",
    "Stale authority",
    "Cross-file editor switch",
    "Inspector Rules and Source tabs",
  ]) {
    const row = matrix
      .split(/\r?\n/)
      .find((line) => line.startsWith(`| ${scenario} |`));
    assert.ok(row, scenario);
    const cells = row.split("|").map((cell) => cell.trim());
    assert.equal(cells[2], "PARTIAL/HARNESS_BLOCKED", `${scenario} Chrome`);
    assert.equal(cells[3], "PARTIAL/HARNESS_BLOCKED", `${scenario} Firefox`);
  }
  assert.match(
    matrix,
    /Evidence \(2026-08-25\):[\s\S]*Task 6[\s\S]*Task 7[\s\S]*native DevTools-to-installed-VS Code click[\s\S]*harness/i,
  );
  assert.doesNotMatch(matrix, /\|\s*Pending\s*\|/i);
  assert.doesNotMatch(matrix, /\|\s*PASS\s*\|/i);
});

test("protocol guide exposes only bounded excerpts and opaque source-open authority", () => {
  assert.ok(sourcePresentationSection, "Source Presentation section is required");
  const matches = jsonExample("source.matches");
  assert.equal(matches.protocolVersion, 7);
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

test("protocol read-only scope names bounded runtime exceptions immediately", () => {
  for (const staleClaim of [
    "Pin-op is read-only with respect to page-owned content.",
    "Pin-op is read-only with respect to application state.",
    "Pin-op is read-only with respect to page-owned content and application state.",
    "Application state is immutable under the read-only model.",
  ]) {
    assert.equal(isUnqualifiedReadOnlyClaim(staleClaim), true);
  }
  for (const boundedClaim of [
    "Pin-op is read-only: it exposes no user-authored CSS, DOM, or source editing operations and no direct application-state commands.",
    "Read-only does not mean page-owned content is immutable.",
    "Read-only does not imply application state is immutable.",
    "The read-only boundary documents page-owned content without claiming it is immutable.",
  ]) {
    assert.equal(isUnqualifiedReadOnlyClaim(boundedClaim), false);
  }

  assert.ok(readOnlySecuritySection, "Read-Only Security Model section is required");
  const clauses = securityClauses(readOnlySecuritySection);
  const scopedIndex = clauses.findIndex(
    (clause) =>
      /read-only/i.test(clause) &&
      /user-authored/i.test(clause) &&
      /editing operations/i.test(clause) &&
      /direct application[- ]state commands/i.test(clause),
  );
  assert.notEqual(
    scopedIndex,
    -1,
    "read-only must be scoped to user-authored editing and direct application-state commands",
  );
  const scopedClause = clauses[scopedIndex] ?? "";
  assert.match(scopedClause, /\bCSS\b/);
  assert.match(scopedClause, /\bDOM\b/);
  assert.match(scopedClause, /\bsource\b/i);

  const immediateExceptions = clauses[scopedIndex + 1] ?? "";
  assert.match(immediateExceptions, /inspection overlay/i);
  assert.match(immediateExceptions, /pseudo[- ]preview/i);
  assert.match(immediateExceptions, /Auto Refresh/i);
  assert.match(immediateExceptions, /(?:bounded|extension-owned) (?:runtime )?(?:exceptions|mutations)/i);

  assert.deepEqual(
    clauses.filter(isUnqualifiedReadOnlyClaim),
    [],
    "read-only must not be asserted broadly over application state or page-owned content",
  );
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
    /Full\s+source documents[\s\S]*local file paths and URIs[\s\S]*source maps[\s\S]*never cross/i,
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

test("0.4.2 record marks unperformed external evidence pending", () => {
  assert.match(verificationRecord, /Pending external release evidence/);
  assert.match(verificationRecord, /No signed `0\.4\.2` XPI/i);
  assert.match(verificationRecord, /hashes?\s+(?:are|is)\s+pending/i);
  assert.match(verificationRecord, /screenshots? (?:and|or) GIF[\s\S]*pending/i);
  assert.doesNotMatch(verificationRecord, /[0-9a-f]{64}/i);
});

test("README presents the canonical Pin-op workflow and release status", () => {
  const normalizedReadme = readme.replace(/\s+/g, " ").trim();

  assert.match(readme, /^# Pin-op\r?\n/);
  assert.match(
    readme,
    /Select a DOM element in Firefox or Chrome and see matching CSS or\s+source-mapped SCSS ranges highlighted in the active VS Code file\./,
  );
  assert.match(readme, /https:\/\/pin-op\.conus\.vision/);
  assert.match(readme, /https:\/\/github\.com\/conus-vision\/pin-op\/issues/);
  assert.match(readme, /^## Quick Start$/m);
  assert.match(readme, /^## Who It Is For$/m);
  assert.match(readme, /```mermaid[\s\S]*?```/);
  assert.match(readme, /normal workflow\s+is terminal-free/i);
  assert.match(readme, /seven-digit link code/);
  assert.match(readme, /Protocol version `7` is an exact-match WebSocket contract/);
  for (const artifact of releaseArtifactNames) {
    assert.ok(readme.includes(`\`${artifact}\``), artifact);
  }
  assert.ok(
    normalizedReadme.includes(
      "`SHA256SUMS` verifies the four packaged artifacts.",
    ),
  );
  assert.ok(
    normalizedReadme.includes(
      "The Firefox ZIP is unsigned Mozilla-review/build input and cannot be installed persistently in Firefox Stable.",
    ),
  );
  assert.ok(
    normalizedReadme.includes(
      "No public `0.4.2` GitHub Release is claimed yet.",
    ),
  );
  assert.ok(
    normalizedReadme.includes(
      "The two-digit PIN prevents accidental local cross-linking; it is not strong authentication against a hostile same-user process.",
    ),
  );
  assert.match(readme, /docs\/installed-verification\.md/);
  assert.match(readme, /docs\/mvp-usage\.md/);
  assert.match(readme, /docs\/architecture\.md/);
  assert.match(readme, /docs\/protocol\.md/);
  assert.match(readme, /CONTRIBUTING\.md/);
  assert.match(readme, /docs\/security\.md/);
  assert.match(readme, /\[security policy\]\(SECURITY\.md\)/);
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
  `artifacts/${legacyTechnicalSlug}-vscode-0.4.2.vsix`,
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

function isBroadCrossOriginStylesheetClaim(clause) {
  if (!/\bcross-origin stylesheets?\b/i.test(clause)) {
    return false;
  }

  const categoricalLimit =
    /\bcross-origin stylesheets?\b[^.!?]{0,120}\b(?:are|remain|stay)\s+(?:categorically\s+)?(?:unavailable|unsupported|inaccessible)\b/i.test(
      clause,
    ) ||
    /\b(?:unavailable|unsupported|inaccessible)\s+cross-origin stylesheets?\b/i.test(
      clause,
    );
  if (!categoricalLimit) {
    return false;
  }

  const cssomBoundary =
    /\b(?:inaccessible|unreadable)\s+CSSOM\b/i.test(clause) ||
    /\bCSSOM\b[^.;!?]{0,60}\b(?:is|remains?|stays?)\s+(?:inaccessible|unreadable)\b/i.test(
      clause,
    );
  return !cssomBoundary;
}

function isUnqualifiedReadOnlyClaim(clause) {
  if (!/read-only/i.test(clause)) {
    return false;
  }
  if (!/(?:application[- ]state|page-owned content)/i.test(clause)) {
    return false;
  }

  const scopedBoundary =
    /\bno\s+user-authored\b/i.test(clause) &&
    /\bediting operations\b/i.test(clause) &&
    /\bno\s+direct application[- ]state commands\b/i.test(clause);
  if (scopedBoundary) {
    return false;
  }

  const clarification =
    /\bread-only\b[^.!?]{0,80}\b(?:does|do|did)\s+not\s+(?:mean|imply|assert|claim|guarantee|make)\b/i.test(
      clause,
    ) ||
    /\bread-only\b[^.!?]{0,80}\b(?:is|are)\s+not\s+(?:a\s+)?(?:claim|guarantee)\b/i.test(
      clause,
    ) ||
    /\bread-only\b[^.!?]{0,120}\bwithout\s+(?:asserting|claiming|implying|guaranteeing)\b/i.test(
      clause,
    ) ||
    /\b(?:is|are)\s+not\s+read-only\b[^.!?]{0,80}\b(?:application[- ]state|page-owned content)\b/i.test(
      clause,
    );
  if (clarification) {
    return false;
  }

  return (
    /\bread-only\b[^.!?]{0,100}\b(?:with respect to|for|over)\b[^.!?]*(?:application[- ]state|page-owned content)/i.test(
      clause,
    ) ||
    /\bread-only\b[^.!?]{0,100}\b(?:means?|implies?|asserts?|guarantees?|makes?)\b[^.!?]*(?:application[- ]state|page-owned content)/i.test(
      clause,
    ) ||
    /(?:application[- ]state|page-owned content)[^.!?]{0,100}\b(?:is|are|remains?|stays?)\s+(?:fully\s+)?(?:immutable|read-only)\b/i.test(
      clause,
    )
  );
}

function findStaleRolloutClaim(document) {
  const patterns = [
    {
      kind: "flag",
      pattern: /PIN_OP_PANEL_VARIANT\s*=\s*["']?inspector["']?/gi,
    },
    {
      kind: "candidate",
      pattern: /(?:opt-in|unpacked)\s+Inspector candidate/gi,
    },
    {
      kind: "default",
      pattern: /\bdefaults?\s+to\s+(?:the\s+)?legacy(?: rollback)?(?: panel| page| asset)?\b/gi,
    },
    {
      kind: "default",
      pattern: /\b(?:store[- ]default|default for (?:ordinary\/store|store) artifacts?)\s+(?:is|remains?|stays?)\s+(?:the\s+)?legacy(?: rollback)?(?: panel| page| asset)?\b/gi,
    },
    {
      kind: "default",
      pattern: /\blegacy(?: rollback)? (?:panel|page|asset)\s+(?:is|remains?|stays?)\s+(?:still\s+)?(?:the\s+)?(?:store[- ])?default\b/gi,
    },
    {
      kind: "default",
      pattern: /\bstore[- ]default\s+legacy(?: rollback)? (?:panel|page|asset)\b/gi,
    },
    {
      kind: "artifact-use",
      pattern: /\b(?:ordinary\/store|store|these) artifacts?\b[^.;!?]{0,160}\b(?:use|uses|run|runs|open|opens|load|loads|remain|remains|stay|stays)(?:\s+on)?\s+(?:the\s+)?legacy(?: rollback)? (?:panel|page)\b/gi,
    },
  ];

  for (const clause of securityClauses(document)) {
    for (const { kind, pattern } of patterns) {
      for (const match of clause.matchAll(pattern)) {
        if (!isNonCurrentRolloutReference(clause, match, kind)) {
          return `${JSON.stringify(match[0])} in ${JSON.stringify(clause)}`;
        }
      }
    }
  }
  return undefined;
}

function isNonCurrentRolloutReference(clause, match, kind) {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  const matched = match[0];
  const before = clause
    .slice(Math.max(0, start - 100), start)
    .replace(/[`*_([{\s]+$/g, "");
  const after = clause
    .slice(end, Math.min(clause.length, end + 180))
    .replace(/^[`*_)\]}\s]+/g, "");

  if (
    /\b(?:do|does|did|must|should|can)\s+not\s+(?:default|use|run|open|load|remain|stay|set|enable|build|select)\b/i.test(
      matched,
    ) ||
    /\bnever\s+(?:defaults?|uses?|runs?|opens?|loads?|remains?|stays?|sets?|enables?|builds?|selects?)\b/i.test(
      matched,
    ) ||
    /\bno longer\s+(?:defaults?|uses?|runs?|opens?|loads?|remains?|stays?|sets?|enables?|builds?|selects?)\b/i.test(
      matched,
    )
  ) {
    return true;
  }
  if (
    /\b(?:do|does|did|must|should|can)\s+not(?:\s+(?:set|use|enable|build|select)(?:\s+the)?)?\s*$/i.test(
      before,
    ) ||
    /\bnever\s*$/i.test(before) ||
    /\bno longer\s*$/i.test(before)
  ) {
    return true;
  }
  if (
    /\b(?:removed|retired|deprecated|obsolete|former|historical)(?:\s+the)?\s*$/i.test(
      before,
    ) ||
    /^(?:(?:is|was|are|were|has been|have been)\s+)?(?:now\s+)?(?:obsolete|removed|retired|deprecated|historical|not (?:current|used|supported|active|needed)|no longer (?:used|supported|current|available|needed))\b/i.test(
      after,
    )
  ) {
    return true;
  }
  return (
    kind === "artifact-use" &&
    /^(?:[^.;!?]{0,40}\bonly\s+(?:when|after|for|as|with)\b[^.;!?]{0,100}\b(?:explicit|rollback|fallback|PIN_OP_PANEL_VARIANT)\b|\s*(?:as|for)\s+(?:an?\s+)?explicit\s+non-default\s+(?:rollback|fallback)\b)/i.test(
      after,
    )
  );
}

function requireMarkdownParagraph(document, marker, label) {
  const paragraph = document
    .split(/\r?\n\s*\r?\n/)
    .map((value) => value.replace(/\s+/g, " ").trim())
    .filter((value) => !value.startsWith("#"))
    .find((value) => marker.test(value));
  assert.ok(paragraph, `${label} paragraph is required`);
  return paragraph;
}

function requireMarkdownClause(document, marker, label) {
  const clause = securityClauses(document).find((value) => marker.test(value));
  assert.ok(clause, `${label} clause is required`);
  return clause;
}

function assertAbruptArtifactClause(clause) {
  assert.doesNotMatch(
    clause,
    /\b(?:does not|never)\b[^.]{0,100}\b(?:leaves?|remains?)\b/i,
  );
  assert.match(
    clause,
    /(?:abrupt extension termination[^.]*(?:leaves?|remains?)|(?:markers?|styles?|artifacts?)[^.]*remains?[^.]*(?:after|following|because of) (?:an? )?abrupt extension termination)/i,
  );
  assert.match(clause, /(?:markers?|styles?|artifacts?)/i);
  assert.match(clause, /until[^.]*(?:navigat|reload)/i);
}

function assertExplicitFidelityLimit(document, marker, label) {
  const directPattern = new RegExp(
    `${marker.source}[^.;!?]{0,100}(?:is|are|remain|remains|:)` +
      String.raw`(?:\s+(?:reported|shown|marked)\s+as)?\s+(?:PARTIAL|unavailable)`,
    "i",
  );
  const clauses = securityClauses(document);
  const direct = clauses.some((clause) => directPattern.test(clause));
  const unified = clauses.some(
    (clause) =>
      marker.test(clause) &&
      /(?:\b(?:all|both)\b|\bthese (?:cases|limits)\b)[^.!?]{0,160}(?:PARTIAL|unavailable)|(?:PARTIAL|unavailable)[^.!?]{0,160}(?:\b(?:all|both)\b|\bthese (?:cases|limits)\b)/i.test(
        clause,
      ),
  );
  assert.ok(direct || unified, `${label} must be explicitly PARTIAL or unavailable`);
}

function markdownSection(document, heading) {
  const [, sectionAndLater = ""] = document.split(`## ${heading}`);
  const [section = ""] = sectionAndLater.split("\n## ");
  assert.ok(section, `${heading} section is required`);
  return section;
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
