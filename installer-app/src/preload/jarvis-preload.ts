import { contextBridge, ipcRenderer } from 'electron';

// Exposed to the NEXUS Jarvis window (which loads the daemon's web UI at
// http://127.0.0.1:4242). Lets the page bring its own native window to the
// front when the "Hey Nexus" wake frame arrives, and dismiss it. Absent in a
// plain browser, so the web UI feature-detects `window.nexusJarvis`.
contextBridge.exposeInMainWorld('nexusJarvis', {
  show: (): Promise<void> => ipcRenderer.invoke('jarvis:show'),
  hide: (): Promise<void> => ipcRenderer.invoke('jarvis:hide'),
});
