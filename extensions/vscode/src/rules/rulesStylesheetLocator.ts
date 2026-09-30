import { createHash } from "node:crypto";
import {
  utf8ByteLength,
  type InspectRuleEvidence,
} from "@pin-op/protocol";
import {
  canonicalRulesSourceUri,
  raceWithAbort,
  RulesSourceSnapshotLimitError,
} from "../sourcePlugins/sourceWorkspace.js";
import { RULES_STYLESHEET_MAX_BYTES } from "../sourcePlugins/stylesheetAst.js";

/** Stylesheet files one batch considers, the likeliest first. */
export const RULES_STYLESHEET_SCAN_MAX_FILES = 2_000;
/** UTF-8 bytes of stylesheet text one batch reads to rank those files. */
export const RULES_STYLESHEET_SCAN_MAX_BYTES = 64 * 1024 * 1024;
/** The best-ranked files parsed and verified for one served stylesheet. */
export const RULES_STYLESHEET_PARSED_CANDIDATES = 8;

export interface RulesStylesheetLocatorLimits {
  readonly scanMaxFiles: number;
  readonly scanMaxBytes: number;
  /** A file larger than this is never read, so it is never chosen either. */
  readonly fileMaxBytes: number;
  readonly parsedCandidates: number;
}

export const RULES_STYLESHEET_LOCATOR_LIMITS: RulesStylesheetLocatorLimits =
  Object.freeze({
    scanMaxFiles: RULES_STYLESHEET_SCAN_MAX_FILES,
    scanMaxBytes: RULES_STYLESHEET_SCAN_MAX_BYTES,
    fileMaxBytes: RULES_STYLESHEET_MAX_BYTES,
    parsedCandidates: RULES_STYLESHEET_PARSED_CANDIDATES,
  });

export interface ScannedStylesheetText {
  readonly text: string;
  readonly bytes: number;
}

export type StylesheetCandidateScore =
  | {
      readonly kind: "verified";
      /** Reported rules the file carries exactly. */
      readonly verified: number;
      /** Of those, the ones standing where the browser said they stand. */
      readonly corroborated: number;
    }
  | { readonly kind: "failed"; readonly reason: string };

export type GeneratedStylesheetLocation =
  | { readonly kind: "located"; readonly uri: string }
  | { readonly kind: "unlocated"; readonly reason: string };

export interface RulesStylesheetLocatorHost {
  /** Workspace files matching a glob, dependencies and VCS data left out. */
  findFiles(pattern: string): Promise<readonly string[]>;
  isWorkspaceUri(uri: string): boolean;
  /**
   * One file's current text, read to rank it and nothing else: none of it is
   * retained past that file or becomes a dependency, and reading it opens no
   * document that was not open already. Past `maxBytes` it throws
   * `RulesSourceSnapshotLimitError`.
   */
  readText(uri: string, maxBytes: number): Promise<ScannedStylesheetText>;
  /**
   * Parses one ranked file and counts the reported rules it carries exactly.
   * This is where a file stops being a guess, so it is read the way every
   * source of the batch is: retained, hashed and charged to the batch.
   */
  scoreCandidate(
    uri: string,
    rules: readonly InspectRuleEvidence[],
  ): Promise<StylesheetCandidateScore>;
}

/**
 * What earlier selections learned about served stylesheets, kept across them
 * until any stylesheet in the workspace changes. It holds only answers the
 * locator re-verifies or that no file could contradict without changing.
 */
export class StylesheetLocationMemory {
  private readonly located = new Map<string, string>();
  private readonly unlocated = new Set<string>();

  public recall(
    sourceUrl: string,
  ):
    | { readonly kind: "located"; readonly uri: string }
    | { readonly kind: "unlocated" }
    | undefined {
    const uri = this.located.get(sourceUrl);
    if (uri !== undefined) return { kind: "located", uri };
    return this.unlocated.has(sourceUrl) ? { kind: "unlocated" } : undefined;
  }

