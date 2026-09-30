import { describe, expect, it } from "vitest";
import {
  utf8ByteLength,
  type InspectRuleEvidence,
} from "@pin-op/protocol";
import {
  chooseGeneratedStylesheet,
  RULES_STYLESHEET_LOCATOR_LIMITS,
  RULES_STYLESHEET_PARSED_CANDIDATES,
  RULES_STYLESHEET_SCAN_MAX_BYTES,
  RULES_STYLESHEET_SCAN_MAX_FILES,
  RulesStylesheetLocator,
  sharedTrailingPathSegments,
  type RankedStylesheetCandidate,
  type RulesStylesheetLocatorHost,
  type RulesStylesheetLocatorLimits,
  type StylesheetCandidateScore,
} from "../src/rules/rulesStylesheetLocator.js";
import { RULES_STYLESHEET_MAX_BYTES } from "../src/sourcePlugins/stylesheetAst.js";
import { RulesSourceSnapshotLimitError } from "../src/sourcePlugins/sourceWorkspace.js";

const SERVED = "http://localhost:8080/assets/app.css";

describe("RulesStylesheetLocator", () => {
  it("publishes bounded scan budgets", () => {
    expect(RULES_STYLESHEET_SCAN_MAX_FILES).toBe(2_000);
    expect(RULES_STYLESHEET_SCAN_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(RULES_STYLESHEET_PARSED_CANDIDATES).toBe(8);
    expect(RULES_STYLESHEET_LOCATOR_LIMITS).toEqual({
      scanMaxFiles: RULES_STYLESHEET_SCAN_MAX_FILES,
      scanMaxBytes: RULES_STYLESHEET_SCAN_MAX_BYTES,
      fileMaxBytes: RULES_STYLESHEET_MAX_BYTES,
      parsedCandidates: RULES_STYLESHEET_PARSED_CANDIDATES,
    });
    expect(Object.isFrozen(RULES_STYLESHEET_LOCATOR_LIMITS)).toBe(true);
  });

  it("counts the trailing path segments a file shares with the served URL", () => {
    expect(sharedTrailingPathSegments(
      "http://localhost/assets/css/app.css?ver=6.1",
      "file:///project/dist/css/app.css",
    )).toBe(2);
    expect(sharedTrailingPathSegments(
      "http://localhost/my%20styles/app.css",
      "file:///project/my%20styles/app.css",
    )).toBe(2);
    expect(sharedTrailingPathSegments(
      "http://localhost/assets/app.css",
      "file:///project/dist/app.min.css",
    )).toBe(0);
    expect(sharedTrailingPathSegments(
      "c:\\build\\src\\card.scss",
      "file:///project/src/card.scss",
    )).toBe(2);
    expect(sharedTrailingPathSegments("not a url", "file:///app.css")).toBe(0);
  });

  it("reads every workspace stylesheet once for all served stylesheets", async () => {
    const harness = locatorHarness({
      "file:///workspace/dist/one.css": ".alpha { color: red; }",
      "file:///workspace/dist/two.css": ".beta { color: red; }",
      "file:///workspace/src/card.scss": ".alpha { color: red; }",
      "file:///workspace/dist/one.css.map": "{}",
      "file:///outside/alpha.css": ".alpha { color: red; }",
    });
    const locator = harness.locator([
      rule(".alpha", "http://localhost/a.css"),
      rule(".beta", "http://localhost/b.css"),
    ]);

    await expect(locator.locateGenerated("http://localhost/a.css"))
      .resolves.toEqual({ kind: "located", uri: "file:///workspace/dist/one.css" });
    await expect(locator.locateGenerated("http://localhost/b.css"))
      .resolves.toEqual({ kind: "located", uri: "file:///workspace/dist/two.css" });

    expect(harness.listings).toEqual(["**/*.css"]);
    expect(harness.reads.map(({ uri }) => uri).sort()).toEqual([
      "file:///workspace/dist/one.css",
      "file:///workspace/dist/two.css",
    ]);
    expect(harness.scored).toEqual([
      "file:///workspace/dist/one.css",
      "file:///workspace/dist/two.css",
    ]);
  });

  it("parses only files that could hold every word of a reported selector", async () => {
    const harness = locatorHarness({
      // `card` alone, and `card__title` alone, are not `.card .card__title`.
      "file:///workspace/dist/a.css": ".card { color: red; }",
      "file:///workspace/dist/b.css": ".card__title { color: red; }",
      "file:///workspace/dist/c.css": ".card .card__title { color: red; }",
    });

    await expect(harness.locator([rule(".card .card__title")])
      .locateGenerated(SERVED)).resolves.toEqual({
      kind: "located",
      uri: "file:///workspace/dist/c.css",
    });
    expect(harness.scored).toEqual(["file:///workspace/dist/c.css"]);
  });

  it("parses the best-ranked few, most likely first", async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 12; index += 1) {
      files[`file:///workspace/copies/copy-${String(index).padStart(2, "0")}.css`] =
        ".card { color: red; }";
    }
    // Holds the words of both selectors but carries only `.card`, so it is
    // not enough on its own and the workspace is ranked after all.
    files["file:///workspace/dist/assets/app.css"] =
      ".card { color: red; } .hero{color:red}";
    const harness = locatorHarness(files);

    await expect(harness.locator([rule(".card"), rule(".hero")])
      .locateGenerated(SERVED)).resolves.toEqual({
      kind: "located",
      uri: "file:///workspace/dist/assets/app.css",
    });
    expect(harness.scored).toHaveLength(RULES_STYLESHEET_PARSED_CANDIDATES);
    expect(harness.scored[0]).toBe("file:///workspace/dist/assets/app.css");
  });

  it("settles on the one file most like the served path when it carries every rule", async () => {
    const harness = locatorHarness({
      "file:///workspace/dist/assets/app.css": ".card { color: red; }",
      "file:///workspace/other/app.css": ".card { color: red; }",
      "file:///workspace/vendor/theme.css": ".card { color: red; }",
    });

    await expect(harness.locator([rule(".card")]).locateGenerated(SERVED))
      .resolves.toEqual({
        kind: "located",
        uri: "file:///workspace/dist/assets/app.css",
      });
    expect(harness.listings).toEqual(["**/*.css"]);
    expect(harness.reads).toEqual([]);
    expect(harness.scored).toEqual(["file:///workspace/dist/assets/app.css"]);
  });

  it("ranks the whole workspace when the file most like the served path misses a rule", async () => {
    const harness = locatorHarness({
      "file:///workspace/dist/assets/app.css": ".card { color: red; }",
      "file:///workspace/build/bundle.css":
        ".card { color: red; }\n.tile { color: red; }",
    });

    await expect(harness.locator([rule(".card"), rule(".tile")])
      .locateGenerated(SERVED)).resolves.toEqual({
      kind: "located",
      uri: "file:///workspace/build/bundle.css",
    });
    expect(harness.reads.map(({ uri }) => uri)).toEqual([
      "file:///workspace/dist/assets/app.css",
      "file:///workspace/build/bundle.css",
    ]);
    // The first file's score is reused, not computed again.
    expect(harness.scored).toEqual([
      "file:///workspace/dist/assets/app.css",
      "file:///workspace/build/bundle.css",
    ]);
  });

  it("ranks the whole workspace when no one file is most like the served path", async () => {
    const harness = locatorHarness({
      "file:///workspace/a/assets/app.css": ".tile { color: red; }",
      "file:///workspace/b/assets/app.css": ".card { color: red; }",
      "file:///workspace/moved/renamed.css": ".card { color: red; }",
    });

    await expect(harness.locator([rule(".card")]).locateGenerated(SERVED))
      .resolves.toEqual({
        kind: "located",
        uri: "file:///workspace/b/assets/app.css",
      });
    expect(harness.reads).toHaveLength(3);
    expect(harness.scored).toEqual([
      "file:///workspace/b/assets/app.css",
      "file:///workspace/moved/renamed.css",
    ]);
  });

  it("gives no answer when a file it did not parse could have been as good", async () => {
    const files: Record<string, string> = {
      "file:///workspace/dist/app.css": ".card { color: red; }",
    };
    // Every one of these could hold `.card` as far as its words go; only
    // parsing would tell that none does, and one of them is never parsed.
    for (let index = 0; index < RULES_STYLESHEET_PARSED_CANDIDATES; index += 1) {
      files[`file:///workspace/themes/theme-${index}.css`] = ".card{color:blue}";
    }
    const hashed = "http://localhost/hashed.3f2a.css";
    const harness = locatorHarness(files);

    await expect(harness.locator([rule(".card", hashed)])
      .locateGenerated(hashed)).resolves.toEqual({
      kind: "unlocated",
      reason: "generated-source-ambiguous",
    });
    expect(harness.scored).toHaveLength(RULES_STYLESHEET_PARSED_CANDIDATES);
    expect(harness.scored[0]).toBe("file:///workspace/dist/app.css");

    // With one file fewer, every candidate is parsed and the answer is sure.
    delete files[`file:///workspace/themes/theme-0.css`];
    await expect(locatorHarness(files).locator([rule(".card", hashed)])
      .locateGenerated(hashed)).resolves.toEqual({
      kind: "located",
      uri: "file:///workspace/dist/app.css",
    });
  });

  it("answers for a stylesheet no rule was reported from with nothing", async () => {
    await expect(locatorHarness({
      "file:///workspace/dist/app.css": ".card { color: red; }",
    }).locator([rule(".card")]).locateGenerated("http://localhost/other.css"))
      .resolves.toEqual({
        kind: "unlocated",
        reason: "generated-source-not-found",
      });
  });

  it("considers the files most like the served path first when there are too many", async () => {
    const harness = locatorHarness({
      "file:///workspace/a/other.css": ".card { color: red; }",
      "file:///workspace/b/assets/app.css": ".card { color: red; }",
      "file:///workspace/c/assets/app.css": ".tile { color: red; }",
    }, { limits: { scanMaxFiles: 2 } });

    await expect(harness.locator([rule(".card")]).locateGenerated(SERVED))
      .resolves.toEqual({
        kind: "located",
        uri: "file:///workspace/b/assets/app.css",
      });
    expect(harness.reads.map(({ uri }) => uri)).toEqual([
      "file:///workspace/b/assets/app.css",
      "file:///workspace/c/assets/app.css",
    ]);
  });

  it("stops reading once the batch's scan budget is spent", async () => {
    const text = ".card { color: red; }";
    const harness = locatorHarness({
      "file:///workspace/a.css": text,
      "file:///workspace/b.css": text,
      "file:///workspace/c.css": text,
    }, { limits: { scanMaxBytes: utf8ByteLength(text) * 2 } });

    await harness.locator([rule(".card")]).locateGenerated(SERVED);

    expect(harness.reads.map(({ uri }) => uri)).toEqual([
      "file:///workspace/a.css",
      "file:///workspace/b.css",
    ]);
  });

  it("never reads a file past the per-file limit and says so when it was the likely one", async () => {
    const harness = locatorHarness({
      "file:///workspace/dist/assets/app.css": `.card { color: red; }/*${
        "x".repeat(64)
      }*/`,
    }, { limits: { fileMaxBytes: 32 } });

    await expect(harness.locator([rule(".card")]).locateGenerated(SERVED))
      .resolves.toEqual({
        kind: "unlocated",
        reason: "generated-source-too-large",
      });
    expect(harness.reads).toEqual([{
      uri: "file:///workspace/dist/assets/app.css",
      maxBytes: 32,
    }]);
    // Asked first for its name, and turned away by its size there too.
    expect(harness.scored).toEqual(["file:///workspace/dist/assets/app.css"]);
  });

  it("fails fast on cancellation", async () => {
    const controller = new AbortController();
    const harness = locatorHarness({
      "file:///workspace/dist/bundle.css": ".card { color: red; }",
    }, {
      onRead: () => controller.abort(),
    });

    await expect(harness.locator([rule(".card")], controller.signal)
      .locateGenerated(SERVED)).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.scored).toEqual([]);
  });

  it("finds an original by name and text, and by text alone only when renamed", async () => {
    const text = ".card { color: red; }";
    const harness = locatorHarness({
      "file:///workspace/a/src/card.scss": text,
      "file:///workspace/b/src/card.scss": ".card { color: blue; }",
      "file:///workspace/styles/renamed.scss": ".tile { color: red; }",
    });
    const locator = harness.locator([]);

    await expect(locator.locateOriginal("webpack:///src/card.scss", text))
      .resolves.toBe("file:///workspace/a/src/card.scss");
    // Files larger than the text, give or take a byte-order mark, are turned
    // away by the read's own limit.
    const limit = utf8ByteLength(text) + 3;
    expect(harness.reads).toEqual([
      { uri: "file:///workspace/a/src/card.scss", maxBytes: limit },
      { uri: "file:///workspace/b/src/card.scss", maxBytes: limit },
    ]);
    // A file of that name exists, so an old text is not looked for elsewhere.
    await expect(locator.locateOriginal(
      "webpack:///src/card.scss",
      ".card { color: green; }",
    )).resolves.toBeUndefined();
    await expect(locator.locateOriginal(
      "webpack:///src/tile.scss",
      ".tile { color: red; }",
    )).resolves.toBe("file:///workspace/styles/renamed.scss");
    // Without text, the name alone must be unique.
    await expect(locator.locateOriginal("webpack:///src/card.scss", undefined))
      .resolves.toBeUndefined();
    await expect(locator.locateOriginal("webpack:///x/renamed.scss", undefined))
      .resolves.toBe("file:///workspace/styles/renamed.scss");
    // A Windows path parses as a scheme of its own; its name still counts.
    await expect(locator.locateOriginal("c:\\build\\x\\renamed.scss", undefined))
      .resolves.toBe("file:///workspace/styles/renamed.scss");
    await expect(locator.locateOriginal("webpack:///src/card.css", text))
      .resolves.toBeUndefined();

    expect(harness.listings).toEqual(["**/*.scss"]);
  });
});

