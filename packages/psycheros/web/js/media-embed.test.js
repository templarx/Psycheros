// Functional smoke test for the client-side media-embed module.
// Runs in pure Node by mocking just enough DOM APIs to load the IIFE.

const fs = require('fs');
const path = require('path');

// ---- Minimal DOM shim ----
class FakeElement {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this._innerHTML = '';
    this._textContent = '';
    this.className = '';
    this.parentElement = null;
    this.style = {};
    this.nodeType = 1;
  }
  get src() { return this.attributes.src || ''; }
  set src(v) { this.attributes.src = v; }
  get href() { return this.attributes.href || ''; }
  set href(v) { this.attributes.href = v; }
  get class() { return this.className; }
  set class(v) { this.className = v; }
  get textContent() {
    if (this._textContent) return this._textContent;
    return this.children.map(c => c.textContent || '').join('');
  }
  set textContent(v) { this._textContent = v; this.children = []; }
  get innerHTML() {
    if (this._innerHTML) return this._innerHTML;
    return this.children.map(c => c.outerHTML || c.textContent || '').join('');
  }
  set innerHTML(html) {
    this._innerHTML = html;
    // very crude: just record the html
  }
  get outerHTML() { return `<${this.tagName.toLowerCase()}>${this.innerHTML}</${this.tagName.toLowerCase()}>`; }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this.dataset[key] = value;
    }
  }
  getAttribute(name) { return this.attributes[name] || null; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  addEventListener() {}
  querySelectorAll(sel) { return []; }
  querySelector(sel) { return null; }
  closest(sel) { return null; }
  matches(sel) { return false; }
  replaceWith() {}
  classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  onerror = null;
  onclick = null;
}

global.document = {
  createElement: (tag) => new FakeElement(tag),
};
global.window = { location: { href: 'http://localhost/', origin: 'http://localhost' } };
global.location = window.location;
global.URL = class URL {
  constructor(u, base) {
    if (typeof u !== 'string') throw new Error('invalid');
    const full = /^https?:/.test(u) ? u : (base || '') + u;
    const m = full.match(/^(https?:)\/\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i);
    if (!m) throw new Error('invalid url ' + u);
    this.protocol = m[1].toLowerCase();
    this.hostname = m[2].toLowerCase();
    this.origin = m[1].toLowerCase() + '//' + m[2].toLowerCase();
    this.pathname = m[3] || '';
    this.search = m[4] || '';
    this.hash = m[5] || '';
    this.href = full;
  }
};

// ---- Load the module ----
const src = fs.readFileSync(path.join(__dirname, 'media-embed.js'), 'utf8');
const wrapped = `(function(){ ${src} \n globalThis.PsycherosMediaEmbed = globalThis.PsycherosMediaEmbed || window.PsycherosMediaEmbed; })();`;
// The module uses `global` (typeof window !== "undefined" ? window : globalThis).
// In Node, window is set above, so the module attaches to window.
const fn = new Function('window', 'globalThis', 'document', 'URL', 'location', src);
fn(window, globalThis, document, URL, location);

const M = globalThis.PsycherosMediaEmbed || window.PsycherosMediaEmbed;
if (!M) { console.error('Module did not expose PsycherosMediaEmbed'); process.exit(1); }

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}\n       got: ${actual}\n    want: ${expected}`); }
}

console.log('-- URL detection --');
check('isImageUrl jpg', M.isImageUrl('https://example.com/cat.jpg'), true);
check('isImageUrl png', M.isImageUrl('https://example.com/x.png'), true);
check('isImageUrl gif', M.isImageUrl('https://example.com/x.gif'), true);
check('isImageUrl gif with query', M.isImageUrl('https://example.com/x.gif?cache=1'), true);
check('isImageUrl webp', M.isImageUrl('https://example.com/x.webp'), true);
check('isImageUrl svg', M.isImageUrl('https://example.com/x.svg'), true);
check('isImageUrl query', M.isImageUrl('https://example.com/x.jpg?v=1'), true);
check('isImageUrl wikimedia', M.isImageUrl('https://upload.wikimedia.org/wikipedia/commons/x.jpg'), true);
check('isImageUrl imgur', M.isImageUrl('https://i.imgur.com/abc.png'), true);
check('isImageUrl google', M.isImageUrl('https://www.google.com/page'), false);
check('isImageUrl non-http', M.isImageUrl('ftp://example.com/x.jpg'), false);

check('isVideoUrl mp4', M.isVideoUrl('https://example.com/clip.mp4'), true);
check('isVideoUrl webm', M.isVideoUrl('https://example.com/clip.webm'), true);
check('isVideoUrl mov', M.isVideoUrl('https://example.com/clip.mov'), true);
check('isVideoUrl gifv (imgur)', M.isVideoUrl('https://i.imgur.com/abc.gifv'), true);
check('isVideoUrl mp4 after query (signed URL)', M.isVideoUrl('https://cdn.example.com/v?id=1&t=2.mp4'), true);
check('isVideoUrl jpg', M.isVideoUrl('https://example.com/cat.jpg'), false);

check('isAudioUrl mp3', M.isAudioUrl('https://example.com/song.mp3'), true);
check('isAudioUrl ogg', M.isAudioUrl('https://example.com/song.ogg'), true);
check('isAudioUrl mp3a', M.isAudioUrl('https://example.com/x.m4a'), true);
check('isAudioUrl mp4', M.isAudioUrl('https://example.com/clip.mp4'), false);

check('youtubeId long', M.youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
check('youtubeId short', M.youtubeId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
check('youtubeId embed', M.youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
check('youtubeId shorts', M.youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
check('youtubeId with extra params',
  M.youtubeId('https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ&t=42s'),
  'dQw4w9WgXcQ');
check('youtubeId nocookie',
  M.youtubeId('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'),
  'dQw4w9WgXcQ');
check('youtubeId non-yt', M.youtubeId('https://example.com/watch?v=abc'), null);

check('vimeoId basic', M.vimeoId('https://vimeo.com/123456789'), '123456789');
check('vimeoId player', M.vimeoId('https://player.vimeo.com/video/123456789'), '123456789');
check('vimeoId non-vimeo', M.vimeoId('https://example.com/123456789'), null);

console.log('\n-- Summary --');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