  public remember(
    sourceUrl: string,
    location: GeneratedStylesheetLocation,
  ): void {
    this.located.delete(sourceUrl);
    this.unlocated.delete(sourceUrl);
    if (location.kind === "located") {
      this.located.set(sourceUrl, location.uri);
    } else if (NOTHING_CARRIES_IT.has(location.reason)) {
      this.unlocated.add(sourceUrl);
    }
    while (this.located.size > MEMORY_LIMIT) {
      const oldest = this.located.keys().next().value;
      if (oldest === undefined) break;
      this.located.delete(oldest);
    }
    while (this.unlocated.size > MEMORY_LIMIT) {
      const oldest = this.unlocated.values().next().value;
      if (oldest === undefined) break;
      this.unlocated.delete(oldest);
    }
  }

  /** A stylesheet in the workspace changed: nothing learned still holds. */
  public forget(): void {
    this.located.clear();
    this.unlocated.clear();
  }
}

/**
 * The outcome that says no workspace stylesheet even mentions the served
 * stylesheet's selectors. A file that mentions them but carries none of this
 * selection's rules exactly may still carry the next selection's, and an
 * ambiguous, unreadable or over-budget outcome can change without any file
 * changing, so none of those is remembered.
 */
const NOTHING_CARRIES_IT: ReadonlySet<string> = new Set([
  "generated-source-not-found",
]);
const MEMORY_LIMIT = 256;
/** More files closer to the served URL than this and the workspace is ranked. */
const MAX_CLOSER_FILES_ASKED = 4;

export interface RankedStylesheetCandidate {
  readonly uri: string;
  /** Reported rules whose selector the file's text could hold. */
  readonly selectors: number;
  /** Trailing path segments the file shares with the URL it was served by. */
  readonly pathSimilarity: number;
  /** Words of the reported declarations that the file's text holds. */
  readonly declarations: number;
}

export interface ScoredStylesheetCandidate {
  readonly candidate: RankedStylesheetCandidate;
  readonly score: StylesheetCandidateScore;
}

export interface UnreadableStylesheetCandidate {
  readonly pathSimilarity: number;
  readonly reason: string;
}

interface ReportedStylesheet {
  readonly sourceUrl: string;
  readonly urlSegments: readonly string[];
  readonly rules: readonly InspectRuleEvidence[];
  /** Per rule, the words its selector is written with. */
  readonly selectorWords: readonly (readonly string[])[];
  readonly declarationWords: readonly string[];
}

interface WorkspaceStylesheetFile {
  readonly uri: string;
  readonly segments: readonly string[];
}

interface UnreadableStylesheetFile {
  readonly segments: readonly string[];
  readonly reason: string;
}

interface StylesheetScan {
  /** Per served URL, the best-ranked files, one more than are parsed. */
  readonly rankings: ReadonlyMap<string, readonly RankedStylesheetCandidate[]>;
  readonly unreadable: readonly UnreadableStylesheetFile[];
}

/**
 * The characters a word of stylesheet text is made of: everything but white
 * space and the punctuation CSS separates its tokens with. An escape splits a
 * word on its backslash on both sides of any comparison alike, and a hyphen
 * never does, so `card__title--active` and `padding-top` stay whole.
 */
const WORD = /[^\s!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]+/gu;
const SELECTOR_WORDS_PER_RULE = 16;
const DECLARATION_WORDS_PER_STYLESHEET = 64;
const DECLARATION_WORD_MIN_LENGTH = 3;
const UTF8_BYTE_ORDER_MARK_BYTES = 3;

/**
 * Finds the workspace files behind the stylesheets a page loaded.
 *
 * The browser names a stylesheet by the URL it was served from, and nothing
 * ties that URL to a place in the project: a dev server mounts `dist/` at the
 * root, a CMS serves a theme from deep inside its own install, a build renames
 * `app.css` to `app.3f2a.css`. What does tie them is what the stylesheet says.
 * So every CSS file in the workspace is a candidate, and the one chosen is the
 * one carrying the most of the rules the browser reported from that URL,
 * matched exactly -- selector, declarations and grouping context. The URL is
 * only heard when the content cannot choose: the file sharing more of its
 * trailing path wins a tie, and a tie that is still a tie is no answer at all.
 *
 * Parsing every candidate would cost far more than the few that matter, so the
 * text of each is first read for words only: a file can carry a rule only if
 * every word of its selector appears in it. The best few by that count are
 * parsed and verified, and the rest are dropped along with their text. One
 * reading of the workspace serves every stylesheet of the batch, and none is
 * needed when the file most like the served URL already carries everything.
 */
