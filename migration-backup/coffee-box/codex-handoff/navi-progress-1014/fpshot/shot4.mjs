import { chromium } from '/workspace/kit-wt/node_modules/playwright/index.mjs';
import fs from 'fs';
const b = await chromium.launch({headless:true, executablePath:'/opt/google/chrome/chrome', args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const p = await b.newPage({ viewport: { width: 1280, height: 800 } }); p.setDefaultTimeout(900000);
const t0=Date.now(), log=(...a)=>console.log(((Date.now()-t0)/1000|0)+'s',...a);
const id='b1f10000000000000000000000000001', o='http://127.0.0.1:8931';
await p.goto(`http://127.0.0.1:5173/nav?id=${id}&apiOrigin=${encodeURIComponent(o)}&projectUrl=${encodeURIComponent(o+'/api/projects/'+id+'.json')}&floor=floor-0&quality=low`);
await p.waitForFunction(() => window.__navTest?.viewer?.getOrbitSnapshot?.() && window.__navKit?.plan?.stats?.props > 0);
await p.waitForTimeout(3000); log('loaded');
const pl = await p.evaluate(() => window.__navTest.places());
const k = re => pl.find(x => re.test(x.label)).key;
log(await p.evaluate(([a,c]) => window.__navTest.route(a,c), [k(/门厅（西·主入口）/), k(/西药房/)]));
await p.evaluate(() => { window.__poses = []; window.__navTest.startWalk(); const iv = setInterval(() => { const v = window.__navTest.viewer; if (v?.debugCamera) { const c = v.debugCamera(); if (c.walk) window.__poses.push(c); } }, 150); window.__iv = iv; });
await p.waitForFunction(() => document.body.innerText.includes('已到达'), null, { timeout: 300000 });
const poses = await p.evaluate(() => { clearInterval(window.__iv); return window.__poses; });
const fp = await p.evaluate(() => window.__navKitInput.footprint);
fs.writeFileSync('poses.json', JSON.stringify({ poses, fp })); log('poses', poses.length);
// distance to footprint boundary
const segd = (q, a, c) => { const dx=c.x-a.x, dy=c.y-a.y, t=Math.max(0,Math.min(1,((q.x-a.x)*dx+(q.y-a.y)*dy)/(dx*dx+dy*dy||1))); const x=a.x+t*dx, y=a.y+t*dy; return [Math.hypot(q.x-x,q.y-y), {x,y}]; };
const near = q => { let best=[1e9,null]; fp.forEach((a,i)=>{ const r=segd(q,a,fp[(i+1)%fp.length]); if(r[0]<best[0]) best=r; }); return best; };
const ps = poses.filter((_,i)=>i%2===0);
const scored = ps.map(c => ({ c, d: near({x:c.x,y:c.y}) }));
const ext = scored.reduce((a,b)=> b.d[0] < a.d[0] ? b : a);
const mid = scored[Math.floor(scored.length*0.55)];
log('ext', JSON.stringify(ext.c), ext.d[0], 'mid', JSON.stringify(mid.c), mid.d[0]);
const shoot = async (name, pos, look) => { await p.evaluate(([a,l]) => window.__navTest.viewer.setWalkCameraForTest(a,l), [pos, look]); await p.waitForTimeout(2500); await p.screenshot({ path: name }); log('saved', name); };
const E = 160;
// corridor: look along walking direction
await shoot('/workspace/navi-progress-1014/fp-corridor.png', [mid.c.x, E, mid.c.y], [mid.c.x+mid.c.dx*500, E-10, mid.c.y+mid.c.dy*500]);
// exterior: step back 2.5 m from the nearest boundary point and look at it, turned 40° along the wall
const q = ext.d[1]; let vx = q.x-ext.c.x, vy = q.y-ext.c.y; const n = Math.hypot(vx,vy)||1; vx/=n; vy/=n;
const pos = { x: q.x - vx*300, y: q.y - vy*300 };
for (const [tag, ang] of [['a', 0.7], ['b', -0.7]]) {
  const lx = vx*Math.cos(ang)-vy*Math.sin(ang), ly = vx*Math.sin(ang)+vy*Math.cos(ang);
  await shoot(`/workspace/navi-progress-1014/fp-exterior-${tag}.png`, [pos.x, E, pos.y], [pos.x+lx*500, E-10, pos.y+ly*500]);
}
// sample pixel colours of exterior-facing wall face vs interior: read material on the hit faces
const hits = await p.evaluate(() => { const v = window.__navTest.viewer; return v.pickForTest ? [0.3,0.5,0.7].map(x => { try { return JSON.stringify(v.pickForTest(x, 0.5)); } catch(e) { return String(e); } }) : null; });
log('pick', JSON.stringify(hits)?.slice(0,800));
await b.close();
