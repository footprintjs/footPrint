'use strict';
// Test data only. No archive member is extracted or executed.
const { gzipSync } = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const source = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
function checksum(header) {
  header.fill(32, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}
function entry(name, value, changeHeader) {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 'latin1');
  header.write('0000000\0', 108, 'latin1');
  header.write('0000000\0', 116, 'latin1');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  header.write('00000000000\0', 136, 'latin1');
  header[156] = 48;
  header.write('ustar\0' + '00', 257, 'latin1');
  if (changeHeader) changeHeader(header);
  checksum(header);
  return Buffer.concat([header, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length)]);
}
function tar(entries) {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}
function pack(manifest = { ...source, version: '11.0.0-rc.1' }, extra = []) {
  const json = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
  return gzipSync(
    tar([entry('package/package.json', json), entry('package/dist/index.js', 'fixture only\n'), ...extra]),
  );
}
const expected = () => ({ package: 'footprintjs', version: '11.0.0-rc.1', sourceManifest: source });
module.exports = { source, checksum, entry, tar, pack, expected };
