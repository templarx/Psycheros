// Test the JSON parsing path used by handleRedgifsEmbed.
// Mirrors the live api.redgifs.com/v1/gifs/<id> response shape.

const sampleResponse = {
  gfyItem: {
    avgColor: '#000000',
    content_urls: {
      poster: { url: 'https://media.redgifs.com/InstructiveRadiantTamarin-poster.jpg', size: 121380, width: 2074, height: 1080 },
      mobilePoster: { url: 'https://media.redgifs.com/InstructiveRadiantTamarin-mobile.jpg', size: 37635, width: 922, height: 480 },
      mp4: { url: 'https://media.redgifs.com/InstructiveRadiantTamarin-silent.mp4', size: 61424840, width: 2074, height: 1080 },
      mobile: { url: 'https://media.redgifs.com/InstructiveRadiantTamarin-silent.mp4', size: 12418324, width: 922, height: 480 },
    },
    id: 'instructiveradianttamarin',
    gifName: 'InstructiveRadiantTamarin',
    title: 'BBC Big Ass Interracial Keisha Grey Mandingo Pawg SnowBunnies Porn GIF by pawg-pro',
    duration: 60,
    width: 2074,
    height: 1080,
    hasAudio: false,
  },
};

// Replica of the parser in handleRedgifsEmbed
function parseRedgifsApiResponse(json) {
  const item = json?.gfyItem;
  if (!item) return { error: 'no gfyItem' };
  const mp4 = item?.content_urls?.mp4?.url || item?.content_urls?.mobile?.url;
  const poster = item?.content_urls?.poster?.url || item?.content_urls?.mobilePoster?.url;
  if (!mp4 || !poster) return { error: 'missing mp4/poster' };
  const title = item.title || item.gifName || item.id || '';
  return { id: item.id, mp4, poster, title, duration: item.duration, width: item.width, height: item.height };
}

// Replica of the id-validation regex
const REDGIFS_ID_RE = /^[a-z0-9]{4,40}$/i;

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected;
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}\n       got: ${JSON.stringify(actual)}\n      want: ${JSON.stringify(expected)}`); }
}

// Happy path
const parsed = parseRedgifsApiResponse(sampleResponse);
check('id',         parsed.id, 'instructiveradianttamarin');
check('mp4 is mp4', parsed.mp4, 'https://media.redgifs.com/InstructiveRadiantTamarin-silent.mp4');
check('poster',     parsed.poster, 'https://media.redgifs.com/InstructiveRadiantTamarin-poster.jpg');
check('title',      parsed.title, 'BBC Big Ass Interracial Keisha Grey Mandingo Pawg SnowBunnies Porn GIF by pawg-pro');
check('duration',   parsed.duration, 60);
check('width',      parsed.width, 2074);
check('height',     parsed.height, 1080);

// Fallback chain: when mp4 is missing, use mobile.url
const sample2 = JSON.parse(JSON.stringify(sampleResponse));
delete sample2.gfyItem.content_urls.mp4;
const parsed2 = parseRedgifsApiResponse(sample2);
check('mp4 fallback to mobile', parsed2.mp4, 'https://media.redgifs.com/InstructiveRadiantTamarin-silent.mp4');

// Fallback chain: when poster is missing, use mobilePoster.url
const sample3 = JSON.parse(JSON.stringify(sampleResponse));
delete sample3.gfyItem.content_urls.poster;
const parsed3 = parseRedgifsApiResponse(sample3);
check('poster fallback to mobilePoster', parsed3.poster, 'https://media.redgifs.com/InstructiveRadiantTamarin-mobile.jpg');

// Error: missing gfyItem
check('error no gfyItem', parseRedgifsApiResponse({}).error, 'no gfyItem');

// Error: missing both mp4 and mobile
const sample4 = { gfyItem: { content_urls: { poster: { url: 'x' } } } };
check('error missing mp4', parseRedgifsApiResponse(sample4).error, 'missing mp4/poster');

// Title fallback chain
// No title → falls to gifName
const sample5 = { gfyItem: { id: 'foo', gifName: 'Foo', content_urls: { mp4: { url: 'm' }, poster: { url: 'p' } } } };
check('title fallback to gifName', parseRedgifsApiResponse(sample5).title, 'Foo');

const sample6 = { gfyItem: { id: 'foo', content_urls: { mp4: { url: 'm' }, poster: { url: 'p' } } } };
check('title fallback to id', parseRedgifsApiResponse(sample6).title, 'foo');

// ID validation regex
check('valid id "instructiveradianttamarin"', REDGIFS_ID_RE.test('instructiveradianttamarin'), true);
check('valid id "abc123"', REDGIFS_ID_RE.test('abc123'), true);
check('invalid id "../etc/passwd"', REDGIFS_ID_RE.test('../etc/passwd'), false);
check('invalid id "a" (too short)', REDGIFS_ID_RE.test('a'), false);
check('invalid id "a@b" (special char)', REDGIFS_ID_RE.test('a@b'), false);
check('invalid id "x".repeat(50) (too long)', REDGIFS_ID_RE.test('x'.repeat(50)), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);