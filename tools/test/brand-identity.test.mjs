import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findLegacyIdentityViolations,
  scanTrackedBrandIdentity,
} from "../brand-identity.mjs";

const legacyDisplay = ["Browser", "2", "IDE"].join("");
const legacyTechnical = ["browser", "2", "ide"].join("");

test("brand guard finds legacy identity in paths and text", () => {
  const violations = findLegacyIdentityViolations([
    { path: `src/${legacyTechnical}.ts`, content: "export const value = 1;" },
    { path: "src/product.ts", content: `export const name = ${JSON.stringify(legacyDisplay)};` },
  ]);

  assert.deepEqual(violations, [
    { path: `src/${legacyTechnical}.ts`, location: "path" },
    { path: "src/product.ts", location: "content" },
  ]);
});

test("brand guard excludes only historical plans and specifications", () => {
  const violations = findLegacyIdentityViolations([
    {
      path: `docs/superpowers/plans/2026-01-01-${legacyTechnical}.md`,
      content: legacyDisplay,
    },
    {
      path: `docs/superpowers/specs/2026-01-01-${legacyTechnical}.md`,
      content: legacyDisplay,
    },
    {
      path: `docs/superpowers/plans-archive/${legacyTechnical}.md`,
      content: legacyDisplay,
    },
  ]);

  assert.deepEqual(violations, [
    {
      path: `docs/superpowers/plans-archive/${legacyTechnical}.md`,
      location: "path",
    },
    {
      path: `docs/superpowers/plans-archive/${legacyTechnical}.md`,
      location: "content",
    },
  ]);
});

test("tracked tree contains no active legacy identity", () => {
  assert.deepEqual(scanTrackedBrandIdentity(process.cwd()), []);
});
