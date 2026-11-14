import type { SystemSnapshot } from '../shared/system-monitor.js';
import type { DiskAnalysisProgress } from '../shared/disk-tools.js';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type AppState, type CleanerApi } from '../shared/types.js';

const api: CleanerApi = {
  getOptimizationTasks: () => ipcRenderer.invoke(IPC.getOptimizationTasks),
  optimizeSystem: (ids) => ipcRenderer.invoke(IPC.optimizeSystem, ids),
  getDiskLocations: () => ipcRenderer.invoke(IPC.getDiskLocations),
  chooseDiskFolder: () => ipcRenderer.invoke(IPC.chooseDiskFolder),
  analyzeDisk: (path) => ipcRenderer.invoke(IPC.analyzeDisk, path),
  cancelDiskAnalysis: () => ipcRenderer.invoke(IPC.cancelDiskAnalysis),
  trashDiskItems: (reportId, paths) => ipcRenderer.invoke(IPC.trashDiskItems, reportId, paths),
  onDiskAnalysisProgress: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: DiskAnalysisProgress) => listener(progress);
    ipcRenderer.on(IPC.diskAnalysisProgress, wrapped);
    return () => ipcRenderer.removeListener(IPC.diskAnalysisProgress, wrapped);
  },
  reviewProcessTermination: (target) => ipcRenderer.invoke(IPC.reviewProcessTermination, target),
  cancelProcessTermination: (token) => ipcRenderer.invoke(IPC.cancelProcessTermination, token),
  terminateSystemProcess: (token, mode) => ipcRenderer.invoke(IPC.terminateSystemProcess, token, mode),
  getSystemSnapshot: () => ipcRenderer.invoke(IPC.getSystemSnapshot),
  setSystemMonitorVisible: (visible) => ipcRenderer.invoke(IPC.setSystemMonitorVisible, visible),
  openSystemMonitor: () => ipcRenderer.invoke(IPC.openSystemMonitor),
  onSystemSnapshot: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: SystemSnapshot) => listener(snapshot);
    ipcRenderer.on(IPC.systemSnapshotChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.systemSnapshotChanged, wrapped);
  },
  getState: () => ipcRenderer.invoke(IPC.getState),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  runQuickClean: () => ipcRenderer.invoke(IPC.runQuickClean),
  scanDeep: (ids) => ipcRenderer.invoke(IPC.scanDeep, ids),
  cleanDeep: (ids) => ipcRenderer.invoke(IPC.cleanDeep, ids),
  clearHistory: () => ipcRenderer.invoke(IPC.clearHistory),
  scanInstalledApps: () => ipcRenderer.invoke(IPC.scanInstalledApps),
  uninstallApplication: (path) => ipcRenderer.invoke(IPC.uninstallApplication, path),
  listTimeMachineSnapshots: () => ipcRenderer.invoke(IPC.listTimeMachineSnapshots),
  clearTimeMachineSnapshots: (dates) => ipcRenderer.invoke(IPC.clearTimeMachineSnapshots, dates),
  getBackupOverview: () => ipcRenderer.invoke(IPC.getBackupOverview),
  previewBackup: (path) => ipcRenderer.invoke(IPC.previewBackup, path),
  trashExpiredBackups: (token, paths) => ipcRenderer.invoke(IPC.trashExpiredBackups, token, paths),
  restoreBackup: (path) => ipcRenderer.invoke(IPC.restoreBackup, path),
  openFullDiskAccessSettings: () => ipcRenderer.invoke(IPC.openFullDiskAccessSettings),
  revealPath: (path) => ipcRenderer.invoke(IPC.revealPath, path),
  quit: () => ipcRenderer.invoke(IPC.quit),
  onNavigateToActivity: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on(IPC.navigateToActivity, wrapped);
    return () => ipcRenderer.removeListener(IPC.navigateToActivity, wrapped);
  },
  onStateChanged: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on(IPC.stateChanged, wrapped);
    return () => ipcRenderer.removeListener(IPC.stateChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('cleaner', api);
