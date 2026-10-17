import * as THREE from 'three/webgpu';
import {
  instancedBufferAttribute,
  vec3,
  vec4,
  float,
  smoothstep,
  uv,
  mx_noise_float,
  time,
  pow,
  abs,
  normalView,
  positionViewDirection,
  dot,
  positionLocal,
  clamp,
} from '../render/tsl';

interface RingInst {
  x: number;
  y: number;
  z: number;
  r0: number;
  r1: number;
  t: number;
  life: number;
  color: THREE.Color;
  intensity: number;
  thick: number;
  tilt: number;
}

/**
 * Pooled instanced shockwaves: flat expanding rings (ground) and fresnel dome shells (big blasts).
 */
export class Shockwaves {
  group = new THREE.Group();
  private rings: RingInst[] = [];
  private domes: RingInst[] = [];
  private ringMesh: THREE.InstancedMesh;
  private domeMesh: THREE.InstancedMesh;
  private ringData: THREE.InstancedBufferAttribute;
  private ringCol: THREE.InstancedBufferAttribute;
  private domeData: THREE.InstancedBufferAttribute;
  private domeCol: THREE.InstancedBufferAttribute;
  private dummy = new THREE.Object3D();
  constructor(private max = 64) {
    // Ring: annulus mapped so uv.y runs inner->outer
    const rg = new THREE.RingGeometry(0.0, 1, 64, 1);
    rg.rotateX(-Math.PI / 2);
    const mkAttr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(max * n), n).setUsage(THREE.DynamicDrawUsage);
    this.ringData = mkAttr(4); // t01, thickness, intensity, seed
    this.ringCol = mkAttr(3);
    const rm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
    const d = instancedBufferAttribute(this.ringData);
    const c = instancedBufferAttribute(this.ringCol);
    const r = positionLocal.xz.length();
    const thick = d.y;
    const band = smoothstep(float(1).sub(thick), float(1).sub(thick.mul(0.35)), r).mul(smoothstep(1.0, 0.9, r));
    const inner = smoothstep(float(1).sub(thick.mul(3.0)), float(0.97), r).mul(smoothstep(1.0, 0.95, r)).mul(0.12);
    const n = mx_noise_float(vec3(positionLocal.x.mul(4), positionLocal.z.mul(4), d.w.add(time))).mul(0.5).add(0.5);
    const fade = pow(float(1).sub(d.x), 1.6);
    const a = band.add(inner).mul(n.mul(0.6).add(0.6)).mul(fade).mul(d.z);
    rm.colorNode = vec4(c.mul(a), a);
    this.ringMesh = new THREE.InstancedMesh(rg, rm, max);
    this.ringMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.ringMesh.frustumCulled = false;
    this.ringMesh.count = 0;
    this.ringMesh.renderOrder = 22;

    const dg = new THREE.IcosahedronGeometry(1, 3);
    this.domeData = mkAttr(4);
    this.domeCol = mkAttr(3);
    const dm = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false });
    const dd = instancedBufferAttribute(this.domeData);
    const dc = instancedBufferAttribute(this.domeCol);
    const fres = pow(float(1).sub(abs(dot(normalView, positionViewDirection))), 3.5);
    const dn = mx_noise_float(positionLocal.mul(3).add(vec3(0, time.mul(2), dd.w))).mul(0.5).add(0.5);
    const dfade = pow(float(1).sub(dd.x), 2);
    const above = smoothstep(-0.2, 0.1, positionLocal.y);
    const da = clamp(fres.mul(dn.mul(0.8).add(0.4)).mul(dfade).mul(dd.z).mul(above), 0, 2);
    dm.colorNode = vec4(dc.mul(da), da);
    this.domeMesh = new THREE.InstancedMesh(dg, dm, max / 2);
    this.domeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.domeMesh.frustumCulled = false;
    this.domeMesh.count = 0;
    this.domeMesh.renderOrder = 21;
    this.group.add(this.ringMesh, this.domeMesh);
    void uv;
  }

  ring(x: number, y: number, z: number, radius: number, color: number, o: { life?: number; intensity?: number; thick?: number; r0?: number; tilt?: number } = {}): void {
    if (this.rings.length >= this.max) this.rings.shift();
    this.rings.push({ x, y: y + 0.08, z, r0: o.r0 ?? radius * 0.1, r1: radius, t: 0, life: o.life ?? 0.5, color: new THREE.Color(color), intensity: o.intensity ?? 3, thick: o.thick ?? 0.18, tilt: o.tilt ?? 0 });
  }

  dome(x: number, y: number, z: number, radius: number, color: number, o: { life?: number; intensity?: number } = {}): void {
    if (this.domes.length >= this.max / 2) this.domes.shift();
    this.domes.push({ x, y, z, r0: radius * 0.2, r1: radius, t: 0, life: o.life ?? 0.45, color: new THREE.Color(color), intensity: o.intensity ?? 1.4, thick: 0, tilt: 0 });
  }

  update(dt: number): void {
    const step = (list: RingInst[], mesh: THREE.InstancedMesh, data: THREE.InstancedBufferAttribute, col: THREE.InstancedBufferAttribute) => {
      for (let i = list.length - 1; i >= 0; i--) {
        list[i].t += dt;
        if (list[i].t >= list[i].life) list.splice(i, 1);
      }
      const da = data.array as Float32Array,
        ca = col.array as Float32Array;
      list.forEach((r, i) => {
        const k = r.t / r.life;
        const e = 1 - Math.pow(1 - k, 3);
        const rad = r.r0 + (r.r1 - r.r0) * e;
        this.dummy.position.set(r.x, r.y, r.z);
        this.dummy.rotation.set(r.tilt, 0, 0);
        this.dummy.scale.setScalar(Math.max(0.01, rad));
        this.dummy.updateMatrix();
        mesh.setMatrixAt(i, this.dummy.matrix);
        da[i * 4] = k;
        da[i * 4 + 1] = r.thick;
        da[i * 4 + 2] = r.intensity;
        da[i * 4 + 3] = (i * 7.31) % 10;
        ca[i * 3] = r.color.r;
        ca[i * 3 + 1] = r.color.g;
        ca[i * 3 + 2] = r.color.b;
      });
      mesh.count = list.length;
      mesh.instanceMatrix.needsUpdate = true;
      data.needsUpdate = true;
      col.needsUpdate = true;
    };
    step(this.rings, this.ringMesh, this.ringData, this.ringCol);
    step(this.domes, this.domeMesh, this.domeData, this.domeCol);
  }
}
