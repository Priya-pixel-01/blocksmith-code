import type { UeField } from "../schemas/block-spec.js";

export const PLACEHOLDER_IMAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#c9cfda"/><text x="200" y="155" font-family="sans-serif" font-size="20" fill="#5b6270" text-anchor="middle">Image</text></svg>';

function placeholderForField(field: UeField, placeholderImagePath: string): string {
  switch (field.component) {
    case "richtext":
      return `<p>Sample ${escapeHtml(field.label)} text with <strong>emphasis</strong>.</p>`;
    case "reference":
      // A real served path, not a data: URI — aem.js's createOptimizedPicture() does URL/origin
      // math on the image src (for its responsive srcset) that only makes sense for a normal
      // http(s) URL; a data: URI has an opaque origin and breaks that math in ways that don't
      // reflect how the block behaves with real authored content.
      return `<picture><img src="${placeholderImagePath}" alt="${escapeHtml(field.label)}"></picture>`;
    case "boolean":
      return "true";
    case "number":
      return "42";
    case "select":
      return escapeHtml(field.options?.[0]?.value ?? field.label);
    case "container":
      return "<div></div>";
    case "text":
    default:
      return `Sample ${escapeHtml(field.label)}`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Builds the pre-decoration authoring DOM for a block — the nested-div shape EDS document/UE
 * authoring produces before decorate() runs, so the render harness exercises the block's real
 * DOM transformation rather than something already shaped the way the block expects. One row
 * with one cell per UE field; blocks with a repeating item pattern (e.g. cards' "card" items)
 * are approximated as a single instance rather than a full repeated list — good enough to verify
 * the transformation and styling, not a substitute for authoring multiple real items.
 */
export function buildAuthoringDom(blockName: string, fields: UeField[], placeholderImagePath: string): string {
  const cells =
    fields.length > 0 ? fields.map((f) => `<div>${placeholderForField(f, placeholderImagePath)}</div>`).join("\n      ") : "<div>Sample content</div>";

  return `<main>
  <div>
    <div class="${blockName}">
      <div>
      ${cells}
      </div>
    </div>
  </div>
</main>`;
}

/**
 * A minimal but real EDS page shell: `<header>`/`<footer>` are present (empty) because aem.js's
 * loadHeader()/loadFooter() call `.append()` on them unconditionally and crash on null — and
 * `scripts/scripts.js` is loaded as a real `<script type="module">`, exactly like a production
 * page, because that's what actually decorates the block: the earlier design imported the block
 * module directly and called decorate() by hand, but that module transitively imports
 * scripts.js, whose *own* top-level code unconditionally calls loadPage() as an import side
 * effect — so the framework was already auto-decorating (and mis-decorating, given the missing
 * header/footer) in the background regardless. Letting the real pipeline own decoration end to
 * end — including its own CSS loading and block-status lifecycle — avoids that double-decoration
 * race entirely and is more faithful to production than fighting it.
 */
export function buildPageHtml(blockName: string, authoringHtml: string, globalStyleHrefs: string[]): string {
  const links = globalStyleHrefs.map((href) => `<link rel="stylesheet" href="${href}">`).join("\n  ");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Blocksmith render: ${escapeHtml(blockName)}</title>
  ${links}
  <script type="module" src="/scripts/scripts.js"></script>
</head>
<body>
<header></header>
${authoringHtml}
<footer></footer>
</body>
</html>`;
}
