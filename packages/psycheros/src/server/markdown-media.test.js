// Functional smoke test for the server-side markdown-media preprocessor.
// Re-implements the TypeScript logic in plain JS so we can run it in Node.

const IMAGE_EXT =
  /\.(jpe?g|png|gif|webp|svg|svgz|bmp|avif|heic|heif|tiff?|ico)(?:\?|#|$)/i;
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v|mkv|gifv)(?:\?|#|$)/i;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|flac|m4a|aac|opus)(?:\?|#|$)/i;
const YT_RE =
  /(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|v\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const VIMEO_RE =
  /(?:vimeo\.com\/(?:video\/)?|player\.vimeo\.com\/video\/)(\d+)/;
const REDGIFS_RE =
  /(?:www\.)?redgifs\.com\/(?:watch\/|ifr\/|embed\/)?([a-z0-9]{4,40})/i;
const IMAGE_DOMAINS =
  /(?:^|\.)(imgur\.com|i\.imgur\.com|gyazo\.com|i\.redd\.it|preview\.redd\.it|wikimedia\.org|wikipedia\.org|githubusercontent\.com|cloudfront\.net|cdn\.|images\.|pbs\.twimg\.com|media\.tenor\.com|giphy\.com|media\d*\.giphy\.com|pinimg\.com|unsplash\.com|pexels\.com)$/i;

function isAbsoluteHttpUrl(h) { return /^https?:\/\//i.test((h || "").trim()); }

function isImageUrl(href) {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  if (IMAGE_EXT.test(path)) return true;
  if (IMAGE_EXT.test(href)) return true;
  try {
    const host = new URL(href).hostname.toLowerCase();
    if (IMAGE_DOMAINS.test(host)) return true;
  } catch {}
  return false;
}
function isVideoUrl(href) {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  return VIDEO_EXT.test(path) || VIDEO_EXT.test(href);
}
function isAudioUrl(href) {
  if (!isAbsoluteHttpUrl(href)) return false;
  const path = href.split("?")[0].split("#")[0];
  return AUDIO_EXT.test(path) || AUDIO_EXT.test(href);
}
function youtubeId(href) {
  if (!isAbsoluteHttpUrl(href)) return null;
  const m = href.match(YT_RE); return m ? m[1] : null;
}
function vimeoId(href) {
  if (!isAbsoluteHttpUrl(href)) return null;
  const m = href.match(VIMEO_RE); return m ? m[1] : null;
}
function redgifsId(href) {
  if (!isAbsoluteHttpUrl(href)) return null;
  const m = href.match(REDGIFS_RE); return m ? m[1] : null;
}

function urlToEmbed(href) {
  const yid = youtubeId(href);
  if (yid) return `<div class="chat-media chat-media-youtube" data-original-src="${href}"><iframe src="https://www.youtube-nocookie.com/embed/${yid}"></iframe></div>`;
  const vid = vimeoId(href);
  if (vid) return `<div class="chat-media chat-media-vimeo" data-original-src="${href}"><iframe src="https://player.vimeo.com/video/${vid}"></iframe></div>`;
  const rgid = redgifsId(href);
  if (rgid) return `<div class="chat-media chat-media-redgifs" data-original-src="${href}"><iframe src="https://www.redgifs.com/ifr/${rgid}"></iframe></div>`;
  if (isVideoUrl(href)) return `<div class="chat-media chat-media-video" data-original-src="${href}"><video src="${href}" controls></video></div>`;
  if (isAudioUrl(href)) return `<div class="chat-media chat-media-audio" data-original-src="${href}"><audio src="${href}" controls></audio></div>`;
  if (isImageUrl(href)) return `![image](${href})`;
  return "";
}

function preprocessMediaUrls(markdown) {
  if (!markdown) return markdown;
  const out = [];
  let i = 0;
  const len = markdown.length;
  while (i < len) {
    const ch = markdown[i];
    if (
      ch === "h" &&
      (markdown.startsWith("http://", i) || markdown.startsWith("https://", i))
    ) {
      let j = i;
      while (j < len && !/[\s<>"\)\]\}]/.test(markdown[j])) j++;
      let end = j;
      while (end > i && /[.,;:!?)\]}>]/.test(markdown[end - 1])) end--;
      const href = markdown.slice(i, end);
      const before = markdown.slice(0, i);
      const lastChar = before.length > 0 ? before[before.length - 1] : "";
      const isInsideSyntax =
        lastChar === "(" || lastChar === "[" || lastChar === '"' ||
        lastChar === "<" || lastChar === "=";
      if (isInsideSyntax) {
        out.push(markdown.slice(i, j));
      } else {
        const embed = urlToEmbed(href);
        if (embed) {
          out.push(embed);
          out.push(markdown.slice(end, j));
        } else {
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

let pass = 0, fail = 0;
function check(label, actual, predicate) {
  const ok = typeof predicate === 'function' ? predicate(actual) : actual === predicate;
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}\n       got: ${JSON.stringify(actual)}`); }
}
function contains(label, haystack, needle) {
  check(label, haystack, (s) => typeof s === 'string' && s.includes(needle));
}
function notContains(label, haystack, needle) {
  check(label, haystack, (s) => typeof s === 'string' && !s.includes(needle));
}

console.log('-- Server-side preprocessMediaUrls --');

// Plain prose with image URL
const t1 = 'Here is a cat: https://example.com/cat.jpg';
const r1 = preprocessMediaUrls(t1);
contains('image url becomes markdown img', r1, '![image](https://example.com/cat.jpg)');
check('image url is wrapped (not bare)', r1, (s) => /!\[image\]\(https:\/\/example\.com\/cat\.jpg\)/.test(s));

// Trailing punctuation preserved
const t2 = 'See https://example.com/cat.jpg.';
const r2 = preprocessMediaUrls(t2);
contains('trailing period kept', r2, '![image](https://example.com/cat.jpg).');

// YouTube
const t3 = 'Watch https://www.youtube.com/watch?v=dQw4w9WgXcQ now';
const r3 = preprocessMediaUrls(t3);
contains('youtube → iframe', r3, 'chat-media-youtube');
contains('youtube embed src', r3, 'youtube-nocookie.com/embed/dQw4w9WgXcQ');

// Vimeo
const t4 = 'Look https://vimeo.com/123456789';
const r4 = preprocessMediaUrls(t4);
contains('vimeo → iframe', r4, 'chat-media-vimeo');
contains('vimeo embed src', r4, 'player.vimeo.com/video/123456789');

// Redgifs
const t4b = 'Check this https://www.redgifs.com/watch/instructiveradianttamarin lol';
const r4b = preprocessMediaUrls(t4b);
contains('redgifs → iframe', r4b, 'chat-media-redgifs');
contains('redgifs embed src', r4b, 'redgifs.com/ifr/instructiveradianttamarin');

// Video file
const t5 = 'Demo: https://example.com/clip.mp4';
const r5 = preprocessMediaUrls(t5);
contains('video file → <video>', r5, '<video src="https://example.com/clip.mp4"');
contains('video class', r5, 'chat-media-video');

// Imgur .gifv → <video> (not <img>; browsers can't render .gifv)
const t5b = 'Look https://i.imgur.com/abc.gifv now';
const r5b = preprocessMediaUrls(t5b);
contains('imgur .gifv → video', r5b, 'chat-media-video');
notContains('imgur .gifv not img', r5b, 'chat-media-image');

// MP4 after query string (signed CDN URL)
const t5c = 'Watch https://cdn.example.com/v?id=1&t=2.mp4 here';
const r5c = preprocessMediaUrls(t5c);
contains('mp4 after query → video', r5c, 'chat-media-video');
notContains('mp4 after query not other', r5c, '![image]');

// Audio file
const t6 = 'Listen: https://example.com/song.mp3';
const r6 = preprocessMediaUrls(t6);
contains('audio file → <audio>', r6, '<audio src="https://example.com/song.mp3"');
contains('audio class', r6, 'chat-media-audio');

// Markdown image syntax — should NOT be transformed (marked handles it)
const t7 = '![alt](https://example.com/cat.jpg)';
const r7 = preprocessMediaUrls(t7);
notContains('md img syntax untouched', r7, 'chat-media-image');

// Markdown link — URL kept as link destination
const t8 = '[click here](https://example.com/cat.jpg)';
const r8 = preprocessMediaUrls(t8);
notContains('md link destination untouched', r8, 'chat-media');

// Multiple URLs in same text
const t9 = 'Image https://example.com/a.png then video https://example.com/b.mp4 done';
const r9 = preprocessMediaUrls(t9);
contains('multiple: img', r9, '![image](https://example.com/a.png)');
contains('multiple: video', r9, 'chat-media-video');

// Non-media URL — left alone
const t10 = 'Visit https://example.com/page for info';
const r10 = preprocessMediaUrls(t10);
notContains('non-media left alone', r10, 'chat-media');
notContains('non-media markdown image', r10, '![');

console.log('\n-- Summary --');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
