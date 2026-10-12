/**
 * Navigation route visual: one mitred ribbon (opaque core with flowing chevrons + white rim) under a
 * soft additive glow, a start puck and a pulsing destination beacon. Progress (walked part greys out)
 * and animation are uniforms, so simulation never rebuilds geometry. Core colour is HDR so the
 * selective bloom picks the route up and nothing else.
 *
 * Materials use toneMapped:false so the blue ribbon stays visible when the Windows path runs
 * without bloom (composer FinalShader / NeutralToneMapping would otherwise crush HDR blues).
 */
import * as THREE from 'three';

export type P2 = { x: number; y: number };

export function ribbonGeometry(points: P2[], halfWidth: number): THREE.BufferGeometry {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 0.5);
  const n = pts.length;
  const position = new Float32Array(n * 6), uv = new Float32Array(n * 4), index: number[] = [];
  let along = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i], prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
    const d0 = new THREE.Vector2(p.x - prev.x, p.y - prev.y), d1 = new THREE.Vector2(next.x - p.x, next.y - p.y);
    if (d0.lengthSq() < 1e-8) d0.copy(d1);
    if (d1.lengthSq() < 1e-8) d1.copy(d0);
    d0.normalize(); d1.normalize();
    const tangent = d0.clone().add(d1);
    if (tangent.lengthSq() < 1e-8) tangent.copy(d1);
    tangent.normalize();
    const normal = new THREE.Vector2(-tangent.y, tangent.x);
    const miter = Math.min(2.2, 1 / Math.max(0.3, normal.dot(new THREE.Vector2(-d1.y, d1.x))));
    if (i) along += Math.hypot(p.x - prev.x, p.y - prev.y);
    for (const [k, side] of [[0, 1], [1, -1]] as const) {
      position.set([p.x + normal.x * halfWidth * miter * side, 0, p.y + normal.y * halfWidth * miter * side], (i * 2 + k) * 3);
      uv.set([along, side], (i * 2 + k) * 2);
    }
    if (i) { const a = (i - 1) * 2, b = i * 2; index.push(a, b, a + 1, a + 1, b, b + 1); }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(index);
  geometry.userData.length = along;
  return geometry;
}