describe("chooseGeneratedStylesheet", () => {
  it("chooses by rules carried, then shared path, then layout", () => {
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(3, 0)),
      scored("file:///b.css", 2, verified(2, 2)),
    ], undefined, undefined)).toEqual({ kind: "located", uri: "file:///a.css" });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(2, 2)),
      scored("file:///b.css", 2, verified(2, 0)),
    ], undefined, undefined)).toEqual({ kind: "located", uri: "file:///b.css" });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(2, 0)),
      scored("file:///b.css", 1, verified(2, 1)),
    ], undefined, undefined)).toEqual({ kind: "located", uri: "file:///b.css" });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(2, 1)),
      scored("file:///b.css", 1, verified(2, 1)),
    ], undefined, undefined)).toEqual({
      kind: "unlocated",
      reason: "generated-source-ambiguous",
    });
  });

  it("does not choose while an unparsed file could still match or beat the best", () => {
    const best = [scored("file:///a.css", 1, verified(2, 2))];
    expect(chooseGeneratedStylesheet(best, ranked("file:///z.css", 3, 0), undefined))
      .toMatchObject({ kind: "unlocated", reason: "generated-source-ambiguous" });
    expect(chooseGeneratedStylesheet(best, ranked("file:///z.css", 2, 1), undefined))
      .toMatchObject({ kind: "unlocated", reason: "generated-source-ambiguous" });
    expect(chooseGeneratedStylesheet(best, ranked("file:///z.css", 2, 0), undefined))
      .toEqual({ kind: "located", uri: "file:///a.css" });
    expect(chooseGeneratedStylesheet(best, ranked("file:///z.css", 1, 5), undefined))
      .toEqual({ kind: "located", uri: "file:///a.css" });
  });

  it("explains a failure by the file most likely to have been the one", () => {
    expect(chooseGeneratedStylesheet([], undefined, undefined)).toEqual({
      kind: "unlocated",
      reason: "generated-source-not-found",
    });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, { kind: "failed", reason: "generated-source-parse-error" }),
      scored("file:///b.css", 0, verified(0, 0)),
    ], undefined, undefined)).toEqual({
      kind: "unlocated",
      reason: "generated-source-parse-error",
    });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(0, 0)),
    ], undefined, undefined)).toEqual({
      kind: "unlocated",
      reason: "generated-css-not-exact",
    });
    expect(chooseGeneratedStylesheet([
      scored("file:///a.css", 1, verified(0, 0)),
    ], undefined, {
      pathSimilarity: 2,
      reason: "generated-source-too-large",
    })).toEqual({ kind: "unlocated", reason: "generated-source-too-large" });
  });
});

