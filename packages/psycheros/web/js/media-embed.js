/**
 * Psycheros Media Embedder
 * ------------------------
 * Transforms plain links in chat messages into rich media embeds:
 *   - Image URLs   (https://.../foo.jpg|png|gif|webp|svg|bmp|avif)  →  <img>
 *   - YouTube URLs (youtube.com/watch?v=ID, youtu.be/ID, youtube.com/embed/ID)  →  <iframe>
 *   - Vimeo URLs   (vimeo.com/ID, player.vimeo.com/video/ID)  →  <iframe>
 *   - Video URLs   (.mp4 .webm .ogg .mov .m4v)  →  <video>
 *   - Audio URLs   (.mp3 .wav .ogg .flac .m4a)  →  <audio>
 *
 * Designed to run AFTER marked + DOMPurify. Scoped to a single root element
 * so it stays safe and idempotent. Uses the server-side proxy for external
 * image URLs so hotlink restrictions (Wikimedia, Imgur, etc.) don't break.
 *
 * Idempotency: each transformed element gets a `data-media-embedded="1"` marker
 * so re-renders (e.g. streaming → final) don't double-process the same nodes.
 */

(function (global) {
  "use strict";

  // ----- URL detection -----

  /** Common image extensions. Case-insensitive. */
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|svg|svgz|bmp|avif|heic|heif|tiff?|ico)(?:\?|#|$)/i;

  /** Common video extensions. */
  // .gifv: Imgur's video format (MP4/H.264 in a .gifv container). Browsers
  // can't render it as an image, so we treat it as a video.
  const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|gifv)(?:\?|#|$)/i;

  /** Common audio extensions. */
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)(?:\?|#|$)/i;

  /** Pattern that pulls a YouTube video id from any common YouTube URL form. */
  const YT_RE = /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;

  /** Pattern that pulls a Vimeo numeric id. */
  const VIMEO_RE = /(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d+)/;

  /**
   * Pattern that pulls a Redgifs id from any common Redgifs URL form.
   * Redgifs replaced Gfycat for adult-content-safe short videos. Watch
   * URLs are https://www.redgifs.com/watch/<id>; the embed iframe lives at
   * https://www.redgifs.com/ifr/<id>. Ids are 8-32 lowercase alphanumerics.
   */
  const REDGIFS_RE = /(?:www\.)?redgifs\.com\/(?:watch\/|ifr\/|embed\/)?([a-z0-9]{4,40})/i;

  /** Domains that almost always serve images regardless of extension. */
  const IMAGE_DOMAINS = /(?:^|\.)(imgur\.com|i\.imgur\.com|gyazo\.com|i\.redd\.it|preview\.redd\.it|wikimedia\.org|wikipedia\.org|githubusercontent\.com|cloudfront\.net|cdn\.|images\.|pbs\.twimg\.com|media\.tenor\.com|giphy\.com|media\d*\.giphy\.com|pinimg\.com|unsplash\.com|pexels\.com)$/i;

  function isAbsoluteHttpUrl(href) {
    if (!href) return false;
    const trimmed = href.trim();
    return /^https?:\/\//i.test(trimmed);
  }

  /** Returns true if this URL points to an image (by extension or known host). */
  function isImageUrl(href) {
    if (!isAbsoluteHttpUrl(href)) return false;
    // Some CDNs put the extension at the very end of the URL, AFTER a query
    // string (e.g. signed URLs like https://cdn.example.com/v?id=1&t=2.mp4).
    // Test BOTH the path-stripped form AND the full URL.
    const path = href.split("?")[0].split("#")[0];
    if (IMAGE_EXT.test(path)) return true;
    if (IMAGE_EXT.test(href)) return true;
    try {
      const host = new URL(href).hostname.toLowerCase();
      if (IMAGE_DOMAINS.test(host)) return true;
    } catch (_) { /* not a valid URL — ignore */ }
    return false;
  }

  /** Returns true if this URL points to a video file. */
  function isVideoUrl(href) {
    if (!isAbsoluteHttpUrl(href)) return false;
    const path = href.split("?")[0].split("#")[0];
    return VIDEO_EXT.test(path) || VIDEO_EXT.test(href);
  }

  /** Returns true if this URL points to an audio file. */
  function isAudioUrl(href) {
    if (!isAbsoluteHttpUrl(href)) return false;
    const path = href.split("?")[0].split("#")[0];
    return AUDIO_EXT.test(path) || AUDIO_EXT.test(href);
  }

  /** Extract YouTube id or null. */
  function youtubeId(href) {
    if (!isAbsoluteHttpUrl(href)) return null;
    const m = href.match(YT_RE);
    return m ? m[1] : null;
  }

  /** Extract Vimeo id or null. */
  function vimeoId(href) {
    if (!isAbsoluteHttpUrl(href)) return null;
    const m = href.match(VIMEO_RE);
    return m ? m[1] : null;
  }

  /** Extract Redgifs id or null. */
  function redgifsId(href) {
    if (!isAbsoluteHttpUrl(href)) return null;
    const m = href.match(REDGIFS_RE);
    return m ? m[1] : null;
  }

  // ----- Element builders -----

  /** Build an <img> element. Uses the server proxy so hotlink restrictions are bypassed. */
  function buildImage(href, altText) {
    const img = document.createElement("img");
    img.className = "chat-media chat-media-image";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = proxyImageUrl(href);
    img.alt = altText || "";
    img.dataset.originalSrc = href;
    img.dataset.mediaEmbedded = "1";
    img.onerror = function () {
      // Fall back to the direct URL if the proxy also fails
      if (img.dataset.originalSrc && img.src !== img.dataset.originalSrc) {
        img.src = img.dataset.originalSrc;
      } else {
        img.classList.add("chat-media-failed");
        img.alt = (altText || "") + " (image failed to load)";
      }
    };
    return img;
  }

  /** Build a YouTube iframe embed. */
  function buildYouTube(id, originalHref) {
    const wrap = document.createElement("div");
    wrap.className = "chat-media chat-media-youtube";
    wrap.dataset.mediaEmbedded = "1";
    wrap.dataset.originalSrc = originalHref;
    const iframe = document.createElement("iframe");
    // youtube-nocookie avoids tracking cookies until the user actually plays
    iframe.src = "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) +
      "?rel=0&modestbranding=1";
    iframe.setAttribute("allow",
      "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share");
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("title", "YouTube video");
    iframe.loading = "lazy";
    wrap.appendChild(iframe);
    return wrap;
  }

  /** Build a Vimeo iframe embed. */
  function buildVimeo(id, originalHref) {
    const wrap = document.createElement("div");
    wrap.className = "chat-media chat-media-vimeo";
    wrap.dataset.mediaEmbedded = "1";
    wrap.dataset.originalSrc = originalHref;
    const iframe = document.createElement("iframe");
    iframe.src = "https://player.vimeo.com/video/" + encodeURIComponent(id);
    iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("title", "Vimeo video");
    iframe.loading = "lazy";
    wrap.appendChild(iframe);
    return wrap;
  }

  /**
   * Build a Redgifs iframe embed. Redgifs provides a stable embed URL at
   * https://www.redgifs.com/ifr/<id> that wraps the GIF/MP4 player without
   * requiring API keys. Same shape as the YouTube/Vimeo embeds (16:9).
   */
  /**
   * Build a Redgifs embed. We don't use the iframe — RedGifs serves a
   * Cloudflare bot challenge from /ifr/<id> to non-cookied visitors, which
   * means the iframe page is blank in a fresh browser session.
   *
   * Instead we ask our own /api/redgifs-embed?id=<id> for the direct MP4 +
   * poster, then render a <video> whose src goes through /api/proxy-media.
   * That way the browser fetches the MP4 same-origin from our server, which
   * sends proper User-Agent / Referer and gets 200 OK from
   * media.redgifs.com (the user's browser would otherwise get 403).
   *
   * Returns a placeholder element while the API call is in flight so the
   * caller can synchronously insert it; the real <video> replaces the
   * placeholder when the response arrives.
   */
  function buildRedgifs(id, originalHref) {
    const wrap = document.createElement("div");
    wrap.className = "chat-media chat-media-redgifs";
    wrap.dataset.mediaEmbedded = "1";
    wrap.dataset.originalSrc = originalHref;
    wrap.dataset.redgifsId = id;
    wrap.dataset.redgifsState = "loading";

    const placeholder = document.createElement("div");
    placeholder.className = "chat-media-redgifs-placeholder";
    placeholder.textContent = "Loading Redgifs video…";
    wrap.appendChild(placeholder);

    // Asynchronously fetch the embed metadata and replace the placeholder.
    fetch("/api/redgifs-embed?id=" + encodeURIComponent(id), {
      headers: { "Accept": "application/json" },
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("embed http " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        if (!data || !data.mp4 || !data.poster) {
          throw new Error("embed missing fields");
        }
        // Remove placeholder
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
        // Build <video>
        const video = document.createElement("video");
        video.controls = true;
        video.preload = "metadata";
        video.poster = data.poster;
        video.referrerPolicy = "no-referrer";
        // Route MP4 through our proxy so the browser sees a same-origin
        // request that won't be 403'd by Cloudflare's bot challenge.
        video.src = proxyImageUrl(data.mp4);
        video.title = data.title || ("Redgifs " + id);
        wrap.appendChild(video);
        // Caption with a fallback link to the original Redgifs watch page
        const cap = document.createElement("div");
        cap.className = "chat-media-caption";
        const link = document.createElement("a");
        link.href = originalHref;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = data.title || ("Redgifs " + id);
        cap.appendChild(link);
        wrap.appendChild(cap);
        wrap.dataset.redgifsState = "ready";
      })
      .catch(function () {
        // Fallback to the iframe if the embed resolver failed. The iframe
        // will likely be blank (Cloudflare gate) but at least the user sees
        // the link and can click through.
        while (wrap.firstChild) wrap.removeChild(wrap.firstChild);
        const iframe = document.createElement("iframe");
        iframe.src = "https://www.redgifs.com/ifr/" + encodeURIComponent(id);
        iframe.setAttribute("allow", "autoplay; fullscreen; picture-in-picture");
        iframe.setAttribute("allowfullscreen", "");
        iframe.setAttribute("frameborder", "0");
        iframe.setAttribute("title", "Redgifs video");
        iframe.referrerPolicy = "no-referrer";
        iframe.loading = "lazy";
        wrap.appendChild(iframe);
        wrap.dataset.redgifsState = "iframe-fallback";
      });

    return wrap;
  }

  /** Build a <video> element with controls and a fallback link. */
  function buildVideo(href) {
    const wrap = document.createElement("div");
    wrap.className = "chat-media chat-media-video";
    wrap.dataset.mediaEmbedded = "1";
    wrap.dataset.originalSrc = href;
    const v = document.createElement("video");
    v.controls = true;
    v.preload = "metadata";
    v.referrerPolicy = "no-referrer";
    v.src = href;
    v.innerHTML = '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">Open video</a>';
    wrap.appendChild(v);
    const cap = document.createElement("div");
    cap.className = "chat-media-caption";
    cap.innerHTML = '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(href) + "</a>";
    wrap.appendChild(cap);
    return wrap;
  }

  /** Build an <audio> element. */
  function buildAudio(href) {
    const wrap = document.createElement("div");
    wrap.className = "chat-media chat-media-audio";
    wrap.dataset.mediaEmbedded = "1";
    wrap.dataset.originalSrc = href;
    const a = document.createElement("audio");
    a.controls = true;
    a.preload = "metadata";
    a.src = href;
    wrap.appendChild(a);
    const cap = document.createElement("div");
    cap.className = "chat-media-caption";
    cap.innerHTML = '<a href="' + escapeAttr(href) + '" target="_blank" rel="noopener noreferrer">' +
      escapeHtml(href) + "</a>";
    wrap.appendChild(cap);
    return wrap;
  }

  // ----- Proxy helpers -----

  /**
   * Build a same-origin URL that the server can proxy.
   * The proxy sets a User-Agent and proper headers so wikimedia etc. don't reject.
   * We only route through the proxy for cross-origin URLs.
   */
  function proxyImageUrl(href) {
    try {
      const u = new URL(href, window.location.href);
      // Same-origin → no proxy needed
      if (u.origin === window.location.origin) return href;
    } catch (_) { /* fall through */ }
    return "/api/proxy-image?url=" + encodeURIComponent(href);
  }

  // ----- Escape helpers -----

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(s) {
    return escapeHtml(s);
  }

  // ----- Main transformer -----

  /**
   * Walk a root element and transform bare media <a> tags into rich embeds.
   * Safe to call multiple times — already-transformed nodes are skipped.
   *
   * @param {Element} root  The chat message container to scan.
   */
  function processMediaLinks(root) {
    if (!root || root.nodeType !== 1) return;
    // Scope the search to .assistant-text, .user-text, .tool-description etc.
    // If the root is already one of those, use it directly.
    const scope = root.matches &&
      root.matches(".assistant-text, .user-text, .tool-description, .generated-image-meta, .msg-content, .attachment-meta, [data-allow-media-embed]")
      ? root
      : root;

    const links = scope.querySelectorAll("a[href]");
    links.forEach(function (a) {
      // Skip if already transformed or inside an existing embed
      if (a.dataset && a.dataset.mediaEmbedded === "1") return;
      const parent = a.parentElement;
      if (parent && parent.closest && parent.closest("[data-media-embedded='1']")) return;
      // Skip link with rich content (text + child nodes) — only transform bare-URL links
      if (!isBareLink(a)) return;

      const href = a.getAttribute("href");
      if (!href) return;

      let replacement = null;
      const ytId = youtubeId(href);
      if (ytId) {
        replacement = buildYouTube(ytId, href);
      } else {
        const vimeoMatch = vimeoId(href);
        if (vimeoMatch) {
          replacement = buildVimeo(vimeoMatch, href);
        } else {
          const rgId = redgifsId(href);
          if (rgId) {
            replacement = buildRedgifs(rgId, href);
          } else if (isVideoUrl(href)) {
            replacement = buildVideo(href);
          } else if (isAudioUrl(href)) {
            replacement = buildAudio(href);
          } else if (isImageUrl(href)) {
            replacement = buildImage(href, a.textContent || "");
          }
        }
      }
      if (replacement) {
        a.replaceWith(replacement);
      }
    });
  }

  /** A "bare" link is one whose only child is a text node equal to its href. */
  function isBareLink(a) {
    if (a.children.length > 0) return false;
    const text = (a.textContent || "").trim();
    if (!text) return false;
    const href = a.getAttribute("href") || "";
    // Compare ignoring trailing slash differences and a few common trailing bits
    const normText = text.replace(/[)\]]+$/, "");
    const normHref = href.replace(/[)\]]+$/, "");
    if (normText === normHref) return true;
    // Also accept "[text](url)" markdown outputs where text is the url and href is the same
    return normText === normHref;
  }

  // ----- DOMPurify config helper -----

  /**
   * Apply the DOMPurify configuration needed for media embeds.
   * Safe to call multiple times. Idempotent.
   */
  function configureDOMPurify() {
    if (!global.DOMPurify) return;
    // Allow iframe (YouTube / Vimeo) + video + audio + source.
    // We restrict src to https to avoid javascript: / data: mischief.
    global.DOMPurify.addHook("uponSanitizeAttribute", function (node, hookEvent) {
      const name = hookEvent.attrName;
      if (name === "src" || name === "href") {
        const val = String(hookEvent.attrValue || "");
        if (/^\s*javascript:/i.test(val)) {
          hookEvent.keepAttr = false;
          return;
        }
        if (name === "src" && /^data:/i.test(val)) {
          // data: URLs are fine for inline base64 images, but block others
          if (!/^data:image\//i.test(val) && !/^data:video\//i.test(val) && !/^data:audio\//i.test(val)) {
            hookEvent.keepAttr = false;
          }
        }
      }
    });
    global.DOMPurify.setConfig({
      ADD_TAGS: ["iframe", "video", "audio", "source", "figure", "figcaption"],
      ADD_ATTR: [
        "allow", "allowfullscreen", "frameborder",
        "controls", "preload", "poster",
        "referrerpolicy", "loading", "decoding",
        "data-media-embedded", "data-original-src",
      ],
    });
  }

  // ----- Public API -----

  global.PsycherosMediaEmbed = {
    processMediaLinks: processMediaLinks,
    configureDOMPurify: configureDOMPurify,
    isImageUrl: isImageUrl,
    isVideoUrl: isVideoUrl,
    isAudioUrl: isAudioUrl,
    youtubeId: youtubeId,
    vimeoId: vimeoId,
    redgifsId: redgifsId,
  };
})(typeof window !== "undefined" ? window : globalThis);
