// Preload for the update notification popup window.
//
// Exposes a minimal API the renderer can use to receive state updates
// and trigger user actions. Lives in its own preload (not the main app
// preload) because the popup is contextIsolation+sandbox-disabled-but-
// preload — we keep the API surface tight to just what the inline HTML
// renderer needs.
//
// API:
//   window.updatePopup.onState((state) => render(state))
//   window.updatePopup.update()    — fires the install flow
//   window.updatePopup.dismiss()   — closes the popup

import { contextBridge, ipcRenderer } from 'electron';

type UpdatePopupState = {
  phase: 'prompt' | 'downloading' | 'installing' | 'restarting' | 'done' | 'error';
  [k: string]: unknown;
};

contextBridge.exposeInMainWorld('updatePopup', {
  onState(listener: (state: UpdatePopupState) => void): void {
    ipcRenderer.on('update-popup:state', (_e, state: UpdatePopupState) => listener(state));
  },
  update(): void {
    void ipcRenderer.invoke('update-popup:update');
  },
  dismiss(): void {
    void ipcRenderer.invoke('update-popup:dismiss');
  },
});
