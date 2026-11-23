// garage.js — Garage workbench: replaceable parts, pop-off / slide-in replacement, highlight,
// skins (via look.js setSkin), and the glowing memory orb used for a memory transfer.
import * as THREE from "three";
import { setSkin, setPartCondition, markReplaced, makeGlowTexture } from "./look.js";

const SERVOS = [
  ["servo_left_hip_yaw", "Left hip yaw"], ["servo_left_hip_roll", "Left hip roll"], ["servo_left_hip_pitch", "Left hip pitch"],
  ["servo_left_knee", "Left knee"], ["servo_left_ankle", "Left ankle"],
  ["servo_right_hip_yaw", "Right hip yaw"], ["servo_right_hip_roll", "Right hip roll"], ["servo_right_hip_pitch", "Right hip pitch"],
  ["servo_right_knee", "Right knee"], ["servo_right_ankle", "Right ankle"],
  ["servo_neck_pitch", "Neck pitch"], ["servo_head_pitch", "Head pitch"], ["servo_head_yaw", "Head yaw"], ["servo_head_roll", "Head roll"], ["servo_jaw", "Jaw"],
];
export const PARTS = [
  { id: "head", label: "Head shell", re: /^shell_head_(top|face)/, skin: "head", group: "Shell" },
  { id: "bodyL", label: "Body shell · left", re: /^shell_body_left/, skin: [/^shell_body_left/], group: "Shell" },
  { id: "bodyR", label: "Body shell · right", re: /^shell_body_right/, skin: [/^shell_body_right/], group: "Shell" },
  { id: "eye", label: "Eye / camera", re: /^(eye_camera_ring|electronics_camera_lens)/, group: "Shell" },
  { id: "beak", label: "Beak", re: /^(shell_beak|shell_head_bottom)/, skin: [/^shell_beak/, /^shell_head_bottom/], group: "Shell" },
  { id: "legL", label: "Left leg", re: /^(leg_left|foot_left)/, skin: "leftLeg", group: "Legs" },
  { id: "legR", label: "Right leg", re: /^(leg_right|foot_right)/, skin: "rightLeg", group: "Legs" },
  ...SERVOS.map(([n, l]) => ({ id: n, label: l, re: new RegExp("^" + n + "$"), group: "Servos", servo: true })),
];