export class RulesStylesheetLocator {
  private readonly stylesheets: ReadonlyMap<string, ReportedStylesheet>;
  private readonly words: ReadonlySet<string>;
  private generatedFiles:
    | Promise<readonly WorkspaceStylesheetFile[]>
    | undefined;
  private scan: Promise<StylesheetScan> | undefined;
  private originalFiles:
    | Promise<readonly WorkspaceStylesheetFile[]>
    | undefined;
  private originalContents:
    | Promise<ReadonlyMap<string, readonly WorkspaceStylesheetFile[]>>
    | undefined;
  private readonly originals = new Map<
    string,
    Map<string | undefined, Promise<string | undefined>>
  >();

  public constructor(
    private readonly host: RulesStylesheetLocatorHost,
    rules: readonly InspectRuleEvidence[],
    private readonly signal?: AbortSignal,
    private readonly limits: RulesStylesheetLocatorLimits =
      RULES_STYLESHEET_LOCATOR_LIMITS,
    private readonly memory = new StylesheetLocationMemory(),
  ) {
    this.stylesheets = reportedStylesheets(rules);
    this.words = new Set(
      [...this.stylesheets.values()].flatMap((stylesheet) => [
        ...stylesheet.selectorWords.flat(),
        ...stylesheet.declarationWords,
      ]),
    );
  }

  /**
   * The workspace file the browser loaded as `sourceUrl`, when it is sure.
   *
   * When one file shares more of the served URL's path than any other, it is
   * asked first. If it carries every rule reported from that URL, nothing could
   * be chosen over it -- no file carries more, and every other shares less of
   * the path -- so the rest of the workspace is not read at all.
   */
  public async locateGenerated(
    sourceUrl: string,
  ): Promise<GeneratedStylesheetLocation> {
    const location = await this.locateGeneratedAnew(sourceUrl);
    throwIfAborted(this.signal);
    this.memory.remember(sourceUrl, location);
    return location;
  }

  /**
   * An earlier selection's answer, when it still stands. A remembered file is
   * kept while it carries every rule reported now, unless a file that ends more
   * like the served URL carries every one of them too: that is the only file
   * the choice could now prefer, and the few there are get asked. A URL whose
   * selectors no file mentions stays unlocated until a stylesheet changes.
   */
  private async recalled(
    sourceUrl: string,
    stylesheet: ReportedStylesheet,
    files: readonly WorkspaceStylesheetFile[],
  ): Promise<GeneratedStylesheetLocation | undefined> {
    const recalled = this.memory.recall(sourceUrl);
    if (!recalled) return undefined;
    if (recalled.kind === "unlocated") {
      return unlocated("generated-source-not-found");
    }
    const remembered = files.find((file) => file.uri === recalled.uri);
    if (!remembered) return undefined;
    const similarity = sharedTrailingSegments(
      stylesheet.urlSegments,
      remembered.segments,
    );
    const closer = files.filter((file) =>
      sharedTrailingSegments(stylesheet.urlSegments, file.segments) >
        similarity
    );
    if (closer.length > MAX_CLOSER_FILES_ASKED) return undefined;
    for (const file of [...closer, remembered]) {
      throwIfAborted(this.signal);
      const score = await this.host.scoreCandidate(file.uri, stylesheet.rules);
      const carriesAll = score.kind === "verified" &&
        score.verified === stylesheet.rules.length;
      if (file !== remembered && carriesAll) return undefined;
      if (file === remembered && !carriesAll) return undefined;
    }
    return { kind: "located", uri: remembered.uri };
  }

