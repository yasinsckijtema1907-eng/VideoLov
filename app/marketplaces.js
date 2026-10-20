// Copyright (c) 2026 M0904sha. GPL-3.0-or-later.
// Public product metadata only. No page JavaScript is evaluated.
const {validUrl,mediaKind}=require('./core');
function siteKind(value){const h=new URL(validUrl(value)).hostname.toLowerCase();return /(^|\.)(wildberries\.ru|wb\.ru)$/.test(h)?'wildberries':/(^|\.)ozon\.(ru|com)$/.test(h)?'ozon':/(^|\.)aliexpress\.(com|ru|us|[a-z]{2})$/.test(h)?'aliexpress':/(^|\.)alibaba\.com$/.test(h)?'alibaba':null;}
function decode(value){return String(value||'').replace(/&#(?:x([0-9a-f]+)|(\d+));/gi,(_,hex,n)=>String.fromCodePoint(Math.min(0x10ffff,parseInt(hex||n,hex?16:10)))).replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/\\u002[fF]|\\\//g,'/');}
function url(value,base){if(typeof value!=='string'||!value.trim())return null;try{return validUrl(new URL(decode(value),base).href);}catch{return null;}}
function parseProductData(data,sourceUrl,title='Видео товара'){
  const videos=[],seen=new Set();let visited=0;
  function add(obj,context){
    if(obj.has_drm||obj.drm||obj.isDrm||obj.licenseUrl)return;
    const formats=[];const push=(v,key)=>{if(typeof v==='string')v={url:v};if(!v||typeof v!=='object')return;const link=url(v.url||v.src||v.videoUrl||v.playUrl||v.contentUrl||v.videoPath,sourceUrl);if(!link)return;let kind;try{kind=mediaKind(link,v.mimeType||v.type||'');}catch{}if(!kind)return;const label=String(v.quality||v.definition||key||'');formats.push({id:label||String(formats.length),url:link,height:+v.height||+label.match(/(?:^|\D)(\d{3,4})p?(?:\D|$)/)?.[1]||null,width:+v.width||null,ext:kind==='HLS'||kind==='DASH'?'mp4':new URL(link).pathname.split('.').pop().toLowerCase(),protocol:kind==='HLS'?'m3u8_native':kind==='DASH'?'dash':'https',filesize:+(v.size||v.length||v.filesize)||null,vcodec:'unknown',acodec:'unknown',watermarked:v.has_watermark===true||v.watermark===true});};
    for(const key of ['videoUrl','video_url','playUrl','videoPath','contentUrl','url','src','mp4','hls','dash'])if(obj[key])push(obj[key],key);
    for(const key of ['formats','sources','variants','playInfoList','videoVersions','video_versions','videoUrlList','videoUrl']){const v=obj[key];if(v&&typeof v==='object')for(const [k,item] of Object.entries(v))push(item,k);}
    if(!formats.length||formats.every(f=>seen.has(f.url)))return;
    formats.forEach(f=>seen.add(f.url));videos.push({id:String(obj.videoId||obj.id||videos.length),title:obj.name||obj.title||title,thumbnail:url(obj.coverUrl||obj.videoCoverUrl||obj.thumbnailUrl||obj.thumbnail||obj.cover||obj.poster||obj.image,sourceUrl),duration:+obj.duration||null,formats,pageUrl:sourceUrl,mode:'direct'});
  }
  function walk(obj,context='',depth=0){if(++visited>30000||depth>22||videos.length>=24||obj==null)return;
    if(typeof obj==='string'){if(obj.length<4e6&&/^\s*[\[{]/.test(obj)){try{walk(JSON.parse(obj),context,depth+1);}catch{}}return;}
    if(typeof obj!=='object')return;
    const videoContext=/video|gallery|media|multimedia|playinfo/i.test(context)||/video/i.test(obj.type||obj['@type']||'')||obj.videoId||obj.videoUrl||obj.video_url||obj.videoPath;
    if(videoContext&&!Array.isArray(obj))add(obj,context);
    for(const [key,value] of Object.entries(obj)){if(/recommend|advert|sponsor|tracking|analytics|relatedProducts/i.test(key))continue;walk(value,context+'/'+key,depth+1);}
  }
  walk(data);return videos;
}
function structuredHtml(html,sourceUrl,title,assignedJson){
  const roots=[];for(const name of ['window.runParams','runParams','window.__INITIAL_STATE__','window.__initData','window._dida_config_','window.__PRELOADED_STATE__']){const d=assignedJson(html,name);if(d)roots.push(d);}
  for(const m of html.matchAll(/<script\b[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi)){try{roots.push(JSON.parse(m[1]));}catch{}}
  for(const m of html.matchAll(/\bdata-state\s*=\s*(?:'([^']*)'|"([^"]*)")/gi)){try{roots.push(JSON.parse(decode(m[1]||m[2])));}catch{}}
  return roots.flatMap(d=>parseProductData(d,sourceUrl,title));
}
async function discoverMarketplace(sourceUrl,fetchData){
  const kind=siteKind(sourceUrl),videos=[];if(!kind)return videos;
  if(kind==='ozon'){const u=new URL(sourceUrl);if(u.pathname.startsWith('/product/')){try{const endpoint=u.origin+'/api/entrypoint-api.bx/page/json/v2?url='+encodeURIComponent(u.pathname+u.search);const r=await fetchData(endpoint,{referer:sourceUrl});const d=JSON.parse(r.body.toString('utf8'));videos.push(...parseProductData(d,sourceUrl));}catch{}}}
  if(kind==='wildberries'){
    const id=new URL(sourceUrl).pathname.match(/\/catalog\/(\d+)\//)?.[1];if(!id)return videos;
    // Resolve current CDN hosts from Wildberries instead of freezing basket numbers.
    try{const r=await fetchData('https://cdn.wbbasket.ru/api/v3/upstreams');const config=JSON.parse(r.body.toString('utf8'));const routes=config.recommend?.videonme_route_map||[];const hosts=routes.flatMap(x=>x.hosts||[]).filter(x=>/^[\w.-]+\.(?:geobasket|wbbasket)\.ru$/.test(x.host));if(!hosts.length)return videos;const vol=Number(BigInt(id)%144n),part=String(BigInt(id)/10000n),host=hosts[vol%hosts.length].host;
      const results=await Promise.allSettled([2160,1440,1080,720,480,360].map(async height=>{const link=`https://${host}/vol${vol}/part${part}/${id}/hls/${height}p/index.m3u8`;const response=await fetchData(link,{referer:sourceUrl,limit:1000000});if(!response.body.toString('utf8').trimStart().startsWith('#EXTM3U'))throw Error('Not a playlist');return {id:String(height),url:link,height,ext:'mp4',protocol:'m3u8_native',vcodec:'unknown',acodec:'unknown'};}));const formats=results.filter(r=>r.status==='fulfilled').map(r=>r.value);if(formats.length)videos.push({id,title:'Wildberries · товар '+id,thumbnail:null,formats,pageUrl:sourceUrl,mode:'direct'});
    }catch{}
  }
  return videos;
}
function hlsVariants(text,base){if(!String(text).trimStart().startsWith('#EXTM3U'))return [];if(/SAMPLE-AES|KEYFORMAT="(?!identity)/i.test(text))return [];const lines=text.split(/\r?\n/),formats=[];for(let i=0;i<lines.length;i++){if(!lines[i].startsWith('#EXT-X-STREAM-INF:'))continue;const dims=lines[i].match(/RESOLUTION=(\d+)x(\d+)/);let next=i+1;while(next<lines.length&&(!lines[next].trim()||lines[next].startsWith('#')))next++;const link=url(lines[next],base);if(link)formats.push({id:'hls-'+formats.length,url:link,width:+dims?.[1]||null,height:+dims?.[2]||null,ext:'mp4',protocol:'m3u8_native',vcodec:'unknown',acodec:'unknown'});}return formats;}
module.exports={siteKind,decode,parseProductData,structuredHtml,discoverMarketplace,hlsVariants};
