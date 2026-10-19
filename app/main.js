// Copyright (c) 2026 M0904sha. GPL-3.0-or-later.
const {app,BrowserWindow,WebContentsView,session,ipcMain,dialog,shell}=require('electron');
const fs=require('node:fs'); const path=require('node:path');const {spawn}=require('node:child_process');const crypto=require('node:crypto');
const {SUPPORT,REPO,validUrl,mediaKind,downloadArgs,parseLine}=require('./core');
let main,browserWin,view,storeFile,store,active=null,analysis=null;
let media=[],privateSession,browserUrl='',status='',queue=[];
if(process.env.NODE_ENV==='test'&&process.env.VIDEOLOV_TEST_USER_DATA)app.setPath('userData',process.env.VIDEOLOV_TEST_USER_DATA);
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(main){if(main.isMinimized())main.restore();main.focus();}});
const tools=path.join(app.isPackaged?process.resourcesPath:path.join(__dirname,'..'),'tools');
const tool=name=>path.join(tools,name+'.exe');
function save(){fs.writeFileSync(storeFile,JSON.stringify({folder:store.folder,jobs:queue.map(({cookieFile,...j})=>j)},null,2));}
function state(){return {version:app.getVersion(),author:'M0904sha',support:SUPPORT,repo:REPO,folder:store.folder,jobs:queue,media,browserUrl,status,ready:['yt-dlp','ffmpeg','ffprobe','node'].every(n=>fs.existsSync(tool(n)))};}
function broadcast(){if(main&&!main.isDestroyed())main.webContents.send('state',state());}
function update(job,data){Object.assign(job,data);broadcast();}
function safeSender(event){if(!main||event.sender.id!==main.webContents.id)throw Error('Доступ запрещён');}
function handle(name,fn){ipcMain.handle(name,async(e,...args)=>{safeSender(e);try{return {ok:true,value:await fn(...args)};}catch(err){return {ok:false,error:err.message};}});}
function run(args,job){return new Promise((resolve,reject)=>{
  const p=spawn(tool('yt-dlp'),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
  if(job) active={process:p,job}; else analysis=p;
  let out='',err='',buf='';
  p.stdout.on('data',chunk=>{if(!job){out+=chunk;if(out.length>16e6){p.kill();reject(Error('Ответ сайта слишком большой.'));}}else{buf+=chunk.toString();const lines=buf.split(/\r?\n/);buf=lines.pop();for(const line of lines){const parsed=parseLine(line);if(parsed)update(job,parsed);}}});
  p.stderr.on('data',chunk=>{err=(err+chunk.toString()).slice(-6000);});
  const timer=!job?setTimeout(()=>{p.kill();reject(Error('Сайт не ответил за 60 секунд. Попробуйте встроенный браузер.'));},60000):null;
  p.on('error',e=>{clearTimeout(timer);reject(e);});
  p.on('close',code=>{clearTimeout(timer);if(!job)analysis=null;if(code===0)resolve(out);else reject(Error(err.trim()||'Загрузка остановлена.'));});
});}
function cleanupCookie(job){if(job.cookieFile){try{fs.unlinkSync(job.cookieFile);}catch{}delete job.cookieFile;}}
function stopProcess(p){if(!p?.pid)return;if(process.platform==='win32')spawn('taskkill',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else p.kill();}
async function pump(){if(active)return;const job=queue.find(j=>j.state==='queued');if(!job)return;
  try{fs.mkdirSync(job.folder,{recursive:true});update(job,{state:'downloading',error:'',percent:0});save();await run(downloadArgs(job,tools),job);if(job.state!=='cancelled'){if(!job.file||!fs.existsSync(job.file))throw Error('Сайт не создал итоговый файл.');update(job,{state:'done',percent:100,completed:new Date().toISOString()});}}
  catch(e){if(job.state!=='cancelled')update(job,{state:'error',error:e.message.slice(-1500)});}
  finally{cleanupCookie(job);active=null;save();broadcast();setImmediate(pump);}
}
async function cookieFile(url){
  if(!privateSession)return null;
  const cookies=await privateSession.cookies.get({url});if(!cookies.length)return null;
  const file=path.join(app.getPath('userData'),'cookies-'+crypto.randomUUID()+'.txt');
  // Session cookies are passed only after the user enables the checkbox for this download.
  const lines=cookies.map(c=>[c.httpOnly?'#HttpOnly_'+c.domain:c.domain,c.domain.startsWith('.')?'TRUE':'FALSE',c.path,c.secure?'TRUE':'FALSE',Math.floor(c.expirationDate||0),c.name,c.value].join('\t'));
  fs.writeFileSync(file,'# Netscape HTTP Cookie File\n'+lines.join('\n')+'\n',{mode:0o600});return file;
}
function addMedia(details){let kind;try{kind=mediaKind(details.url,(details.responseHeaders?.['content-type']||details.responseHeaders?.['Content-Type']||[''])[0]);}catch{return;}
  if(!kind||media.some(m=>m.url===details.url)||media.length>=100)return;
  media.push({id:crypto.randomUUID(),url:details.url,kind,host:new URL(details.url).hostname,referer:browserUrl,title:view?.webContents.getTitle()||'Найденный поток'});broadcast();
}
function secureWeb(wc){wc.setWindowOpenHandler(({url})=>{try{wc.loadURL(validUrl(url));}catch{}return {action:'deny'};});wc.on('will-navigate',(e,url)=>{try{validUrl(url);}catch{e.preventDefault();}});}
async function browserOpen(url){
  const target=validUrl(url);
  if(!browserWin||browserWin.isDestroyed()){
    // Ephemeral isolated browser; never reads Chrome profiles, passwords or cookies.
    privateSession=session.fromPartition('videolov-'+crypto.randomUUID());privateSession.setPermissionRequestHandler((wc,permission,cb)=>cb(false));
    privateSession.setPermissionCheckHandler(()=>false);
    privateSession.on('will-download',(event,item)=>{event.preventDefault();addMedia({url:item.getURL(),responseHeaders:{'content-type':[item.getMimeType()]}});});
    privateSession.webRequest.onHeadersReceived((d,cb)=>{addMedia(d);cb({});});
    browserWin=new BrowserWindow({width:1100,height:780,title:'Браузер ВидеоЛов — включите видео на странице',backgroundColor:'#10151f',webPreferences:{preload:path.join(__dirname,'browser-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
    browserWin.loadFile(path.join(__dirname,'browser.html'));browserWin.webContents.on('will-navigate',e=>e.preventDefault());browserWin.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    view=new WebContentsView({webPreferences:{session:privateSession,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});browserWin.contentView.addChildView(view);
    const bounds=()=>{if(!browserWin?.isDestroyed()){const [width,height]=browserWin.getContentSize();view.setBounds({x:0,y:64,width,height:Math.max(0,height-64)});}};browserWin.on('resize',bounds);bounds();secureWeb(view.webContents);
    const location=u=>{browserUrl=u;browserWin?.webContents.send('location',u);broadcast();};
    view.webContents.on('did-navigate',(_,u)=>location(u));view.webContents.on('did-navigate-in-page',(_,u)=>location(u));
    view.webContents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&input.alt&&input.key==='ArrowLeft'){event.preventDefault();if(view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();}});
    view.webContents.on('did-fail-load',(_,code,msg,failedUrl,isMain)=>{if(isMain&&code!==-3){status='Не удалось открыть страницу: '+msg;broadcast();}});
    browserWin.on('closed',()=>{if(view&&!view.webContents.isDestroyed())view.webContents.close();view=null;browserWin=null;browserUrl='';media=[];broadcast();});
  }
  browserWin.show();await view.webContents.loadURL(target);return true;
}
app.whenReady().then(()=>{
  require('electron').Menu.setApplicationMenu(null);
  app.setAppUserModelId('io.github.m0904sha.videolov');storeFile=path.join(app.getPath('userData'),'state.json');
  try{store=JSON.parse(fs.readFileSync(storeFile,'utf8'));}catch{store={};}
  store.folder=store.folder||path.join(app.getPath('videos'),'ВидеоЛов');queue=Array.isArray(store.jobs)?store.jobs.slice(-100):[];
  for(const j of queue){if(['queued','downloading'].includes(j.state))j.state='cancelled';delete j.cookieFile;}
  // Remove transient cookies after an interrupted session.
  for(const f of fs.readdirSync(app.getPath('userData')))if(/^cookies-[\w-]+\.txt$/.test(f))try{fs.unlinkSync(path.join(app.getPath('userData'),f));}catch{}
  main=new BrowserWindow({width:1180,height:820,minWidth:960,minHeight:680,title:'ВидеоЛов',icon:path.join(__dirname,'icon.ico'),backgroundColor:'#0d111a',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  main.on('closed',()=>app.quit());
  ipcMain.handle('browserAction',async(e,action,url)=>{if(!browserWin||e.sender.id!==browserWin.webContents.id)throw Error('Доступ запрещён');if(action==='go')return browserOpen(url);if(action==='back'&&view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();if(action==='forward'&&view.webContents.navigationHistory.canGoForward())view.webContents.navigationHistory.goForward();if(action==='return'){main.show();main.focus();}return browserUrl;});
  main.webContents.setWindowOpenHandler(()=>({action:'deny'}));main.webContents.on('will-navigate',e=>e.preventDefault());main.loadFile(path.join(__dirname,'index.html'));
  handle('state',()=>state());handle('support',()=>shell.openExternal(SUPPORT));handle('github',()=>shell.openExternal(REPO));
  handle('chooseFolder',async()=>{const d=await dialog.showOpenDialog(main,{defaultPath:store.folder,properties:['openDirectory','createDirectory']});if(!d.canceled){store.folder=d.filePaths[0];save();broadcast();}return store.folder;});
  handle('openFolder',async()=>{fs.mkdirSync(store.folder,{recursive:true});return shell.openPath(store.folder);});
  handle('reveal',id=>{const j=queue.find(j=>j.id===id);if(!j?.file||!fs.existsSync(j.file))throw Error('Файл не найден.');shell.showItemInFolder(j.file);});
  handle('analyze',async(url)=>{url=validUrl(url);if(analysis)throw Error('Дождитесь предыдущего анализа.');const raw=await run(['--ignore-config','--no-playlist','--skip-download','--dump-single-json','--socket-timeout','15','--retries','1','--js-runtimes',`node:${tool('node')}`,'--',url]);const d=JSON.parse(raw);return {title:d.title,duration:d.duration,extractor:d.extractor,formats:[...new Set((d.formats||[]).map(f=>f.height).filter(Boolean))].sort((a,b)=>b-a)};});
  handle('add',async(input)=>{const url=validUrl(input.url);if(queue.filter(j=>['queued','downloading'].includes(j.state)).length>=30)throw Error('В очереди уже 30 загрузок.');const detected=input.mediaId?media.find(m=>m.id===input.mediaId):null;
    const j={id:crypto.randomUUID(),url,title:input.title?.slice(0,250)||detected?.title||new URL(url).hostname,quality:['best','2160','1080','720','480','audio'].includes(input.quality)?input.quality:'best',folder:store.folder,state:'queued',percent:0,created:new Date().toISOString()};
    if(detected){if(detected.url!==url)throw Error('Поток изменился.');j.referer=detected.referer;j.userAgent=view?.webContents.getUserAgent();}
    if(input.useSession){if(!privateSession)throw Error('Откройте сайт во встроенном браузере.');j.cookieFile=await cookieFile(url);}
    queue.push(j);save();broadcast();pump();return j.id;
  });
  handle('cancel',id=>{const j=queue.find(j=>j.id===id);if(j&&['queued','downloading'].includes(j.state)){j.state='cancelled';if(active?.job.id===id)stopProcess(active.process);else cleanupCookie(j);save();broadcast();}});
  handle('retry',id=>{const j=queue.find(j=>j.id===id);if(j&&['error','cancelled'].includes(j.state)){j.state='queued';j.error='';save();broadcast();pump();}});
  handle('clearHistory',()=>{queue=queue.filter(j=>['queued','downloading'].includes(j.state));save();broadcast();});
  handle('browserOpen',browserOpen);handle('browserNavigate',browserOpen);handle('browserHide',()=>browserWin?.hide());handle('browserCurrent',()=>browserUrl);
  handle('browserClear',async()=>{media=[];if(privateSession){await privateSession.clearStorageData();await privateSession.clearCache();}broadcast();});
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{if(active){active.job.state='cancelled';stopProcess(active.process);}if(analysis)stopProcess(analysis);for(const j of queue)cleanupCookie(j);if(storeFile)save();});
