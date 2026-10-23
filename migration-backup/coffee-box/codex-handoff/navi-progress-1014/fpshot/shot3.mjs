import { chromium } from '/workspace/kit-wt/node_modules/playwright/index.mjs';
const b = await chromium.launch({headless:true, executablePath:'/opt/google/chrome/chrome', args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage({ viewport: { width: 1280, height: 800 } }); p.setDefaultTimeout(900000);
const t0=Date.now(), log=(...a)=>console.log(((Date.now()-t0)/1000|0)+'s',...a);
const id='b1f10000000000000000000000000001', o='http://127.0.0.1:8931';
await p.goto(`http://127.0.0.1:5173/nav?id=${id}&apiOrigin=${encodeURIComponent(o)}&projectUrl=${encodeURIComponent(o+'/api/projects/'+id+'.json')}&floor=floor-0&quality=low`);
await p.waitForFunction(() => window.__navTest?.viewer?.getOrbitSnapshot?.() && window.__navKit?.plan?.stats?.props > 0);
await p.waitForTimeout(5000); await p.screenshot({ path: 'orbit.png' }); log('orbit');
const pl = await p.evaluate(() => window.__navTest.places());
const k = re => pl.find(x => re.test(x.label)).key;
log(await p.evaluate(([a,c]) => window.__navTest.route(a,c), [k(/门厅（西·主入口）/), k(/西药房/)]));
await p.evaluate(() => window.__navTest.startWalk());
for (let i=0;i<10;i++){ await p.waitForTimeout(1200); await p.screenshot({ path: `w-${String(i).padStart(2,'0')}.png` }); log('shot', i, await p.evaluate(()=>document.querySelector('input[type=range]')?.value)); }
const box = await p.locator('canvas').first().boundingBox();
for (let j=0;j<4;j++){ await p.mouse.move(box.x+box.width/2, box.y+box.height/2); await p.mouse.down(); await p.mouse.move(box.x+box.width/2+300, box.y+box.height/2, {steps:6}); await p.mouse.up(); await p.waitForTimeout(2000); await p.screenshot({ path: `look-${j}.png` }); log('look', j); }
await b.close();
