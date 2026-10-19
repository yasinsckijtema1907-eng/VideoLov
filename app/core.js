// Copyright (c) 2026 M0904sha. GPL-3.0-or-later.
const path = require('node:path');
const crypto = require('node:crypto');
const SUPPORT = 'https://finance.ozon.ru/apps/sbp/ozonbankpay/01a15626-f41a-7445-915d-3349d0f96806';
const REPO = 'https://github.com/yasinsckijtema1907-eng/VideoLov';
function validUrl(value) {
  if(typeof value !== 'string' || value.length > 16384) throw Error('Вставьте ссылку HTTP или HTTPS.');
  let u; try {u = new URL(value.trim());} catch {throw Error('Не удалось прочитать ссылку.');}
  if(!['http:','https:'].includes(u.protocol) || u.username || u.password) throw Error('Нужна ссылка HTTP или HTTPS без пароля в адресе.');
  return u.href;
}
function mediaKind(url, mime='') {
  const pathname = new URL(url).pathname.toLowerCase();
  if(/\.(ts|m4s|cmfv|cmfa)$/.test(pathname) || /mp2t/i.test(mime)) return null;
  if(/\.m3u8$/.test(pathname) || /mpegurl/i.test(mime)) return 'HLS';
  if(/\.mpd$/.test(pathname) || /dash\+xml/i.test(mime)) return 'DASH';
  if(/\.(mp4|webm|mov|m4v|mkv)$/.test(pathname) || /^video\//i.test(mime)) return 'Видео';
  return null;
}
function selection(quality) {
  if(quality === 'audio') return ['-f','bestaudio/best','-x','--audio-format','mp3'];
  const max = {'2160':2160,'1080':1080,'720':720,'480':480}[quality];
  return ['-f',max ? `bv*[height<=?${max}]+ba/b[height<=?${max}]` : 'bv*+ba/b','--merge-output-format','mp4/mkv'];
}
function downloadArgs(job, tools) {
  const key=crypto.createHash('sha256').update(job.url+'|'+job.quality).digest('hex').slice(0,8);
  const args=['--ignore-config','--no-playlist','--no-colors','--newline','--windows-filenames','--no-overwrites','--socket-timeout','20','--retries','3','--ffmpeg-location',tools,'--js-runtimes',`node:${path.join(tools,'node.exe')}`,
    '--progress-template','download:VL_PROGRESS:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print','before_dl:VL_TITLE:%(title)s','--print','after_move:VL_FILE:%(filepath)s',
    '-o',path.join(job.folder,`%(title).120B [%(id).40B-${job.quality}-${key}].%(ext)s`),...selection(job.quality)];
  if(job.referer) args.push('--referer',validUrl(job.referer));
  if(job.userAgent) args.push('--user-agent',job.userAgent);
  if(job.cookieFile) args.push('--cookies',job.cookieFile);
  args.push('--',validUrl(job.url)); return args;
}
function parseLine(line) {
  if(line.startsWith('VL_TITLE:')) return {title:line.slice(9)};
  if(line.startsWith('VL_FILE:')) return {file:line.slice(8)};
  if(line.startsWith('VL_PROGRESS:')) {const [p,speed,eta]=line.slice(12).split('|');return {percent:Math.min(100,Math.max(0,parseFloat(p)||0)),speed:speed?.trim(),eta:eta?.trim()};}
  return null;
}
module.exports={SUPPORT,REPO,validUrl,mediaKind,selection,downloadArgs,parseLine};
