// Copyright (c) 2026 M0904sha. GPL-3.0-or-later.
const {app,BrowserWindow,WebContentsView,session,ipcMain,dialog,shell,net,protocol}=require('electron');
const fs=require('node:fs'); const path=require('node:path');const {spawn}=require('node:child_process');const crypto=require('node:crypto');
const {SUPPORT,REPO,validUrl,mediaKind,downloadArgs,parseLine}=require('./core');
const {discoverHtml,metadataEntries,offeredFormats}=require('./discovery');
const {siteKind,parseProductData,discoverMarketplace,hlsVariants,verifiedProductVideos,hlsSample}=require('./marketplaces');
const {pathToFileURL}=require('node:url');
protocol.registerSchemesAsPrivileged([{scheme:'vl-preview',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true}}]);
const previewSources=new Map(),previewFiles=new Set();
const analyzed=new Map();let discovering=false;
let main,browserWin,view,storeFile,store,active=null,analysis=null;
let media=[],privateSession,browserUrl='',status='',queue=[];
if(process.env.NODE_ENV==='test'&&process.env.VIDEOLOV_TEST_USER_DATA)app.setPath('userData',process.env.VIDEOLOV_TEST_USER_DATA);
if(!app.requestSingleInstanceLock())app.exit(0);
app.on('second-instance',()=>{if(main){if(main.isMinimized())main.restore();main.focus();}});
const tools=path.join(app.isPackaged?process.resourcesPath:path.join(__dirname,'..'),'tools');
const tool=name=>path.join(tools,name+'.exe');
const tlsArgs=url=>/^https:/i.test(url)?['-tls_verify','1','-ca_file',path.join(tools,'cacert.pem')]:[];
const tlsDownloader='ffmpeg_i:-tls_verify 1 -ca_file '+JSON.stringify(path.join(tools,'cacert.pem').replaceAll('\\','/'));
const captures=new Set();
const referrerRequests=new Map(),referrerSessions=new WeakSet();
async function fetchSource(url,{referer,useSession=false,headers={},...options}={}){
  const target=validUrl(url),ses=useSession&&privateSession?privateSession:session.defaultSession;
  if(!referrerSessions.has(ses)){
    // Chromium rejects a manually supplied Referer in fetch(). Attach it at
    // the supported request-header stage, scoped to this one cached request.
    ses.webRequest.onBeforeSendHeaders({urls:['http://*/*','https://*/*']},(details,callback)=>{
      const key=Object.keys(details.requestHeaders).find(k=>k.toLowerCase()==='x-videolov-request'),record=key&&referrerRequests.get(details.requestHeaders[key]);
      if(key)delete details.requestHeaders[key];
      if(record&&new URL(details.url).origin===record.origin){for(const k of Object.keys(details.requestHeaders))if(k.toLowerCase()==='referer')delete details.requestHeaders[k];details.requestHeaders.Referer=record.referer;}
      callback({requestHeaders:details.requestHeaders});
    });referrerSessions.add(ses);
  }
  const token=referer?crypto.randomUUID():null;if(token)referrerRequests.set(token,{referer:validUrl(referer),origin:new URL(target).origin});
  try{return await ses.fetch(target,{...options,headers:{...headers,...(token?{'X-VideoLov-Request':token}:{})}});}finally{if(token)referrerRequests.delete(token);}
}
function save(){fs.writeFileSync(storeFile,JSON.stringify({folder:store.folder,jobs:queue.map(({cookieFile,...j})=>j)},null,2));}
function state(){return {version:app.getVersion(),author:'M0904sha',support:SUPPORT,repo:REPO,folder:store.folder,jobs:queue,media,browserUrl,status,ready:['yt-dlp','ffmpeg','ffprobe','node'].every(n=>fs.existsSync(tool(n)))&&fs.existsSync(path.join(tools,'cacert.pem'))};}
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
function capture(name,args,limit=8e6,timeout=18000){return new Promise((resolve,reject)=>{const p=spawn(tool(name),args,{windowsHide:true,stdio:['ignore','pipe','pipe']});captures.add(p);let chunks=[],bytes=0,err='';const timer=setTimeout(()=>{stopProcess(p);reject(Error('Время получения превью истекло.'));},timeout);p.stdout.on('data',b=>{bytes+=b.length;if(bytes>limit){stopProcess(p);reject(Error('Слишком большой ответ.'));}else chunks.push(b);});p.stderr.on('data',b=>err=(err+b.toString()).slice(-1500));p.on('error',e=>{captures.delete(p);clearTimeout(timer);reject(e);});p.on('close',code=>{captures.delete(p);clearTimeout(timer);code===0?resolve(Buffer.concat(chunks)):reject(Error(err||'Не удалось прочитать видео.'));});});}
async function inspectFile(file){const raw=await capture('ffprobe',['-v','quiet','-show_format','-show_streams','-of','json',...tlsArgs(file),file]);const d=JSON.parse(raw);if(!d.streams?.some(s=>s.codec_type==='video'||s.codec_type==='audio'))throw Error('Медиафайл не читается.');return d;}
async function recoverFinished(){for(const j of queue){if(j.state!=='error'||j.error!=='Сайт не создал итоговый файл.'||!j.file)continue;let candidate=path.join(j.folder,path.basename(j.file));if(!fs.existsSync(candidate)){try{const key=crypto.createHash('sha256').update(j.url+'|'+j.quality).digest('hex').slice(0,8);const matches=fs.readdirSync(j.folder).filter(name=>name.includes('-'+j.quality+'-'+key+']')&&/\.(mp4|mkv|webm|mp3|m4a)$/i.test(name));if(matches.length!==1)continue;candidate=path.join(j.folder,matches[0]);}catch{continue;}}try{await inspectFile(candidate);j.file=candidate;j.state='done';j.percent=100;j.error='';j.recovered=true;}catch{}}save();}
async function limitedFetch(url,{referer,limit=8e6,useSession=false,method='GET'}={}){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);try{const response=await fetchSource(url,{method,signal:controller.signal,referer,useSession});if(!response.ok){const error=Error('Сайт ответил HTTP '+response.status);error.status=response.status;throw error;}if(method==='HEAD')return {body:Buffer.alloc(0),type:response.headers.get('content-type')||'',url:response.url,size:Number(response.headers.get('content-length'))||null};if(Number(response.headers.get('content-length'))>limit){controller.abort();throw Error('Ответ слишком большой.');}const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>limit){controller.abort();throw Error('Ответ страницы слишком большой.');}chunks.push(Buffer.from(chunk));}return {body:Buffer.concat(chunks),type:response.headers.get('content-type')||'',url:response.url};}finally{clearTimeout(timer);}}
async function thumbnail(video){if(video.thumbnail){try{const r=await limitedFetch(video.thumbnail,{referer:video.pageUrl,limit:4e6,useSession:video.useSession});if(/^image\/(jpeg|png|webp)/i.test(r.type))return 'data:'+r.type.split(';')[0]+';base64,'+r.body.toString('base64');}catch{}}
  const ordered=[...offeredFormats(video)].reverse();const source=video.formats.find(f=>f.height>=128&&f.height<=360&&f.acodec!=='none'&&/m3u8/.test(f.protocol||''))||ordered.find(f=>f.acodec!=='none'&&/\.(mp4|webm)(?:[?#]|$)/i.test(f.url))||ordered.find(f=>f.acodec!=='none')||ordered[0];if(!source)return null;
  try{const args=['-hide_banner','-loglevel','error','-rw_timeout','10000000'];if(video.pageUrl)args.push('-referer',video.pageUrl);if(video.userAgent)args.push('-user_agent',video.userAgent);args.push(...tlsArgs(source.url),'-i',source.url,'-frames:v','1','-vf','scale=480:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1');return 'data:image/jpeg;base64,'+(await capture('ffmpeg',args,3e6,16000)).toString('base64');}catch{
    const temporary=path.join(app.getPath('temp'),'videolov-preview-'+crypto.randomUUID()+'.mp4');try{const r=await limitedFetch(source.url,{referer:video.pageUrl,limit:12e6});fs.writeFileSync(temporary,r.body);const picture=await capture('ffmpeg',['-hide_banner','-loglevel','error','-i',temporary,'-frames:v','1','-vf','scale=480:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],3e6);return 'data:image/jpeg;base64,'+picture.toString('base64');}catch{return null;}finally{try{fs.unlinkSync(temporary);}catch{}}}}
function canonical(url){const u=new URL(url);return u.origin+u.pathname;}
async function renderProduct(url,useSession){
  // Normal sandboxed page load, including public XHR metadata. No player clicks,
  // security interstitial bypasses, CAPTCHA automation, or access to Chrome.
  const scan=new BrowserWindow({show:false,webPreferences:{session:useSession?privateSession:session.fromPartition('scan-'+crypto.randomUUID()),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  const wc=scan.webContents;secureWeb(wc);wc.session.setPermissionRequestHandler((_,__,cb)=>cb(false));const found=[];
  try{
    wc.loadURL(url).catch(()=>{});const start=Date.now();let last={videos:[],blocked:false};while(Date.now()-start<16000&&!wc.isDestroyed()){await new Promise(resolve=>setTimeout(resolve,800));try{const html=await Promise.race([wc.executeJavaScript('document.documentElement.outerHTML.slice(0,8000000)'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Page not ready')),2000))]);last=discoverHtml(html,url);if(last.videos.length)return last;if(found.length)return {title:last.title,videos:found.slice(0,24)};}catch{}}
    return last;
  }finally{if(!scan.isDestroyed())scan.destroy();}
}
function extractionArgs(url,cookies){return ['--ignore-config','--encoding','utf-8','--no-playlist','--skip-download','--dump-single-json','--socket-timeout','15','--retries','1','--js-runtimes',`node:${tool('node')}`,...(cookies?['--cookies',cookies]:[]),'--',url];}
function friendlyError(message){if(/DRM protected|DRM-protected/i.test(message))return 'Видео защищено DRM. Доступного для сохранения потока нет.';if(/login|sign in|cookies|authentication|private|age.restricted/i.test(message))return 'Для этого видео нужен вход. Откройте сайт во встроенном браузере, войдите, включите «Использовать вход» и повторите поиск.';if(/unavailable|not available|removed|deleted|404/i.test(message))return 'Сайт сообщает, что видео недоступно или удалено. Проверьте ссылку во встроенном браузере.';return '';}
async function analyzeSource(value){const input=typeof value==='string'?{url:value}:value;const url=validUrl(input.url),useSession=input.useSession===true;if(discovering)throw Error('Дождитесь предыдущего анализа.');if(useSession&&!privateSession)throw Error('Сначала откройте сайт во встроенном браузере и войдите.');discovering=true;let cookies;
  try{let videos=[],pageTitle='',blocked=false,extractError;cookies=useSession?await cookieFile(url):null;
    const fetchPage=(u,options={})=>limitedFetch(u,{...options,useSession});
    const marketplace=siteKind(url)||/(^|\.)(market\.yandex\.ru|amazon\.[a-z.]+)$/.test(new URL(url).hostname);
    if(marketplace){try{const r=await fetchPage(url);const d=discoverHtml(r.body.toString('utf8'),r.url||url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch(e){blocked=[403,429,498].includes(e.status);}}
    if(!videos.length&&siteKind(url))videos=await discoverMarketplace(url,fetchPage);
    if(!videos.length&&marketplace){try{const d=await renderProduct(url,useSession);videos=d.videos;pageTitle=d.title||pageTitle;blocked=blocked||d.blocked;}catch{}}
    if(!videos.length&&!marketplace){try{const raw=await run(extractionArgs(url,cookies));const d=JSON.parse(raw);videos=metadataEntries(d,url);pageTitle=d.title||pageTitle;}catch(e){extractError=e;}}
    if(!videos.length&&view&&!view.webContents.isDestroyed()&&browserUrl&&canonical(browserUrl)===canonical(url)){try{const html=await view.webContents.executeJavaScript('document.documentElement.outerHTML.slice(0,8000000)');const d=discoverHtml(html,url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch{}}
    if(!videos.length&&!marketplace){try{const r=await fetchPage(url);const d=discoverHtml(r.body.toString('utf8'),r.url||url);videos=d.videos;pageTitle=d.title;blocked=d.blocked;}catch{}}
    if(!videos.length&&browserUrl&&canonical(browserUrl)===canonical(url)){videos=media.filter(m=>m.referer&&canonical(m.referer)===canonical(url)).slice(0,12).map(m=>({id:m.id,title:m.title,mode:'direct',pageUrl:url,formats:[{id:'stream',url:m.url,ext:'mp4',protocol:m.kind==='HLS'?'m3u8_native':m.kind==='DASH'?'dash':'https'}]}));}
    if(!videos.length)throw Error(blocked?'Сайт запрашивает проверку посетителя. Нажмите «Открыть сайт», выполните проверку самостоятельно, затем повторите анализ.':friendlyError(extractError?.message||'')||'На странице пока не найден доступный видеопоток. Откройте сайт во встроенном браузере и повторите поиск.');
    if(siteKind(url)==='wildberries')videos=await verifiedProductVideos(videos,async link=>{
      if(/\.m3u8(?:[?#]|$)/i.test(link)){
        const temporary=path.join(app.getPath('temp'),'videolov-inspect-'+crypto.randomUUID()+'.ts');
        try{const manifest=await fetchPage(link,{referer:url,limit:1e6}),sample=hlsSample(manifest.body.toString('utf8'),link);if(sample){const chunk=await fetchPage(sample.url,{referer:url,limit:8e6});fs.writeFileSync(temporary,chunk.body);const d=await inspectFile(temporary);d.format.duration=String(sample.duration);return d;}}catch{}finally{try{fs.unlinkSync(temporary);}catch{}}
      }
      return inspectFile(link);
    });
    const analysisId=crypto.randomUUID();const record={url,videos,useSession};analyzed.set(analysisId,record);while(analyzed.size>8)analyzed.delete(analyzed.keys().next().value);
    const summaries=[];
    for(const [index,v] of videos.slice(0,24).entries()){v.key=crypto.randomUUID();v.useSession=useSession;
      if(v.mode==='direct'&&v.formats.length===1&&(!v.formats[0].width||!v.formats[0].height)&&/m3u8|dash|\.mpd|\.m3u8/i.test(v.formats[0].protocol+' '+v.formats[0].url)){const manifest=v.formats[0].url;try{const d=JSON.parse(await run(extractionArgs(manifest,cookies))),expanded=metadataEntries(d,url)[0];if(expanded?.formats.length){v.formats=expanded.formats;v.mode='extractor';v.extractUrl=manifest;v.duration=v.duration||expanded.duration;}}catch{try{const r=await fetchPage(manifest,{referer:url});const variants=hlsVariants(r.body.toString('utf8'),manifest);if(variants.length)v.formats=variants;}catch{}}}
      let formats=offeredFormats(v);if(v.mode==='direct'&&formats.length===1&&(!formats[0].height||!formats[0].width)){try{const d=await inspectFile(formats[0].url),stream=d.streams.find(s=>s.codec_type==='video');if(stream){Object.assign(formats[0],{height:stream.height,width:stream.width});v.duration=+d.format.duration||null;}}catch{}}
      v.choices=formats.map((f,i)=>({...f,key:'f'+i}));const preview=v.choices.find(f=>f.acodec!=='none'&&/mp4|webm/i.test(f.ext)&&!/(m3u8|dash)/i.test(f.protocol||''))||v.choices[0];
      let previewUrl=null;if(preview&&!/(m3u8|dash)/i.test(preview.protocol||'')&&!/\.(m3u8|mpd)(?:[?#]|$)/i.test(preview.url)){const token=crypto.randomUUID();previewSources.set(token,{url:preview.url,referer:v.pageUrl,useSession});while(previewSources.size>100)previewSources.delete(previewSources.keys().next().value);previewUrl='vl-preview://'+token+'/video';}
      summaries.push({id:v.key,title:v.title,duration:v.duration||null,thumbnail:index<6?await Promise.race([thumbnail(v),new Promise(resolve=>setTimeout(()=>resolve(null),8000))]):null,previewUrl,previewClip:!previewUrl,formats:v.choices.map(f=>({id:f.key,height:f.height,width:f.width,ext:f.ext||'mp4',filesize:f.filesize||null,label:(f.height?`${f.height}p${f.width?' · '+f.width+'×'+f.height:''}`:'Исходное качество')+(f.watermarked?' · знак в исходнике':'')}))});
    }
    return {analysisId,sourceUrl:url,title:pageTitle||summaries[0].title,videos:summaries};
  }finally{if(cookies)try{fs.unlinkSync(cookies);}catch{}discovering=false;}
}
async function previewClip(input){
  const record=analyzed.get(input.analysisId),v=record?.videos.find(v=>v.key===input.videoId);if(!v)throw Error('Повторите поиск видео.');if(v.clipUrl)return v.clipUrl;
  const f=v.formats.find(f=>f.height>=128&&f.height<=360&&f.acodec!=='none'&&/m3u8/.test(f.protocol||''))||[...v.choices].reverse().find(f=>f.height>=240&&f.height<=720)||v.choices.at(-1);if(!f)throw Error('Нет доступного потока.');
  const file=path.join(app.getPath('temp'),'videolov-preview-'+crypto.randomUUID()+'.mp4'),temporary=path.join(app.getPath('temp'),'videolov-preview-input-'+crypto.randomUUID()+'.mp4');previewFiles.add(file);
  const make=(source,remote)=>capture('ffmpeg',['-hide_banner','-loglevel','error','-y',...(remote?[...tlsArgs(source),'-rw_timeout','10000000','-referer',v.pageUrl,...(v.userAgent?['-user_agent',v.userAgent]:[])]:[]),'-i',source,'-t','6','-vf','scale=480:-2','-c:v','libx264','-preset','ultrafast','-crf','28','-c:a','aac','-movflags','+faststart','-fs','8000000',file],10000,20000);
  try{if(v.mode==='extractor'){let cookie;try{cookie=v.useSession?await cookieFile(v.pageUrl):null;await capture('yt-dlp',['--ignore-config','--encoding','utf-8','--no-playlist','--no-progress','--no-warnings','--socket-timeout','12','--retries','1','--ffmpeg-location',tools,'--js-runtimes',`node:${tool('node')}`,'--download-sections','*0-6','--downloader-args','ffmpeg:-fs 8000000',...(/^https:/i.test(v.extractUrl||v.pageUrl)?['--downloader-args',tlsDownloader]:[]),'-f','b[height<=480]/bv[height<=480]+ba/b','--merge-output-format','mp4','--remux-video','mp4','-o',temporary,...(cookie?['--cookies',cookie]:[]),'--',v.extractUrl||v.pageUrl],1000000,45000);await make(temporary,false);}finally{if(cookie)try{fs.unlinkSync(cookie);}catch{}}}else{try{await make(f.url,true);}catch(e){let source=f.url;if(/m3u8/.test(f.protocol||'')){const manifest=await limitedFetch(f.url,{referer:v.pageUrl,useSession:v.useSession,limit:1e6}),sample=hlsSample(manifest.body.toString('utf8'),f.url);if(!sample)throw e;source=sample.url;}else if(/dash/.test(f.protocol||''))throw e;const response=await limitedFetch(source,{referer:v.pageUrl,useSession:v.useSession,limit:12e6});fs.writeFileSync(temporary,response.body);await make(temporary,false);}}const token=crypto.randomUUID();previewSources.set(token,{file});v.clipUrl='vl-preview://'+token+'/clip.mp4';return v.clipUrl;
  }catch(e){try{fs.unlinkSync(file);}catch{}previewFiles.delete(file);throw Error('Не удалось подготовить отрывок. Превью-кадр и скачивание остаются доступны.');}finally{try{fs.unlinkSync(temporary);}catch{}}
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
  const target=validUrl(url);const cookies=await privateSession.cookies.get({url:target});if(!cookies.length)return null;
  const file=path.join(app.getPath('userData'),'cookies-'+crypto.randomUUID()+'.txt');
  // Only cookies applicable to this origin; never export a whole browser profile.
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
    browserWin=new BrowserWindow({width:1100,height:780,title:'Браузер VideoLov — включите видео на странице',backgroundColor:'#10151f',webPreferences:{preload:path.join(__dirname,'browser-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
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
  protocol.handle('vl-preview',async request=>{const token=new URL(request.url).hostname,p=previewSources.get(token);if(!p)return new Response('Expired',{status:404});if(p.file)return net.fetch(pathToFileURL(p.file).href,{headers:request.headers.has('range')?{Range:request.headers.get('range')}:{}});const headers={};if(request.headers.has('range'))headers.Range=request.headers.get('range');return fetchSource(p.url,{headers,referer:p.referer,useSession:p.useSession,signal:AbortSignal.any([request.signal,AbortSignal.timeout(12000)])});});
  require('electron').Menu.setApplicationMenu(null);
  app.setAppUserModelId('io.github.m0904sha.videolov');app.userAgentFallback=app.userAgentFallback.replace(/(?:Electron|videolov|VideoLov)\/[^\s]+\s?/g,'');storeFile=path.join(app.getPath('userData'),'state.json');
  try{store=JSON.parse(fs.readFileSync(storeFile,'utf8'));}catch{store={};}
  if(fs.existsSync(storeFile)&&!fs.existsSync(path.join(app.getPath('userData'),'state-before-1.1.0.json')))fs.copyFileSync(storeFile,path.join(app.getPath('userData'),'state-before-1.1.0.json'));
  store.folder=store.folder||path.join(app.getPath('videos'),'VideoLov');queue=Array.isArray(store.jobs)?store.jobs.slice(-100):[];
  for(const j of queue){if(['queued','downloading'].includes(j.state))j.state='cancelled';delete j.cookieFile;}
  await recoverFinished();
  // Remove transient cookies after an interrupted session.
  for(const f of fs.readdirSync(app.getPath('userData')))if(/^cookies-[\w-]+\.txt$/.test(f))try{fs.unlinkSync(path.join(app.getPath('userData'),f));}catch{}
  main=new BrowserWindow({width:1180,height:820,minWidth:960,minHeight:680,title:'VideoLov',icon:path.join(__dirname,'icon.ico'),backgroundColor:'#0d111a',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  main.on('closed',()=>app.quit());
  ipcMain.handle('browserAction',async(e,action,url)=>{if(!browserWin||e.sender.id!==browserWin.webContents.id)throw Error('Доступ запрещён');if(action==='go')return browserOpen(url);if(action==='back'&&view.webContents.navigationHistory.canGoBack())view.webContents.navigationHistory.goBack();if(action==='forward'&&view.webContents.navigationHistory.canGoForward())view.webContents.navigationHistory.goForward();if(action==='return'){main.show();main.focus();}return browserUrl;});
  main.webContents.setWindowOpenHandler(()=>({action:'deny'}));main.webContents.on('will-navigate',e=>e.preventDefault());main.loadFile(path.join(__dirname,'index.html'));
  handle('state',()=>state());handle('support',()=>shell.openExternal(SUPPORT));handle('github',()=>shell.openExternal(REPO));
  handle('chooseFolder',async()=>{const d=await dialog.showOpenDialog(main,{defaultPath:store.folder,properties:['openDirectory','createDirectory']});if(!d.canceled){store.folder=d.filePaths[0];save();broadcast();}return store.folder;});
  handle('openFolder',async()=>{fs.mkdirSync(store.folder,{recursive:true});return shell.openPath(store.folder);});
  handle('reveal',id=>{const j=queue.find(j=>j.id===id);if(!j?.file||!fs.existsSync(j.file))throw Error('Файл не найден.');shell.showItemInFolder(j.file);});
  handle('analyze',analyzeSource);handle('preview',previewClip);
  handle('add',async(input)=>{let url=validUrl(input.url),chosen,source;
    if(input.analysisId){const record=analyzed.get(input.analysisId);if(!record||record.url!==url)throw Error('Ссылка изменилась. Повторите анализ.');source=record.videos.find(v=>v.key===input.videoId);if(!source)throw Error('Выберите найденное видео.');chosen=input.quality==='audio'?offeredFormats(source)[0]:source.choices.find(f=>f.key===input.quality);if(!chosen)throw Error('Выберите доступное качество.');url=source.mode==='direct'?chosen.url:(source.extractUrl||source.pageUrl);}
    if(queue.filter(j=>['queued','downloading'].includes(j.state)).length>=30)throw Error('В очереди уже 30 загрузок.');const detected=input.mediaId?media.find(m=>m.id===input.mediaId):null;
    const quality=source?(input.quality==='audio'?'audio':chosen.height?String(chosen.height):'best'):(['best','2160','1080','720','540','480','360','audio'].includes(input.quality)?input.quality:'best');
    const j={id:crypto.randomUUID(),url,title:source?.title||input.title?.slice(0,250)||detected?.title||new URL(url).hostname,quality,folder:store.folder,state:'queued',percent:0,created:new Date().toISOString()};
    if(source){j.sourceUrl=validUrl(input.url);j.referer=j.sourceUrl;if(input.quality!=='audio'&&source.mode==='extractor')j.format=chosen.acodec==='none'?chosen.id+'+ba/'+chosen.id:chosen.id;if(source.mode==='direct')j.outputTitle=source.title;}
    if(detected){if(detected.url!==url)throw Error('Поток изменился.');j.referer=detected.referer;j.userAgent=view?.webContents.getUserAgent();}
    if(input.useSession){if(!privateSession)throw Error('Откройте сайт во встроенном браузере.');j.cookieFile=await cookieFile(source?.pageUrl||url);}
    queue.push(j);save();broadcast();pump();return j.id;
  });
  handle('cancel',id=>{const j=queue.find(j=>j.id===id);if(j&&['queued','downloading'].includes(j.state)){j.state='cancelled';if(active?.job.id===id)stopProcess(active.process);else cleanupCookie(j);save();broadcast();}});
  handle('retry',id=>{const j=queue.find(j=>j.id===id);if(j&&['error','cancelled'].includes(j.state)){j.state='queued';j.error='';save();broadcast();pump();}});
  handle('clearHistory',()=>{queue=queue.filter(j=>['queued','downloading'].includes(j.state));save();broadcast();});
  handle('browserOpen',browserOpen);handle('browserNavigate',browserOpen);handle('browserHide',()=>browserWin?.hide());handle('browserCurrent',()=>browserUrl);
  handle('browserClear',async()=>{media=[];if(privateSession){await privateSession.clearStorageData();await privateSession.clearCache();}broadcast();});
});
app.on('window-all-closed',()=>app.quit());app.on('before-quit',()=>{if(active){active.job.state='cancelled';stopProcess(active.process);}if(analysis)stopProcess(analysis);for(const p of captures)stopProcess(p);for(const j of queue)cleanupCookie(j);for(const file of previewFiles)try{fs.unlinkSync(file);}catch{}if(storeFile)save();});
