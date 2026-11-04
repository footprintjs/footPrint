'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectArchive, archiveRefusalCode } = require('./inspector.cjs');
const { expected } = require('./fixture.cjs');
const corpus = require('./fixtures/corpus.json');

// These are inert hostile bytes, not scripts. No member is extracted or run.
// Old minimal foottrace baselines are not claimed as full-source FP positives.
for (const item of corpus)
  test('Claude archive data ' + item.file, () => {
    const bytes = fs.readFileSync(path.join(__dirname, 'fixtures', item.file));
    assert.equal(bytes.length, item.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    assert.throws(
      () => inspectArchive(bytes, expected()),
      (error) => {
        const code = archiveRefusalCode(error);
        // Structural probes must be refused by the tar/gzip profile itself. An
        // unrelated source mismatch must not make these probes appear effective.
        assert.match(
          code,
          item.structuralRefusal
            ? /^(invalid-archive|archive-profile)$/
            : /^(invalid-archive|archive-profile|manifest-)/,
        );
        return true;
      },
    );
  });
