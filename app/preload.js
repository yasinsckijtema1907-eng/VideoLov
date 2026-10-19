const {contextBridge,ipcRenderer}=require('electron');
const allowed=new Set(['state','analyze','add','cancel','retry','chooseFolder','openFolder','reveal','support','github','browserOpen','browserNavigate','browserCurrent','browserClear','browserHide','clearHistory']);
contextBridge.exposeInMainWorld('vl',{
  invoke:(name,...args)=>{if(!allowed.has(name))throw Error('Unknown action');return ipcRenderer.invoke(name,...args);},
  onState:fn=>{const cb=(_,data)=>fn(data);ipcRenderer.on('state',cb);return()=>ipcRenderer.removeListener('state',cb);}
});
