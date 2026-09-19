'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets this and nothing else: no fs, no child_process, no paths
// it can make up. Every argument below is data the main process validates
// against what it found itself.
contextBridge.exposeInMainWorld('flat', {
  appInfo: () => ipcRenderer.invoke('app-info'),
  probe: () => ipcRenderer.invoke('flatpak-probe'),

  scanApps: (options) => ipcRenderer.invoke('scan-apps', options),
  runningApps: () => ipcRenderer.invoke('running-apps'),
  closeApps: (ids) => ipcRenderer.invoke('close-apps', ids),
  chooseBackupFile: () => ipcRenderer.invoke('choose-backup-file'),
  runBackup: (options) => ipcRenderer.invoke('run-backup', options),


  listRead: () => ipcRenderer.invoke('applist-read'),
  listWrite: (payload) => ipcRenderer.invoke('applist-write', payload),
  listFromInstalled: () => ipcRenderer.invoke('applist-from-installed'),
  listSearch: (term) => ipcRenderer.invoke('applist-search', term),
  listExport: (payload) => ipcRenderer.invoke('applist-export', payload),
  listImport: () => ipcRenderer.invoke('applist-import'),
  addFlathub: () => ipcRenderer.invoke('add-flathub'),
  installApps: (payload) => ipcRenderer.invoke('install-apps', payload),
  settingsBackupFind: () => ipcRenderer.invoke('settings-backup-find'),
  settingsBackupChoose: () => ipcRenderer.invoke('settings-backup-choose'),
  settingsBackupDescribe: (file) => ipcRenderer.invoke('settings-backup-describe', file),

  revealFile: (file) => ipcRenderer.invoke('reveal-file', file),

  onScanProgress: (handler) => ipcRenderer.on('scan-progress', (event, payload) => handler(payload)),
  onJobProgress: (handler) => ipcRenderer.on('job-progress', (event, payload) => handler(payload)),
  onGoToTab: (handler) => ipcRenderer.on('go-to-tab', (event, tab) => handler(tab)),

  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),
  onUpdateState: (handler) => ipcRenderer.on('update-state', (event, state) => handler(state)),
  updateStateGet: () => ipcRenderer.invoke('update-state-get'),
});
