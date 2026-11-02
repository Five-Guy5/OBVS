
const { contextBridge, ipcRenderer } =
  require('electron') as typeof import('electron');

type PreloadSettingsInput = {
  serverUrl: string;
  groupCode: string;
  displayName: string;
  authKey: string;
};

contextBridge.exposeInMainWorld('obvs', {
  loadSettings: () => ipcRenderer.invoke('settings:load'),

  saveSettings: (values: PreloadSettingsInput) =>
    ipcRenderer.invoke('settings:save', values)
});