  private async locateGeneratedAnew(
    sourceUrl: string,
  ): Promise<GeneratedStylesheetLocation> {
    throwIfAborted(this.signal);
    const stylesheet = this.stylesheets.get(sourceUrl);
    if (!stylesheet) return unlocated("generated-source-not-found");
    this.generatedFiles ??= this.workspaceFiles("**/*.css", ".css");
    const recalled = await this.recalled(
      sourceUrl,
      stylesheet,
      await this.generatedFiles,
    );
    if (recalled) return recalled;
    const likeliest = closestFile(
      stylesheet.urlSegments,
      await this.generatedFiles,
      1,
    );
    let likeliestScore: StylesheetCandidateScore | undefined;
    if (likeliest !== undefined) {
      throwIfAborted(this.signal);
      likeliestScore = await this.host.scoreCandidate(
        likeliest,
        stylesheet.rules,
      );
      if (
        likeliestScore.kind === "verified" &&
        likeliestScore.verified === stylesheet.rules.length
      ) {
        return { kind: "located", uri: likeliest };
      }
    }
    this.scan ??= this.scanGenerated();
    const scan = await this.scan;
    const ranked = scan.rankings.get(sourceUrl) ?? [];
    const scored: ScoredStylesheetCandidate[] = [];
    for (const candidate of ranked.slice(0, this.limits.parsedCandidates)) {
      throwIfAborted(this.signal);
      const score = candidate.uri === likeliest && likeliestScore
        ? likeliestScore
        : await this.host.scoreCandidate(candidate.uri, stylesheet.rules);
      scored.push({ candidate, score });
    }
    throwIfAborted(this.signal);
    if (scored.length === 0 && likeliestScore) {
      // Nothing else could hold these rules; the file most like the served
      // path is still the one to say why none was found.
      return unlocated(
        likeliestScore.kind === "failed"
          ? likeliestScore.reason
          : "generated-css-not-exact",
      );
    }
    return chooseGeneratedStylesheet(
      scored,
      ranked[this.limits.parsedCandidates],
      closestUnreadable(scan.unreadable, stylesheet.urlSegments),
    );
  }

  /**
   * The SCSS file a source map names by something other than a workspace path
   * -- a bundler's `webpack://` scheme, a path on the machine that ran the
   * build. The name still says which file it was: the one of that name whose
   * text is exactly the text the map carries for it, or, when the map carries
   * none, the one file of that name. A file of that name with other text means
   * the map is older than the source, not that some other file is meant; only
   * when no file carries the name at all -- it was renamed -- is the text
   * looked for under any name.
   */
  public locateOriginal(
    sourceUrl: string,
    sourceContent: string | undefined,
  ): Promise<string | undefined> {
    let byContent = this.originals.get(sourceUrl);
    if (!byContent) {
      byContent = new Map();
      this.originals.set(sourceUrl, byContent);
    }
    let pending = byContent.get(sourceContent);
    if (!pending) {
      pending = this.findOriginal(sourceUrl, sourceContent);
      byContent.set(sourceContent, pending);
    }
    return pending;
  }

  private async scanGenerated(): Promise<StylesheetScan> {
    const stylesheets = [...this.stylesheets.values()];
    this.generatedFiles ??= this.workspaceFiles("**/*.css", ".css");
    const files = (await this.generatedFiles)
      .map((file) => ({
        file,
        similarity: Math.max(0, ...stylesheets.map((stylesheet) =>
          sharedTrailingSegments(stylesheet.urlSegments, file.segments)
        )),
      }))
      .sort((left, right) =>
        right.similarity - left.similarity ||
        compareText(left.file.uri, right.file.uri)
      )
      .map(({ file }) => file);
    const rankings = new Map(stylesheets.map((stylesheet) => [
      stylesheet.sourceUrl,
      [] as RankedStylesheetCandidate[],
    ]));
    const unreadable: UnreadableStylesheetFile[] = [];
    await this.readEach(
      files,
      this.limits.fileMaxBytes,
      (file, text) => {
        const present = presentWords(text, this.words);
        for (const stylesheet of stylesheets) {
          const candidate = rankedCandidate(stylesheet, file, present);
          if (candidate.selectors === 0) continue;
          keepBest(
            rankings.get(stylesheet.sourceUrl)!,
            candidate,
            this.limits.parsedCandidates + 1,
          );
        }
      },
      (file, error) => unreadable.push({
        segments: file.segments,
        reason: error instanceof RulesSourceSnapshotLimitError
          ? "generated-source-too-large"
          : "generated-source-unreadable",
      }),
    );
    return { rankings, unreadable };
  }

