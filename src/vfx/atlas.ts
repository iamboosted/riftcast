import * as THREE from 'three/webgpu';

/** Particle sprite shapes, laid out in a 4x4 procedural atlas. */
export const SHAPE = {
  glow: 0,
  spark: 1,
  flame: 2,
  smoke: 3,
  shard: 4,
  ring: 5,
  flare: 6,
  bubble: 7,
  rock: 8,
  wisp: 9,
  zap: 10,
  blob: 11,
  flake: 12,
  ember: 13,
  chip: 14,
  plus: 15,
} as const;
export type ShapeId = (typeof SHAPE)[keyof typeof SHAPE];

let cached: THREE.Texture | null = null;

/** Draws every sprite shape with Canvas2D at boot: zero image assets. */
export function particleAtlas(): THREE.Texture {
  if (cached) return cached;
  const C = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = C * 4;
  const g = cv.getContext('2d')!;
  const cell = (i: number, fn: (cx: number, cy: number) => void) => {
    const x = (i % 4) * C,
      y = Math.floor(i / 4) * C;
    g.save();
    g.beginPath();
    g.rect(x, y, C, C);
    g.clip();
    fn(x + C / 2, y + C / 2);
    g.restore();
  };
  const radial = (cx: number, cy: number, r: number, stops: [number, string][]) => {
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    for (const [o, c] of stops) gr.addColorStop(o, c);
    g.fillStyle = gr;
    g.fillRect(cx - C / 2, cy - C / 2, C, C);
  };
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  // 0 glow
  cell(0, (cx, cy) => radial(cx, cy, 62, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.65)'], [0.6, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]));
  // 1 spark: horizontal streak
  cell(1, (cx, cy) => {
    const gr = g.createLinearGradient(cx - 60, cy, cx + 60, cy);
    gr.addColorStop(0, 'rgba(255,255,255,0)');
    gr.addColorStop(0.7, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.85, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath();
    g.ellipse(cx, cy, 60, 9, 0, 0, Math.PI * 2);
    g.fill();
    radial(cx + 30, cy, 18, [[0, 'rgba(255,255,255,0.9)'], [1, 'rgba(255,255,255,0)']]);
  });
  // 2 flame tongue
  cell(2, (cx, cy) => {
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(cx, cy - 58 + k * 6);
      g.bezierCurveTo(cx + 34 - k * 6, cy - 10, cx + 40 - k * 8, cy + 40, cx, cy + 56 - k * 10);
      g.bezierCurveTo(cx - 40 + k * 8, cy + 40, cx - 30 + k * 6, cy - 10, cx, cy - 58 + k * 6);
      g.fillStyle = `rgba(255,255,255,${0.25 + k * 0.3})`;
      g.filter = `blur(${6 - k * 2}px)`;
      g.fill();
    }
    g.filter = 'none';
  });
  // 3 smoke puff
  cell(3, (cx, cy) => {
    g.filter = 'blur(6px)';
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2,
        d = rnd() * 26;
      const r = 16 + rnd() * 20;
      const gr = g.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.35)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(cx - C / 2, cy - C / 2, C, C);
    }
    g.filter = 'none';
  });
  // 4 ice shard: diamond with facet line
  cell(4, (cx, cy) => {
    g.beginPath();
    g.moveTo(cx + 58, cy);
    g.lineTo(cx, cy - 14);
    g.lineTo(cx - 50, cy);
    g.lineTo(cx, cy + 14);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(cx - 50, cy);
    g.lineTo(cx + 58, cy);
    g.stroke();
  });
  // 5 ring
  cell(5, (cx, cy) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.filter = 'blur(2px)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(cx, cy, 50, 0, Math.PI * 2);
    g.stroke();
    g.filter = 'none';
  });
  // 6 flare: 4-point star
  cell(6, (cx, cy) => {
    radial(cx, cy, 30, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
    for (const [w, h] of [[60, 4], [4, 60]]) {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, 62);
      gr.addColorStop(0, 'rgba(255,255,255,1)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
      g.fill();
    }
  });
  // 7 bubble
  cell(7, (cx, cy) => {
    radial(cx, cy, 50, [[0, 'rgba(255,255,255,0.08)'], [0.8, 'rgba(255,255,255,0.35)'], [0.95, 'rgba(255,255,255,0.95)'], [1, 'rgba(255,255,255,0)']]);
    radial(cx - 18, cy - 18, 14, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
  });
  // 8 rock chunk
  cell(8, (cx, cy) => {
    g.beginPath();
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 38 + rnd() * 18;
      if (i === 0) g.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      else g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    g.closePath();
    const gr = g.createLinearGradient(cx - 40, cy - 40, cx + 40, cy + 40);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(1, 'rgba(120,120,120,1)');
    g.fillStyle = gr;
    g.fill();
  });
  // 9 wisp: crescent arc
  cell(9, (cx, cy) => {
    g.filter = 'blur(2px)';
    g.lineCap = 'round';
    for (let k = 0; k < 3; k++) {
      g.strokeStyle = `rgba(255,255,255,${0.4 + k * 0.25})`;
      g.lineWidth = 10 - k * 3;
      g.beginPath();
      g.arc(cx, cy + 30, 52 - k * 4, Math.PI * 1.15, Math.PI * 1.85);
      g.stroke();
    }
    g.filter = 'none';
  });
  // 10 zap squiggle
  cell(10, (cx, cy) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 5;
    g.lineJoin = 'miter';
    g.shadowColor = 'white';
    g.shadowBlur = 10;
    g.beginPath();
    let x = cx - 58,
      y = cy;
    g.moveTo(x, y);
    for (let i = 0; i < 8; i++) {
      x += 14.5;
      y = cy + (rnd() - 0.5) * 50;
      g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
  });
  // 11 blob: gooey droplet
  cell(11, (cx, cy) => {
    radial(cx, cy + 6, 44, [[0, 'rgba(255,255,255,1)'], [0.7, 'rgba(255,255,255,0.85)'], [1, 'rgba(255,255,255,0)']]);
    radial(cx - 12, cy - 8, 12, [[0, 'rgba(255,255,255,1)'], [1, 'rgba(255,255,255,0)']]);
  });
  // 12 snowflake
  cell(12, (cx, cy) => {
    g.strokeStyle = 'rgba(255,255,255,1)';
    g.lineWidth = 5;
    g.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * 52, cy + Math.sin(a) * 52);
      const bx = cx + Math.cos(a) * 32,
        by = cy + Math.sin(a) * 32;
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(a + 0.8) * 14, by + Math.sin(a + 0.8) * 14);
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(a - 0.8) * 14, by + Math.sin(a - 0.8) * 14);
      g.stroke();
    }
  });
  // 13 ember: tight core with halo
  cell(13, (cx, cy) => radial(cx, cy, 40, [[0, 'rgba(255,255,255,1)'], [0.2, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]));
  // 14 chip: triangle shard
  cell(14, (cx, cy) => {
    g.beginPath();
    g.moveTo(cx, cy - 50);
    g.lineTo(cx + 40, cy + 36);
    g.lineTo(cx - 36, cy + 30);
    g.closePath();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.fill();
  });
  // 15 plus (heal)
  cell(15, (cx, cy) => {
    g.fillStyle = 'rgba(255,255,255,1)';
    g.filter = 'blur(1px)';
    g.fillRect(cx - 10, cy - 44, 20, 88);
    g.fillRect(cx - 44, cy - 10, 88, 20);
    g.filter = 'none';
  });

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cached = tex;
  return tex;
}
