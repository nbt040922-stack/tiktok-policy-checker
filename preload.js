const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window Controls
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  quitApp: () => ipcRenderer.send('app-quit'),

  // Maintenance & Tools
  openHomeDir: () => ipcRenderer.invoke('open-home-dir'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  updateEngine: () => ipcRenderer.invoke('update-engine'),
  repairEngine: () => ipcRenderer.invoke('repair-engine'),
  getEngineStatus: () => ipcRenderer.invoke('get-engine-status'),

  // Storage and Core
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),
  getDefaultPath: () => ipcRenderer.invoke('get-default-path'),
  loginYouTube: () => ipcRenderer.invoke('login-youtube'),
  logoutYouTube: () => ipcRenderer.invoke('logout-youtube'),
  getAuthState: () => ipcRenderer.invoke('get-auth-state'),
  openYouTubeTranscriptSession: () => ipcRenderer.invoke('open-youtube-transcript-session'),
  getTranscriptExtensionHealth: () => ipcRenderer.invoke('get-transcript-extension-health'),
  analyzeYouTubeVideo: (url, requestId) => ipcRenderer.invoke('analyze-youtube-video', { url, requestId }),
  enqueueAnalysisJobs: (text, options) => ipcRenderer.invoke('enqueue-analysis-jobs', text, options),
  getAnalysisJobs: (filters) => ipcRenderer.invoke('get-analysis-jobs', filters),
  pauseAnalysisQueue: () => ipcRenderer.invoke('pause-analysis-queue'),
  resumeAnalysisQueue: () => ipcRenderer.invoke('resume-analysis-queue'),
  cancelAnalysisJob: (id) => ipcRenderer.invoke('cancel-analysis-job', id),
  cancelAllAnalysisJobs: () => ipcRenderer.invoke('cancel-all-analysis-jobs'),
  retryAnalysisJob: (id) => ipcRenderer.invoke('retry-analysis-job', id),
  reanalyzeJob: (id) => ipcRenderer.invoke('reanalyze-job', id),
  openAnalysisReport: (id) => ipcRenderer.invoke('open-analysis-report', id),
  getAnalysisResult: (id) => ipcRenderer.invoke('get-analysis-result', id),
  exportAnalysisBatch: (format) => ipcRenderer.invoke('export-analysis-batch', format),
  clearPolicyCache: () => ipcRenderer.invoke('clear-policy-cache'),
  clearVisualCache: () => ipcRenderer.invoke('clear-visual-cache'),
  clearAnalysisReports: () => ipcRenderer.invoke('clear-analysis-reports'),
  getAnalysisStorage: () => ipcRenderer.invoke('get-analysis-storage'),
  setReportRetention: (days) => ipcRenderer.invoke('set-report-retention', days),

  // Download Engine
  getPlaylistData: (url) => ipcRenderer.invoke('get-playlist-data', url),
  enqueueDownloadJobs: (jobs) => ipcRenderer.invoke('enqueue-download-jobs', jobs),
  getDownloadJobs: () => ipcRenderer.invoke('get-download-jobs'),
  cancelDownloadJob: (id) => ipcRenderer.invoke('cancel-download-job', id),
  retryDownloadJob: (id) => ipcRenderer.invoke('retry-download-job', id),
  clearDownloadJobs: (states) => ipcRenderer.invoke('clear-download-jobs', states),
  cancelAllDownloads: () => ipcRenderer.send('cancel-all-downloads'),
  
  // Listeners
  onDownloadJobsUpdated: (callback) => ipcRenderer.on('download-jobs-updated', (event, data) => callback(data)),
  onEngineStatusUpdated: (callback) => ipcRenderer.on('engine-status-updated', (event, data) => callback(data)),
  onAuthStateUpdated: (callback) => ipcRenderer.on('auth-state-updated', (event, data) => callback(data)),
  onAnalysisStage: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('analysis-stage', listener);
    return () => ipcRenderer.removeListener('analysis-stage', listener);
  },
  onAnalysisJobsUpdated: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('analysis-jobs-updated', listener);
    return () => ipcRenderer.removeListener('analysis-jobs-updated', listener);
  }
});
