const fs = require('node:fs');
const path = require('node:path');

const PARTITION = 'persist:youtube-transcript';
const EXTENSION_ID = 'nmmicjeknamkfloonkhhcjmomieiodli';
const EXTENSION_VERSION = '2.3.1';
const HEALTH = Object.freeze({
  READY: 'EXTENSION_READY', NOT_FOUND: 'EXTENSION_NOT_FOUND', LOAD_FAILED: 'EXTENSION_LOAD_FAILED',
  VERSION_MISMATCH: 'EXTENSION_VERSION_MISMATCH', RUNTIME_FAILED: 'EXTENSION_RUNTIME_FAILED'
});

function resolveExtensionPath(userDataPath, env = process.env) {
  return path.resolve(env.YOUTUBE_TRANSCRIPT_EXTENSION_PATH || path.join(userDataPath, 'extensions', 'youtube-summary'));
}

function inspectExtension(extensionPath, fileSystem = fs) {
  const manifestPath = path.join(extensionPath, 'manifest.json');
  if (!fileSystem.existsSync(manifestPath)) return { status: HEALTH.NOT_FOUND, extensionPath };
  try {
    const manifest = JSON.parse(fileSystem.readFileSync(manifestPath, 'utf8'));
    if (manifest.manifest_version !== 3 || manifest.version !== EXTENSION_VERSION) {
      return { status: HEALTH.VERSION_MISMATCH, extensionPath, version: manifest.version, manifestVersion: manifest.manifest_version };
    }
    return { status: HEALTH.READY, extensionPath, version: manifest.version, name: manifest.name };
  } catch (error) {
    return { status: HEALTH.LOAD_FAILED, extensionPath, error: error.message };
  }
}

class ExtensionManager {
  constructor({ userDataPath, sessionFromPartition, env = process.env, logger = () => {} } = {}) {
    this.extensionPath = resolveExtensionPath(userDataPath, env);
    this.session = sessionFromPartition(PARTITION, { cache: true });
    this.logger = logger;
    this.loadedExtension = null;
    this.loadPromise = null;
    this.health = inspectExtension(this.extensionPath);
  }
  async load() {
    if (this.loadedExtension) return this.loadedExtension;
    if (this.loadPromise) return this.loadPromise;
    if (this.health.status !== HEALTH.READY) throw Object.assign(new Error(this.health.status), { code: this.health.status });
    this.loadPromise = (async () => {
      try {
        const extension = await this.session.loadExtension(this.extensionPath, { allowFileAccess: false });
        if (extension.id !== EXTENSION_ID || extension.version !== EXTENSION_VERSION) {
          this.health = { ...this.health, status: HEALTH.VERSION_MISMATCH, id: extension.id, version: extension.version };
          throw Object.assign(new Error(HEALTH.VERSION_MISMATCH), { code: HEALTH.VERSION_MISMATCH });
        }
        this.loadedExtension = extension;
        this.health = { ...this.health, status: HEALTH.READY, id: extension.id, version: extension.version };
        this.logger({ event: 'extension-ready', extensionId: extension.id, extensionVersion: extension.version });
        return extension;
      } catch (error) {
        if (error.code !== HEALTH.VERSION_MISMATCH) this.health = { ...this.health, status: HEALTH.LOAD_FAILED, error: error.message };
        throw Object.assign(error, { code: error.code || 'EXTENSION_LOAD_FAILED' });
      } finally { this.loadPromise = null; }
    })();
    return this.loadPromise;
  }
  reportRuntimeFailure(error) { this.health = { ...this.health, status: HEALTH.RUNTIME_FAILED, error: error.message }; }
}

module.exports = { EXTENSION_ID, EXTENSION_VERSION, ExtensionManager, HEALTH, PARTITION, inspectExtension, resolveExtensionPath };
