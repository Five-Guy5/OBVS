
const { contextBridge, ipcRenderer } =
  require('electron') as typeof import('electron');

type PreloadSettingsInput = {
  serverUrl: string;
  groupCode: string;
  displayName: string;
  authKey: string;
};

type PreloadSessionStatus = {
  state: 'idle' | 'connecting' | 'live' | 'stopping';
  error: string | null;
};

contextBridge.exposeInMainWorld('obvs', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),

  saveSettings: (values: PreloadSettingsInput) =>
    ipcRenderer.invoke('settings:save', values),

  clearAuthKey: () => ipcRenderer.invoke('settings:clear-auth-key'),

  getSessionStatus: () => ipcRenderer.invoke('session:status'),

  connect: () => ipcRenderer.invoke('session:connect'),

  disconnect: () => ipcRenderer.invoke('session:disconnect'),

  onSessionStatus: (callback: (status: PreloadSessionStatus) => void) => {
    ipcRenderer.on('session:status', (_event, status: PreloadSessionStatus) => callback(status));
  }
});
