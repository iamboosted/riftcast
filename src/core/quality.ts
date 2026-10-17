export type QualityName = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  name: QualityName;
  label: string;
  /** max device pixel ratio */
  dpr: number;
  /** GPU particle pool size (WebGPU compute path) */
  gpuParticles: number;
  /** CPU particle pool size (WebGL2 fallback path) */
  cpuParticles: number;
  bloom: boolean;
  bloomStrength: number;
  chromatic: boolean;
  distortion: boolean;
  softParticles: boolean;
  shadows: boolean;
  trails: number;
  /** scale for emitter spawn counts */
  density: number;
  decorDensity: number;
}

export const QUALITY: Record<QualityName, QualityPreset> = {
  low: { name: 'low', label: 'Low', dpr: 1, gpuParticles: 16384, cpuParticles: 4096, bloom: true, bloomStrength: 0.75, chromatic: false, distortion: false, softParticles: false, shadows: false, trails: 24, density: 0.5, decorDensity: 0.4 },
  medium: { name: 'medium', label: 'Medium', dpr: 1.25, gpuParticles: 32768, cpuParticles: 8192, bloom: true, bloomStrength: 0.85, chromatic: true, distortion: false, softParticles: false, shadows: false, trails: 40, density: 0.8, decorDensity: 0.7 },
  high: { name: 'high', label: 'High', dpr: 1.75, gpuParticles: 65536, cpuParticles: 12288, bloom: true, bloomStrength: 0.95, chromatic: true, distortion: true, softParticles: true, shadows: true, trails: 64, density: 1, decorDensity: 1 },
  ultra: { name: 'ultra', label: 'Ultra', dpr: 2, gpuParticles: 131072, cpuParticles: 16384, bloom: true, bloomStrength: 1.0, chromatic: true, distortion: true, softParticles: true, shadows: true, trails: 96, density: 1.35, decorDensity: 1.3 },
};

export const QUALITY_ORDER: QualityName[] = ['low', 'medium', 'high', 'ultra'];

export function isMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iPadOS = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return /iPhone|iPad|iPod|Android|Mobile/i.test(ua) || iPadOS;
}

/**
 * Heuristic auto-detect. Mobile defaults to 'low' at a 1.0-1.25 DPR cap, which holds 60fps on recent iPhones;
 * desktops with WebGPU get 'high', WebGL2-only desktops 'medium'.
 */
export function autoQuality(webgpu: boolean): QualityName {
  if (typeof window !== 'undefined') {
    const q = new URLSearchParams(location.search).get('quality');
    if (q && q in QUALITY) return q as QualityName;
  }
  if (isMobile()) return 'low';
  const cores = navigator.hardwareConcurrency ?? 4;
  if (!webgpu) return cores >= 8 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}
