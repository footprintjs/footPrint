import assert from 'node:assert/strict';
import test from 'node:test';
import { feedContent, readingMinutes } from '../src/blog/presentation.ts';

const site = new URL('https://example.com');

test('feed keeps rendered component content and code, removing only presentation controls', () => {
  const html =
    '<aside aria-label="Note" class="starlight-aside"><svg class="starlight-aside__icon"></svg><p>Use &lt;code&gt; safely.</p></aside>' +
    '<div class="expressive-code"><pre style="color:red" data-language="ts"><code>const text = "&lt;script&gt;";</code></pre><div><button data-code="copied">Copy</button></div></div>' +
    '<script>bad()</script><style>unused{}</style><div aria-live="polite">Copied!</div>';
  assert.equal(
    feedContent(html, site),
    '<aside aria-label="Note"><p>Use &#x3C;code> safely.</p></aside><div><pre><code>const text = "&#x3C;script>";</code></pre></div>',
  );
});

test('feed keeps heading IDs but removes anchors and their hidden labels', () => {
  const html =
    '<div class="sl-heading-wrapper"><h2 id="start">Start</h2><a href="#start" class="sl-anchor-link"><span class="sr-only">Section titled Start</span></a></div>';
  assert.equal(feedContent(html, site), '<div><h2 id="start">Start</h2></div>');
});

test('feed resolves local links/images and leaves external links and fragments intact', () => {
  const html =
    '<a href="/footPrint/blog/">Blog</a><img src="/footPrint/image.png" alt="Image"><a href="https://other.example/x">Elsewhere</a><a href="#start">Start</a>';
  assert.equal(
    feedContent(html, site),
    '<a href="https://example.com/footPrint/blog/">Blog</a><img src="https://example.com/footPrint/image.png" alt="Image"><a href="https://other.example/x">Elsewhere</a><a href="#start">Start</a>',
  );
});

test('reading time excludes code and screen-reader labels without excluding prose', () => {
  const prose = 'word '.repeat(213);
  assert.equal(readingMinutes(`<p>${prose}</p>`), 1);
  assert.equal(
    readingMinutes(
      `<p>${prose}</p><div class="expressive-code">${prose.repeat(5)}</div><span class="sr-only">${prose}</span>`,
    ),
    1,
  );
  assert.equal(readingMinutes(`<p>${prose}extra</p>`), 2);
});

test('reading time retains the image allowance and empty-content behavior', () => {
  assert.equal(readingMinutes(''), 0);
  assert.equal(readingMinutes('<img src="image.png" alt="Image">'), 1);
  assert.equal(readingMinutes(`<p>${'word '.repeat(213)}</p><img src="image.png" alt="Image">`), 2);
});
