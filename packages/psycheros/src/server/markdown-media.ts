/**
 * Server-side media URL preprocessor.
 *
 * Runs BEFORE marked.parse() on assistant / user markdown content so that
 * bare media URLs (LLMs often output plain URLs in prose) get converted to
 * the proper media element. Mirrors the client-side `media-embed.js` logic.
 *
 * Why server-side too?
 *   - Page reloads (history view) render server HTML directly.
 *   - SSR is the canonical content; client only enhances after the fact.
 *
 * Transformations (applied in order):
 *   - YouTube watch / share / shorts / embed URLs  → <div class="chat-media chat-media-youtube"><iframe …></div>
 *   - Vimeo URLs                                   → <div class="chat-media chat-media-vimeo"><iframe …></div>
 *   - Bare .mp4 / .webm / .ogg / .mov / .m4v URLs  → <video src="…" controls preload="metadata"></video>
 *   - Bare .mp3 / .wav / .ogg / .flac / .m4a URLs  → <audio src="…" controls preload="metadata"></audio>
 *   - Bare image URLs (jpg/png/gif/webp/svg/bmp/avif, plus known image hosts)
 *                                                   → ![alt](url)
 *
 * URL detection matches the client-side rules in web/js/media-embed.js.
 */

const IMAGE_EXT =
  /\.(jpe?g|png|gif|webp|svg|svgz|bmp|avif|heic|heif|tiff?|ico)(?:\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv)(?:\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)(?:\?|#|$)/i;
const YT_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const VIMEO_RE =
  /(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d+)/;
const IMAGE_DOMAINS =
  /(?:^|\.)(imgur\.com|i\.imgur\.com|gyazo\.com|i\.redd\.it|preview\.redd\.it|wikimedia\.org|wikipedia\.org|githubusercontent\.com|cloudfront\.net|cdn\.|images\.|pbs\.twimg\.com|media\.tenor\.com|giphy\.com|media\d*\.giphy\.com|pinimg\.com|unsplash\.com|pexels\.com)$/i;

function isAbsoluteHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test((href || "").trim());
}

function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isImageUrl(href: string): boolean {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  if (IMAGE_EXT.test(path)) return true;
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (IMAGE_DOMAINS.test(host)) return true;
  } catch { /* ignore */ }
  return false;
}

function isVideoUrl(href: string): boolean {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  return VIDEO_EXT.test(path);
}

function isAudioUrl(href: string): boolean {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  return AUDIO_EXT.test(path);
}

function youtubeId(href: string): string | null {
  if (!isAbsoluteHttpUrl(href)) return null;
  const m = href.match(YT_RE);
  return m ? m[1] : null;
}

function vimeoId(href: string): string | null {
  if (!isAbsoluteHttpUrl(href)) return null;
  const m = href.match(VIMEO_RE);
  return m ? m[1] : null;
}

/**
 * Build the embed HTML for a YouTube URL.
 */
function youTubeEmbed(id: string, originalHref: string): string {
  const src =
    "https://www.youtube-nocookie.com/embed/" +
    encodeURIComponent(id) +
    "?rel=0&modestbranding=1";
  return (
    `<div class="chat-media chat-media-youtube" data-media-embedded="1" data-original-src="${escapeAttr(originalHref)}">` +
    `<iframe src="${escapeAttr(src)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen frameborder="0" title="YouTube video" loading="lazy"></iframe>` +
    `</div>`
  );
}

function vimeoEmbed(id: string, originalHref: string): string {
  const src = "https://player.vimeo.com/video/" + encodeURIComponent(id);
  return (
    `<div class="chat-media chat-media-vimeo" data-media-embedded="1" data-original-src="${escapeAttr(originalHref)}">` +
    `<iframe src="${escapeAttr(src)}" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen frameborder="0" title="Vimeo video" loading="lazy"></iframe>` +
    `</div>`
  );
}

function videoEmbed(href: string): string {
  return (
    `<div class="chat-media chat-media-video" data-media-embedded="1" data-original-src="${escapeAttr(href)}">` +
    `<video src="${escapeAttr(href)}" controls preload="metadata" referrerpolicy="no-referrer"></video>` +
    `<div class="chat-media-caption"><a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a></div>` +
    `</div>`
  );
}

function audioEmbed(href: string): string {
  return (
    `<div class="chat-media chat-media-audio" data-media-embedded="1" data-original-src="${escapeAttr(href)}">` +
    `<audio src="${escapeAttr(href)}" controls preload="metadata"></audio>` +
    `<div class="chat-media-caption"><a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a></div>` +
    `</div>`
  );
}

/**
 * Process a single URL match into either an embed HTML block or a markdown
 * image shortcut `![alt](url)`. Markdown image is preferred for image URLs
 * because marked will turn it into a proper `<img>` with alt text.
 */
function urlToEmbed(href: string): string {
  const ytId = youtubeId(href);
  if (ytId) return youTubeEmbed(ytId, href);
  const vimeoMatch = vimeoId(href);
  if (vimeoMatch) return vimeoEmbed(vimeoMatch, href);
  if (isVideoUrl(href)) return videoEmbed(href);
  if (isAudioUrl(href)) return audioEmbed(href);
  if (isImageUrl(href)) return `![image](${href})`;
  return ""; // not a media URL — leave it alone
}

/**
 * Scan markdown text for bare media URLs that aren't already inside markdown
 * link / image syntax, and replace them with the appropriate embed.
 *
 * "Bare" means: surrounded by whitespace / start / end / punctuation, NOT
 * preceded by `(`, `[`, `"`, or `<' — those mean it's already part of
 * markdown / HTML syntax and we should leave it.
 */
export function preprocessMediaUrls(markdown: string): string {
  if (!markdown) return markdown;

  // We look for http(s) URLs and process each match.
  // Use a manual scan rather than a single regex so we can inspect the
  // surrounding context.
  const out: string[] = [];
  let i = 0;
  const len = markdown.length;

  while (i < len) {
    const ch = markdown[i];
    // Find start of an http(s):// URL
    if (
      ch === "h" &&
      (markdown.startsWith("http://", i) || markdown.startsWith("https://", i))
    ) {
      // Find the URL end (whitespace, newline, or closing punctuation)
      let j = i;
      while (
        j < len &&
        !/[\s<>"\)\]\}]/.test(markdown[j])
      ) {
        j++;
      }
      // Strip trailing punctuation that's part of prose, not the URL
      let end = j;
      while (
        end > i &&
        /[.,;:!?)\]}>]/.test(markdown[end - 1])
      ) {
        end--;
      }
      const href = markdown.slice(i, end);

      // Check what comes BEFORE — skip if part of markdown link/image/HTML attr
      const before = markdown.slice(0, i);
      const lastChar = before.length > 0 ? before[before.length - 1] : "";
      const isInsideSyntax = lastChar === "(" || lastChar === "[" ||
        lastChar === '"' || lastChar === "<" || lastChar === "=";

      if (isInsideSyntax) {
        // Already part of markdown / HTML — leave it
        out.push(markdown.slice(i, j));
      } else {
        const embed = urlToEmbed(href);
        if (embed) {
          // Replace the URL with embed, keep trailing punctuation
          out.push(embed);
          out.push(markdown.slice(end, j));
        } else {
          // Not a media URL — keep as-is
          out.push(markdown.slice(i, j));
        }
      }

      i = j;
    } else {
      out.push(ch);
      i++;
    }
  }

  return out.join("");
}