  private async findOriginal(
    sourceUrl: string,
    sourceContent: string | undefined,
  ): Promise<string | undefined> {
    const urlSegments = pathSegments(sourceUrl);
    const name = urlSegments.at(-1);
    if (name === undefined || !name.toLowerCase().endsWith(".scss")) {
      return undefined;
    }
    this.originalFiles ??= this.workspaceFiles("**/*.scss", ".scss");
    const files = await this.originalFiles;
    const named = files.filter((file) => file.segments.at(-1) === name);
    if (sourceContent === undefined) return closestFile(urlSegments, named);
    const bytes = utf8ByteLength(sourceContent);
    if (bytes < 1 || bytes > this.limits.fileMaxBytes) return undefined;
    if (named.length > 0) {
      const carrying: WorkspaceStylesheetFile[] = [];
      // A file larger than the text -- and the byte-order mark a document
      // drops -- cannot be it, and is turned away before it is read.
      const maxBytes = Math.min(
        this.limits.fileMaxBytes,
        bytes + UTF8_BYTE_ORDER_MARK_BYTES,
      );
      await this.readEach(named, maxBytes, (file, text) => {
        if (text === sourceContent) carrying.push(file);
      });
      return closestFile(urlSegments, carrying);
    }
    this.originalContents ??= this.indexContents(files);
    const contents = await this.originalContents;
    return closestFile(
      urlSegments,
      contents.get(contentHash(sourceContent)) ?? [],
    );
  }

  private async indexContents(
    files: readonly WorkspaceStylesheetFile[],
  ): Promise<ReadonlyMap<string, readonly WorkspaceStylesheetFile[]>> {
    const index = new Map<string, WorkspaceStylesheetFile[]>();
    await this.readEach(files, this.limits.fileMaxBytes, (file, text) => {
      const key = contentHash(text);
      const entries = index.get(key);
      if (entries) entries.push(file);
      else index.set(key, [file]);
    });
    return index;
  }

  private async workspaceFiles(
    pattern: string,
    extension: string,
  ): Promise<readonly WorkspaceStylesheetFile[]> {
    throwIfAborted(this.signal);
    let listed: readonly string[];
    try {
      listed = await raceWithAbort(
        Promise.resolve().then(() => this.host.findFiles(pattern)),
        this.signal,
      );
    } catch {
      if (this.signal?.aborted) throw abortError();
      return [];
    }
    throwIfAborted(this.signal);
    const seen = new Set<string>();
    const files: WorkspaceStylesheetFile[] = [];
    for (const entry of listed) {
      const uri = canonicalRulesSourceUri(entry);
      if (uri === undefined || seen.has(uri)) continue;
      seen.add(uri);
      const segments = pathSegments(uri);
      if (!segments.at(-1)?.toLowerCase().endsWith(extension)) continue;
      if (!this.host.isWorkspaceUri(uri)) continue;
      files.push({ uri, segments });
    }
    return files.sort((left, right) => compareText(left.uri, right.uri));
  }

  /**
   * Reads files in the order given until the batch's reading budget is spent.
   * A file that cannot be read is passed over; what it was is up to `skip`.
   */
  private async readEach(
    files: readonly WorkspaceStylesheetFile[],
    maxBytes: number,
    visit: (file: WorkspaceStylesheetFile, text: string) => void,
    skip?: (file: WorkspaceStylesheetFile, error: unknown) => void,
  ): Promise<void> {
    let readBytes = 0;
    for (const file of files.slice(0, this.limits.scanMaxFiles)) {
      if (readBytes >= this.limits.scanMaxBytes) break;
      throwIfAborted(this.signal);
      let scanned: ScannedStylesheetText;
      try {
        scanned = await raceWithAbort(
          Promise.resolve().then(() => this.host.readText(file.uri, maxBytes)),
          this.signal,
        );
      } catch (error) {
        if (this.signal?.aborted) throw abortError();
        skip?.(file, error);
        continue;
      }
      readBytes += scanned.bytes;
      visit(file, scanned.text);
    }
    throwIfAborted(this.signal);
  }
}

