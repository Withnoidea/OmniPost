import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopEvent, ElectronAPI, StudioEvent } from '../shared/contracts.js';
const api: ElectronAPI = {
  studioSettings: () => ipcRenderer.invoke('omni:studio-settings'),
  saveStudioSettings: settings => ipcRenderer.invoke('omni:save-studio-settings', settings),
  library: id => ipcRenderer.invoke('omni:library', id),
  rewrite: (id, platforms) => ipcRenderer.invoke('omni:rewrite', id, platforms),
  saveCopy: (id, platform, copy, revision) => ipcRenderer.invoke('omni:save-copy', id, platform, copy, revision),
  processMedia: id => ipcRenderer.invoke('omni:process', id),
  cancelStudio: (id, kind) => ipcRenderer.invoke('omni:cancel-studio', id, kind),
  analytics: () => ipcRenderer.invoke('omni:analytics'),
  onStudio: listener => {
    const handler = (_event: Electron.IpcRendererEvent, event: StudioEvent): void => listener(event);
    ipcRenderer.on('omni:studio', handler);
    return () => ipcRenderer.removeListener('omni:studio', handler);
  },
  snapshot: () => ipcRenderer.invoke('omni:snapshot'),
  fetchMetadata: (url) => ipcRenderer.invoke('omni:fetch', url),
  selectAndAttach: (id) => ipcRenderer.invoke('omni:select-attach', id),
  attachDroppedFile: (id, file) => ipcRenderer.invoke('omni:attach', id, webUtils.getPathForFile(file)),
  assets: (id) => ipcRenderer.invoke('omni:assets', id),
  cancel: (id) => ipcRenderer.invoke('omni:cancel', id),
  setProxy: (settings) => ipcRenderer.invoke('omni:proxy', settings),
  openAssets: (id) => ipcRenderer.invoke('omni:open-assets', id),
  copyText: (text) => ipcRenderer.invoke('omni:copy', text),
  windowControl: (action) => ipcRenderer.invoke('omni:window', action),
  onTask: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: DesktopEvent): void => listener(event);
    ipcRenderer.on('omni:task', handler);
    return () => ipcRenderer.removeListener('omni:task', handler);
  }
};
contextBridge.exposeInMainWorld('electronAPI', api);
