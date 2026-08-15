const fs = require('fs');
const os = require('os');
const path = require('path');

const EXTENSION_ID = 'nmmicjeknamkfloonkhhcjmomieiodli';

function browserRoots(localAppData = process.env.LOCALAPPDATA) {
  return [
    ['Chrome', path.join(localAppData, 'Google', 'Chrome', 'User Data')],
    ['CocCoc', path.join(localAppData, 'CocCoc', 'Browser', 'User Data')],
    ['Edge', path.join(localAppData, 'Microsoft', 'Edge', 'User Data')]
  ];
}

function findInstalledExtension(localAppData = process.env.LOCALAPPDATA) {
  const found = [];
  for (const [browser, root] of browserRoots(localAppData)) {
    if (!fs.existsSync(root)) continue;
    for (const profile of fs.readdirSync(root, { withFileTypes: true })) {
      if (!profile.isDirectory() || (profile.name !== 'Default' && !/^Profile \d+$/.test(profile.name))) continue;
      const versions = path.join(root, profile.name, 'Extensions', EXTENSION_ID);
      if (!fs.existsSync(versions)) continue;
      for (const version of fs.readdirSync(versions, { withFileTypes: true })) {
        const extensionPath = path.join(versions, version.name);
        const manifestPath = path.join(extensionPath, 'manifest.json');
        if (version.isDirectory() && fs.existsSync(manifestPath)) {
          found.push({ browser, profile: profile.name, extensionPath, modified: fs.statSync(manifestPath).mtimeMs });
        }
      }
    }
  }
  return found.sort((a, b) => b.modified - a.modified)[0] || null;
}

function prepareExtension() {
  const installed = findInstalledExtension();
  if (!installed) throw new Error(`Extension ${EXTENSION_ID} was not found in Chrome, CocCoc, or Edge profiles.`);
  const manifest = JSON.parse(fs.readFileSync(path.join(installed.extensionPath, 'manifest.json'), 'utf8'));
  const target = path.join(os.tmpdir(), 'TikTokPolicyChecker', 'extension-poc', 'youtube-summary', manifest.version);
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(installed.extensionPath, target, { recursive: true, force: true });
  console.log(JSON.stringify({ ...installed, version: manifest.version, copiedTo: target }, null, 2));
  console.log(`\nPowerShell:\n$env:YOUTUBE_TRANSCRIPT_EXTENSION_PATH='${target.replace(/'/g, "''")}'`);
  return target;
}

if (require.main === module) {
  try { prepareExtension(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { EXTENSION_ID, browserRoots, findInstalledExtension, prepareExtension };
