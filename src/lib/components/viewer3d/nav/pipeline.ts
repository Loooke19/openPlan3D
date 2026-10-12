/**
 * Navigation preview render pipeline (nav shell only; the editor keeps its own renderer path).
 *
 * high  = HDR render (MSAA) → half-res selective bloom → one final pass (Khronos Neutral tone map,
 *         sRGB, 32³ LUT grade, vignette).
 * ultra = high + SMAA + 2048 shadows + pixel ratio up to 2.
 * low   = direct render with Neutral tone mapping (no post, no shadows).
 * Choose with `?quality=ultra|high|low` or localStorage `nav-render-quality`.
 *
 * Windows ANGLE: HalfFloat+MSAA and/or sampler3D LUT FinalShader can black the canvas. Default
 * Windows stack = UnsignedByte RT, samples=0, UnrealBloom, Final without 3D LUT (neutral+sRGB+vignette)
 * so coffee HDR route + bloom glow stays lit. Override with ?postProbe=… for isolation.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

export type NavQuality = 'ultra' | 'high' | 'low';
export type NavLook = 'overview' | 'walk';

export function detectNavQuality(): NavQuality {
  if (typeof window === 'undefined') return 'high';
  const q = new URLSearchParams(window.location.search).get('quality') || localStorage.getItem('nav-render-quality') || '';
  return q === 'ultra' || q === 'low' || q === 'high' ? q : 'high';
}

/** Half-float + MSAA render targets black-out on some Windows ANGLE/GPU combos (esp. virtual adapters). */
function probeHdrMsaa(renderer: THREE.WebGLRenderer): { type: THREE.TextureDataType; samples: number } {
  const gl = renderer.getContext() as WebGL2RenderingContext | WebGLRenderingContext;
  const fallback = { type: THREE.UnsignedByteType, samples: 0 };
  try {
    if (!(gl instanceof WebGL2RenderingContext)) return fallback;
    if (!gl.getExtension('EXT_color_buffer_float')) return fallback;
    const maxSamples = gl.getParameter(gl.MAX_SAMPLES) as number;
    const samples = Math.min(4, maxSamples || 0);
    if (samples < 1) return { type: THREE.HalfFloatType, samples: 0 };
    const tex = gl.createTexture();
    const rb = gl.createRenderbuffer();
    const fb = gl.createFramebuffer();
    if (!tex || !rb || !fb) return fallback;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, 4, 4);
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA16F, 4, 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    gl.deleteRenderbuffer(rb);
    gl.deleteTexture(tex);
    return ok ? { type: THREE.HalfFloatType, samples } : fallback;
  } catch {
    return fallback;
  }
}

type Grade = { lift: [number, number, number]; gain: [number, number, number]; contrast: number; saturation: number };
const GRADES: Record<NavLook, Grade> = {
  overview: { lift: [0.0, 0.004, 0.012], gain: [0.995, 1.0, 1.01], contrast: 1.06, saturation: 1.06 },
  walk: { lift: [0.006, 0.01, 0.02], gain: [1.04, 1.0, 0.95], contrast: 1.14, saturation: 1.08 },
};

function buildLut(grade: Grade, size = 32): THREE.Data3DTexture {
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    let c = [r / (size - 1), g / (size - 1), b / (size - 1)];
    c = c.map((v, k) => grade.lift[k] * (1 - v) + v * grade.gain[k]);
    c = c.map(v => Math.min(1, Math.max(0, (v - 0.5) * grade.contrast + 0.5)));
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    c = c.map(v => Math.min(1, Math.max(0, l + (v - l) * grade.saturation)));
    data[i++] = Math.round(c[0] * 255); data[i++] = Math.round(c[1] * 255); data[i++] = Math.round(c[2] * 255); data[i++] = 255;
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

/** Coffee FinalShader: Neutral + sRGB + 3D LUT + vignette. */
const FinalShaderLut = {
  name: 'NavFinalLut',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1 },
    lut: { value: null as THREE.Data3DTexture | null },
    vignette: { value: 0.18 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    precision highp sampler3D;
    uniform sampler2D tDiffuse; uniform sampler3D lut; uniform float exposure, vignette;
    varying vec2 vUv;
    vec3 neutral(vec3 color) {
      const float StartCompression = 0.8 - 0.04; const float Desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < StartCompression) return color;
      float d = 1. - StartCompression;
      float newPeak = 1. - d * d / (peak + d - StartCompression);
      color *= newPeak / max(peak, 1e-5);
      float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);
      return mix(color, vec3(newPeak), g);
    }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = toSRGB(clamp(neutral(c.rgb * exposure), 0., 1.));
      col = texture3D(lut, col * (31. / 32.) + .5 / 32.).rgb;
      vec2 d = (vUv - .5) * vec2(1.15, 1.);
      col *= 1. - vignette * smoothstep(.35, .95, length(d));
      gl_FragColor = vec4(col, 1.);
    }`,
};

/** Windows-safe Final: same Neutral + sRGB + vignette, no sampler3D (ANGLE often blacks with 3D LUT). */
const FinalShaderNoLut = {
  name: 'NavFinalNoLut',
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1 },
    vignette: { value: 0.18 },
  },
  vertexShader: /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float exposure, vignette;
    varying vec2 vUv;
    vec3 neutral(vec3 color) {
      const float StartCompression = 0.8 - 0.04; const float Desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < StartCompression) return color;
      float d = 1. - StartCompression;
      float newPeak = 1. - d * d / (peak + d - StartCompression);
      color *= newPeak / max(peak, 1e-5);
      float g = 1. - 1. / (Desaturation * (peak - newPeak) + 1.);
      return mix(color, vec3(newPeak), g);
    }
    vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - 0.055, step(0.0031308, c)); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec3 col = toSRGB(clamp(neutral(c.rgb * exposure), 0., 1.));
      // Mild cool lift approximating overview LUT without sampler3D.
      col = mix(col, col * vec3(0.995, 1.0, 1.01) + vec3(0.0, 0.004, 0.012), 0.85);
      vec2 d = (vUv - .5) * vec2(1.15, 1.);
      col *= 1. - vignette * smoothstep(.35, .95, length(d));
      gl_FragColor = vec4(col, 1.);
    }`,
};

