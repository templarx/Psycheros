// Functional test for the proxy-image URL validation + SSRF guard.
// Mirrors the logic in handleProxyImage (routes.ts) without needing Deno.

function validateProxyTarget(target) {
  let parsed;
  try { parsed = new URL(target); }
  catch { return { ok: false, reason: 'invalid-url' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'non-http' };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
    host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal') ||
    /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host) ||
    /^fc[0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)
  ) {
    return { ok: false, reason: 'blocked-host' };
  }
  return { ok: true };
}

let pass = 0, fail = 0;
function check(label, ok, hint) {
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.error(`  FAIL ${label}${hint ? '\n       ' + hint : ''}`); }
}

// Public hosts — should pass
check('wikimedia accepted',
  validateProxyTarget('https://upload.wikimedia.org/wikipedia/commons/x.jpg').ok);
check('imgur accepted',
  validateProxyTarget('https://i.imgur.com/abc.png').ok);
check('github raw accepted',
  validateProxyTarget('https://raw.githubusercontent.com/user/repo/main/img.png').ok);
check('http also accepted',
  validateProxyTarget('http://example.com/x.jpg').ok);

// SSRF — should be blocked
check('localhost blocked',
  !validateProxyTarget('http://localhost/x.jpg').ok,
  'localhost should be blocked');
check('127.0.0.1 blocked',
  !validateProxyTarget('http://127.0.0.1/x.jpg').ok);
check('10.x blocked',
  !validateProxyTarget('http://10.0.0.1/x.jpg').ok);
check('192.168 blocked',
  !validateProxyTarget('http://192.168.1.1/x.jpg').ok);
check('172.16-31 blocked',
  !validateProxyTarget('http://172.20.5.5/x.jpg').ok);
check('169.254 blocked',
  !validateProxyTarget('http://169.254.169.254/x.jpg').ok);  // AWS metadata
check('.local blocked',
  !validateProxyTarget('http://printer.local/x.jpg').ok);
check('.internal blocked',
  !validateProxyTarget('http://db.internal/x.jpg').ok);
check('ftp blocked',
  !validateProxyTarget('ftp://example.com/x.jpg').ok,
  'non-http protocol rejected');
check('javascript: blocked',
  !validateProxyTarget('javascript:alert(1)').ok);
check('file: blocked',
  !validateProxyTarget('file:///etc/passwd').ok);
check('empty blocked',
  !validateProxyTarget('').ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
