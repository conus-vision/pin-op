import { describe, expect, it } from "vitest";
import type {
  SelectionSnapshot,
  SourceDocument,
  SourceMatch,
  SourceUriResolution,
  SourceWorkspace,
} from "@pin-op/plugin-api";
import type { InspectTarget, RuntimeFact } from "@pin-op/protocol";
import { PhpSourcePlugin } from "../src/sourcePlugins/phpSourcePlugin.js";
import { withDomAttributeFacts } from "../src/sourcePlugins/domFacts.js";
import { parsePhpMarkup } from "../src/sourcePlugins/phpMarkup.js";

const TEMPLATE = [
  "<?php $title = get_the_title(); ?>",
  '<section class="page">',
  '  <article id="hero" class="card card--wide" data-block="hero">',
  "    <h1><?= $title ?></h1>",
  "  </article>",
  '  <article class="card">',
  '    <p class="card__body">One</p>',
  "  </article>",
  '  <article class="card">',
  '    <p class="card__body">Two</p>',
  "  </article>",
  "</section>",
].join("\n");

describe("PhpSourcePlugin", () => {
  it("only claims PHP file documents and DOM or template evidence", () => {
    const plugin = new PhpSourcePlugin();

    expect(plugin.documentSelectors).toEqual([
      { languageId: "php", scheme: "file" },
    ]);
    expect([...plugin.supportedFactKinds]).toEqual([
      "dom-attribute",
      "php.template",
      "wordpress.acf-block",
    ]);
  });

  it("resolves the selected element by id and keeps the match heuristic", async () => {
    const result = await resolve(TEMPLATE, [
      target("selected", { tag: "article", id: "hero", classes: ["card", "card--wide"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      targetRole: "selected",
      kind: "template",
      relation: "renders",
      confidence: "heuristic",
      label: "article#hero.card.card--wide",
      metadata: { evidence: "markup-id" },
    });
    expect(snippet(TEMPLATE, result.matches[0]!)).toBe([
      '<article id="hero" class="card card--wide" data-block="hero">',
      "    <h1><?= $title ?></h1>",
      "  </article>",
    ].join("\n"));
  });

  it("lists every equally strong candidate the template writes", async () => {
    const result = await resolve(TEMPLATE, [
      target("selected", { tag: "p", classes: ["card__body"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(snippets(TEMPLATE, result.matches)).toEqual([
      '<p class="card__body">One</p>',
      '<p class="card__body">Two</p>',
    ]);
  });

  it("keeps a branch written twice in one template out of the ambiguous bucket", async () => {
    // The front-page and landing branches of a WordPress header render the
    // same block, so both are real candidate origins for one element.
    const markup = [
      "<?php if (is_front_page()) { ?>",
      '  <div id="home_slider" data-slides-col="<?php echo $count; ?>"></div>',
      "<?php } else { ?>",
      '  <div id="home_slider" data-slides-col="1"></div>',
      "<?php } ?>",
    ].join("\n");
    const result = await resolve(markup, [
      target("selected", {
        tag: "div",
        id: "home_slider",
        attributes: { "data-slides-col": "4" },
      }),
    ]);

    // The landing branch pins the attribute to a value this element never had,
    // so only the front-page branch survives.
    expect(result.status).toBe("matched");
    expect(snippets(markup, result.matches)).toEqual([
      '<div id="home_slider" data-slides-col="<?php echo $count; ?>"></div>',
    ]);
  });

  it("lists both branches when neither contradicts the element", async () => {
    const markup = [
      "<?php if (is_front_page()) { ?>",
      '  <div id="home_slider" class="slider"></div>',
      "<?php } else { ?>",
      '  <div id="home_slider" class="slider"></div>',
      "<?php } ?>",
    ].join("\n");
    const result = await resolve(markup, [
      target("selected", {
        tag: "div",
        id: "home_slider",
        classes: ["slider", "is-ready"],
      }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(2);
  });

  it("does not fall through to weaker evidence once a stronger tier answers", async () => {
    const result = await resolve(TEMPLATE, [
      target("selected", { tag: "article", classes: ["card"] }),
    ]);

    // Only the two plain `.card` articles qualify; the wide one declares a
    // class the element never had.
    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((match) =>
      match.metadata?.["evidence"] === "markup-classes"
    )).toBe(true);
  });

  it("reports too many equal candidates as ambiguous instead of a wall of guesses", async () => {
    const markup = Array.from(
      { length: 9 },
      () => '<li class="row"></li>',
    ).join("\n");
    const result = await resolve(markup, [
      target("selected", { tag: "li", classes: ["row"] }),
    ]);

    expect(result.status).toBe("rule-match-ambiguous");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics?.map((entry) => entry.code)).toEqual([
      "php.markupAmbiguous",
    ]);
  });

  it("resolves a unique data attribute when the element carries no id", async () => {
    const markup = [
      '<div class="card" data-block="hero">A</div>',
      '<div class="card" data-block="teaser">B</div>',
    ].join("\n");
    const result = await resolve(markup, [
      target("selected", {
        tag: "div",
        classes: ["card"],
        attributes: { "data-block": "teaser" },
      }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      confidence: "heuristic",
      metadata: { evidence: "markup-attributes" },
    });
    expect(snippet(markup, result.matches[0]!)).toBe(
      '<div class="card" data-block="teaser">B</div>',
    );
  });

  it("never matches an attribute value a PHP expression produced", async () => {
    const markup = '<div id="<?php echo $id; ?>" class="card">A</div>';
    const result = await resolve(markup, [
      target("selected", { tag: "div", id: "hero", classes: ["card"] }),
    ]);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      metadata: { evidence: "markup-classes" },
    });
  });

  it("matches a template element the browser gave extra runtime classes", async () => {
    // The template writes the static classes; the browser and PHP add more.
    const markup = '<header class="site-header"><nav class="nav"></nav></header>';
    const result = await resolve(markup, [
      target("selected", {
        tag: "nav",
        classes: ["nav", "nav--sticky", "is-open"],
      }),
    ]);

    expect(result.status).toBe("matched");
    expect(snippet(markup, result.matches[0]!)).toBe(
      '<nav class="nav"></nav>',
    );
  });

  it("matches the literal half of a class attribute PHP also writes into", async () => {
    const markup = '<div class="menu-item <?php echo $state; ?>">Home</div>';
    const result = await resolve(markup, [
      target("selected", { tag: "div", classes: ["menu-item", "current"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches[0]).toMatchObject({
      metadata: { evidence: "markup-classes" },
    });
  });

  it("prefers the most specific template element over a looser ancestor match", async () => {
    const markup = [
      '<div class="card">',
      '  <div class="card media">Inner</div>',
      "</div>",
    ].join("\n");
    const result = await resolve(markup, [
      target("selected", { tag: "div", classes: ["card", "media"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(snippet(markup, result.matches[0]!)).toBe(
      '<div class="card media">Inner</div>',
    );
  });

  it("rejects a template element whose literal class the element never had", async () => {
    const result = await resolve('<div class="card featured">A</div>', [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
  });

  it("rejects a template element whose literal id contradicts the element", async () => {
    const result = await resolve('<div id="other" class="card">A</div>', [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
  });

  it("treats an attribute the browser dropped as neutral, not contradictory", async () => {
    const markup = '<div class="card" data-init="lazy">A</div>';
    const result = await resolve(markup, [
      target("selected", { tag: "div", classes: ["card"] }),
    ]);

    expect(result.status).toBe("matched");
    expect(result.matches[0]).toMatchObject({
      metadata: { evidence: "markup-classes" },
    });
  });

  it("resolves both the selected element and its parent independently", async () => {
    const result = await resolve(TEMPLATE, [
      target("selected", {
        tag: "article",
        id: "hero",
        classes: ["card", "card--wide"],
      }),
      target("parent", { tag: "section", classes: ["page"] }),
    ]);

    expect(result.matches.map((match) => match.targetRole)).toEqual([
      "selected",
      "parent",
    ]);
  });

  it("reports no rule match when the template renders nothing similar", async () => {
    const result = await resolve(TEMPLATE, [
      target("selected", { tag: "span", classes: ["absent"] }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
  });

  it("prefers an instrumented template fact over the markup search", async () => {
    const result = await resolve(
      TEMPLATE,
      [
        {
          ...target("selected", {
            tag: "article",
            id: "hero",
            classes: ["card", "card--wide"],
          }),
          facts: [templateFact("php.template", "templates/page.php", 3, 3, 5, 14)],
        },
      ],
      { status: "exact", uris: ["file:///workspace/templates/page.php"], strategy: "workspace-bound" },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      confidence: "instrumented",
      kind: "template",
      metadata: { evidence: "php.template" },
    });
  });

  it("keeps an instrumented template that resolves elsewhere out of the result", async () => {
    const result = await resolve(
      TEMPLATE,
      [
        {
          ...target("selected", { tag: "span", classes: ["absent"] }),
          facts: [templateFact("php.template", "templates/other.php", 1, 1)],
        },
      ],
      { status: "exact", uris: ["file:///workspace/templates/other.php"], strategy: "workspace-bound" },
    );

    expect(result.status).toBe("source-not-active-document");
    expect(result.matches).toEqual([]);
    expect(result.diagnostics?.map((entry) => entry.code)).toContain(
      "php.sourceNotActiveDocument",
    );
  });

  it("labels a WordPress ACF block without exposing its template path", async () => {
    const result = await resolve(
      TEMPLATE,
      [
        {
          ...target("selected", { tag: "article", id: "hero" }),
          facts: [{
            type: "wordpress.acf-block",
            source: {
              uri: "blocks/hero/render.php",
              line: 3,
              column: 3,
              endLine: 5,
              endColumn: 14,
              metadata: {},
            },
            payload: {
              blockName: "acf/hero",
              template: "blocks/hero/render.php",
            },
            metadata: {},
          }],
        },
      ],
      { status: "exact", uris: ["file:///workspace/templates/page.php"], strategy: "workspace-bound" },
    );

    expect(result.matches[0]?.label).toBe("hero");
    expect(result.matches[0]?.label).not.toContain("/");
  });

  it("stops before the abort deadline without returning partial matches", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new PhpSourcePlugin().resolve({
      selection: selection([target("selected", { tag: "article", id: "hero" })]),
      document: phpDocument(TEMPLATE),
      workspace: workspace(),
      signal: controller.signal,
    });

    expect(result.matches).toEqual([]);
  });

  it("reports no DOM evidence rather than scanning the whole template", async () => {
    const result = await resolve(TEMPLATE, [{
      role: "selected",
      depth: 0,
      subject: { selector: "article", metadata: { tag: "article" } },
      facts: [],
      metadata: {},
    }]);

    expect(result.status).toBe("no-facts");
    expect(result.matches).toEqual([]);
  });
});

describe("parsePhpMarkup", () => {
  it("treats PHP blocks as opaque and never reads markup out of them", () => {
    const parsed = parsePhpMarkup(
      '<?php if ($x) { echo "<div class=\\"ghost\\">"; } ?><p class="real"></p>',
    );

    expect(parsed.elements.map((element) => element.tag)).toEqual(["p"]);
    expect(parsed.elements[0]?.attributes).toEqual([
      { name: "class", literalValue: "real", dynamic: false },
    ]);
  });

  it("marks an attribute PHP contributed to as dynamic", () => {
    const parsed = parsePhpMarkup('<div class="card <?= $extra ?>"></div>');

    expect(parsed.elements[0]?.attributes).toEqual([
      { name: "class", literalValue: "card", dynamic: true },
    ]);
  });

  it("skips script and comment content that looks like markup", () => {
    const parsed = parsePhpMarkup([
      "<!-- <div class=\"commented\"></div> -->",
      '<script>var html = "<span class=\'inline\'></span>";</script>',
      '<b class="real"></b>',
    ].join("\n"));

    expect(parsed.elements.map((element) => element.tag)).toEqual([
      "script",
      "b",
    ]);
  });

  it("closes void and self-closing elements at the opening tag", () => {
    const parsed = parsePhpMarkup('<img src="a.png"><br /><p>text</p>');

    expect(parsed.elements.map((element) =>
      element.endOffset === element.openEndOffset
    )).toEqual([true, true, false]);
  });

  it("leaves an unclosed element bounded by its opening tag", () => {
    const parsed = parsePhpMarkup('<div class="open">');

    expect(parsed.elements[0]?.endOffset).toBe(
      parsed.elements[0]?.openEndOffset,
    );
  });
});

describe("withDomAttributeFacts", () => {
  it("restates the bounded subject identity as built-in dom-attribute facts", () => {
    const [enriched] = withDomAttributeFacts([
      target("selected", {
        tag: "article",
        id: "hero",
        classes: ["card", "card--wide"],
        attributes: { "data-block": "hero" },
      }),
    ]);

    expect(enriched?.facts).toEqual([
      { type: "dom-attribute", name: "id", value: "hero", metadata: {} },
      { type: "dom-attribute", name: "class", value: "card card--wide", metadata: {} },
      { type: "dom-attribute", name: "data-block", value: "hero", metadata: {} },
    ]);
  });

  it("leaves targets without a DOM identity untouched", () => {
    const bare: InspectTarget = {
      role: "selected",
      depth: 0,
      subject: { selector: "div", metadata: {} },
      facts: [],
      metadata: {},
    };

    expect(withDomAttributeFacts([bare])[0]).toBe(bare);
  });
});

/**
 * A faithful reduction of a real WordPress theme header: a conditional slider
 * whose id is literal but whose every other attribute is written by PHP, with
 * a `foreach` emitting the repeated slides inside it.
 */
const THEME_HEADER = [
  "<header>",
  '  <div class="clear"></div>',
  "</header>",
  "",
  "<?php",
  "if ((is_front_page() == true) && (isset($page_options['_slides']) == true))",
  "{",
  "    //print_r($page_options); die;",
  "    ?>",
  '    <div id="home_slider" data-slides-col="<?php echo count($page_options[\'_slides\']); ?>" style="max-width:<?php echo $w; ?>px;">',
  '        <img src="<?php echo $page_options[\'_slides\'][0][\'_slide\'][\'url\']; ?>" class="home_slied_spacer" style="padding-bottom:<?php echo $pb; ?>%;">',
  "        <?php",
  "        foreach ($page_options['_slides'] as $key => $slide)",
  "        {",
  "            ?>",
  '            <div id="home_slide_<?php echo ($key + 1); ?>" data-id="<?php echo ($key + 1); ?>" class="home_slide <?php echo $anim; ?>">',
  '                <div class="home_slide_border"></div>',
  '                <div class="home_slide_title_block <?php echo $slide[\'_options\'][\'_slide_class\']; ?>">',
  "                    <?php",
  "                        $cta = '<a class=\"home_slide_cta_btn btn\"'.$click.' href=\"'.$link.'\">';",
  "                        echo '<div class=\"home_slide_title\">'.$title.'</div>';",
  "                        echo $cta;",
  "                    ?>",
  "                </div>",
  "            </div>",
  "            <?php",
  "        }",
  "        ?>",
  "    </div>",
  "    <?php",
  "}",
  "?>",
].join("\n");

describe("PhpSourcePlugin on a real theme header", () => {
  it("resolves a literal id through PHP-written sibling attributes", async () => {
    const result = await resolve(THEME_HEADER, [
      target("selected", {
        tag: "div",
        id: "home_slider",
        attributes: { "data-slides-col": "4" },
      }),
      target("parent", { tag: "div", classes: ["page_wrap"] }),
    ]);

    expect(result.status).toBe("matched");
    const selected = result.matches.filter(
      (match) => match.targetRole === "selected",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.label).toBe("div#home_slider");
    expect(snippet(THEME_HEADER, selected[0]!)).toContain('id="home_slider"');
    expect(snippet(THEME_HEADER, selected[0]!)).toContain("</div>");
  });

  it("keeps PHP string markup inside a block out of the scan", async () => {
    // `$cta` writes an <a class="home_slide_cta_btn btn"> inside a PHP block.
    // It is not markup this file renders literally, so it must not match.
    const result = await resolve(THEME_HEADER, [
      target("selected", {
        tag: "a",
        classes: ["home_slide_cta_btn", "btn"],
      }),
    ]);

    expect(result.status).toBe("no-rule-match");
    expect(result.matches).toEqual([]);
  });

  it("resolves one loop element even though the browser rendered it four times", async () => {
    const result = await resolve(THEME_HEADER, [
      target("selected", {
        tag: "div",
        id: "home_slide_2",
        classes: ["home_slide", "home_slide_anim", "home_slide_active"],
        attributes: { "data-id": "2" },
      }),
    ]);

    // The id and both attributes are PHP-written, so the literal class token
    // carries the match.
    expect(result.status).toBe("matched");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      metadata: { evidence: "markup-classes" },
    });
  });
});

async function resolve(
  text: string,
  targets: readonly InspectTarget[],
  resolution: SourceUriResolution = {
    status: "not-found",
    uris: [],
    strategy: "workspace-bound",
  },
) {
  return new PhpSourcePlugin().resolve({
    selection: selection(targets),
    document: phpDocument(text),
    workspace: workspace(resolution),
    signal: new AbortController().signal,
  });
}

function selection(targets: readonly InspectTarget[]): SelectionSnapshot {
  return {
    sessionId: "session-a",
    messageId: "inspect-a",
    targets: withDomAttributeFacts(targets),
    ruleEvidence: { rules: [], omittedRuleCount: 0 },
    context: { url: "https://example.test/page", metadata: {} },
    metadata: {},
  };
}

function target(
  role: "selected" | "parent",
  identity: {
    readonly tag: string;
    readonly id?: string;
    readonly classes?: readonly string[];
    readonly attributes?: Readonly<Record<string, string>>;
  },
): InspectTarget {
  const attributes = Object.entries(identity.attributes ?? {}).map(
    ([name, value]) => ({ name, value, metadata: {} }),
  );
  return {
    role,
    depth: role === "selected" ? 0 : 1,
    subject: {
      selector: identity.tag,
      ...(identity.id ? { nodeId: identity.id } : {}),
      ...(attributes.length > 0 ? { attributes } : {}),
      metadata: {
        tag: identity.tag,
        id: identity.id ?? "",
        classes: identity.classes ?? [],
        pageUrl: "https://example.test/page",
      },
    },
    facts: [],
    metadata: {},
  };
}

function templateFact(
  type: string,
  template: string,
  line: number,
  column: number,
  endLine?: number,
  endColumn?: number,
): RuntimeFact {
  return {
    type,
    source: {
      uri: template,
      line,
      column,
      ...(endLine !== undefined && endColumn !== undefined
        ? { endLine, endColumn }
        : {}),
      metadata: {},
    },
    payload: { template },
    metadata: {},
  };
}

function phpDocument(
  text: string,
  uri = "file:///workspace/templates/page.php",
): SourceDocument {
  const lines = text.split("\n");
  return {
    uri,
    languageId: "php",
    version: 1,
    getText: () => text,
    positionAt(offset) {
      const clamped = Math.max(0, Math.min(offset, text.length));
      const before = text.slice(0, clamped).split("\n");
      return {
        line: before.length - 1,
        character: before.at(-1)?.length ?? 0,
      };
    },
    offsetAt(position) {
      const line = Math.max(0, Math.min(position.line, lines.length - 1));
      const before = lines
        .slice(0, line)
        .reduce((total, value) => total + value.length + 1, 0);
      return before + Math.max(
        0,
        Math.min(position.character, lines[line]?.length ?? 0),
      );
    },
  };
}

function workspace(
  resolution: SourceUriResolution = {
    status: "not-found",
    uris: [],
    strategy: "workspace-bound",
  },
): SourceWorkspace {
  return {
    findFiles: async () => [],
    readText: async () => "",
    resolveSourceUri: async () => resolution,
    resolveRelativeUri: (base, reference) => new URL(reference, base).toString(),
    isWorkspaceUri: () => true,
  };
}

function snippets(
  text: string,
  matches: readonly SourceMatch[],
): readonly string[] {
  return matches.map((match) => snippet(text, match));
}

function snippet(text: string, match: SourceMatch): string {
  const document = phpDocument(text);
  return text.slice(
    document.offsetAt(match.range.start),
    document.offsetAt(match.range.end),
  );
}