const FLASH_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uA: { value: 0 }, uC: { value: new THREE.Color("#FFF1D6").multiplyScalar(2.2) } },
  vertexShader: `varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
  fragmentShader: `uniform float uA; uniform vec3 uC; varying vec3 vN; varying vec3 vV;
    void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0); gl_FragColor = vec4(uC * (0.25 + f) * uA, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

export class Workshop {
  constructor({ scene, duck, rig, reduced }) {
    this.scene = scene; this.reduced = reduced;
    this.anims = []; this.highlights = new Map();
    this.bind(duck, rig);
  }
  bind(duck, rig) {
    this.duck = duck; this.rig = rig;
    this.parts = PARTS.map(p => ({ ...p, meshes: rig.meshes.filter(m => p.re.test(m.name)), replaced: false, swaps: 0 }));
    this.meshToPart = new Map(); for (const p of this.parts) for (const m of p.meshes) this.meshToPart.set(m, p);
    this.clearHighlight();
  }
  get total() { return this.parts.length; }
  get originals() { return this.parts.filter(p => !p.replaced).length; }
  partOfMesh(m) { while (m) { if (this.meshToPart.has(m)) return this.meshToPart.get(m); m = m.parent; } return null; }
  pickMeshes() { return this.parts.flatMap(p => p.meshes); }

  markAllNew() { for (const p of this.parts) { p.replaced = true; p.swaps = 1; } }
  wear() { setPartCondition(this.rig, null, "worn"); }

  // --- highlight (selection)
  highlight(part, color = "#64D2FF") {
    this.clearHighlight();
    if (!part) return;
    for (const src of part.meshes) {
      const m = FLASH_MAT(); m.uniforms.uC.value = new THREE.Color(color).multiplyScalar(1.6); m.uniforms.uA.value = 0.9;
      const o = new THREE.Mesh(src.geometry, m); o.userData.lookFX = true; o.renderOrder = 13; o.raycast = () => {};
      this.rig.addTracked(o, src); this.highlights.set(o, src);
    }
  }
  clearHighlight() { for (const o of this.highlights.keys()) { this.rig.removeTracked(o); o.material.dispose(); } this.highlights.clear(); }

  /** replace a part: old copy pops off, the real part (now "new") slides back in. returns duration */
  replace(part) {
    const dur = this.reduced ? 0.8 : 1.7;
    this.clearHighlight();
    this.duck.root.updateMatrixWorld(true);
    const box = new THREE.Box3(); part.meshes.forEach(m => box.expandByObject(m));
    const c = box.getCenter(new THREE.Vector3());
    const dc = this.duck.trunk.getWorldPosition(new THREE.Vector3());
    const out = c.clone().sub(dc); out.y = Math.max(out.y, 0) * 0.5; if (out.lengthSq() < 1e-6) out.set(1, 0, 0);
    out.normalize().add(new THREE.Vector3(0, 0.55, 0)).normalize();
    // ghosts of the old part
    const ghosts = part.meshes.map(src => {
      const mat = src.material.clone(); mat.transparent = true; mat.depthWrite = true;
      mat.onBeforeCompile = src.material.onBeforeCompile; mat.customProgramCacheKey = src.material.customProgramCacheKey;
      const g = new THREE.Mesh(src.geometry, mat); g.matrixAutoUpdate = false; g.matrix.copy(src.matrixWorld);
      g.userData.base = src.matrixWorld.clone(); g.castShadow = true; g.userData.lookNoContact = true;
      this.scene.add(g); return g;
    });
    // the "new" part: hide, then slide in along `out`
    const bases = part.meshes.map(m => ({ m, pos: m.position.clone(), scl: (m.userData.baseScale ||= m.scale.clone()).clone(), dirLocal: (() => { const inv = new THREE.Quaternion(); m.parent.getWorldQuaternion(inv).invert(); return out.clone().applyQuaternion(inv); })() }));
    part.meshes.forEach(m => m.scale.copy(m.userData.baseScale).multiplyScalar(1e-4)); // (look.setWeights owns .visible)
    part.replaced = true; part.swaps++;
    if (part.servo || part.id === "eye") this._freshen(part.meshes);
    else markReplaced(this.rig, part.meshes.map(m => new RegExp("^" + m.name + "$")), { duration: 2.2 + dur * 0.5, condition: "new" });
    const spin = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
    const dist = 0.12;
    let t = 0;
    const flash = part.meshes.map(src => { const m = FLASH_MAT(); const o = new THREE.Mesh(src.geometry, m); o.userData.lookFX = true; o.renderOrder = 13; o.raycast = () => {}; this.rig.addTracked(o, src); o.visible = false; return o; });
    this.anims.push((dt) => {
      t += dt; const u = t / dur;
      // pop off: first 55%
      const a = Math.min(1, u / 0.55);
      ghosts.forEach(g => {
        const e = 1 - Math.pow(1 - a, 2);
        const m = new THREE.Matrix4().makeTranslation(out.x * dist * 1.6 * e, out.y * dist * 1.6 * e - 0.25 * Math.max(0, a - 0.5) ** 2, out.z * dist * 1.6 * e);
        const pivot = new THREE.Vector3().setFromMatrixPosition(g.userData.base);
        const r = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z).multiply(new THREE.Matrix4().makeRotationAxis(spin, e * 2.2)).multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
        g.matrix.copy(m).multiply(r).multiply(g.userData.base);
        g.material.opacity = 1 - smoothstep(0.35, 1, a);
        g.visible = a < 1;
      });
      // slide in: from 35% to 100%
      const b = Math.max(0, Math.min(1, (u - 0.35) / 0.65));
      if (b > 0) {
        const e = 1 - Math.pow(1 - b, 3);
        for (const { m, pos, scl, dirLocal } of bases) { m.scale.copy(scl); m.position.copy(pos).addScaledVector(dirLocal, dist * (1 - e)); }
        flash.forEach(o => { o.visible = true; o.material.uniforms.uA.value = (1 - b) * 1.2 + 0.15 * Math.sin(b * Math.PI); });
      }
      if (u >= 1) {
        for (const { m, pos, scl } of bases) { m.position.copy(pos); m.scale.copy(scl); }
        ghosts.forEach(g => { this.scene.remove(g); g.material.dispose(); });
        flash.forEach(o => { this.rig.removeTracked(o); o.material.dispose(); });
        return false;
      }
    });
    return dur;
  }
  _freshen(meshes) {
    for (const m of meshes) {
      if (!m.userData.freshMat) {
        const src = m.material, c = src.clone(); c.onBeforeCompile = src.onBeforeCompile; c.customProgramCacheKey = src.customProgramCacheKey;
        c.userData = { ...src.userData };
        if ("roughness" in c) c.roughness = Math.max(0.12, (c.roughness ?? 0.5) * 0.55);
        if ("clearcoat" in c) { c.clearcoat = 0.8; c.clearcoatRoughness = 0.08; }
        if (c.color) c.color.offsetHSL(0, 0, 0.04);
        m.material = c; m.userData.freshMat = true;
      }
    }
  }
  /** skins: name in cream|graphite|lavender|sky; target: 'all' or a part-group key */
  skin(name, target = "all") {
    const map = { all: undefined, head: ["head"], body: ["body"], beak: ["beak"], leftLeg: ["leftLeg"], rightLeg: ["rightLeg"], feet: ["feet"] };
    setSkin(this.rig, name, { parts: map[target] });
  }
  update(dt) { this.anims = this.anims.filter(fn => fn(dt) !== false); }
  get busy() { return this.anims.length > 0; }
}

