import { NAV_FONT } from '$lib/utils/navFonts';
/**
 * First-person wayfinding signage for the nav preview: for every door between a named room and a
 * corridor, one projecting double-sided blade above the door (readable looking up/down the corridor).
 * Flat wall plates were removed — they duplicated the blade text and read as stacked signs.
 */
import * as THREE from 'three';
import { toiletKind } from '$lib/utils/placeSearch';

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

/**
 * Corridor-outward normal for a door into exactly one named room.
 * Returns null when both/neither sides are named rooms (skip sign).
 */
export function corridorOutward(door: SignDoor, rooms: SignRoom[]): { room: SignRoom; outward: P } | null {
  const probe = (k: number) => ({ x: door.center.x + door.normal.x * k * 70, y: door.center.y + door.normal.y * k * 70 });
  const sideRoom = (k: number) => rooms.find((r) => inside(probe(k), r.polygon));
  const a = sideRoom(1), b = sideRoom(-1);
  const room = a && !b ? a : b && !a ? b : null;
  if (!room) return null;
  const k = room === a ? -1 : 1;
  return { room, outward: { x: door.normal.x * k, y: door.normal.y * k } };
}

/**
 * Right-handed basis for a projecting blade: X = into corridor, Y = up, Z = x×y (along wall).
 * Textured ±Z faces look up/down the corridor. Z is derived from X×Y — never from wall
 * winding — so a left-handed (n, up, along) triple cannot flatten the blade onto the wall.
 * `along` is unused for orientation (kept for call-site compatibility / door-side offsets).
 */
export function bladeBasis(outward: P, _along?: P): { x: THREE.Vector3; y: THREE.Vector3; z: THREE.Vector3 } {
  const x = new THREE.Vector3(outward.x, 0, outward.y);
  if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
  else x.normalize();
  const y = new THREE.Vector3(0, 1, 0);
  const z = new THREE.Vector3().crossVectors(x, y).normalize();
  return { x, y, z };
}

