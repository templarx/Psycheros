import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { preprocessMediaUrls } from "./markdown-media.ts";

const sanitizerOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    "img",
    "del",
    // Media embeds — used by the chat media-embedder (client + server).
    // We allow these tags so rich previews render; we still strip dangerous
    // attributes (e.g. javascript: on*) via sanitize-html's defaults.
    "iframe",
    "video",
    "audio",
    "source",
    "figure",
    "figcaption",
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: [
      "src", "alt", "title", "width", "height",
      "loading", "referrerpolicy", "decoding",
      "class", "data-original-src", "data-media-embedded",
    ],
    a: ["href", "name", "target", "rel", "class"],
    iframe: [
      "src", "title", "width", "height",
      "allow", "allowfullscreen", "frameborder",
      "loading", "referrerpolicy",
    ],
    video: [
      "src", "controls", "preload", "poster",
      "loop", "muted", "autoplay", "width", "height",
    ],
    audio: ["src", "controls", "preload", "loop", "muted", "autoplay"],
    source: ["src", "type", "media", "sizes"],
    div: ["class", "data-media-embedded", "data-original-src"],
    span: ["class"],
  },
  allowedSchemes: ["http", "https", "data", "mailto"],
  allowedSchemesByTag: {
    img: ["http", "https", "data"],
    video: ["http", "https"],
    audio: ["http", "https"],
    source: ["http", "https"],
    iframe: ["http", "https"],
  },
  allowedIframeHostnames: [
    "www.youtube.com",
    "youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "player.vimeo.com",
    "vimeo.com",
    "open.spotify.com",
    "w.soundcloud.com",
  ],
};

// Configure marked for Deno-compatible settings
marked.setOptions({
  breaks: true, // Preserve line breaks in chat output (e.g. multi-line blockquotes)
  gfm: true, // GitHub Flavored Markdown
});

/**
 * Strip XML tags emitted by the LLM that shouldn't be displayed.
 * Removes <t>timestamp</t> tags entirely, and strips non-HTML XML wrappers.
 */
function stripEntityXml(text: string): string {
  const htmlTags = new Set([
    "a",
    "b",
    "i",
    "u",
    "p",
    "br",
    "hr",
    "em",
    "ol",
    "ul",
    "li",
    "td",
    "th",
    "tr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "pre",
    "code",
    "del",
    "sub",
    "sup",
    "img",
    "div",
    "span",
    "strong",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "blockquote",
    "caption",
    "details",
    "summary",
    "section",
    "article",
    "header",
    "footer",
  ]);
  let result = text;
  // Remove <t>...</t> timestamp tags entirely (tag + content)
  result = result.replace(/<t>[^<]*<\/t>\s*/g, "");
  // Remove other non-HTML XML tags (preserve inner content)
  result = result.replace(/<\/?([a-z_][a-z0-9_-]*)\b[^>]*>/gi, (match, tag) => {
    return htmlTags.has(tag.toLowerCase()) ? match : "";
  });
  // Collapse excessive whitespace left by removals
  result = result.replace(/[ \t]{3,}/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  return result;
}

/**
 * Parse markdown to sanitized HTML.
 * Strips LLM XML artifacts first, then sanitizes to prevent XSS.
 *
 * @param text - Raw markdown text
 * @returns Sanitized HTML string
 */
export function renderMarkdown(text: string): string {
  if (!text) return "";
  const cleaned = stripEntityXml(text);
  if (!cleaned.trim()) return "";
  // Convert bare media URLs (image / video / YouTube / Vimeo) into embed
  // HTML or markdown image syntax before parsing. Runs client-side too via
  // web/js/media-embed.js — both paths must agree on output.
  const preprocessed = preprocessMediaUrls(cleaned);
  const html = marked.parse(preprocessed) as string;
  return sanitizeHtml(html, sanitizerOptions);
}