function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** glowing memory orb that travels from one duck's head to another's */
export class MemoryOrb {
  constructor(scene) {
    this.scene = scene;
    const tex = makeGlowTexture();
    this.group = new THREE.Group(); this.group.visible = false; this.group.userData.lookFX = true; scene.add(this.group);
    this.core = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color("#E9D5FF").multiplyScalar(3), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.core.scale.setScalar(0.05); this.group.add(this.core);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color("#BF5AF2").multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(0.14); this.group.add(this.halo);
    this.trail = [];
    for (let i = 0; i < 26; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color("#BF5AF2").multiplyScalar(1.4), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      s.scale.setScalar(0.02); s.userData.lookFX = true; scene.add(s); this.trail.push({ s, p: new THREE.Vector3(), life: 0 });
    }
    this.light = new THREE.PointLight(0xc58cff, 0, 0.5, 2); this.group.add(this.light);
    this.anim = null;
  }
  /** fly from getA() to getB() (functions returning world positions) over dur seconds */
  fly(getA, getB, dur = 2.6, onDone) {
    this.group.visible = true; let t = 0, k = 0;
    this.anim = (dt) => {
      t += dt; const u = Math.min(1, t / dur);
      const A = getA(), B = getB();
      // rise out of A, arc, descend into B
      const e = u < 0.2 ? 0 : (u > 0.85 ? 1 : (u - 0.2) / 0.65);
      const ee = e * e * (3 - 2 * e);
      const p = A.clone().lerp(B, ee); p.y += Math.sin(Math.PI * ee) * 0.16 + (u < 0.2 ? u / 0.2 * 0.05 : (u > 0.85 ? (1 - (u - 0.85) / 0.15) * 0.05 : 0.05));
      this.group.position.copy(p);
      const grow = u < 0.15 ? u / 0.15 : (u > 0.9 ? (1 - u) / 0.1 : 1);
      const pulse = 1 + 0.12 * Math.sin(t * 14);
      this.core.scale.setScalar(0.045 * grow * pulse); this.halo.scale.setScalar(0.16 * grow * pulse);
      this.light.intensity = 0.012 * grow;
      // trail
      const tr = this.trail[k++ % this.trail.length]; tr.p.copy(p).add(new THREE.Vector3((Math.random() - .5) * 0.01, (Math.random() - .5) * 0.01, (Math.random() - .5) * 0.01)); tr.life = 1;
      for (const q of this.trail) { q.life = Math.max(0, q.life - dt * 1.8); q.s.position.copy(q.p); q.s.material.opacity = q.life * grow; q.s.scale.setScalar(0.022 * q.life); q.s.visible = q.life > 0; }
      if (u >= 1) { this.light.intensity = 0; this.group.visible = false; this.trail.forEach(q => q.s.visible = false); this.anim = null; onDone && onDone(); }
    };
  }
  update(dt) { if (this.anim) this.anim(dt); }
}
