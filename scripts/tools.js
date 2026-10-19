// Fetch official release artifacts. No credentials, browser profiles or user files are used.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const {execFileSync}=require('node:child_process');
const root=path.join(__dirname,'..','tools');fs.mkdirSync(root,{recursive:true});
const headers={'User-Agent':'VideoLov-build','Accept':'application/vnd.github+json'};
async function get(url,file){const r=await fetch(url,{headers});if(!r.ok)throw Error(url+': '+r.status);const data=Buffer.from(await r.arrayBuffer());if(file)fs.writeFileSync(path.join(root,file),data);return data;}
function hash(data){return crypto.createHash('sha256').update(data).digest('hex');}
async function unzip(zip,folder){await require('extract-zip')(path.join(root,zip),{dir:path.join(root,folder)});}
(async()=>{
  const release=JSON.parse(await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'));
  const sums=(await get(`https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/SHA2-256SUMS`)).toString();
  const ytdlp=await get(`https://github.com/yt-dlp/yt-dlp/releases/download/${release.tag_name}/yt-dlp.exe`,'yt-dlp.exe');
  const line=sums.split('\n').find(l=>/\s\*?yt-dlp\.exe$/.test(l.trim()));if(!line||line.split(/\s/)[0]!==hash(ytdlp))throw Error('yt-dlp checksum mismatch');
  await get(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/THIRD_PARTY_LICENSES.txt`,'yt-dlp-LICENSES.txt');
  const ff=JSON.parse(await get('https://api.github.com/repos/GyanD/codexffmpeg/releases/latest'));
  const asset=ff.assets.find(a=>a.name==='ffmpeg-'+ff.tag_name+'-essentials_build.zip')||ff.assets.find(a=>a.name.endsWith('essentials_build.zip'));
  if(!asset)throw Error('FFmpeg release asset not found');
  await get(asset.browser_download_url,'ffmpeg.zip');await unzip('ffmpeg.zip','ffmpeg-build');
  const folder=fs.readdirSync(path.join(root,'ffmpeg-build'))[0];const base=path.join(root,'ffmpeg-build',folder);
  for(const name of ['ffmpeg','ffprobe'])fs.copyFileSync(path.join(base,'bin',name+'.exe'),path.join(root,name+'.exe'));
  for(const name of fs.readdirSync(base))if(/licen|copying|readme/i.test(name)&&fs.statSync(path.join(base,name)).isFile())fs.copyFileSync(path.join(base,name),path.join(root,'ffmpeg-'+name));
  // Node is a standalone official runtime for yt-dlp's EJS support.
  const nodeVersion=process.version;const node=await get(`https://nodejs.org/dist/${nodeVersion}/win-x64/node.exe`,'node.exe');
  const nodeSums=(await get(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)).toString();const expected=nodeSums.split('\n').find(l=>l.endsWith('win-x64/node.exe'))?.split(/\s/)[0];if(expected!==hash(node))throw Error('Node checksum mismatch');
  await get(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`,'node-LICENSE.txt');
  fs.writeFileSync(path.join(root,'versions.json'),JSON.stringify({ytDlp:release.tag_name,ffmpeg:ff.tag_name,node:nodeVersion,source:{ytDlp:release.html_url,ffmpeg:ff.html_url,node:`https://nodejs.org/dist/${nodeVersion}/`},sha256:Object.fromEntries(['yt-dlp','ffmpeg','ffprobe','node'].map(n=>[n+'.exe',hash(fs.readFileSync(path.join(root,n+'.exe')))]))},null,2));
  // Keep extracted build/archive out of the application package.
  const scratch=path.resolve(root,'ffmpeg-build');if(path.dirname(scratch)!==path.resolve(root))throw Error('Unexpected scratch location');
  fs.rmSync(scratch,{recursive:true,force:true});fs.unlinkSync(path.join(root,'ffmpeg.zip'));console.log(fs.readFileSync(path.join(root,'versions.json'),'utf8'));
})().catch(e=>{console.error(e);process.exit(1);});