/**
 * Chooses among the files that were parsed for one served stylesheet.
 *
 * The file carrying the most reported rules exactly is the stylesheet. Between
 * files carrying as many, the one sharing more trailing path segments with the
 * served URL is, and after that the one whose rules stand where the browser
 * said they stand: an identical copy rather than a reformatted one. Files
 * ranked too low to be parsed are not forgotten: when the first of them could
 * have carried as many rules under as close a path, the choice was never
 * really made, and nothing is chosen.
 */
export function chooseGeneratedStylesheet(
  scored: readonly ScoredStylesheetCandidate[],
  firstUnparsed: RankedStylesheetCandidate | undefined,
  unreadable: UnreadableStylesheetCandidate | undefined,
): GeneratedStylesheetLocation {
  const verified = scored
    .flatMap(({ candidate, score }) =>
      score.kind === "verified" && score.verified > 0
        ? [{
            uri: candidate.uri,
            verified: score.verified,
            pathSimilarity: candidate.pathSimilarity,
            corroborated: score.corroborated,
          }]
        : []
    )
    .sort(compareVerified);
  const best = verified[0];
  if (!best) return unlocated(unverifiedReason(scored, unreadable));
  const runnerUp = verified[1];
  if (runnerUp && compareVerified(best, runnerUp) === 0) {
    return unlocated("generated-source-ambiguous");
  }
  if (
    firstUnparsed &&
    (firstUnparsed.selectors > best.verified ||
      (firstUnparsed.selectors === best.verified &&
        firstUnparsed.pathSimilarity >= best.pathSimilarity))
  ) {
    return unlocated("generated-source-ambiguous");
  }
  return { kind: "located", uri: best.uri };
}

/**
 * How many trailing path segments two URLs share: `/assets/css/app.css` and
 * `file:///project/dist/css/app.css` share two.
 */
export function sharedTrailingPathSegments(
  left: string,
  right: string,
): number {
  return sharedTrailingSegments(pathSegments(left), pathSegments(right));
}

/**
 * Why nothing was chosen, told by the file most likely to have been it: the
 * best-ranked parsed file, unless a file closer to the served URL could not be
 * read at all.
 */
function unverifiedReason(
  scored: readonly ScoredStylesheetCandidate[],
  unreadable: UnreadableStylesheetCandidate | undefined,
): string {
  const first = scored[0];
  if (
    unreadable &&
    (!first || unreadable.pathSimilarity > first.candidate.pathSimilarity)
  ) {
    return unreadable.reason;
  }
  if (!first) return "generated-source-not-found";
  return first.score.kind === "failed"
    ? first.score.reason
    : "generated-css-not-exact";
}

function compareVerified(
  left: {
    readonly verified: number;
    readonly pathSimilarity: number;
    readonly corroborated: number;
  },
  right: {
    readonly verified: number;
    readonly pathSimilarity: number;
    readonly corroborated: number;
  },
): number {
  return right.verified - left.verified ||
    right.pathSimilarity - left.pathSimilarity ||
    right.corroborated - left.corroborated;
}

function compareRanked(
  left: RankedStylesheetCandidate,
  right: RankedStylesheetCandidate,
): number {
  return right.selectors - left.selectors ||
    right.pathSimilarity - left.pathSimilarity ||
    right.declarations - left.declarations ||
    compareText(left.uri, right.uri);
}

function keepBest(
  ranked: RankedStylesheetCandidate[],
  candidate: RankedStylesheetCandidate,
  limit: number,
): void {
  let index = ranked.length;
  while (index > 0 && compareRanked(candidate, ranked[index - 1]!) < 0) {
    index -= 1;
  }
  if (index >= limit) return;
  ranked.splice(index, 0, candidate);
  if (ranked.length > limit) ranked.pop();
}

function rankedCandidate(
  stylesheet: ReportedStylesheet,
  file: WorkspaceStylesheetFile,
  present: ReadonlySet<string>,
): RankedStylesheetCandidate {
  return {
    uri: file.uri,
    selectors: stylesheet.selectorWords.filter((words) =>
      words.every((word) => present.has(word))
    ).length,
    pathSimilarity: sharedTrailingSegments(
      stylesheet.urlSegments,
      file.segments,
    ),
    declarations: stylesheet.declarationWords.filter((word) =>
      present.has(word)
    ).length,
  };
}

