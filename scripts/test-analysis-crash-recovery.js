const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { AnalysisJobStore, AnalysisQueue, ReportManager } = require('../analysis-jobs');
const { VisualMediaService } = require('../services/visualRisk');

if (process.argv[2] === '--child') {
  const dir = process.argv[3]; const store = new AnalysisJobStore({ filePath: path.join(dir, 'jobs.json') });
  const queue = new AnalysisQueue({ store, reports: new ReportManager({ reportsDir: path.join(dir, 'reports') }), versions: { policySet: 'v1' },
    executor: async () => new Promise(() => {}) });
  queue.on('job-event', event => { if (event.event === 'started') fs.writeFileSync(path.join(dir, 'ready'), 'RUNNING'); });
  queue.enqueueText('https://youtu.be/crash12345'); queue.start(); setInterval(() => {}, 1000);
} else {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase6-crash-')); const reports = path.join(dir, 'reports');
  fs.mkdirSync(reports); fs.writeFileSync(path.join(reports, 'completed.html'), 'preserved');
  const stale = path.join(dir, 'visual-temp', 'analysis-stale'); fs.mkdirSync(stale, { recursive: true }); fs.writeFileSync(path.join(stale, 'proxy.mp4'), 'temp');
  const child = spawn(process.execPath, [__filename, '--child', dir], { windowsHide: true, stdio: 'ignore' });
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  (async () => {
    try {
      for (let index = 0; index < 100 && !fs.existsSync(path.join(dir, 'ready')); index++) await wait(20);
      if (!fs.existsSync(path.join(dir, 'ready'))) throw new Error('Child job did not reach RUNNING.');
      child.kill(); await new Promise(resolve => child.once('exit', resolve));
      const recovered = new AnalysisJobStore({ filePath: path.join(dir, 'jobs.json') });
      new VisualMediaService({ tempRoot: path.join(dir, 'visual-temp'), downloadProxy: async () => {} }).cleanupStale();
      const result = { status: recovered.jobs()[0].status, errorCode: recovered.jobs()[0].lastError.errorCode,
        databaseReadable: recovered.health.ok, completedReportPreserved: fs.existsSync(path.join(reports, 'completed.html')), tempCleaned: !fs.existsSync(stale) };
      if (result.status !== 'QUEUED' || !result.databaseReadable || !result.completedReportPreserved || !result.tempCleaned) throw new Error(JSON.stringify(result));
      console.log(JSON.stringify({ result: 'PASS', ...result }, null, 2));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
