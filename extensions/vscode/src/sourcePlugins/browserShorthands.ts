/**
 * What a shorthand says, read the way a browser reads it.
 *
 * A browser hands a shorthand back in its own words. It leaves out every part
 * that holds its initial value, writes the parts in its own order, and folds a
 * longhand the rule sets after the shorthand into the shorthand itself:
 * `transition: transform 0.2s ease` comes back as `transform 0.2s`, `flex: 1`
 * as `1 1 0%`, `border: solid 1px red` as `1px solid red`, and `transition:
 * opacity .3s; transition-delay: .1s` as a single `transition`. The engines do
 * not agree with each other either -- Chrome writes out every part of an
 * `animation`, Firefox only the parts it cannot leave out.
 *
 * So both sides of a comparison are read here as the longhands a shorthand
 * sets, with every part it leaves out at its initial value. That is exactly
 * what the shorthand means: a part is only ever filled with the value the
 * shorthand itself gives it, so nothing that differs is made to look the same.
 * A value that cannot be read with certainty -- a token no part accepts, a
 * part given twice, anything still waiting on `var()` -- is left as written,
 * which can only keep two sides apart, never join them.
 *
 * Each reading was checked against what Chrome 155 and Firefox 158 report for
 * the declarations authors and dart-sass write. Values arrive already
 * normalized: single spaces, no space around `,` `/` `(` `)`, and colours,
 * numbers and URLs in their canonical spelling.
 */

export interface Longhand {
  readonly property: string;
  readonly value: string;
}

/**
 * Legacy names both engines resolve to the standard property: the rule says
 * `-webkit-transform` or `grid-gap`, the browser reports `transform` or
 * `gap`. Only names Chrome and Firefox both alias are listed -- a `-moz-` name
 * is an alias in Firefox and unknown to Chrome, which drops it.
 *
 * The old flexbox is the other way round: Chrome keeps `-webkit-box-orient`,
 * Firefox reports the same property as `-moz-box-orient`. Reading the `-moz-`
 * name as the `-webkit-` one is what lets a line clamp match in both; Chrome
 * drops a `-moz-box-` name, and a prefixed name the browser did not report is
 * already allowed to be missing.
 */
const PROPERTY_ALIASES: Readonly<Record<string, string>> = {
  "grid-gap": "gap",
  "grid-row-gap": "row-gap",
  "grid-column-gap": "column-gap",
  "word-wrap": "overflow-wrap",
  ...Object.fromEntries([
    "align",
    "direction",
    "flex",
    "ordinal-group",
    "orient",
    "pack",
  ].map((part) => [`-moz-box-${part}`, `-webkit-box-${part}`])),
  ...Object.fromEntries([
    "align-content",
    "align-items",
    "align-self",
    "animation",
    "animation-delay",
    "animation-duration",
    "animation-fill-mode",
    "animation-iteration-count",
    "animation-name",
    "animation-timing-function",
    "appearance",
    "backface-visibility",
    "background-clip",
    "background-size",
    "border-radius",
    "box-shadow",
    "box-sizing",
    "clip-path",
    "filter",
    "flex",
    "flex-basis",
    "flex-direction",
    "flex-flow",
    "flex-grow",
    "flex-shrink",
    "flex-wrap",
    "justify-content",
    "mask",
    "mask-image",
    "mask-position",
    "mask-repeat",
    "mask-size",
    "order",
    "perspective",
    "perspective-origin",
    "transform",
    "transform-origin",
    "transform-style",
    "transition",
    "transition-delay",
    "transition-duration",
    "transition-property",
    "transition-timing-function",
    "user-select",
  ].map((property) => [`-webkit-${property}`, property])),
};

export function canonicalPropertyName(property: string): string {
  return PROPERTY_ALIASES[property] ?? property;
}

type ShorthandReader = (
  value: string,
  property: string,
) => readonly Longhand[] | undefined;

