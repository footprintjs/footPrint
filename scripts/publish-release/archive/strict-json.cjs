'use strict';
const { fail, archiveRefusalCode } = require('./refusal.cjs');
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_VALUES = 100000;

/** A bounded structural pass rejects decoded duplicate keys before JSON.parse. */
function parseManifest(bytes) {
  try {
    if (!(Buffer.isBuffer(bytes) || typeof bytes === 'string')) fail('manifest-json');
    if (Buffer.byteLength(bytes) > MAX_BYTES) fail('manifest-json');
    const input = Buffer.isBuffer(bytes)
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : bytes.replace(/^\uFEFF/, '');
    let at = 0;
    let values = 0;
    function whitespace() {
      while (at < input.length && /[\x20\t\r\n]/.test(input[at])) at++;
    }
    function string() {
      const start = at++;
      if (input[start] !== '"') fail('manifest-json');
      while (at < input.length) {
        const character = input[at++];
        if (character === '"') return JSON.parse(input.slice(start, at));
        if (character === '\\') at++;
        else if (character.charCodeAt(0) < 32) fail('manifest-json');
      }
      fail('manifest-json');
    }
    function value(depth) {
      if (depth > MAX_DEPTH || ++values > MAX_VALUES) fail('manifest-json');
      whitespace();
      const first = input[at];
      if (first === '"') {
        string();
        return;
      }
      if (first === '{' || first === '[') {
        const object = first === '{';
        const close = object ? '}' : ']';
        const keys = new Set();
        at++;
        whitespace();
        if (input[at] === close) {
          at++;
          return;
        }
        for (;;) {
          if (object) {
            const key = string();
            if (keys.has(key)) fail('manifest-json', key);
            keys.add(key);
            whitespace();
            if (input[at++] !== ':') fail('manifest-json');
          }
          value(depth + 1);
          whitespace();
          if (input[at] === close) {
            at++;
            return;
          }
          if (input[at++] !== ',') fail('manifest-json');
          whitespace();
        }
      }
      const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(input.slice(at));
      if (!token) fail('manifest-json');
      at += token[0].length;
      const scalar = JSON.parse(token[0]);
      if (typeof scalar === 'number' && !Number.isFinite(scalar)) fail('manifest-json');
    }
    value(0);
    whitespace();
    if (at !== input.length) fail('manifest-json');
    const manifest = JSON.parse(input);
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) fail('manifest-json', 'root');
    return manifest;
  } catch (error) {
    if (archiveRefusalCode(error)) throw error;
    fail('manifest-json');
  }
}
module.exports = { parseManifest };
