import { NAV_FONT } from '$lib/utils/navFonts';
/**
 * First-person wayfinding signage for the nav preview: for every door between a named room and a
 * corridor, a projecting double-sided blade sign above the door (read from down the corridor) and a
 * flat plate on the corridor wall beside it. Teal plate, white pictogram tile, large white name.
 */
import * as THREE from 'three';

type P = { x: number; y: number };
export type SignDoor = { center: P; along: P; normal: P; width: number; wallThickness: number; height: number };
export type SignRoom = { name: string; displayName?: string; polygon: P[] };

function inside(p: P, poly: P[]) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function drawIcon(g: CanvasRenderingContext2D, name: string, x: number, y: number, s: number) {
  g.fillStyle = '#ffffff';
  g.beginPath(); g.roundRect(x, y, s, s, s * 0.16); g.fill();
  g.fillStyle = '#0e5f58'; g.strokeStyle = '#0e5f58'; g.lineWidth = s * 0.09; g.lineCap = 'round';
  const cx = x + s / 2, cy = y + s / 2;
  if (/电梯/.test(name)) {
    for (const [dx, up] of [[-0.17, true], [0.17, false]] as const) {
      const ax = cx + dx * s; g.beginPath();
      if (up) { g.moveTo(ax - s * 0.13, cy); g.lineTo(ax, cy - s * 0.22); g.lineTo(ax + s * 0.13, cy); }
      else { g.moveTo(ax - s * 0.13, cy); g.lineTo(ax, cy + s * 0.22); g.lineTo(ax + s * 0.13, cy); }
      g.closePath(); g.fill();
    }
  } else if (/楼梯/.test(name)) {
    g.beginPath(); g.moveTo(x + s * 0.18, y + s * 0.8);
    for (let i = 0; i < 3; i++) { g.lineTo(x + s * (0.18 + i * 0.22), y + s * (0.58 - i * 0.2)); g.lineTo(x + s * (0.4 + i * 0.22), y + s * (0.58 - i * 0.2)); }
    g.stroke();
  } else if (/卫生间|洗手间|厕/.test(name)) {
    g.font = `800 ${s * 0.46}px ${NAV_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WC', cx, cy + s * 0.03);
  } else {
    const a = s * 0.14, b = s * 0.34;
    g.fillStyle = '#d6453d';
    g.fillRect(cx - a, cy - b, a * 2, b * 2); g.fillRect(cx - b, cy - a, b * 2, a * 2);
  }
}

function signTexture(name: string) {
  const c = document.createElement('canvas'); c.width = 768; c.height = 240;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0e5f58'; g.beginPath(); g.roundRect(0, 0, 768, 240, 26); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 6; g.beginPath(); g.roundRect(10, 10, 748, 220, 20); g.stroke();
  drawIcon(g, name, 36, 40, 160);
  g.fillStyle = '#ffffff'; g.textBaseline = 'middle'; g.textAlign = 'left';
  const fit = (text: string, max: number, from: number) => {
    let size = from;
    do { g.font = `800 ${size}px ${NAV_FONT}`; size -= 4; } while (g.measureText(text).width > 520 && size > max);
    return g.measureText(text).width <= 520;
  };
  // Long department names (狂犬病暴露预防处置门诊) wrap onto two lines rather than shrinking to dust.
  if (fit(name, 78, 118)) g.fillText(name, 222, 126);
  else {
    const cut = Math.ceil(name.length / 2);
    const [l1, l2] = [name.slice(0, cut), name.slice(cut)];
    fit(l1.length >= l2.length ? l1 : l2, 40, 84);
    g.fillText(l1, 222, 80); g.fillText(l2, 222, 168);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export class NavSigns {
  readonly group = new THREE.Group();
  private disposables: { dispose(): void }[] = [];

  constructor(doors: SignDoor[], rooms: SignRoom[], floorY: number) {
    this.group.userData.navDressing = true;
    const edge = new THREE.MeshStandardMaterial({ color: '#cfd4d2', metalness: 0.6, roughness: 0.35 });
    const bracketMat = new THREE.MeshStandardMaterial({ color: '#9aa2a0', metalness: 0.7, roughness: 0.3 });
    this.disposables.push(edge, bracketMat);
    const textures = new Map<string, THREE.Material[]>();
    const faceMats = (name: string) => {
      if (!textures.has(name)) {
        const make = () => {
          const map = signTexture(name);
          const m = new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: new THREE.Color(0.5, 0.5, 0.5), roughness: 0.5 });
          this.disposables.push(map, m);
          return m;
        };
        // BoxGeometry maps both ±z faces readable from outside; no mirroring needed.
        textures.set(name, [make(), make()]);
      }
      const [front, back] = textures.get(name)!;
      return [edge, edge, edge, edge, front, back];
    };
    for (const d of doors) {
      const probe = (k: number) => ({ x: d.center.x + d.normal.x * k * 70, y: d.center.y + d.normal.y * k * 70 });
      const sideRoom = (k: number) => rooms.find(r => inside(probe(k), r.polygon));
      const a = sideRoom(1), b = sideRoom(-1);
      // Signs go on the corridor side of a door into one named room.
      const room = a && !b ? a : b && !a ? b : null;
      if (!room) continue;
      const k = room === a ? -1 : 1; // corridor side
      const n = new THREE.Vector3(d.normal.x * k, 0, d.normal.y * k);
      const along = new THREE.Vector3(d.along.x, 0, d.along.y);
      const base = new THREE.Vector3(d.center.x, floorY, d.center.y);
      // Blade sign: projects from the wall above the door's edge, faces up/down the corridor.
      const blade = new THREE.Mesh(this.box(64, 20, 2.5), faceMats(room.displayName || room.name));
      blade.position.copy(base).addScaledVector(along, d.width / 2 + 14).addScaledVector(n, d.wallThickness / 2 + 38);
      // Low enough to stay in frame from eye height a few metres back, still above the door head.
      blade.position.y = floorY + Math.max(d.height + 14, 222);
      blade.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(n, new THREE.Vector3(0, 1, 0), along));
      const arm = new THREE.Mesh(this.box(42, 2, 2), bracketMat);
      arm.position.copy(base).addScaledVector(along, d.width / 2 + 14).addScaledVector(n, d.wallThickness / 2 + 20);
      arm.position.y = blade.position.y + 11;
      arm.quaternion.copy(blade.quaternion);
      // Flat plate on the wall next to the door, at eye height.
      const plate = new THREE.Mesh(this.box(58, 18, 1.6), faceMats(room.displayName || room.name));
      plate.position.copy(base).addScaledVector(along, -(d.width / 2 + 42)).addScaledVector(n, d.wallThickness / 2 + 1.2);
      plate.position.y = floorY + 168;
      const side = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n);
      plate.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(side, new THREE.Vector3(0, 1, 0), n));
      for (const m of [blade, arm, plate]) { m.userData.navDressing = true; this.group.add(m); }
    }
  }

  private box(w: number, h: number, d: number) {
    const g = new THREE.BoxGeometry(w, h, d);
    this.disposables.push(g);
    return g;
  }

  dispose() {
    for (const d of this.disposables) d.dispose();
    this.group.removeFromParent();
  }
}
