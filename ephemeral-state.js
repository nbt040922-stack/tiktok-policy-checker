const fs = require('fs');
const path = require('path');

const EPHEMERAL_ENTRIES = [
  'analysis-jobs.json',
  'download-jobs.json',
  'contentops-handoffs.json',
  'policy-judge-cache.json',
  'visual-findings-cache.json',
  'analysis-checkpoints',
  'reports',
  'visual-temp',
  'logs',
  'app_debug.log',
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'blob_storage',
  'Shared Dictionary'
];

function clearEphemeralState(userDataPath) {
  for (const entry of EPHEMERAL_ENTRIES) {
    try { fs.rmSync(path.join(userDataPath, entry), { recursive: true, force: true }); } catch (_) {}
  }
}

module.exports = { EPHEMERAL_ENTRIES, clearEphemeralState };
