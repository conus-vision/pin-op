import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const attribution =
  "Pin-op by Volodymyr Moskvin (c) 2026 [Conus Vision](https://conus.vision)";
const releaseArtifacts = [
  "pin-op-vscode-0.3.0.vsix",
  "pin-op-chrome-0.3.0.zip",
  "pin-op-firefox-0.3.0.zip",
  "pin-op-firefox-0.3.0.xpi",
  "pin-op-firefox-source-0.3.0.zip",
  "SHA256SUMS",
];

const [rootReadme, vscodeReadme, storeListings] = await Promise.all([
  readRepositoryFile("README.md"),
  readRepositoryFile("extensions/vscode/README.md"),
  readRepositoryFile("docs/store-listings.md"),
]);

const rootSections = parseH2Sections(rootReadme);
const vscodeSections = parseH2Sections(vscodeReadme);
const listingSections = parseH2Sections(storeListings);

test("public READMEs end with the exact product attribution", () => {
  assert.equal(rootReadme.trimEnd().endsWith(attribution), true);
  assert.equal(vscodeReadme.trimEnd().endsWith(attribution), true);
});

test("root README uses the canonical section order", () => {
  assert.deepEqual(sectionHeadings(rootSections), [
    "See It Work",
    "Quick Start",
    "Who It Is For",
    "What You Get",
    "Compatibility",
    "Install Status",
    "How It Works",
    "Development",
    "Next Steps",
  ]);
});

test("store listings use ordered, attributed browser sections", () => {
  assert.deepEqual(sectionHeadings(listingSections), [
    "GitHub About",
    "Firefox AMO",
    "Chrome Web Store",
  ]);

  for (const heading of ["Firefox AMO", "Chrome Web Store"]) {
    const content = requireSection(listingSections, heading).content;
    assert.notEqual(content, "", `${heading} must not be empty`);
    assert.equal(
      content.trimEnd().endsWith(attribution),
      true,
      `${heading} must end with the exact attribution`,
    );
  }

  const escapedAttribution = escapeRegExp(attribution);
  const matches = storeListings.match(new RegExp(escapedAttribution, "g"));
  assert.equal(matches?.length ?? 0, 2);
});

test("GitHub About avoids unsupported speed claims", () => {
  assert.equal(
    collapseWhitespace(requireSection(listingSections, "GitHub About").content),
    "Select a DOM element in Firefox or Chrome and reveal its CSS/SCSS source directly in VS Code.",
  );
  assert.doesNotMatch(storeListings, /\binstantly\b/i);
});

test("VS Code README preserves the seven-step protocol recovery workflow", () => {
  assert.deepEqual(sectionHeadings(vscodeSections), [
    "Install From VSIX",
    "Link And Inspect",
    "What Pin-op Resolves",
    "Safety And Compatibility",
    "Documentation",
  ]);

  const linkAndInspect = requireSection(vscodeSections, "Link And Inspect");
  assert.deepEqual(topLevelOrderedListNumbers(linkAndInspect.content), [
    1, 2, 3, 4, 5, 6, 7,
  ]);

  const safety = collapseWhitespace(
    requireSection(vscodeSections, "Safety And Compatibility").content,
  );
  assert.ok(
    safety.includes(
      "Protocol v5 is rejected with WebSocket close code `1002`, with no fallback.",
    ),
  );
  assert.ok(
    safety.includes(
      "When the panel reports incompatible extensions, update both, restart them, and reconnect.",
    ),
  );
});

test("root README leads with the installed alpha workflow without timing claims", () => {
  assert.match(rootReadme, /```mermaid[\s\S]*?```/);
  assert.match(rootReadme, /normal workflow\s+is terminal-free/i);
  assert.match(rootReadme, /Pin-op starts automatically\./);
  assert.match(rootReadme, /seven-digit link code/);
  assert.doesNotMatch(rootReadme, /takes about five minutes/i);
  assert.match(
    rootReadme,
    /> Alpha: product and installation details may change before 1\.0\./,
  );
  assert.match(rootReadme, /The `0\.3\.0` release is being prepared\./);
});

test("root README preserves release artifact trust facts", () => {
  const installStatus = requireSection(rootSections, "Install Status").content;
  const normalizedStatus = collapseWhitespace(installStatus);

  for (const artifact of releaseArtifacts) {
    assert.ok(installStatus.includes(`\`${artifact}\``), artifact);
  }
  assert.ok(
    normalizedStatus.includes(
      "`SHA256SUMS` verifies the five packaged artifacts.",
    ),
  );
  assert.ok(
    normalizedStatus.includes(
      "The Firefox ZIP is unsigned Mozilla-review/build input and cannot be installed persistently in Firefox Stable.",
    ),
  );
  assert.ok(
    normalizedStatus.includes(
      "No signed `0.3.0` XPI or public `0.3.0` release is claimed yet.",
    ),
  );
});

test("root README states source disclosure and local authentication boundaries", () => {
  const normalizedReadme = collapseWhitespace(rootReadme);
  assert.ok(
    normalizedReadme.includes(
      "Bounded active-document excerpts cross the bridge and are not content-redacted, so they may contain sensitive code.",
    ),
  );
  assert.ok(
    normalizedReadme.includes(
      "Full documents, workspace paths or URIs, source maps, browser-local DOM references, and executable commands do not cross.",
    ),
  );
  assert.ok(
    normalizedReadme.includes(
      "The two-digit PIN prevents accidental local cross-linking; it is not strong authentication against a hostile same-user process.",
    ),
  );
  assert.match(rootReadme, /\[security policy\]\(SECURITY\.md\)/);
});

function parseH2Sections(markdown) {
  const headings = [...markdown.matchAll(/^## ([^\r\n]+)\r?$/gm)];
  return headings.map((heading, index) => {
    const contentStart = heading.index + heading[0].length;
    const contentEnd = headings[index + 1]?.index ?? markdown.length;
    return {
      heading: heading[1],
      content: markdown.slice(contentStart, contentEnd).trim(),
    };
  });
}

function sectionHeadings(sections) {
  return sections.map(({ heading }) => heading);
}

function requireSection(sections, heading) {
  const section = sections.find((candidate) => candidate.heading === heading);
  assert.ok(section, `Missing section: ${heading}`);
  return section;
}

function topLevelOrderedListNumbers(markdown) {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d+)\. /.exec(line);
    return match ? [Number(match[1])] : [];
  });
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readRepositoryFile(path) {
  try {
    return await readFile(resolve(repositoryRoot, path), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