type ProbeMode =
  | 'direct'
  | 'rp'
  | 'rp_final_nolut'
  | 'rp_final'
  | 'rp_bloom'
  | 'rp_bloom_final'
  | 'rp_bloom_final_hf'
  | 'hf0_bloom_nolut'
  | '';

function detectProbe(): ProbeMode {
  if (typeof window === 'undefined') return '';
  const v = new URLSearchParams(window.location.search).get('postProbe') || '';
  return (
    v === 'direct' || v === 'rp' || v === 'rp_final_nolut' || v === 'rp_final' ||
    v === 'rp_bloom' || v === 'rp_bloom_final' || v === 'rp_bloom_final_hf' ||
    v === 'hf0_bloom_nolut'
  ) ? v : '';
}

export class NavPipeline {
  readonly quality: NavQuality;
  readonly hdrMsaa: boolean;
  /** Active post configuration (for diagnostics). */
  readonly postMode: string;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private smaa: SMAAPass | null = null;
  private final: ShaderPass | null = null;
  private useLut = false;
  private luts: Record<NavLook, THREE.Data3DTexture>;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  private interactive = false;
  look: NavLook = 'overview';
  exposure = 1;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: THREE.Camera, quality = detectNavQuality()) {
    this.quality = quality;
    this.luts = { overview: buildLut(GRADES.overview), walk: buildLut(GRADES.walk) };
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.envTarget = pmrem.fromScene(room, 0.04);
    room.dispose?.();
    pmrem.dispose();
    scene.environment = this.envTarget.texture;
    renderer.shadowMap.enabled = quality !== 'low';
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping; // tone map in FinalShader (coffee path)

    const win = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent || '');
    const probe = detectProbe();
    const qs = typeof window !== 'undefined' ? window.location.search : '';
    const forceLut = new URLSearchParams(qs).get('lut') === '1';

    if (quality === 'low' || probe === 'direct') {
      this.hdrMsaa = false;
      this.postMode = 'direct';
      renderer.toneMapping = THREE.NeutralToneMapping;
      this.setLook('overview');
      if (typeof window !== 'undefined') (window as unknown as { __postProbeResult?: unknown }).__postProbeResult = { mode: this.postMode, win };
      return;
    }

    // Default (probe-proven on this Windows ANGLE box):
    // - Root black cause = FinalShader 3D LUT (sampler3D/texture3D), NOT UnrealBloom.
    // - HalfFloat+MSAA+LUT blacks; HalfFloat samples=0 + bloom + Final-no-LUT is lit with HDR glow.
    // - Non-Windows: coffee tip (HF+MSAA when ok, bloom, 3D LUT final).
    let wantHdr = true;
    let wantBloom = true;
    let wantFinal: 'lut' | 'nolut' | 'none' = win && !forceLut ? 'nolut' : 'lut';
    let forceNoMsaa = win; // Windows: HF without MSAA (MSAA+HF still risky with other passes)

    if (probe === 'rp') { wantBloom = false; wantFinal = 'none'; wantHdr = false; forceNoMsaa = true; }
    else if (probe === 'rp_final_nolut') { wantBloom = false; wantFinal = 'nolut'; wantHdr = false; forceNoMsaa = true; }
    else if (probe === 'rp_final') { wantBloom = false; wantFinal = 'lut'; wantHdr = false; forceNoMsaa = true; }
    else if (probe === 'rp_bloom') { wantBloom = true; wantFinal = 'none'; wantHdr = false; forceNoMsaa = true; }
    else if (probe === 'rp_bloom_final') { wantBloom = true; wantFinal = 'nolut'; wantHdr = false; forceNoMsaa = true; }
    else if (probe === 'rp_bloom_final_hf') { wantBloom = true; wantFinal = 'lut'; wantHdr = true; forceNoMsaa = false; }
    else if (probe === 'hf0_bloom_nolut') { wantBloom = true; wantFinal = 'nolut'; wantHdr = true; forceNoMsaa = true; }

    const fmt = probeHdrMsaa(renderer);
    let samples = 0;
    if (wantHdr && fmt.type === THREE.HalfFloatType) {
      samples = forceNoMsaa ? 0 : (fmt.samples > 0 ? fmt.samples : 0);
      this.hdrMsaa = samples > 0;
    } else if (wantHdr) {
      // Requested HF but probe failed → UnsignedByte, still try bloom.
      wantHdr = false;
      this.hdrMsaa = false;
      samples = 0;
    } else {
      this.hdrMsaa = false;
      samples = 0;
    }

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: wantHdr ? THREE.HalfFloatType : THREE.UnsignedByteType,
      samples,
    });
    // HalfFloat needs LinearSRGBColorSpace for HDR bloom path (three r152+).
    if ('colorSpace' in target.texture) {
      (target.texture as THREE.Texture).colorSpace = wantHdr ? THREE.LinearSRGBColorSpace : THREE.SRGBColorSpace;
    }

    const composer = this.composer = new EffectComposer(renderer, target);
    composer.addPass(new RenderPass(scene, camera));

    if (wantBloom) {
      // Slightly lower threshold so LDR-clamped route HDR still blooms on UnsignedByte RTs.
      // strength, radius, threshold — match coffee tip c072758 (0.55, 0.45, 1.0)
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.45, 1.0);
      composer.addPass(this.bloom);
    }

    if (wantFinal === 'lut') {
      this.final = new ShaderPass(FinalShaderLut);
      this.useLut = true;
    } else if (wantFinal === 'nolut') {
      this.final = new ShaderPass(FinalShaderNoLut);
      this.useLut = false;
    }

    if (this.final) composer.addPass(this.final);

    if (quality === 'ultra' && !win) {
      this.smaa = new SMAAPass();
      composer.addPass(this.smaa);
    }

    this.postMode = [
      wantHdr ? 'hf' : 'ub',
      `s${samples}`,
      wantBloom ? 'bloom' : 'nobloom',
      wantFinal,
      win ? 'win' : 'nowin',
      probe || 'default',
    ].join('_');

    this.setLook('overview');
    if (typeof window !== 'undefined') {
      (window as unknown as { __postProbeResult?: unknown }).__postProbeResult = {
        mode: this.postMode,
        probe: probe || null,
        win,
        wantHdr,
        wantBloom,
        wantFinal,
        samples,
        hdrProbe: { type: fmt.type === THREE.HalfFloatType ? 'HalfFloat' : 'UnsignedByte', samples: fmt.samples },
      };
    }
  }

  setInteractive(on: boolean) {
    if (this.interactive === on) return;
    this.interactive = on;
    if (this.bloom) this.bloom.enabled = !on;
    if (this.smaa) this.smaa.enabled = !on;
  }

  setLook(look: NavLook) {
    this.look = look;
    if (this.final) {
      if (this.useLut && this.final.uniforms.lut) {
        this.final.uniforms.lut.value = this.luts[look];
      }
      if (this.final.uniforms.vignette) {
        this.final.uniforms.vignette.value = look === 'walk' ? 0.32 : 0.14;
      }
    }
    if (this.bloom) {
      this.bloom.strength = look === 'walk' ? 0.3 : 0.6;
      this.bloom.radius = look === 'walk' ? 0.55 : 0.4;
    }
    this.scene.environmentIntensity = look === 'walk' ? 0.22 : 0.3;
  }

  setExposure(value: number) { this.exposure = value; this.renderer.toneMappingExposure = value; }

  setSize(w: number, h: number) {
    if (!this.composer) return;
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
    this.bloom?.setSize(Math.ceil((w * this.renderer.getPixelRatio()) / 2), Math.ceil((h * this.renderer.getPixelRatio()) / 2));
  }

  render(delta = 1 / 60) {
    if (!this.composer) {
      this.renderer.render(this.scene, this.camera);
      return;
    }
    if (this.final?.uniforms?.exposure) this.final.uniforms.exposure.value = this.exposure;
    try {
      this.composer.render(delta);
    } catch (err) {
      this.composer = null;
      this.final = null;
      this.bloom = null;
      this.smaa = null;
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.toneMappingExposure = this.exposure;
      this.renderer.render(this.scene, this.camera);
      if (typeof window !== 'undefined') {
        (window as unknown as { __postProbeResult?: unknown }).__postProbeResult = {
          ...(typeof (window as unknown as { __postProbeResult?: object }).__postProbeResult === 'object'
            ? (window as unknown as { __postProbeResult: object }).__postProbeResult
            : {}),
          renderError: String(err),
        };
      }
    }
  }

  dispose() {
    this.composer?.dispose();
    this.envTarget?.dispose();
    this.luts.overview.dispose(); this.luts.walk.dispose();
    if (this.scene.environment === this.envTarget?.texture) this.scene.environment = null;
  }
}