const CSS_WIDE_KEYWORDS = new Set([
  "inherit",
  "initial",
  "revert",
  "revert-layer",
  "unset",
]);
const PENDING_SUBSTITUTION = /(?:^|[^\w-])(?:var|env|attr)\(/i;

/** The longhands a shorthand sets, or `undefined` when it cannot be read. */
export function expandBrowserShorthand(
  property: string,
  value: string,
): readonly Longhand[] | undefined {
  const reader = SHORTHAND_READERS[property];
  if (!reader) return undefined;
  if (
    CSS_WIDE_KEYWORDS.has(value.toLowerCase()) ||
    PENDING_SUBSTITUTION.test(value)
  ) {
    return undefined;
  }
  return reader(value, property);
}

/**
 * A longhand the rule writes out is spelled the way the browser spells it
 * too: `background-position: top right` comes back as `right top`,
 * `step-end` as `steps(1)` in Firefox, `currentColor` as `currentcolor`.
 */
export function canonicalLonghandValue(
  property: string,
  value: string,
): string {
  if (PENDING_SUBSTITUTION.test(value)) return value;
  const canonical = LONGHAND_CANONICALIZERS[property];
  if (canonical) return canonical(value) ?? value;
  if (COLOR_PROPERTIES.has(property) && IDENTIFIER.test(value)) {
    return value.toLowerCase();
  }
  return value;
}

const IDENTIFIER = /^(?:--|-?[A-Za-z_])[\w-]*$/;
const STRING = /^(?:"[^"]*"|'[^']*')$/;
const NUMBER = /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i;
const INTEGER = /^\d+$/;
const TIME = /^[+-]?(?:\d+|\d*\.\d+)m?s$/i;
const LENGTH = new RegExp(
  "^[+-]?(?:\\d+|\\d*\\.\\d+)(?:px|em|rem|ex|rex|ch|rch|cap|rcap|ic|ric|lh|" +
    "rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|" +
    "lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|" +
    "mm|q|in|pt|pc)$",
  "i",
);
const PERCENTAGE = /^[+-]?(?:\d+|\d*\.\d+)%$/;
const ANGLE = /^[+-]?(?:\d+|\d*\.\d+)(?:deg|grad|rad|turn)$/i;
const MATH_FUNCTION = /^(?:calc|min|max|clamp)\(/i;
const COLOR_FUNCTION =
  /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(/i;
const IMAGE_FUNCTION =
  /^(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|-webkit-image-set|image-set|image|cross-fade|element|paint)\(/i;

function isLength(token: string): boolean {
  return token === "0" || LENGTH.test(token) || MATH_FUNCTION.test(token);
}

function isLengthPercentage(token: string): boolean {
  return isLength(token) || PERCENTAGE.test(token);
}

/**
 * Whatever is left once every other part has had its keywords: a colour. A
 * name that is not one is a declaration the browser throws away, which keeps
 * the two sides apart on its own.
 */
function colorToken(token: string): string | undefined {
  if (COLOR_FUNCTION.test(token)) return token;
  if (!IDENTIFIER.test(token) || token.startsWith("--")) return undefined;
  const lower = token.toLowerCase();
  return lower === "none" || lower === "auto" ? undefined : lower;
}

/** Splits on a separator that sits outside quotes and parentheses. */
export function splitTopLevel(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === separator && depth === 0) {
      if (current !== "") parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current !== "") parts.push(current);
  return parts;
}

/** The space-separated parts of a value, with a top-level `/` as its own part. */
function components(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let depth = 0;
  const flush = (): void => {
    if (current !== "") tokens.push(current);
    current = "";
  };
  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) quote = "";
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
    } else if (depth === 0 && (character === " " || character === "/")) {
      flush();
      if (character === "/") tokens.push("/");
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

function layersOf(value: string): string[] | undefined {
  const layers = splitTopLevel(value, ",");
  return layers.length > 0 ? layers : undefined;
}

const EASING_KEYWORDS = new Set([
  "ease",
  "ease-in",
  "ease-in-out",
  "ease-out",
  "linear",
  "step-end",
  "step-start",
]);
const EASING_FUNCTION = /^(?:cubic-bezier|steps|linear)\(/i;

function isEasing(token: string): boolean {
  return EASING_KEYWORDS.has(token.toLowerCase()) || EASING_FUNCTION.test(token);
}

/**
 * `step-end` is `steps(1)` and a step function's `end` is its default; Chrome
 * keeps the keyword and drops the default, Firefox spells both as steps.
 */
function canonicalEasing(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "step-end") return "steps(1)";
  if (lower === "step-start") return "steps(1,start)";
  const steps = /^steps\((\d+)(?:,(?:jump-)?end)?\)$/i.exec(token);
  if (steps) return `steps(${steps[1]})`;
  return EASING_KEYWORDS.has(lower) ? lower : token;
}

/** A zero time is the initial delay however it is spelled; others keep theirs. */
function canonicalTime(token: string): string {
  return Number.parseFloat(token) === 0 ? "0s" : token;
}

function readTransition(value: string): readonly Longhand[] | undefined {
  const layers = layersOf(value);
  if (!layers) return undefined;
  const columns: string[][] = [[], [], [], [], []];
  for (const layer of layers) {
    let property: string | undefined;
    let duration: string | undefined;
    let easing: string | undefined;
    let delay: string | undefined;
    let behavior: string | undefined;
    for (const token of components(layer)) {
      const lower = token.toLowerCase();
      if (TIME.test(token)) {
        if (duration === undefined) duration = token;
        else if (delay === undefined) delay = token;
        else return undefined;
      } else if (isEasing(token)) {
        if (easing !== undefined) return undefined;
        easing = token;
      } else if (lower === "normal" || lower === "allow-discrete") {
        if (behavior !== undefined) return undefined;
        behavior = lower;
      } else if (IDENTIFIER.test(token) && property === undefined) {
        property = token.startsWith("--") ? token : lower;
      } else {
        return undefined;
      }
    }
    columns[0]!.push(property ?? "all");
    columns[1]!.push(canonicalTime(duration ?? "0s"));
    columns[2]!.push(canonicalEasing(easing ?? "ease"));
    columns[3]!.push(canonicalTime(delay ?? "0s"));
    columns[4]!.push(behavior ?? "normal");
  }
  return [
    "transition-property",
    "transition-duration",
    "transition-timing-function",
    "transition-delay",
    "transition-behavior",
  ].map((property, index) => ({
    property,
    value: columns[index]!.join(","),
  }));
}

const ANIMATION_DIRECTIONS = new Set([
  "alternate",
  "alternate-reverse",
  "normal",
  "reverse",
]);
const ANIMATION_FILL_MODES = new Set(["backwards", "both", "forwards", "none"]);
const ANIMATION_PLAY_STATES = new Set(["paused", "running"]);

/**
 * Each part takes the first token it accepts, in the order the browser tries
 * them, so `none` is a fill mode before it is a name. Chrome reports an
 * omitted duration as `auto`, which on the document timeline the shorthand
 * always resets to is the same as `0s`.
 */
function readAnimation(value: string): readonly Longhand[] | undefined {
  const layers = layersOf(value);
  if (!layers) return undefined;
  const columns: string[][] = [[], [], [], [], [], [], [], []];
  for (const layer of layers) {
    let duration: string | undefined;
    let easing: string | undefined;
    let delay: string | undefined;
    let iterations: string | undefined;
    let direction: string | undefined;
    let fillMode: string | undefined;
    let playState: string | undefined;
    let name: string | undefined;
    for (const token of components(layer)) {
      const lower = token.toLowerCase();
      if (TIME.test(token)) {
        if (duration === undefined) duration = token;
        else if (delay === undefined) delay = token;
        else return undefined;
      } else if (lower === "auto" && duration === undefined) {
        duration = "0s";
      } else if (isEasing(token) && easing === undefined) {
        easing = token;
      } else if (
        (NUMBER.test(token) || lower === "infinite") &&
        iterations === undefined
      ) {
        iterations = lower;
      } else if (ANIMATION_DIRECTIONS.has(lower) && direction === undefined) {
        direction = lower;
      } else if (ANIMATION_FILL_MODES.has(lower) && fillMode === undefined) {
        fillMode = lower;
      } else if (ANIMATION_PLAY_STATES.has(lower) && playState === undefined) {
        playState = lower;
      } else if (
        (IDENTIFIER.test(token) || STRING.test(token)) &&
        !token.startsWith("--") &&
        !isEasing(token) &&
        name === undefined
      ) {
        name = lower === "none" ? lower : token;
      } else {
        return undefined;
      }
    }
    columns[0]!.push(name ?? "none");
    columns[1]!.push(canonicalTime(duration ?? "0s"));
    columns[2]!.push(canonicalEasing(easing ?? "ease"));
    columns[3]!.push(canonicalTime(delay ?? "0s"));
    columns[4]!.push(iterations ?? "1");
    columns[5]!.push(direction ?? "normal");
    columns[6]!.push(fillMode ?? "none");
    columns[7]!.push(playState ?? "running");
  }
  return [
    "animation-name",
    "animation-duration",
    "animation-timing-function",
    "animation-delay",
    "animation-iteration-count",
    "animation-direction",
    "animation-fill-mode",
    "animation-play-state",
  ].map((property, index) => ({
    property,
    value: columns[index]!.join(","),
  }));
}

const FLEX_BASIS_KEYWORDS = new Set([
  "auto",
  "content",
  "fit-content",
  "max-content",
  "min-content",
]);

/**
 * `flex: 1` is `1 1 0%` and `flex: 200px` is `1 1 200px`. A unitless zero is a
 * flex factor unless two factors already came before it, when it is the basis.
 */
function readFlex(value: string): readonly Longhand[] | undefined {
  const tokens = components(value);
  const only = tokens.length === 1 ? tokens[0]!.toLowerCase() : undefined;
  if (only === "none") return flexLonghands("0", "0", "auto");
  if (only === "auto") return flexLonghands("1", "1", "auto");
  let grow: string | undefined;
  let shrink: string | undefined;
  let basis: string | undefined;
  let afterGrow = false;
  for (const token of tokens) {
    if (NUMBER.test(token)) {
      if (grow === undefined) {
        grow = token;
        afterGrow = true;
      } else if (shrink === undefined && afterGrow) {
        shrink = token;
        afterGrow = false;
      } else if (basis === undefined && shrink !== undefined && token === "0") {
        basis = token;
      } else {
        return undefined;
      }
      continue;
    }
    afterGrow = false;
    const lower = token.toLowerCase();
    if (basis !== undefined) return undefined;
    if (FLEX_BASIS_KEYWORDS.has(lower)) basis = lower;
    else if (isLengthPercentage(token) || /^fit-content\(/i.test(token)) {
      basis = token;
    } else {
      return undefined;
    }
  }
  if (grow === undefined && basis === undefined) return undefined;
  return flexLonghands(grow ?? "1", shrink ?? "1", basis ?? "0%");
}

function flexLonghands(
  grow: string,
  shrink: string,
  basis: string,
): readonly Longhand[] {
  return [
    { property: "flex-grow", value: grow },
    { property: "flex-shrink", value: shrink },
    { property: "flex-basis", value: basis },
  ];
}

const FLEX_DIRECTIONS = new Set([
  "column",
  "column-reverse",
  "row",
  "row-reverse",
]);
const FLEX_WRAPS = new Set(["nowrap", "wrap", "wrap-reverse"]);

function readFlexFlow(value: string): readonly Longhand[] | undefined {
  let direction: string | undefined;
  let wrap: string | undefined;
  for (const token of components(value)) {
    const lower = token.toLowerCase();
    if (FLEX_DIRECTIONS.has(lower) && direction === undefined) direction = lower;
    else if (FLEX_WRAPS.has(lower) && wrap === undefined) wrap = lower;
    else return undefined;
  }
  return [
    { property: "flex-direction", value: direction ?? "row" },
    { property: "flex-wrap", value: wrap ?? "nowrap" },
  ];
}

const LINE_WIDTH_KEYWORDS = new Set(["medium", "thick", "thin"]);
const BORDER_STYLES = new Set([
  "dashed",
  "dotted",
  "double",
  "groove",
  "hidden",
  "inset",
  "none",
  "outset",
  "ridge",
  "solid",
]);
const OUTLINE_STYLES = new Set([...BORDER_STYLES, "auto"]);

interface Line {
  readonly width: string;
  readonly style: string;
  readonly color: string;
}

function readLine(
  value: string,
  styles: ReadonlySet<string>,
): Line | undefined {
  let width: string | undefined;
  let style: string | undefined;
  let color: string | undefined;
  for (const token of components(value)) {
    const lower = token.toLowerCase();
    if (
      (LINE_WIDTH_KEYWORDS.has(lower) || isLength(token)) &&
      width === undefined
    ) {
      width = LINE_WIDTH_KEYWORDS.has(lower) ? lower : token;
    } else if (styles.has(lower) && style === undefined) {
      style = lower;
    } else if (color === undefined && colorToken(token) !== undefined) {
      color = colorToken(token);
    } else {
      return undefined;
    }
  }
  return {
    width: width ?? "medium",
    style: style ?? "none",
    color: color ?? "currentcolor",
  };
}

function readOutline(value: string): readonly Longhand[] | undefined {
  const line = readLine(value, OUTLINE_STYLES);
  return line && [
    { property: "outline-width", value: line.width },
    { property: "outline-style", value: line.style },
    { property: "outline-color", value: line.color },
  ];
}

const BORDER_SIDES: Readonly<Record<string, readonly string[]>> = {
  border: ["top", "right", "bottom", "left"],
  "border-top": ["top"],
  "border-right": ["right"],
  "border-bottom": ["bottom"],
  "border-left": ["left"],
  "border-block": ["block-start", "block-end"],
  "border-block-start": ["block-start"],
  "border-block-end": ["block-end"],
  "border-inline": ["inline-start", "inline-end"],
  "border-inline-start": ["inline-start"],
  "border-inline-end": ["inline-end"],
};

/**
 * `border` also resets `border-image`, which is how Chrome can report a
 * `border: none` as four declarations, the last of them `border-image: none`.
 */
function readBorder(
  value: string,
  property: string,
): readonly Longhand[] | undefined {
  const line = readLine(value, BORDER_STYLES);
  if (!line) return undefined;
  const sides = BORDER_SIDES[property]!.flatMap((side) => [
    { property: `border-${side}-width`, value: line.width },
    { property: `border-${side}-style`, value: line.style },
    { property: `border-${side}-color`, value: line.color },
  ]);
  return property === "border"
    ? [...sides, { property: "border-image", value: "none" }]
    : sides;
}

const POSITION_KEYWORDS = new Set(["bottom", "center", "left", "right", "top"]);
const HORIZONTAL_SIDES = new Set(["left", "right"]);
const VERTICAL_SIDES = new Set(["bottom", "top"]);

function isPositionToken(token: string): boolean {
  return POSITION_KEYWORDS.has(token.toLowerCase()) || isLengthPercentage(token);
}

/**
 * One position written as two values, horizontal first: `center` is `center
 * center`, `top` is `center top`, `top right` is `right top`. Three and four
 * value positions are written out in full by both engines and kept as they are.
 */
function canonicalPosition(tokens: readonly string[]): string | undefined {
  if (tokens.length < 1 || tokens.length > 4) return undefined;
  if (!tokens.every(isPositionToken)) return undefined;
  const parts = tokens.map((token) =>
    POSITION_KEYWORDS.has(token.toLowerCase()) ? token.toLowerCase() : token
  );
  if (parts.length === 1) {
    const only = parts[0]!;
    return VERTICAL_SIDES.has(only) ? `center ${only}` : `${only} center`;
  }
  if (parts.length === 2) {
    const [first, second] = parts as [string, string];
    const swapped = (VERTICAL_SIDES.has(first) &&
      (HORIZONTAL_SIDES.has(second) || second === "center")) ||
      (first === "center" && HORIZONTAL_SIDES.has(second));
    return swapped ? `${second} ${first}` : `${first} ${second}`;
  }
  return parts.join(" ");
}

const SIZE_KEYWORDS = new Set(["auto", "contain", "cover"]);

/** `100%` is `100% auto` and `auto auto` is `auto`. */
function canonicalSize(tokens: readonly string[]): string | undefined {
  const parts = tokens.map((token) =>
    SIZE_KEYWORDS.has(token.toLowerCase()) ? token.toLowerCase() : token
  );
  if (
    parts.length < 1 || parts.length > 2 ||
    !parts.every((part) => SIZE_KEYWORDS.has(part) || isLengthPercentage(part))
  ) {
    return undefined;
  }
  if (parts.length === 1) {
    const only = parts[0]!;
    return SIZE_KEYWORDS.has(only) ? only : `${only} auto`;
  }
  if (parts.some((part) => part === "cover" || part === "contain")) {
    return undefined;
  }
  return parts[0] === "auto" && parts[1] === "auto" ? "auto" : parts.join(" ");
}

const REPEAT_KEYWORDS = new Set(["no-repeat", "repeat", "round", "space"]);

/** Both axes spelled out: `repeat-x` is `repeat no-repeat`. */
function canonicalRepeat(tokens: readonly string[]): string | undefined {
  const parts = tokens.map((token) => token.toLowerCase());
  if (parts.length === 1) {
    const only = parts[0]!;
    if (only === "repeat-x") return "repeat no-repeat";
    if (only === "repeat-y") return "no-repeat repeat";
    return REPEAT_KEYWORDS.has(only) ? `${only} ${only}` : undefined;
  }
  return parts.length === 2 && parts.every((part) => REPEAT_KEYWORDS.has(part))
    ? parts.join(" ")
    : undefined;
}

const ATTACHMENTS = new Set(["fixed", "local", "scroll"]);
const BOXES = new Set(["border-box", "content-box", "padding-box"]);

interface BackgroundLayer {
  readonly image: string;
  readonly position: string;
  readonly size: string;
  readonly repeat: string;
  readonly attachment: string;
  readonly origin: string;
  readonly clip: string;
  readonly color?: string;
}

/**
 * One box sets both the origin and the clip; two set them in that order. The
 * clip alone can be `text`, which Firefox reports beside the default origin.
 */
function readBackgroundLayer(
  layer: string,
  final: boolean,
): BackgroundLayer | undefined {
  const tokens = components(layer);
  let image: string | undefined;
  let position: string | undefined;
  let size: string | undefined;
  let repeat: string | undefined;
  let attachment: string | undefined;
  let origin: string | undefined;
  let clip: string | undefined;
  let color: string | undefined;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (
      image === undefined && (lower === "none" || IMAGE_FUNCTION.test(token))
    ) {
      image = lower === "none" ? lower : token;
      index += 1;
    } else if (isPositionToken(token)) {
      if (position !== undefined) return undefined;
      const run: string[] = [];
      while (
        index < tokens.length && run.length < 4 &&
        isPositionToken(tokens[index]!)
      ) {
        run.push(tokens[index]!);
        index += 1;
      }
      position = canonicalPosition(run);
      if (position === undefined) return undefined;
      if (tokens[index] === "/") {
        index += 1;
        const sizes: string[] = [];
        while (index < tokens.length && sizes.length < 2) {
          const candidate = tokens[index]!;
          if (
            !SIZE_KEYWORDS.has(candidate.toLowerCase()) &&
            !isLengthPercentage(candidate)
          ) break;
          sizes.push(candidate);
          index += 1;
        }
        size = canonicalSize(sizes);
        if (size === undefined) return undefined;
      }
    } else if (lower === "repeat-x" || lower === "repeat-y") {
      if (repeat !== undefined) return undefined;
      repeat = canonicalRepeat([lower]);
      index += 1;
    } else if (REPEAT_KEYWORDS.has(lower)) {
      if (repeat !== undefined) return undefined;
      const run = [lower];
      index += 1;
      const next = tokens[index]?.toLowerCase();
      if (next !== undefined && REPEAT_KEYWORDS.has(next)) {
        run.push(next);
        index += 1;
      }
      repeat = canonicalRepeat(run);
    } else if (ATTACHMENTS.has(lower)) {
      if (attachment !== undefined) return undefined;
      attachment = lower;
      index += 1;
    } else if (BOXES.has(lower)) {
      if (origin === undefined) origin = lower;
      else if (clip === undefined) clip = lower;
      else return undefined;
      index += 1;
    } else if (lower === "text") {
      if (clip !== undefined) return undefined;
      clip = lower;
      index += 1;
    } else if (final && color === undefined && colorToken(token)) {
      color = colorToken(token);
      index += 1;
    } else {
      return undefined;
    }
  }
  return {
    image: image ?? "none",
    position: position ?? "0% 0%",
    size: size ?? "auto",
    repeat: repeat ?? "repeat repeat",
    attachment: attachment ?? "scroll",
    clip: clip ?? origin ?? "border-box",
    origin: origin ?? "padding-box",
    ...(final ? { color: color ?? "transparent" } : {}),
  };
}

function readBackground(value: string): readonly Longhand[] | undefined {
  const layers = layersOf(value);
  if (!layers) return undefined;
  const read: BackgroundLayer[] = [];
  for (const [index, layer] of layers.entries()) {
    const parsed = readBackgroundLayer(layer, index === layers.length - 1);
    if (!parsed) return undefined;
    read.push(parsed);
  }
  const column = (key: Exclude<keyof BackgroundLayer, "color">): string =>
    read.map((layer) => layer[key]).join(",");
  return [
    { property: "background-image", value: column("image") },
    { property: "background-position", value: column("position") },
    { property: "background-size", value: column("size") },
    { property: "background-repeat", value: column("repeat") },
    { property: "background-attachment", value: column("attachment") },
    { property: "background-origin", value: column("origin") },
    { property: "background-clip", value: column("clip") },
    { property: "background-color", value: read.at(-1)!.color! },
  ];
}

/** Each layer's position, size or repeat, the way the browser writes it. */
function perLayer(
  canonical: (tokens: readonly string[]) => string | undefined,
): (value: string) => string | undefined {
  return (value) => {
    const layers = layersOf(value);
    if (!layers) return undefined;
    const read = layers.map((layer) => canonical(components(layer)));
    return read.every((layer) => layer !== undefined)
      ? read.join(",")
      : undefined;
  };
}

/** Firefox writes a `transform-origin` out with its default depth, `0px`. */
function canonicalTransformOrigin(value: string): string | undefined {
  const tokens = components(value);
  const depth = tokens.length === 3 && isLength(tokens[2]!)
    ? tokens[2]!
    : undefined;
  const position = canonicalPosition(
    depth === undefined ? tokens : tokens.slice(0, 2),
  );
  if (position === undefined) return undefined;
  return depth === undefined || depth === "0"
    ? position
    : `${position} ${depth}`;
}

const SYSTEM_FONTS = new Set([
  "caption",
  "icon",
  "menu",
  "message-box",
  "small-caption",
  "status-bar",
]);
const FONT_STYLES = new Set(["italic", "oblique"]);
const FONT_WEIGHTS = /^(?:bold|bolder|lighter|[1-9]\d{0,2}|1000)$/;
const FONT_STRETCHES = new Set([
  "condensed",
  "expanded",
  "extra-condensed",
  "extra-expanded",
  "semi-condensed",
  "semi-expanded",
  "ultra-condensed",
  "ultra-expanded",
]);
const FONT_SIZE_KEYWORDS = new Set([
  "large",
  "larger",
  "medium",
  "small",
  "smaller",
  "x-large",
  "x-small",
  "xx-large",
  "xx-small",
  "xxx-large",
]);

/** A weight of `400` is `normal`: Chrome keeps the number, Firefox drops it. */
function canonicalFontWeight(weight: string): string {
  return weight === "400" ? "normal" : weight;
}

function readFont(value: string): readonly Longhand[] | undefined {
  if (SYSTEM_FONTS.has(value.toLowerCase())) return undefined;
  const tokens = components(value);
  let style: string | undefined;
  let variant: string | undefined;
  let weight: string | undefined;
  let stretch: string | undefined;
  let index = 0;
  for (; index < tokens.length && index < 4; index += 1) {
    const lower = tokens[index]!.toLowerCase();
    if (lower === "normal") continue;
    if (FONT_STYLES.has(lower) && style === undefined) style = lower;
    else if (lower === "small-caps" && variant === undefined) variant = lower;
    else if (FONT_WEIGHTS.test(lower) && weight === undefined) weight = lower;
    else if (FONT_STRETCHES.has(lower) && stretch === undefined) stretch = lower;
    else break;
  }
  const size = tokens[index];
  if (
    size === undefined ||
    !(FONT_SIZE_KEYWORDS.has(size.toLowerCase()) || isLengthPercentage(size))
  ) {
    return undefined;
  }
  index += 1;
  let lineHeight = "normal";
  if (tokens[index] === "/") {
    const written = tokens[index + 1];
    if (written === undefined || written === "/") return undefined;
    lineHeight = written.toLowerCase() === "normal" ? "normal" : written;
    index += 2;
  }
  const family = tokens.slice(index).join(" ");
  if (family === "" || family.includes("/")) return undefined;
  return [
    { property: "font-style", value: style ?? "normal" },
    { property: "font-variant-caps", value: variant ?? "normal" },
    { property: "font-weight", value: canonicalFontWeight(weight ?? "normal") },
    { property: "font-stretch", value: stretch ?? "normal" },
    {
      property: "font-size",
      value: FONT_SIZE_KEYWORDS.has(size.toLowerCase())
        ? size.toLowerCase()
        : size,
    },
    { property: "line-height", value: lineHeight },
    { property: "font-family", value: family },
  ];
}

/**
 * `none` sets whichever of the image and the type nothing else set; Firefox
 * leaves out every part at its default, Chrome writes them in its own order.
 */
function readListStyle(value: string): readonly Longhand[] | undefined {
  let position: string | undefined;
  let image: string | undefined;
  let type: string | undefined;
  let nones = 0;
  for (const token of components(value)) {
    const lower = token.toLowerCase();
    if ((lower === "inside" || lower === "outside") && position === undefined) {
      position = lower;
    } else if (lower === "none") {
      nones += 1;
    } else if (IMAGE_FUNCTION.test(token) && image === undefined) {
      image = token;
    } else if (
      type === undefined &&
      (IDENTIFIER.test(token) || STRING.test(token) || /^symbols\(/i.test(token))
    ) {
      type = token;
    } else {
      return undefined;
    }
  }
  if (nones > 2) return undefined;
  if (nones === 2) {
    if (image !== undefined || type !== undefined) return undefined;
    image = "none";
    type = "none";
  } else if (nones === 1) {
    if (image === undefined && type === undefined) {
      image = "none";
      type = "none";
    } else if (image === undefined) {
      image = "none";
    } else if (type === undefined) {
      type = "none";
    } else {
      return undefined;
    }
  }
  return [
    { property: "list-style-position", value: position ?? "outside" },
    { property: "list-style-image", value: image ?? "none" },
    { property: "list-style-type", value: type ?? "disc" },
  ];
}

function readColumns(value: string): readonly Longhand[] | undefined {
  let width: string | undefined;
  let count: string | undefined;
  let autos = 0;
  for (const token of components(value)) {
    if (token.toLowerCase() === "auto") autos += 1;
    else if (INTEGER.test(token) && count === undefined) count = token;
    else if (isLength(token) && width === undefined) width = token;
    else return undefined;
  }
  const given = autos + (width === undefined ? 0 : 1) +
    (count === undefined ? 0 : 1);
  if (given < 1 || given > 2) return undefined;
  return [
    { property: "column-width", value: width ?? "auto" },
    { property: "column-count", value: count ?? "auto" },
  ];
}

const DECORATION_LINES = new Set([
  "blink",
  "grammar-error",
  "line-through",
  "overline",
  "spelling-error",
  "underline",
]);
const DECORATION_STYLES = new Set(["dashed", "dotted", "double", "solid", "wavy"]);

function readTextDecoration(value: string): readonly Longhand[] | undefined {
  const lines: string[] = [];
  let none = false;
  let style: string | undefined;
  let thickness: string | undefined;
  let color: string | undefined;
  for (const token of components(value)) {
    const lower = token.toLowerCase();
    if (lower === "none" && lines.length === 0 && !none) {
      none = true;
    } else if (DECORATION_LINES.has(lower) && !none && !lines.includes(lower)) {
      lines.push(lower);
    } else if (DECORATION_STYLES.has(lower) && style === undefined) {
      style = lower;
    } else if (
      (lower === "auto" || lower === "from-font" || isLengthPercentage(token)) &&
      thickness === undefined
    ) {
      thickness = lower === "auto" || lower === "from-font" ? lower : token;
    } else if (color === undefined && colorToken(token) !== undefined) {
      color = colorToken(token);
    } else {
      return undefined;
    }
  }
  return [
    { property: "text-decoration-line", value: lines.join(" ") || "none" },
    { property: "text-decoration-style", value: style ?? "solid" },
    { property: "text-decoration-color", value: color ?? "currentcolor" },
    { property: "text-decoration-thickness", value: thickness ?? "auto" },
  ];
}

const SHORTHAND_READERS: Readonly<Record<string, ShorthandReader>> = {
  animation: readAnimation,
  background: readBackground,
  columns: readColumns,
  flex: readFlex,
  "flex-flow": readFlexFlow,
  font: readFont,
  "list-style": readListStyle,
  outline: readOutline,
  "text-decoration": readTextDecoration,
  transition: readTransition,
  ...Object.fromEntries(
    Object.keys(BORDER_SIDES).map((property) => [property, readBorder]),
  ),
};

const timesPerLayer = (value: string): string | undefined =>
  layersOf(value)?.map(canonicalTime).join(",");
const easingsPerLayer = (value: string): string | undefined =>
  layersOf(value)?.map(canonicalEasing).join(",");
const positionsPerLayer = perLayer(canonicalPosition);

const LONGHAND_CANONICALIZERS: Readonly<
  Record<string, (value: string) => string | undefined>
> = {
  "animation-delay": timesPerLayer,
  "animation-timing-function": easingsPerLayer,
  "background-position": positionsPerLayer,
  "background-repeat": perLayer(canonicalRepeat),
  "background-size": perLayer(canonicalSize),
  "font-weight": canonicalFontWeight,
  "mask-position": positionsPerLayer,
  "object-position": (value) => canonicalPosition(components(value)),
  "perspective-origin": (value) => canonicalPosition(components(value)),
  "transform-origin": canonicalTransformOrigin,
  "transition-delay": timesPerLayer,
  "transition-duration": timesPerLayer,
  "transition-timing-function": easingsPerLayer,
};

/** Properties whose whole value is one colour. */
const COLOR_PROPERTIES = new Set([
  "accent-color",
  "background-color",
  "border-block-end-color",
  "border-block-start-color",
  "border-bottom-color",
  "border-color",
  "border-inline-end-color",
  "border-inline-start-color",
  "border-left-color",
  "border-right-color",
  "border-top-color",
  "caret-color",
  "color",
  "column-rule-color",
  "fill",
  "flood-color",
  "lighting-color",
  "outline-color",
  "stop-color",
  "stroke",
  "text-decoration-color",
  "text-emphasis-color",
]);

const GRADIENT = /^(?:repeating-)?(linear|radial|conic)-gradient$/i;
const RADIAL_SHAPES = new Set(["circle", "ellipse"]);
const RADIAL_EXTENTS = new Set([
  "closest-corner",
  "closest-side",
  "farthest-corner",
  "farthest-side",
]);
const DEFAULT_LINEAR_DIRECTIONS = new Set(["to bottom", "180deg", "0.5turn"]);

/** The gradient a function name stands for, or `undefined` for anything else. */
export function gradientKind(
  name: string,
): "linear" | "radial" | "conic" | undefined {
  return GRADIENT.exec(name)?.[1]?.toLowerCase() as
    | "linear"
    | "radial"
    | "conic"
    | undefined;
}

/**
 * A gradient's arguments the way a browser writes them back: it leaves out a
 * direction, shape, extent or centre that is the default, and splits a colour
 * stop with two positions into two stops. `body` is already canonical inside.
 */
export function canonicalGradientArguments(
  kind: "linear" | "radial" | "conic",
  body: string,
): string {
  const args = splitTopLevel(body, ",");
  if (args.length === 0) return body;
  const leading = canonicalGradientSetup(kind, args[0]!);
  const stops = leading === undefined ? args : args.slice(1);
  const out = leading ? [leading] : [];
  for (const stop of stops) {
    const tokens = components(stop).map((token) =>
      kind === "conic" && ANGLE.test(token) && Number.parseFloat(token) === 0
        ? "0"
        : token
    );
    if (
      tokens.length === 3 &&
      !isStopPosition(tokens[0]!) &&
      isStopPosition(tokens[1]!) &&
      isStopPosition(tokens[2]!)
    ) {
      out.push(`${tokens[0]} ${tokens[1]}`, `${tokens[0]} ${tokens[2]}`);
    } else {
      out.push(tokens.join(" "));
    }
  }
  return out.join(",");
}

function isStopPosition(token: string): boolean {
  return isLengthPercentage(token) || ANGLE.test(token);
}

/**
 * The canonical first argument when it sets the gradient up rather than
 * naming a colour stop: `""` when everything in it is the default,
 * `undefined` when it is a colour stop after all.
 */
function canonicalGradientSetup(
  kind: "linear" | "radial" | "conic",
  first: string,
): string | undefined {
  const tokens = components(first).map((token) =>
    /^[a-z-]+$/i.test(token) ? token.toLowerCase() : token
  );
  if (kind === "linear") {
    const setup = tokens.join(" ");
    if (DEFAULT_LINEAR_DIRECTIONS.has(setup)) return "";
    return tokens[0] === "to" || (tokens.length === 1 && ANGLE.test(tokens[0]!))
      ? setup
      : undefined;
  }
  const at = tokens.indexOf("at");
  const head = at < 0 ? tokens : tokens.slice(0, at);
  const position = at < 0 ? undefined : centredPosition(tokens.slice(at + 1));
  if (at >= 0 && position === undefined) return undefined;
  if (kind === "conic") {
    let from = "";
    if (head.length === 2 && head[0] === "from") {
      const angle = head[1]!;
      if (angle !== "0" && !ANGLE.test(angle)) return undefined;
      from = Number.parseFloat(angle) === 0 ? "" : `from ${angle}`;
    } else if (head.length > 0 || at < 0) {
      return undefined;
    }
    return [from, position ? `at ${position}` : ""].filter(Boolean).join(" ");
  }
  if (head.length === 0 && at < 0) return undefined;
  if (
    !head.every((token) =>
      RADIAL_SHAPES.has(token) || RADIAL_EXTENTS.has(token) ||
      isLengthPercentage(token)
    )
  ) {
    return undefined;
  }
  const explicitSize = head.some((token) => isLengthPercentage(token));
  const kept = head.filter((token) =>
    token !== "farthest-corner" && !(token === "ellipse" && !explicitSize)
  );
  return [...kept, ...(position ? [`at ${position}`] : [])].join(" ");
}

/** A gradient centre, or `""` when it is the default centre. */
function centredPosition(tokens: readonly string[]): string | undefined {
  const position = canonicalPosition(tokens);
  if (position === undefined) return undefined;
  return position === "center center" || position === "50% 50%"
    ? ""
    : position;
}
