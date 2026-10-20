const {test}=require('node:test'),assert=require('node:assert/strict');const {parseProductData,discoverMarketplace,hlsVariants,siteKind}=require('../app/marketplaces');const {discoverHtml,offeredFormats}=require('../app/discovery');
test('Ozon gallery data-state and widget JSON find video without a player and exclude recommendations',()=>{const widget={videos:[{name:'Товар',url:'https://cdn.ozon.test/v/master.m3u8',cover:'https://cdn.ozon.test/v/cover.jpg'}],recommendations:{videos:[{url:'https://cdn.test/advert.mp4'}]}};const html='<div id="state-webGallery-1" data-state=\''+JSON.stringify(widget).replace(/&/g,'&amp;').replace(/'/g,'&#39;')+'\'></div>';const d=discoverHtml(html,'https://www.ozon.ru/product/123/');assert.equal(d.videos.length,1);assert.equal(d.videos[0].thumbnail,'https://cdn.ozon.test/v/cover.jpg');assert.equal(d.videos[0].formats[0].protocol,'m3u8_native');assert.equal(parseProductData({widgetStates:{webGallery:JSON.stringify(widget)}},'https://www.ozon.ru/product/123/').length,1);});
test('AliExpress runParams group variants under one video with a real cover',()=>{const d=discoverHtml('<script>window.runParams = '+JSON.stringify({data:{videoModule:{videoId:'123',coverUrl:'https://cdn.test/cover.jpg',videoUrl:[{url:'https://cdn.test/hd.mp4',height:720},{url:'https://cdn.test/sd.mp4',height:360}]}}})+';</script>','https://www.aliexpress.com/item/123.html');assert.equal(d.videos.length,1);assert.deepEqual(offeredFormats(d.videos[0]).map(f=>f.height),[720,360]);assert(d.videos[0].thumbnail);});
test('HLS master uses actual variants and rejects protected samples',()=>{const text='#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720\n720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360\n360/index.m3u8';assert.deepEqual(hlsVariants(text,'https://cdn.test/master.m3u8').map(f=>f.height),[720,360]);assert.equal(hlsVariants(text+'\n#EXT-X-KEY:METHOD=SAMPLE-AES','https://cdn.test/master.m3u8').length,0);});
test('Wildberries resolves public CDN, offers only responding playlists, never invents 4K',async()=>{const requested=[];const fetcher=async u=>{requested.push(u);if(u.endsWith('/upstreams'))return {body:Buffer.from(JSON.stringify({recommend:{videonme_route_map:[{hosts:[{host:'mow-videonme-cdn-01.geobasket.ru'}]}]}}))};if(!/\/hls\/(720|360)p\//.test(u))throw Error('404');return {body:Buffer.from('#EXTM3U\n#EXTINF:4,\nfile.ts')};};const r=await discoverMarketplace('https://www.wildberries.ru/catalog/123456/detail.aspx',fetcher);assert.equal(r.length,1);assert.deepEqual(r[0].formats.map(f=>f.height),[720,360]);assert(requested.every(u=>u.includes('wbbasket.ru')||u.includes('geobasket.ru')));});
test('Watermark-free published variant wins, DRM and images are not media',()=>{const v={formats:[{height:720,url:'https://c/v.mp4',filesize:999,watermarked:true},{height:720,url:'https://c/original.mp4',filesize:100,watermarked:false}]};assert.equal(offeredFormats(v)[0].url,'https://c/original.mp4');assert.equal(parseProductData({videos:[{url:'https://c/image.jpg'},{url:'https://c/v.mp4',drm:true}]},'https://www.ozon.ru/product/1/').length,0);assert.equal(siteKind('https://evilozon.ru/product/1'),null);});

test('Captured live Ozon gallery retains both original videos and covers',()=>{const d=require('./fixtures/ozon-gallery.json');const r=parseProductData(d,'https://www.ozon.ru/product/3025956623/',d.title);assert.equal(r.length,2);assert(r.every(v=>v.thumbnail&&v.formats.length===1&&v.formats[0].url.includes('ozone.ru/vod/')));});

test('Wildberries MP4-only real-card layout uses product ID for host and volume independently',async()=>{
  const hosts=Array.from({length:60},(_,i)=>({host:`mow-videonme-cdn-${String((i+1)%60+1).padStart(2,'0')}.geobasket.ru`}));
  const expected='https://mow-videonme-cdn-31.geobasket.ru/vol125/part16224/162246509/mp4/360p/1.mp4';
  const requests=[];const fetcher=async(u,options={})=>{requests.push({u,...options});if(u.endsWith('/upstreams'))return {body:Buffer.from(JSON.stringify({recommend:{videonme_route_map:[{hosts}]}}))};if(u===expected&&options.method==='HEAD')return {type:'video/mp4',size:469329};throw Error('404');};
  const videos=await discoverMarketplace('https://www.wildberries.ru/catalog/162246509/detail.aspx',fetcher);
  assert.equal(videos.length,1);assert.equal(videos[0].formats.length,1);assert.equal(videos[0].formats[0].url,expected);assert.equal(videos[0].formats[0].filesize,469329);
  assert(requests.filter(r=>r.u.includes('/mp4/')).every(r=>r.method==='HEAD'));
});

test('Wildberries does not offer an HTML error returned with status 200 as MP4',async()=>{
  const fetcher=async u=>u.endsWith('/upstreams')?{body:Buffer.from(JSON.stringify({recommend:{videonme_route_map:[{hosts:[{host:'mow-videonme-cdn-01.geobasket.ru'}]}]}}))}:{body:Buffer.from('<html>Error</html>'),type:'text/html',size:200};
  assert.equal((await discoverMarketplace('https://www.wildberries.ru/catalog/162246509/detail.aspx',fetcher)).length,0);
});

test('Measured dimensions replace CDN labels, and different clips are not interchangeable qualities',async()=>{
  const {verifiedProductVideos}=require('../app/marketplaces');
  const videos=[{id:'product',title:'Товар',formats:[{url:'https://cdn.test/1440.m3u8',height:1440,protocol:'m3u8_native'},{url:'https://cdn.test/360.mp4',height:360,protocol:'https'}]}];
  const result=await verifiedProductVideos(videos,async u=>u.endsWith('.mp4')?{streams:[{codec_type:'video',codec_name:'h264',width:360,height:480}],format:{duration:'7.032'}}:{streams:[{codec_type:'video',codec_name:'h264',width:810,height:1080},{codec_type:'audio',codec_name:'aac'}],format:{duration:'82.752'}});
  assert.equal(result.length,2);assert.equal(result[0].formats[0].height,480);assert.equal(result[1].formats[0].height,1080);assert.equal(result[0].duration,7.032);assert.equal(result[1].duration,82.752);
  const unavailable=await verifiedProductVideos(videos,async()=>{throw Error('timeout')});assert(unavailable.every(v=>v.formats.every(f=>f.height===null)));
});

test('Plain HLS sample uses a real segment and total duration; encrypted or fragmented samples stay excluded',()=>{
  const {hlsSample}=require('../app/marketplaces');const playlist='#EXTM3U\n#EXTINF:6.7\n1.ts\n#EXTINF:4.1\n2.ts\n#EXT-X-ENDLIST';
  assert.deepEqual(hlsSample(playlist,'https://cdn.test/video/index.m3u8'),{url:'https://cdn.test/video/1.ts',duration:10.8});
  for(const line of ['#EXT-X-KEY:METHOD=AES-128,URI="key"','#EXT-X-MAP:URI="init.mp4"','#EXT-X-STREAM-INF:BANDWIDTH=1000'])assert.equal(hlsSample(playlist+'\n'+line,'https://cdn.test/video/index.m3u8'),null);
});