/** The unreadable file sharing the most of the served URL's path, if any. */
function closestUnreadable(
  unreadable: readonly UnreadableStylesheetFile[],
  urlSegments: readonly string[],
): UnreadableStylesheetCandidate | undefined {
  let closest: UnreadableStylesheetCandidate | undefined;
  for (const file of unreadable) {
    const pathSimilarity = sharedTrailingSegments(urlSegments, file.segments);
    if (pathSimilarity > (closest?.pathSimilarity ?? 0)) {
      closest = { pathSimilarity, reason: file.reason };
    }
  }
  return closest;
}

/**
 * The one file sharing the most trailing path, and at least `minimum`
 * segments of it; none when the most is shared by more than one.
 */
function closestFile(
  urlSegments: readonly string[],
  files: readonly WorkspaceStylesheetFile[],
  minimum = 0,
): string | undefined {
  let closest: string | undefined;
  let closestSimilarity = -1;
  let tied = false;
  for (const file of files) {
    const similarity = sharedTrailingSegments(urlSegments, file.segments);
    if (similarity > closestSimilarity) {
      closest = file.uri;
      closestSimilarity = similarity;
      tied = false;
    } else if (similarity === closestSimilarity) {
      tied = true;
    }
  }
  return tied || closestSimilarity < minimum ? undefined : closest;
}

function reportedStylesheets(
  rules: readonly InspectRuleEvidence[],
): ReadonlyMap<string, ReportedStylesheet> {
  const grouped = new Map<string, InspectRuleEvidence[]>();
  for (const rule of rules) {
    const sourceUrl = rule.generatedSource?.sourceUrl;
    if (sourceUrl === undefined) continue;
    const entries = grouped.get(sourceUrl);
    if (entries) entries.push(rule);
    else grouped.set(sourceUrl, [rule]);
  }
  return new Map([...grouped].map(([sourceUrl, entries]) => {
    const declarationWords = new Set<string>();
    for (const rule of entries) {
      for (const declaration of rule.declarations) {
        for (const word of distinctWords(
          `${declaration.property} ${declaration.value}`,
          DECLARATION_WORD_MIN_LENGTH,
          DECLARATION_WORDS_PER_STYLESHEET - declarationWords.size,
        )) {
          declarationWords.add(word);
        }
      }
    }
    return [sourceUrl, {
      sourceUrl,
      urlSegments: pathSegments(sourceUrl),
      rules: entries,
      selectorWords: entries.map((rule) =>
        distinctWords(rule.selector, 1, SELECTOR_WORDS_PER_RULE)
      ),
      declarationWords: [...declarationWords],
    }];
  }));
}

function distinctWords(
  text: string,
  minLength: number,
  limit: number,
): string[] {
  const words = new Set<string>();
  if (limit < 1) return [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (word.length < minLength) continue;
    words.add(word);
    if (words.size >= limit) break;
  }
  return [...words];
}

/** Which of `words` occur in `text` as whole words. */
function presentWords(
  text: string,
  words: ReadonlySet<string>,
): ReadonlySet<string> {
  const present = new Set<string>();
  if (words.size === 0) return present;
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    if (!words.has(word)) continue;
    present.add(word);
    if (present.size === words.size) break;
  }
  return present;
}

function sharedTrailingSegments(
  left: readonly string[],
  right: readonly string[],
): number {
  let shared = 0;
  while (
    shared < left.length &&
    shared < right.length &&
    left[left.length - 1 - shared] === right[right.length - 1 - shared]
  ) {
    shared += 1;
  }
  return shared;
}

/**
 * A URL's path, segment by segment. A map may name a source by a Windows path,
 * which parses as a scheme of its own and keeps its backslashes; they separate
 * segments all the same.
 */
function pathSegments(value: string): readonly string[] {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return [];
  }
  return pathname.split(/[/\\]/).filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function unlocated(reason: string): GeneratedStylesheetLocation {
  return { kind: "unlocated", reason };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Rules stylesheet location was aborted");
  error.name = "AbortError";
  return error;
}
