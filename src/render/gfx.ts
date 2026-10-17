import * as THREE from 'three/webgpu';
import { pass, uniform, vec3, vec4, float, screenUV, mix, smoothstep, length, clamp, vec2, dot, max } from './tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { QUALITY, type QualityName, type QualityPreset, autoQuality, isMobile } from '../core/quality';

/**
 * Owns the WebGPURenderer (auto-falls back to WebGL2), the post-processing pipeline and quality presets.
 * Post chain: HDR scene pass -> bloom -> custom composite (chromatic aberration, flash, hurt vignette, grade).
 */
export class Gfx {
  renderer!: THREE.WebGPURenderer;
  isWebGPU = false;
  quality!: QualityPreset;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
  pipeline: THREE.RenderPipeline | null = null;
  canvas!: HTMLCanvasElement;
  /** dynamic resolution multiplier, adjusted by frame time */
  dynScale = 1;
  u = {
    flash: uniform(new THREE.Color(0, 0, 0)),
    flashAmt: uniform(0),
    ca: uniform(0),
    hurt: uniform(0),
    exposure: uniform(1),
    bloomStrength: uniform(0.9),
    saturation: uniform(1.12),
    desat: uniform(0),
  };
  private bloomNode: ReturnType<typeof bloom> | null = null;
  private lastW = 0;
  private lastH = 0;
  drawCalls = 0;

  async init(canvas: HTMLCanvasElement, quality?: QualityName): Promise<void> {
    this.canvas = canvas;
    patchTextureViewSwizzle();
    const params = new URLSearchParams(location.search);
    const forceWebGL = params.has('webgl');
    const mobile = isMobile();
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL, powerPreference: 'high-performance', alpha: false });
    await this.renderer.init();
    this.isWebGPU = !!(this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x05040a, 1);
    this.quality = QUALITY[quality ?? autoQuality(this.isWebGPU)];
    if (mobile && !quality && this.quality.name !== 'low' && !params.has('quality')) this.quality = QUALITY.low;
    this.applyQuality();
  }

  setQuality(name: QualityName): void {
    this.quality = QUALITY[name];
    this.applyQuality();
  }

  private applyQuality(): void {
    this.dynScale = 1;
    this.resize(true);
    this.buildPipeline();
  }

  buildPipeline(): void {
    const q = this.quality;
    const scenePass = pass(this.scene, this.camera, { samples: q.name === 'ultra' ? 4 : 0 });
    const tex = scenePass.getTextureNode('output');
    // Chromatic aberration: sample R and B with radial offsets (cheap, no extra pass)
    const uvc = screenUV;
    const dir = uvc.sub(0.5);
    const caOff = dir.mul(this.u.ca.mul(q.chromatic ? 0.03 : 0.0));
    const r = tex.sample(uvc.add(caOff)).r;
    const g = tex.sample(uvc).g;
    const b = tex.sample(uvc.sub(caOff)).b;
    let col: any = vec3(r, g, b);
    if (q.bloom) {
      this.bloomNode = bloom(tex, q.bloomStrength, 0.55, 0.62);
      this.bloomNode.setResolutionScale?.(q.name === 'low' ? 0.3 : q.name === 'medium' ? 0.4 : 0.5);
      this.bloomNode.strength = this.u.bloomStrength as any;
      this.u.bloomStrength.value = q.bloomStrength;
      col = col.add(this.bloomNode.rgb);
    }
    col = col.mul(this.u.exposure);
    // saturation grade
    const lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, this.u.saturation.sub(this.u.desat));
    // vignette + hurt pulse
    const d = length(dir.mul(vec2(1.0, 0.8)));
    const vig = smoothstep(float(0.85), float(0.35), d);
    col = col.mul(mix(float(0.55), float(1.0), vig));
    const hurtMask = smoothstep(float(0.3), float(0.8), d).mul(this.u.hurt);
    col = mix(col, vec3(0.9, 0.05, 0.08).mul(max(lum, 0.4).add(0.6)), clamp(hurtMask, 0, 0.75));
    // full-screen flash
    col = col.add(vec3(this.u.flash).mul(this.u.flashAmt));
    const pipeline = new THREE.RenderPipeline(this.renderer);
    pipeline.outputNode = vec4(col, 1);
    this.pipeline = pipeline;
  }

  resize(force = false): void {
    const w = Math.max(1, window.innerWidth),
      h = Math.max(1, window.innerHeight);
    if (!force && w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    const dpr = Math.min(window.devicePixelRatio || 1, this.quality.dpr) * this.dynScale;
    this.renderer.setPixelRatio(Math.max(0.5, dpr));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Called with smoothed frame time; nudges resolution to hold 60fps. */
  adaptResolution(avgMs: number): void {
    const prev = this.dynScale;
    if (avgMs > 19.5) this.dynScale = Math.max(0.6, this.dynScale - 0.05);
    else if (avgMs < 14 && this.dynScale < 1) this.dynScale = Math.min(1, this.dynScale + 0.05);
    if (prev !== this.dynScale) this.resize(true);
  }

  render(): void {
    this.resize();
    if (this.pipeline) this.pipeline.render();
    else this.renderer.render(this.scene, this.camera);
    const info = this.renderer.info as any;
    this.drawCalls = info?.render?.drawCalls ?? info?.render?.calls ?? 0;
  }
}

/**
 * three r186 sends `swizzle: 'rgba'` on every GPUTextureViewDescriptor. Some shipping browsers implement an
 * older draft where `swizzle` is a dictionary and throw on the string. 'rgba' is the identity, so drop it.
 */
function patchTextureViewSwizzle(): void {
  const T = (globalThis as unknown as { GPUTexture?: { prototype: { createView: (d?: object) => unknown; __rcPatched?: boolean } } }).GPUTexture;
  if (!T || T.prototype.__rcPatched) return;
  const orig = T.prototype.createView;
  T.prototype.createView = function (desc?: { swizzle?: unknown }) {
    if (desc && desc.swizzle === 'rgba') {
      const { swizzle: _s, ...rest } = desc;
      return orig.call(this, rest);
    }
    return orig.call(this, desc);
  };
  T.prototype.__rcPatched = true;
}
