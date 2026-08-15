const os = require('node:os');
const path = require('node:path');
const { inspectExtension, resolveExtensionPath, EXTENSION_ID, EXTENSION_VERSION, PARTITION } = require('../services/youtube/extensionTranscript/extensionManager');

const userData = process.env.DOCTOR_USER_DATA || path.join(process.env.APPDATA || os.homedir(), 'tiktok-policy-checker');
const extensionPath = resolveExtensionPath(userData);
const health = inspectExtension(extensionPath);
const status = health.status === 'EXTENSION_READY' ? 'PASS'
  : health.status === 'EXTENSION_NOT_FOUND' ? 'WARN' : 'FAIL';
console.table([{ name: 'Transcript extension', status, detail: `${health.status} · ${extensionPath}` }]);
console.log(JSON.stringify({ ...health, expectedId: EXTENSION_ID, expectedVersion: EXTENSION_VERSION, partition: PARTITION }, null, 2));
if (status === 'FAIL') process.exitCode = 1;
