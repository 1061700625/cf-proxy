const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleRequest,
  splitSetCookieHeader,
  rewriteSetCookie,
  rewriteCssUrls,
  stripHopByHopHeaders,
} = require('./worker.js');

test('robots.txt should deny all crawlers', async () => {
  const response = await handleRequest(
    new Request('https://proxy.example/robots.txt'),
  );

  assert.equal(response.status, 200);
  assert.equal(
    await response.text(),
    'User-agent: *\nDisallow: /\n',
  );
});

test('splitSetCookieHeader handles Expires comma and multiple cookies', () => {
  const combined =
    'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/, b=2; Path=/foo';

  assert.deepEqual(splitSetCookieHeader(combined), [
    'a=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Path=/',
    'b=2; Path=/foo',
  ]);
});

test('rewriteSetCookie rewrites path/domain safely', () => {
  const cookie =
    'sid=abc; Domain=.example.com; Path=/app; HttpOnly; Secure; SameSite=Lax';
  const rewritten = rewriteSetCookie(
    cookie,
    'https://proxy.example',
    new URL('https://example.com/app/page'),
  );

  assert.match(
    rewritten,
    /^sid=abc; Path=\/https:\/\/example\.com\/app; HttpOnly; Secure; SameSite=Lax; Domain=proxy\.example$/,
  );
});

test('rewriteSetCookie adds default path when source path is absent', () => {
  const rewritten = rewriteSetCookie(
    'sid=abc; HttpOnly',
    'https://proxy.example',
    new URL('https://example.com/app/page/index.html'),
  );

  assert.match(
    rewritten,
    /^sid=abc; HttpOnly; Path=\/https:\/\/example\.com\/app\/page$/,
  );
});

test('rewriteCssUrls rewrites network urls and skips non-network urls', () => {
  const css = [
    "a{background:url('/img/bg.png')}",
    "b{background:url(https://cdn.example.com/app.js)}",
    "c{background:url(data:image/png;base64,abc)}",
    "d{background:url(#mask)}",
  ].join('');

  const rewritten = rewriteCssUrls(
    css,
    'https://proxy.example',
    new URL('https://example.com/styles/main.css'),
  );

  assert.match(
    rewritten,
    /url\('https:\/\/proxy\.example\/https:\/\/example\.com\/img\/bg\.png'\)/,
  );
  assert.match(
    rewritten,
    /url\(https:\/\/proxy\.example\/https:\/\/cdn\.example\.com\/app\.js\)/,
  );
  assert.match(rewritten, /url\(data:image\/png;base64,abc\)/);
  assert.match(rewritten, /url\(#mask\)/);
});

test('stripHopByHopHeaders removes connection-level headers and tokens', () => {
  const headers = new Headers({
    Connection: 'keep-alive, x-custom-hop',
    'Keep-Alive': 'timeout=5',
    'Transfer-Encoding': 'chunked',
    'X-Custom-Hop': '1',
    Referer: 'https://example.com/',
  });

  stripHopByHopHeaders(headers);

  assert.equal(headers.get('Connection'), null);
  assert.equal(headers.get('Keep-Alive'), null);
  assert.equal(headers.get('Transfer-Encoding'), null);
  assert.equal(headers.get('X-Custom-Hop'), null);
  assert.equal(headers.get('Referer'), 'https://example.com/');
});