function locatorHarness(
  files: Readonly<Record<string, string>>,
  options: {
    readonly limits?: Partial<RulesStylesheetLocatorLimits>;
    readonly onRead?: () => void;
  } = {},
) {
  const listings: string[] = [];
  const reads: { readonly uri: string; readonly maxBytes: number }[] = [];
  const scored: string[] = [];
  const limits = { ...RULES_STYLESHEET_LOCATOR_LIMITS, ...options.limits };
  const host: RulesStylesheetLocatorHost = {
    async findFiles(pattern) {
      listings.push(pattern);
      return Object.keys(files);
    },
    isWorkspaceUri: (uri) => uri.startsWith("file:///workspace/"),
    async readText(uri, maxBytes) {
      reads.push({ uri, maxBytes });
      options.onRead?.();
      const text = files[uri];
      if (text === undefined) throw new Error(`Missing fixture: ${uri}`);
      const bytes = utf8ByteLength(text);
      if (bytes > maxBytes) throw new RulesSourceSnapshotLimitError();
      return { text, bytes };
    },
    // Stands in for parsing: a rule is carried when its selector is written
    // verbatim before a block, which is all these fixtures need.
    async scoreCandidate(uri, rules) {
      scored.push(uri);
      const text = files[uri] ?? "";
      if (utf8ByteLength(text) > limits.fileMaxBytes) {
        return { kind: "failed", reason: "generated-source-too-large" };
      }
      const carried = rules.filter((entry) =>
        text.includes(`${entry.selector} {`)
      ).length;
      return { kind: "verified", verified: carried, corroborated: carried };
    },
  };
  return {
    listings,
    reads,
    scored,
    locator: (
      rules: readonly InspectRuleEvidence[],
      signal?: AbortSignal,
    ) => new RulesStylesheetLocator(host, rules, signal, limits),
  };
}

let nextRuleRef = 0;

function rule(selector: string, sourceUrl = SERVED): InspectRuleEvidence {
  return {
    ruleRef: `rule-${++nextRuleRef}`,
    selector,
    declarations: [{
      property: "color",
      value: "red",
      important: false,
      valueTruncated: false,
    }],
    declarationsTruncated: false,
    generatedSource: {
      sourceUrl,
      rulePath: "0.0",
      contexts: [],
      contextsTruncated: false,
      unsupportedGroupContext: false,
    },
  } as InspectRuleEvidence;
}

function verified(
  count: number,
  corroborated: number,
): StylesheetCandidateScore {
  return { kind: "verified", verified: count, corroborated };
}

function ranked(
  uri: string,
  selectors: number,
  pathSimilarity: number,
): RankedStylesheetCandidate {
  return { uri, selectors, pathSimilarity, declarations: 0 };
}

function scored(
  uri: string,
  pathSimilarity: number,
  score: StylesheetCandidateScore,
) {
  return { candidate: ranked(uri, 1, pathSimilarity), score };
}
