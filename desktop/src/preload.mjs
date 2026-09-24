// 配置窗口与主进程之间的唯一桥：只暴露一个 saveConfig（写 .env.local），不暴露 Node 能力。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('miaoda', {
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
});
