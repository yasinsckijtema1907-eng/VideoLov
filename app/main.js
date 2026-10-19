// Copyright (c) 2026 M0904sha. GPL-3.0-or-later.
const {app,BrowserWindow,WebContentsView,session,ipcMain,dialog,shell,net}=require('electron');
const fs=require('node:fs'); const path=require('node:path');const {spawn}=require('node:child_process');const crypto=require('node:crypto');
const {SUPPORT,REPO,validUrl,mediaKind,downloadArgs,parseLine}=require('./core');
const {discoverHtml,metadataEntries,offeredFormats}=require('./discovery');
const analyzed=new Map();let discovering=false;
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
  const p=spawn(tool('yt-dlp'),args,{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}});
  p.stdout.setEncoding('utf8');p.stderr.setEncoding('utf8');
  if(job) active={process:p,job}; else analysis=p;
  let out='',err='',buf='';
  const consume=line=>{const parsed=parseLine(line);if(parsed){if(job.sourceUrl&&parsed.title)delete parsed.title;update(job,parsed);}};
  p.stdout.on('data',chunk=>{if(!job){out+=chunk;if(out.length>16e6){p.kill();reject(Error('Ответ сайта слишком большой.'));}}else{buf+=chunk;const lines=buf.split(/\r?\n/);buf=lines.pop();for(const line of lines)consume(line);}});
  p.stderr.on('data',chunk=>{err=(err+chunk.toString()).slice(-6000);});
  const timer=!job?setTimeout(()=>{p.kill();reject(Error('Сайт не ответил за 60 секунд. Попробуйте встроенный браузер.'));},60000):null;
  p.on('error',e=>{clearTimeout(timer);reject(e);});
  p.on('close',code=>{clearTimeout(timer);if(job&&buf)consume(buf);if(!job)analysis=null;if(code===0)resolve(out);else reject(Error(err.trim()||'Загрузка остановлена.'));});
});}
function capture(name,args,limit=8e6,timeout=18000){return new Promise((resolve,reject)=>{const p=spawn(tool(name),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let chunks=[],bytes=0,err='';const timer=setTimeout(()=>{stopProcess(p);reject(Error('Время получения превью истекло.'));},timeout);p.stdout.on('data',b=>{bytes+=b.length;if(bytes>limit){stopProcess(p);reject(Error('Слишком большой ответ.'));}else chunks.push(b);});p.stderr.on('data',b=>err=(err+b.toString()).slice(-1500));p.on('error',e=>{clearTimeout(timer);reject(e);});p.on('close',code=>{clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(Error(err||'Не удалось прочитать видео.'));});});}
async function inspectFile(file){const raw=await capture('ffprobe',['-v','quiet','-show_format','-show_streams','-of','json',file]);const d=JSON.parse(raw);if(!d.streams?.some(s=>s.codec_type==='video'||s.codec_type==='audio'))throw Error('Медиафайл не читается.');return d;}
async function recoverFinished(){for(const j of queue){if(j.state!=='error'||j.error!=='Сайт не создал итоговый файл.'||!j.file)continue;let candidate=path.join(j.folder,path.basename(j.file));if(!fs.existsSync(candidate)){try{const key=crypto.createHash('sha256').update(j.url+'|'+j.quality).digest('hex').slice(0,8);const matches=fs.readdirSync(j.folder).filter(name=>name.includes('-'+j.quality+'-'+key+']')&&/\.(mp4|mkv|webm|mp3|m4a)$/i.test(name));if(matches.length!==1)continue;candidate=path.join(j.folder,matches[0]);}catch{continue;}}try{await inspectFile(candidate);j.file=candidate;j.state='done';j.percent=100;j.error='';j.recovered=true;}catch{}}save();}
async function limitedFetch(url,{referer,limit=8e6}={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await net.fetch(validUrl(url),{signal:controller.signal,headers:referer?{'Referer':referer}:{}});if(!response.ok)throw Error('Сайт ответил HTTP '+response.status);if(Number(response.headers.get('content-length'))>limit){controller.abort();throw Error('Ответ слишком большой.');}const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit){controller.abort();throw Error('Ответ страницы слишком большой.');}chunks.push(Buffer.from(chunk));}return {body:Buffer.concat(chunks),type:response.headers.get('content-type')||''};}finally{clearTimeout(timer);}}
async function thumbnail(video){if(video.thumbnail){try{const r=await limitedFetch(video.thumbnail,{referer:video.pageUrl,limit:4e6});if(/^image\/(jpeg|png|webp)/i.test(r.type))return 'data:'+r.type.split(';')[0]+';base64,'+r.body.toString('base64');}catch{}}
  const source=offeredFormats(video).find(f=>/\.(mp4|webm)(?:[?#]|$)/i.test(f.url))||offeredFormats(video)[0];if(!source)return null;
  try{const args=['-hide_banner','-loglevel','error','-rw_timeout','10000000'];if(video.pageUrl)args.push('-referer',video.pageUrl);args.push('-i',source.url,'-frames:v','1','-vf','scale=480:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1');return 'data:image/jpeg;base64,'+(await capture('ffmpeg',args,3e6,16000)).toString('base64');}catch{
    const temporary=path.join(app.getPath('temp'),'videolov-preview-'+crypto.randomUUID()+'.mp4');try{const r=await limitedFetch(source.url,{referer:video.pageUrl,limit:12e6});fs.writeFileSync(temporary,r.body);const picture=await capture('ffmpeg',['-hide_banner','-loglevel','error','-i',temporary,'-frames:v','1','-vf','scale=480:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],3e6);return 'data:image/jpeg;base64,'+picture.toString('base64');}catch{return null;}finally{try{fs.unlinkSync(temporary);}catch{}}}}
function canonical(url){const u=new URL(url);return u.origin+u.pathname;}
async function analyzeSource(value){const url=validUrl(value);if(discovering)throw Error('Дождитесь предыдущего анализа.');discovering=true;
  try{let videos=[],pageTitle='',blocked=false,extractError;
    // Prefer product data for marketplaces: it can contain several videos.
    const marketplace=/(^|\.)(alibaba\.com|aliexpress\.[a-z.]+|ozon\.ru|wildberries\.ru|market\.yandex\.ru|amazon\.[a-z.]+)$/.test(new URL(url).hostname);
    if(marketplace){try{const r=await limitedFetch(url);const d=discoverHtml(r.body.toString('utf8'),url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch{}}
    if(!videos.length){try{const raw=await run(['--ignore-config','--encoding','utf-8','--no-playlist','--skip-download','--dump-single-json','--socket-timeout','15','--retries','1','--js-runtimes',`node:${tool('node')}`,'--',url]);const d=JSON.parse(raw);videos=metadataEntries(d,url);pageTitle=d.title||pageTitle;}catch(e){extractError=e;}}
    if(!videos.length&&view&&!view.webContents.isDestroyed()&&browserUrl&&canonical(browserUrl)===canonical(url)){try{const html=await view.webContents.executeJavaScript('document.documentElement.outerHTML.slice(0,8000000)');const d=discoverHtml(html,url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch{}}
    if(!videos.length&&!marketplace){try{const r=await limitedFetch(url);const d=discoverHtml(r.body.toString('utf8'),url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch{}}
    if(!videos.length)throw Error(blocked?'Сайт запрашивает проверку посетителя. Нажмите «Открыть сайт», выполните проверку самостоятельно, затем повторите анализ.':('На странице пока не найдено видео. Откройте сайт во встроенном браузере, включите видео и повторите анализ.'+(extractError?'':' Без доступного видеопотока скачать файл невозможно.')));
    const analysisId=crypto.randomUUID();const record={url,videos};analyzed.set(analysisId,record);while(analyzed.size>8)analyzed.delete(analyzed.keys().next().value);
    const summaries=[];
    for(const [index,v] of videos.slice(0,24).entries()){v.key=crypto.randomUUID();let formats=offeredFormats(v);if(v.mode==='direct'&&formats.length===1&&!formats[0].height){try{const d=await inspectFile(formats[0].url),stream=d.streams.find(s=>s.codec_type==='video');if(stream){Object.assign(formats[0],{height:stream.height,width:stream.width});v.duration=+d.format.duration||null;}}catch{}}
      v.choices=formats.map((f,i)=>({...f,key:'f'+i}));const preview=v.choices.find(f=>f.acodec!=='none'&&/mp4|webm/i.test(f.ext))||v.choices[0];
      summaries.push({id:v.key,title:v.title,duration:v.duration||null,thumbnail:index<6?await thumbnail(v):null,previewUrl:preview&&/mp4|webm/i.test(preview.ext)?preview.url:null,formats:v.choices.map(f=>({id:f.key,height:f.height,width:f.width,ext:f.ext||'mp4',filesize:f.filesize||null,label:f.height?`${f.height}p${f.width?' · '+f.width+'×'+f.height:''}`:'Исходное качество'}))});
    }
    return {analysisId,sourceUrl:url,title:pageTitle||summaries[0].title,videos:summaries};
  }finally{discovering=false;}
}
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
app.whenReady().then(async()=>{
  require('electron').Menu.setApplicationMenu(null);
  app.setAppUserModelId('io.github.m0904sha.videolov');storeFile=path.join(app.getPath('userData'),'state.json');
  try{store=JSON.parse(fs.readFileSync(storeFile,'utf8'));}catch{store={};}
  if(fs.existsSync(storeFile)&&!fs.existsSync(path.join(app.getPath('userData'),'state-before-1.1.0.json')))fs.copyFileSync(storeFile,path.join(app.getPath('userData'),'state-before-1.1.0.json'));
  store.folder=store.folder||path.join(app.getPath('videos'),'ВидеоЛов');queue=Array.isArray(store.jobs)?store.jobs.slice(-100):[];
  for(const j of queue){if(['queued','downloading'].includes(j.state))j.state='cancelled';delete j.cookieFile;}
  await recoverFinished();
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
  handle('analyze',analyzeSource);
  handle('add',async(input)=>{let url=validUrl(input.url),chosen,source;
    if(input.analysisId){const record=analyzed.get(input.analysisId);if(!record||record.url!==url)throw Error('Ссылка изменилась. Повторите анализ.');source=record.videos.find(v=>v.key===input.videoId);if(!source)throw Error('Выберите найденное видео.');chosen=input.quality==='audio'?offeredFormats(source)[0]:source.choices.find(f=>f.key===input.quality);if(!chosen)throw Error('Выберите доступное качество.');url=source.mode==='direct'?chosen.url:source.pageUrl;}
    if(queue.filter(j=>['queued','downloading'].includes(j.state)).length>=30)throw Error('В очереди уже 30 загрузок.');const detected=input.mediaId?media.find(m=>m.id===input.mediaId):null;
    const quality=source?(input.quality==='audio'?'audio':chosen.height?String(chosen.height):'best'):(['best','2160','1080','720','540','480','360','audio'].includes(input.quality)?input.quality:'best');
    const j={id:crypto.randomUUID(),url,title:source?.title||input.title?.slice(0,250)||detected?.title||new URL(url).hostname,quality,folder:store.folder,state:'queued',percent:0,created:new Date().toISOString()};
    if(source){j.sourceUrl=validUrl(input.url);j.referer=j.sourceUrl;if(input.quality!=='audio'&&source.mode==='extractor')j.format=chosen.acodec==='none'?chosen.id+'+ba/'+chosen.id:chosen.id;if(source.mode==='direct')j.outputTitle=source.title;}
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
