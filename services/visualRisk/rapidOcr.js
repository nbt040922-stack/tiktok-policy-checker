const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

class RapidOcrProvider {
  constructor({ pythonPath = process.env.VISUAL_OCR_PYTHON || path.join(__dirname, '..', '..', '.venv-visual', 'Scripts', 'python.exe'), workerPath = path.join(__dirname, 'ocr-worker.py'), spawnImpl = spawn } = {}) {
    this.pythonPath = pythonPath; this.workerPath = workerPath; this.spawn = spawnImpl;
    this.child = null; this.pending = new Map(); this.nextId = 1; this.ready = null;
  }

  healthCheck() {
    return Promise.resolve(fs.existsSync(this.pythonPath) && fs.existsSync(this.workerPath)
      ? { ok: true, engine: 'RapidOCR', device: 'cpu' }
      : { ok: false, code: 'OCR_UNAVAILABLE', message: 'RapidOCR worker environment is unavailable.' });
  }

  async start() {
    if (this.child) return this.ready;
    const health = await this.healthCheck();
    if (!health.ok) throw Object.assign(new Error(health.message), { code: health.code });
    this.child = this.spawn(this.pythonPath, ['-u', this.workerPath], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });
    this.ready = new Promise((resolve, reject) => {
      const fail = error => reject(Object.assign(new Error(error.message || 'RapidOCR worker failed.'), { code: 'OCR_UNAVAILABLE' }));
      this.child.once('error', fail);
      this.child.once('exit', code => {
        const message = code === 0 ? 'OCR worker closed.' : `OCR worker exited with code ${code}.`;
        fail(new Error(message)); this.failAll(message);
      });
      readline.createInterface({ input: this.child.stdout }).on('line', line => {
        let value;
        try { value = JSON.parse(line); } catch (_) { return; }
        if (value.type === 'ready') return resolve(value);
        if (value.type === 'fatal') return fail(new Error(value.error));
        const request = this.pending.get(value.id);
        if (!request) return;
        this.pending.delete(value.id);
        value.error ? request.reject(Object.assign(new Error(value.error), { code: 'OCR_FAILED' })) : request.resolve(value);
      });
    });
    return this.ready;
  }

  async inspectFrame(framePath, timestamp, { signal } = {}) {
    await this.start();
    if (signal?.aborted) throw Object.assign(new Error('Analysis was cancelled.'), { code: 'ANALYSIS_CANCELLED' });
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const abort = () => { this.close(); reject(Object.assign(new Error('Analysis was cancelled.'), { code: 'ANALYSIS_CANCELLED' })); };
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: value => { signal?.removeEventListener('abort', abort); resolve(value); },
        reject: error => { signal?.removeEventListener('abort', abort); reject(error); }
      });
      this.child.stdin.write(`${JSON.stringify({ id, path: framePath, timestamp })}\n`);
    });
  }

  failAll(message) {
    for (const request of this.pending.values()) request.reject(Object.assign(new Error(message), { code: 'OCR_UNAVAILABLE' }));
    this.pending.clear(); this.child = null;
  }

  close() {
    if (!this.child) return;
    const child = this.child; this.child = null;
    child.kill();
    this.failAll('OCR worker closed.');
  }
}

module.exports = { RapidOcrProvider };
