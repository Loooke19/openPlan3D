import { chromium } from '/workspace/kit-wt/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch({ executablePath: '/home/box/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
p.setDefaultTimeout(600000);
p.on('pageerror', e => console.log('ERR', e.message));
const url = 'http://127.0.0.1:5173/nav?projectUrl=' + encodeURIComponent('http://127.0.0.1:8931/api/projects/b1f10000000000000000000000000001.json') + '&floor=floor-0';
const t0 = Date.now(); const log = (...a) => console.log(((Date.now()-t0)/1000).toFixed(0)+'s', ...a);
await p.goto(url); await p.waitForFunction(() => window.__navTest && window.__navKit);
log('loaded'); await p.waitForTimeout(3000);
const places = await p.evaluate(() => window.__navTest.places()); fs.writeFileSync('places.json', JSON.stringify(places, null, 1));
log(places.length, places.slice(0,80).map(x=>x.label).join(' | '));
const find = re => places.find(x => re.test(x.label));
const from = find(/玄関|入口|出入口|大厅|ホール/) || places[0];
const to = find(/放射|リハ|検査|CT|MRI|薬|药|食堂|売店/) || places[places.length-1];
log('route', from.label, '->', to.label, await p.evaluate(([a,c]) => window.__navTest.route(a,c), [from.key, to.key]));
log('legs', JSON.stringify(await p.evaluate(() => window.__navTest.legs())));
// materials
const mats = await p.evaluate(() => {
  let root = window.__navKit.group; while (root.parent) root = root.parent;
  const out = {}; const hex = c => c ? '#' + c.getHexString() : null;
  root.traverse(o => { if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    const tag = o.userData.navDressing ? 'dress:' + o.name : (o.userData.wallId || o.userData.renderMaterial === 'wall') ? 'wall' : null; if (!tag) return;
    ms.forEach((m, i) => { const k = tag + '|' + m.type + '|' + hex(m.color) + '|r' + m.roughness + '|m' + m.metalness + '|em' + hex(m.emissive) + '|map:' + (m.map ? (m.map.image?.src || m.map.image?.constructor?.name || 'yes') : '-') + '|vc' + m.vertexColors + '|key:' + (m.customProgramCacheKey ? m.customProgramCacheKey() : '-') + '|slot' + (Array.isArray(o.material) ? i : '-');
      out[k] = (out[k] || 0) + 1; }); });
  return out; });
fs.writeFileSync('mats.json', JSON.stringify(mats, null, 1)); log('mats', Object.keys(mats).length);
log('walk', await p.evaluate(() => window.__navTest.startWalk()));
for (const [ms, name] of [[6000,'a'],[12000,'b'],[20000,'c'],[30000,'d'],[45000,'e']]) { await p.waitForTimeout(ms === 6000 ? 6000 : 8000); await p.screenshot({ path: `raw-${name}.png` }); log('shot', name); }
await b.close();
