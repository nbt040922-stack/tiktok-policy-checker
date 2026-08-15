const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const { EPHEMERAL_ENTRIES, clearEphemeralState } = require('../ephemeral-state');

test('exit cleanup removes old jobs and caches but preserves user data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpc-exit-cleanup-'));
  try {
    for (const entry of EPHEMERAL_ENTRIES) {
      const target = path.join(root, entry);
      if (path.extname(entry)) fs.writeFileSync(target, 'old');
      else { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'old'), 'old'); }
    }
    for (const entry of ['settings.json', 'exports', 'runtime', 'Partitions']) {
      const target = path.join(root, entry);
      if (path.extname(entry)) fs.writeFileSync(target, 'keep');
      else { fs.mkdirSync(target); fs.writeFileSync(path.join(target, 'keep'), 'keep'); }
    }

    clearEphemeralState(root);

    for (const entry of EPHEMERAL_ENTRIES) assert.equal(fs.existsSync(path.join(root, entry)), false, entry);
    for (const entry of ['settings.json', 'exports', 'runtime', 'Partitions']) assert.equal(fs.existsSync(path.join(root, entry)), true, entry);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