/** Keep one door per opening cluster (twin walls / stacked doors → one blade). */
export function dedupeSignDoors(doors: SignDoor[], pad = 45): SignDoor[] {
  const out: SignDoor[] = [];
  for (const d of doors) {
    if (out.some((o) => Math.hypot(o.center.x - d.center.x, o.center.y - d.center.y) <= pad)) continue;
    out.push(d);
  }
  return out;
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
  } else if (toiletKind(name) && toiletKind(name) !== 'any') {
    drawToiletPictogram(g, toiletKind(name)!, cx, cy, s);
  } else if (/卫生间|洗手间|厕/.test(name)) {
    g.font = `800 ${s * 0.46}px ${NAV_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('WC', cx, cy + s * 0.03);
  } else {
    const a = s * 0.14, b = s * 0.34;
    g.fillStyle = '#d6453d';
    g.fillRect(cx - a, cy - b, a * 2, b * 2); g.fillRect(cx - b, cy - a, b * 2, a * 2);
  }
}

/** Standard toilet pictograms so 男 / 女 / 无障碍 doors in a shared anteroom read apart at a glance. */
function drawToiletPictogram(g: CanvasRenderingContext2D, kind: 'male' | 'female' | 'accessible', cx: number, cy: number, s: number) {
  g.fillStyle = kind === 'female' ? '#c8324a' : kind === 'male' ? '#1f5fbf' : '#0e5f58';
  g.strokeStyle = g.fillStyle;
  const head = (x: number, y: number) => { g.beginPath(); g.arc(x, y, s * 0.075, 0, Math.PI * 2); g.fill(); };
  if (kind === 'male') {
    head(cx, cy - s * 0.28);
    g.fillRect(cx - s * 0.11, cy - s * 0.18, s * 0.22, s * 0.24);
    g.fillRect(cx - s * 0.11, cy + s * 0.06, s * 0.09, s * 0.3); g.fillRect(cx + s * 0.02, cy + s * 0.06, s * 0.09, s * 0.3);
  } else if (kind === 'female') {
    head(cx, cy - s * 0.28);
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.18); g.lineTo(cx + s * 0.06, cy - s * 0.18);
    g.lineTo(cx + s * 0.17, cy + s * 0.14); g.lineTo(cx - s * 0.17, cy + s * 0.14); g.closePath(); g.fill();
    g.fillRect(cx - s * 0.08, cy + s * 0.14, s * 0.06, s * 0.22); g.fillRect(cx + s * 0.02, cy + s * 0.14, s * 0.06, s * 0.22);
  } else {
    // ISO 7001 style wheelchair user
    g.lineWidth = s * 0.07; g.lineCap = 'round'; g.lineJoin = 'round';
    head(cx - s * 0.04, cy - s * 0.32);
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.2); g.lineTo(cx - s * 0.06, cy + s * 0.02); g.lineTo(cx + s * 0.16, cy + s * 0.02);
    g.lineTo(cx + s * 0.24, cy + s * 0.24); g.stroke();
    g.beginPath(); g.moveTo(cx - s * 0.06, cy - s * 0.12); g.lineTo(cx + s * 0.12, cy - s * 0.12); g.stroke();
    g.lineWidth = s * 0.055;
    g.beginPath(); g.arc(cx - s * 0.04, cy + s * 0.12, s * 0.2, Math.PI * 1.15, Math.PI * 2.85); g.stroke();
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

  constructor(doors: SignDoor[], rooms: SignRoom[], floorY: number, links: { x: number; y: number; name: string }[] = []) {
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
    for (const d of dedupeSignDoors(doors)) {
      const hit = corridorOutward(d, rooms);
      if (!hit) continue;
      const { room, outward } = hit;
      const { x: n, y: up, z: faceDir } = bladeBasis(outward, d.along);
      // Door-side offset keeps the authored wall tangent (which jamb the blade hangs on).
      const jamb = new THREE.Vector3(d.along.x, 0, d.along.y);
      if (jamb.lengthSq() > 1e-8) jamb.normalize();
      else jamb.copy(faceDir);
      const base = new THREE.Vector3(d.center.x, floorY, d.center.y);
      const label = room.displayName || room.name;
      // Blade: projects into the corridor; ±Z faces read when looking along the hall.
      const blade = new THREE.Mesh(this.box(64, 20, 2.5), faceMats(label));
      blade.position.copy(base).addScaledVector(jamb, d.width / 2 + 14).addScaledVector(n, d.wallThickness / 2 + 38);
      blade.position.y = floorY + Math.max(d.height + 10, 218);
      blade.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(n, up, faceDir));
      blade.userData.navSign = { kind: 'blade', name: label };
      const arm = new THREE.Mesh(this.box(42, 2, 2), bracketMat);
      arm.position.copy(base).addScaledVector(jamb, d.width / 2 + 14).addScaledVector(n, d.wallThickness / 2 + 20);
      arm.position.y = blade.position.y + 11;
      arm.quaternion.copy(blade.quaternion);
      for (const m of [blade, arm]) { m.userData.navDressing = true; this.group.add(m); }
    }
    this.hangLinks(links, floorY, faceMats, bracketMat);
  }

  /** Ceiling-hung two-sided sign over each stair/lift landing with its patient name (「楼梯 A」). */
  private hangLinks(links: { x: number; y: number; name: string }[], floorY: number, faceMats: (n: string) => THREE.Material[], mat: THREE.Material) {
    for (const l of links) {
      for (const rot of [0, Math.PI / 2]) {
        const sign = new THREE.Mesh(this.box(90, 28, 3), faceMats(l.name));
        sign.position.set(l.x, floorY + 232, l.y);
        sign.rotation.y = rot;
        const rod = new THREE.Mesh(this.box(1.5, 30, 1.5), mat);
        rod.position.set(l.x, floorY + 261, l.y);
        for (const m of [sign, rod]) { m.userData.navDressing = true; this.group.add(m); }
      }
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