const VERT = /* glsl */`
  varying vec2 vUv;
  #include <common>
  #include <logdepthbuf_pars_vertex>
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;

export class NavRouteVisual {
  readonly group = new THREE.Group();
  readonly uniforms = {
    uTime: { value: 0 },
    uTraveled: { value: -1 },
    uHalf: { value: 16 },
    uAccent: { value: new THREE.Color('#1f7cf2') },
    uGlowColor: { value: new THREE.Color('#4aa3ff') },
    uWalk: { value: 0 },
  };
  private beacon: THREE.Group | null = null;
  length = 0;

  constructor(points: P2[], opts: { y?: number; walk?: boolean; end?: boolean; start?: boolean } = {}) {
    const y = opts.y ?? 4.5;
    this.group.userData.navRoute = true;
    if (points.length < 2) return;
    for (const [view, core, rim, glow] of [['walk', 15, 21, 60], ['overview', 30, 41, 130]] as const) {
      this.buildSet(points, y, view, core, rim, glow);
    }
    this.length = (this.group.children[0] as THREE.Mesh)?.geometry.userData.length ?? 0;
    if (opts.start !== false) this.addStart(points[0], y);
    if (opts.end !== false) this.addBeacon(points[points.length - 1], y);
  }

  private buildSet(points: P2[], y: number, view: 'walk' | 'overview', halfCore: number, halfRim: number, halfGlow: number) {
    const u = { ...this.uniforms, uHalf: { value: halfCore } };
    const core = ribbonGeometry(points, halfCore);
    const rim = ribbonGeometry(points, halfRim);
    const glow = ribbonGeometry(points, halfGlow);
    // Do not put backticks inside these GLSL template strings — they truncate the source and
    // leave fragmentShader as a number (Windows then loses the blue ribbon + chevrons).
    const coreMat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VERT,
      fragmentShader: /* glsl */`
        uniform float uTime, uTraveled, uHalf, uWalk; uniform vec3 uAccent;
        varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float along = vUv.x, across = abs(vUv.y);
          // Chevrons tip forward (+along): peak along shrinks as |across| grows (was minus-across).
          float v = fract((along + across * uHalf * 1.1) / (uHalf * 7.) - uTime * 80. / (uHalf * 7.));
          float chev = smoothstep(.0, .06, v) * (1. - smoothstep(.18, .24, v)) * (1. - smoothstep(.72, .86, across));
          vec3 base = uAccent * (1.25 - .25 * uWalk);
          vec3 col = mix(base, mix(vec3(2.2, 2.4, 2.6), vec3(1.25, 1.35, 1.45), uWalk), chev * .9);
          if (along < uTraveled) col = mix(vec3(.42, .46, .45), vec3(.6), chev * .3);
          gl_FragColor = vec4(col, 1.);
        }`,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      toneMapped: false,
    });
    const rimMat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VERT,
      fragmentShader: /* glsl */`
        uniform float uTraveled; varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          gl_FragColor = vec4(vUv.x < uTraveled ? vec3(.82) : vec3(1.05), 1.);
        }`,
      side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      toneMapped: false,
    });
    const glowMat = new THREE.ShaderMaterial({
      uniforms: u, vertexShader: VERT,
      fragmentShader: /* glsl */`
        uniform float uTime, uTraveled, uWalk; uniform vec3 uGlowColor; varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          float a = pow(1. - abs(vUv.y), 2.2) * (.5 - .42 * uWalk);
          a *= .8 + .2 * sin(vUv.x / 60. - uTime * 3.);
          if (vUv.x < uTraveled) a *= .15;
          gl_FragColor = vec4(uGlowColor * a, 1.);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      toneMapped: false,
    });
    const add = (g: THREE.BufferGeometry, m: THREE.Material, dy: number, order: number) => {
      const mesh = new THREE.Mesh(g, m);
      mesh.position.y = y + dy;
      mesh.renderOrder = order;
      mesh.frustumCulled = false;
      mesh.userData.view = view;
      this.group.add(mesh);
    };
    add(glow, glowMat, -0.6, 4);
    add(rim, rimMat, -0.2, 5);
    add(core, coreMat, 0, 6);
  }

  private addStart(p: P2, y: number) {
    const puck = new THREE.Mesh(new THREE.CylinderGeometry(30, 30, 3, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color('#2fbf71').multiplyScalar(1.3), toneMapped: false }));
    puck.position.set(p.x, y + 1, p.y);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(38, 38, 2, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    ring.position.set(p.x, y + 0.2, p.y);
    this.group.add(ring, puck);
  }

  private addBeacon(p: P2, y: number) {
    const g = this.beacon = new THREE.Group();
    g.position.set(p.x, y, p.y);
    const hot = new THREE.Color('#ff8a3d');
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(32, 32, 3, 48), new THREE.MeshBasicMaterial({ color: hot.clone().multiplyScalar(1.4), toneMapped: false }));
    disc.position.y = 1;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(40, 40, 2, 48), new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(44, 52, 64).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({
      color: hot.clone().multiplyScalar(2.2), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }));
    ring.position.y = 2; ring.userData.pulse = true;
    const column = new THREE.Mesh(new THREE.CylinderGeometry(10, 26, 220, 32, 1, true).translate(0, 110, 0), new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uColor: { value: hot.clone().multiplyScalar(1.6) } },
      vertexShader: /* glsl */`varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.);
        #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`uniform float uTime; uniform vec3 uColor; varying vec2 vUv;
        #include <common>
        #include <logdepthbuf_pars_fragment>
        void main(){
          #include <logdepthbuf_fragment>
          float a = pow(1. - vUv.y, 1.6) * (.5 + .15 * sin(uTime * 3.));
          gl_FragColor = vec4(uColor * a, 1.); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      toneMapped: false,
    }));
    column.userData.beaconColumn = true;
    g.add(rim, disc, ring, column);
    this.group.add(g);
  }

  setWalk(walk: boolean) {
    this.uniforms.uWalk.value = walk ? 1 : 0;
    for (const c of this.group.children) if (c.userData.view) c.visible = c.userData.view === (walk ? 'walk' : 'overview');
  }

  setTraveled(distance: number) { this.uniforms.uTraveled.value = distance; }

  tick(seconds: number, eye?: THREE.Vector3) {
    this.uniforms.uTime.value = seconds;
    if (this.beacon) {
      // First person: the glow column swallowed the whole view when the camera reached it.
      const col = this.beacon.children.find(c => c.userData.beaconColumn);
      if (col) col.visible = !eye || Math.hypot(eye.x - this.beacon.position.x, eye.z - this.beacon.position.z) > 180;
      const ring = this.beacon.children.find(c => c.userData.pulse) as THREE.Mesh | undefined;
      if (ring) {
        const t = (seconds * 0.8) % 1;
        ring.scale.setScalar(1 + t * 1.6);
        (ring.material as THREE.MeshBasicMaterial).opacity = 1 - t;
      }
    }
  }

  dispose() {
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose?.();
    });
  }
}
