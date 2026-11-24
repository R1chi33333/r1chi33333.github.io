// toon.js — the comic-book look for Microduck Lab (three.js r160).
//
//   toonify(material, opts)        patch any MeshStandard/MeshPhysical material into banded toon shading
//                                   (3-band ramp, hue-shifted shadows, screen-space halftone + cross-hatching,
//                                   coloured rim band, hard specular pop). Composes with existing onBeforeCompile.
//   toonifyTree(object3d, opts)    toonify every standard material below an object
//   TOON                           shared uniforms (thresholds, dot size, ink colour…); live-editable
//   twos                           "animating on twos": characters step at 12 fps while the camera stays smooth
//   setupComicPost(renderer, scene, camera, opts) -> { composer, resize, render, fx, comic, twos }
//   createComicFX(opts)            comic stickers (BONK!, GOAL!, ZOOM, SNAP!, WHEE!), speed lines, impact frames
//
// Everything is screen-space and resolution-aware, so it stays crisp at DPR 2.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

// ================================================================== shared uniforms
export const TOON = {
  uTnKey: { value: 2.4 },                       // key-light intensity that counts as "fully lit"
  uTnT1: { value: 0.62 },                       // lit / mid threshold (fraction of key light)
  uTnT2: { value: 0.22 },                       // mid / shadow threshold
  uTnT3: { value: 0.06 },                       // deep shadow (hatching) threshold
  uTnDotPx: { value: 7.0 },                     // halftone cell in device pixels (set from DPR)
  uTnHatchPx: { value: 6.0 },                   // hatch spacing in device pixels
  uTnHatch: { value: 1.0 },                     // 0 = no hatching (phone tier)
  uTnRimT: { value: 0.55 },                     // fresnel threshold for the rim band
  uTnRimColor: { value: new THREE.Color("#FF7AD9") },
  uTnLitGain: { value: 1.0 },
  uTnShadowHue: { value: 0.72 },                // hue the shadows lean towards (violet)
};
export const INK = new THREE.Color("#1B1430");
export const PAPER = new THREE.Color("#FFF7E8");

const TOON_HEAD = /* glsl */`
uniform float uTnKey, uTnT1, uTnT2, uTnT3, uTnDotPx, uTnHatchPx, uTnHatch, uTnRimT, uTnLitGain, uTnShadowHue;
uniform vec3 uTnRimColor;
uniform float uTnSpec, uTnSpecT, uTnRim, uTnHue, uTnHalftone, uTnLift, uTnTwo, uTnSoft, uTnHatchOn, uTnMask, uTnShade, uTnDeep;
vec3 tnHsv(vec3 c){ vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0); vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r)); float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x); }
vec3 tnRgb(vec3 c){ vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0); vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y); }
// shadow colour: darker, more saturated and hue-shifted towards violet (greys pick up a lilac tint)
vec3 tnShadow(vec3 lin){
  vec3 s = pow(max(lin, 0.0), vec3(1.0 / 2.2)); vec3 h = tnHsv(s);
  float d = uTnShadowHue - h.x; d -= floor(d + 0.5);
  float hs = fract(h.x + d * 0.22 * uTnHue + 1.0);
  h.x = mix(uTnShadowHue, hs, smoothstep(0.04, 0.2, h.y));
  h.y = clamp(max(h.y * 1.12, 0.24 * uTnHue), 0.0, 1.0);
  h.z *= 0.6;
  return pow(tnRgb(h), vec3(2.2));
}
float tnDots(vec2 fc, float px, float ang){ float s = sin(ang), c = cos(ang); vec2 p = mat2(c, -s, s, c) * fc / px; return length(fract(p) - 0.5); }
float tnHatch(vec2 fc, float px){
  float a = abs(fract((fc.x + fc.y) / px) - 0.5), b = abs(fract((fc.x - fc.y) / (px * 1.15)) - 0.5);
  return max(1.0 - smoothstep(0.1, 0.18, a), 0.75 * (1.0 - smoothstep(0.08, 0.15, b)));
}
`;
const TOON_BODY = /* glsl */`
{
  vec3 tAlb = diffuseColor.rgb;
  const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);
  float tDen = max(dot(material.diffuseColor, LUM), 1e-3) * RECIPROCAL_PI;
  float q = dot(reflectedLight.directDiffuse, LUM) / tDen / uTnKey + uTnLift;   // lift: big flat surfaces stay in the clean lit band
  float aa = clamp(fwidth(q), 1e-3, 0.08);
  float lit = smoothstep(uTnT1 - aa, uTnT1 + aa, q);
  float mid = smoothstep(uTnT2 - aa, uTnT2 + aa, q);
  vec3 sh = tnShadow(tAlb);
  vec3 midC = mix(sh, tAlb, 0.6);
  vec3 c = mix(sh, midC, mid);
  c = mix(c, tAlb * uTnLitGain, lit);
  vec2 fc = gl_FragCoord.xy;
  // halftone: dots of shadow colour grow across the mid band towards the terminator
  float cover = 1.0 - clamp((q - uTnT2) / max(uTnT1 - uTnT2, 1e-3), 0.0, 1.0);
  float hd = tnDots(fc, uTnDotPx, 0.4363);
  float dotR = 0.12 + 0.5 * cover;
  float dotm = (1.0 - smoothstep(dotR - 0.07, dotR + 0.07, hd)) * mid * (1.0 - lit);
  c = mix(c, sh, dotm * 0.8 * uTnHalftone);
  // shadow band: sparse light dots near its edge, cross-hatching in the deepest shadow
  float hd2 = tnDots(fc, uTnDotPx, 0.4363);
  float lift = (1.0 - mid) * smoothstep(uTnT3, uTnT2, q);
  c = mix(c, midC, (1.0 - smoothstep(0.16, 0.26, hd2)) * lift * 0.5 * uTnHalftone);
  float deep = 1.0 - smoothstep(uTnT3 - aa, uTnT3 + aa, q);
  c = mix(c, sh * 0.62, deep * tnHatch(fc, uTnHatchPx) * uTnHatch * uTnHatchOn * uTnHalftone);
  // character mode (ducks): two clean bands with a softer terminator, subtle dots only inside the shadow
  if (uTnTwo > 0.5) {
    float tT = mix(uTnT2, uTnT1, 0.45), w = aa + uTnSoft;
    float l2 = smoothstep(tT - w, tT + w, q);
    vec3 sh2 = mix(sh * uTnDeep, tAlb, uTnShade);   // character shadow tone: shade = how much albedo survives, deep = extra darkening (spot blacks)
    c = mix(sh2, tAlb * uTnLitGain, l2);
    float hd3 = tnDots(fc, uTnDotPx, 0.4363);
    float inSh = (1.0 - l2) * smoothstep(tT - w - 0.14, tT - w, q);   // a band of dots along the shadow side of the terminator
    c = mix(c, sh2 * 0.82, (1.0 - smoothstep(0.2, 0.3, hd3)) * inSh * 0.55 * uTnHalftone);
  }
  // rim band: coloured light catching the silhouette
  float ndv = clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, 3.0);
  float rim = smoothstep(uTnRimT - 0.03, uTnRimT + 0.03, fres) * (1.0 - lit * 0.5);
  c = mix(c, mix(tAlb, uTnRimColor, 0.5) * 1.08, rim * uTnRim);
  // hard specular pop
  float sp = dot(reflectedLight.directSpecular, LUM) / uTnKey;
  c = mix(c, vec3(1.0, 0.97, 0.92), smoothstep(uTnSpecT, uTnSpecT + 0.04, sp) * uTnSpec);
  outgoingLight = c + totalEmissiveRadiance;
}
`;
const TOON_MASK = /* glsl */`
  if (uTnMask > 0.0) gl_FragColor.a = 1.0 - uTnMask;   // object mask for the ink pass (ducks)
`;

/**
 * Turn a MeshStandardMaterial / MeshPhysicalMaterial into toon shading in place.
 * opts: { spec (0..1, hard highlight), specT (threshold), rim (0..1), hue (shadow hue shift 0..1),
 *         halftone (0..1), keepMaps (keep normal/roughness maps; default false), flat (drop colour map) }
 */
export function toonify(m, opts = {}) {
  if (!m || !(m.isMeshStandardMaterial) || m.userData.toon) return m;
  const U = m.userData.toonU = {
    uTnSpec: { value: opts.spec ?? (m.roughness < 0.5 ? 0.85 : 0.0) },
    uTnSpecT: { value: opts.specT ?? 0.55 },
    uTnRim: { value: opts.rim ?? 0.55 },
    uTnHue: { value: opts.hue ?? 1.0 },
    uTnHalftone: { value: opts.halftone ?? 1.0 },
    uTnLift: { value: opts.lift ?? m.userData.toonLift ?? 0.0 },
    uTnTwo: { value: opts.twoBand ? 1 : 0 },
    uTnSoft: { value: opts.soft ?? 0.0 },
    uTnHatchOn: { value: opts.hatch === false ? 0 : 1 },
    uTnMask: { value: opts.mask ?? 0.0 },
    uTnShade: { value: opts.shade ?? 0.45 },
    uTnDeep: { value: opts.deep ?? 1.0 },
  };
  m.userData.toon = true;
  if (!opts.keepMaps) {
    m.normalMap = null; m.roughnessMap = null; m.metalnessMap = null; m.aoMap = null; m.bumpMap = null;
    if (m.isMeshPhysicalMaterial) { m.clearcoatNormalMap = null; m.sheen = 0; m.clearcoat = 0; m.transmission = 0; m.iridescence = 0; }
  }
  if (opts.flat) m.map = null;
  m.metalness = 0; m.envMap = null; m.envMapIntensity = 0;
  const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    Object.assign(s.uniforms, TOON, (this.userData && this.userData.toonU) || U);
    s.fragmentShader = TOON_HEAD + s.fragmentShader.replace("#include <opaque_fragment>", TOON_BODY + "\n#include <opaque_fragment>\n" + TOON_MASK);
  };
  const base = prevKey && prevKey !== THREE.Material.prototype.customProgramCacheKey ? prevKey.call(m) : "std";
  m.customProgramCacheKey = () => base + "|toon";
  m.needsUpdate = true;
  return m;
}
export function toonifyTree(root, opts = {}) {
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) toonify(m, opts);
  });
  return root;
}

// ================================================================== animating on twos
// Character roots register here. Between 12 fps ticks the registered hierarchies are drawn with the pose
// captured at the last tick, while the simulation keeps the live pose (restored right after rendering).
export const twos = {
  enabled: false, fps: 12, stepRoot: false, props: false,   // off by default: full-frame-rate animation (set true for the stepped look)
  roots: new Set(), _acc: 0, _tick: true,
  register(root) { if (root) this.roots.add(root); return root; },
  unregister(root) { this.roots.delete(root); },
  _nodes(root) {
    if (!root.userData.twosNodes) { const list = []; root.traverse((o) => { if (o !== root || this.stepRoot) if (!o.userData.lookFX) list.push(o); }); Object.defineProperty(root.userData, "twosNodes", { value: list, writable: true, configurable: true, enumerable: false }); }
    return root.userData.twosNodes;
  },
  _attached(o) { while (o.parent) o = o.parent; return o.isScene; },
  /** call once per rendered frame before drawing; dt = 0 means "always live" (tests, paused) */
  hold(dt) {
    if (!this.enabled || !this.roots.size) return;
    this._acc += dt;
    const tick = dt <= 0 || this._acc >= 1 / this.fps || this._first !== false;
    if (tick) this._acc = dt <= 0 ? 0 : this._acc % (1 / this.fps);
    this._first = false;
    for (const root of this.roots) {
      if (!this._attached(root)) { if (!root.parent) this.roots.delete(root); continue; }
      const nodes = this._nodes(root), n = nodes.length;
      let snap = root.userData.twosSnap, live = root.userData.twosLive;
      if (!snap || snap.length !== n * 7) { snap = root.userData.twosSnap = new Float32Array(n * 7); live = root.userData.twosLive = new Float32Array(n * 7); root.userData.twosFresh = true; }
      for (let i = 0; i < n; i++) { const o = nodes[i], k = i * 7; o.position.toArray(live, k); o.quaternion.toArray(live, k + 3); }
      if (tick || root.userData.twosFresh) { snap.set(live); root.userData.twosFresh = false; }
      else for (let i = 0; i < n; i++) { const o = nodes[i], k = i * 7; o.position.fromArray(snap, k); o.quaternion.fromArray(snap, k + 3); }
      root.userData.twosHeld = !tick;
    }
  },
  /** call after drawing: puts the live pose back for the simulation */
  release() {
    if (!this.enabled) return;
    for (const root of this.roots) {
      if (!root.userData.twosHeld) continue;
      const nodes = this._nodes(root), live = root.userData.twosLive;
      for (let i = 0; i < nodes.length; i++) { const o = nodes[i], k = i * 7; o.position.fromArray(live, k); o.quaternion.fromArray(live, k + 3); }
      root.updateMatrixWorld(true); root.userData.twosHeld = false;
    }
  },
};

// ================================================================== comic post pass
const COMIC_SHADER = {
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null },
    uRes: { value: new THREE.Vector2(1, 1) }, uNear: { value: 0.01 }, uFar: { value: 40 },
    uInvProj: { value: new THREE.Matrix4() }, uBoil: { value: 0 }, uLine: { value: 1.3 }, uWobble: { value: 1.0 },
    uInk: { value: INK.clone() }, uPaper: { value: PAPER.clone() }, uMis: { value: 0.8 }, uPoster: { value: 0.45 }, uGrain: { value: 1.0 },
    uSpeedC: { value: new THREE.Vector2(0.5, 0.5) }, uSpeedAmt: { value: 0 }, uSpeedT: { value: 0 }, uImpact: { value: 0 },
    uCrease: { value: 1.0 }, uVignette: { value: 0.18 },
  },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
  fragmentShader: /* glsl */`
    #include <packing>
    uniform sampler2D tDiffuse, tDepth;
    uniform vec2 uRes, uSpeedC; uniform float uNear, uFar, uBoil, uLine, uWobble, uMis, uPoster, uGrain, uSpeedAmt, uSpeedT, uImpact, uCrease, uVignette;
    uniform mat4 uInvProj; uniform vec3 uInk, uPaper;
    varying vec2 vUv;
    float h21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
    float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }
    float dAt(vec2 uv){ return texture2D(tDepth, uv).x; }
    float vz(float d){ return -perspectiveDepthToViewZ(d, uNear, uFar); }
    vec3 vpos(vec2 uv, float d){ vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
    vec3 toSRGB(vec3 c){ c = clamp(c, 0.0, 1.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
    void main(){
      vec2 px = 1.0 / uRes;
      // hand-drawn boil: the ink samples wobble with low-frequency noise that changes ~8 times a second
      // (all depth reads are snapped to texel centres: the depth texture is sampled nearest, so sub-pixel
      //  offsets would make reconstructed positions disagree with their depth values)
      vec2 wobPx = floor((vec2(vn(vUv * uRes / 41.0 + uBoil), vn(vUv * uRes / 37.0 - uBoil + 7.3)) - 0.5) * 2.0 * uWobble + 0.5);
      vec2 uv = (floor(gl_FragCoord.xy) + wobPx + 0.5) * px;
      float dC = dAt(uv), zC = vz(dC);
      float r = max(1.0, floor(uLine * mix(1.65, 0.75, smoothstep(0.35, 3.2, zC)) + 0.5));
      vec2 o1 = vec2(r, 0.0) * px, o2 = vec2(0.0, r) * px;
      float dL = dAt(uv - o1), dR = dAt(uv + o1), dD = dAt(uv - o2), dU = dAt(uv + o2);
      // silhouettes: relative depth jump over a slightly wider footprint (bolder outer line)
      vec2 s1 = vec2(floor(r * 1.4 + 0.5), 0.0) * px, s2 = vec2(0.0, floor(r * 1.4 + 0.5)) * px;
      float z1 = vz(dAt(uv - s1)), z2 = vz(dAt(uv + s1)), z3 = vz(dAt(uv - s2)), z4 = vz(dAt(uv + s2));
      float zmx = max(max(z1, z2), max(z3, z4)), zmn = min(min(z1, z2), min(z3, z4));
      float jump = (max(zmx, zC) - min(zmn, zC)) / max(min(zmn, zC), 1e-3);
      // object mask (alpha < 0.9 = character): outer outline where the mask changes, much higher interior
      // thresholds so the many small CAD parts inside a duck don't turn into line noise
      float mC = step(texture2D(tDiffuse, uv).a, 0.9);
      float m1 = step(texture2D(tDiffuse, uv - s1).a, 0.9), m2 = step(texture2D(tDiffuse, uv + s1).a, 0.9);
      float m3 = step(texture2D(tDiffuse, uv - s2).a, 0.9), m4 = step(texture2D(tDiffuse, uv + s2).a, 0.9);
      float edgeMask = step(0.5, max(max(abs(mC - m1), abs(mC - m2)), max(abs(mC - m3), abs(mC - m4))));
      float anyDuck = max(mC, max(max(m1, m2), max(m3, m4)));
      float silT = mix(0.03, 0.18, anyDuck * (1.0 - edgeMask));
      float sil = max(smoothstep(silT, silT * 2.0, jump), edgeMask * step(0.5, mC));
      // creases: angle between one-sided normals reconstructed from depth
      vec3 PC = vpos(uv, dC), PL = vpos(uv - o1, dL), PR = vpos(uv + o1, dR), PD = vpos(uv - o2, dD), PU = vpos(uv + o2, dU);
      vec3 n1 = normalize(cross(PR - PC, PU - PC)), n2 = normalize(cross(PC - PL, PC - PD));
      vec3 n3 = normalize(cross(PR - PC, PC - PD)), n4 = normalize(cross(PC - PL, PU - PC));
      float cr = max(1.0 - dot(n1, n2), 1.0 - dot(n3, n4));
      float crease = smoothstep(0.14, 0.3, cr) * (1.0 - sil) * uCrease * (1.0 - step(0.99999, dC)) * (1.0 - anyDuck);
      float ink = max(sil, crease * 0.75);
      // colour with slight CMYK misregistration
      vec2 mo = uMis * px;
      vec3 lin = vec3(texture2D(tDiffuse, vUv + mo).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - mo * vec2(0.7, -0.9)).b);
      vec3 col = toSRGB(lin);
      col = mix(col, floor(col * 14.0 + 0.5) / 14.0, uPoster * (1.0 - mC));                   // mild posterisation
      // paper: warm stock, fine grain and a few fibres
      vec2 fc = gl_FragCoord.xy;
      float g = vn(fc / 1.6) * 0.55 + vn(fc / 6.0) * 0.3 + vn(fc * vec2(0.03, 0.9)) * 0.15;
      col = mix(col, uPaper, 0.05 * (1.0 - 0.6 * mC)) * (0.965 + 0.06 * g * uGrain * (1.0 - 0.9 * mC) + 0.027 * mC * uGrain);   // ducks: grain masked off, same mean
      // ink, with a faint magenta/cyan registration fringe
      col = mix(col, uInk, ink * 0.94);
      // speed lines radiating from the action
      if (uSpeedAmt > 0.001) {
        vec2 p = (vUv - uSpeedC) * vec2(uRes.x / uRes.y, 1.0);
        float a = atan(p.y, p.x) / 6.2831853 + 0.5, rad = length(p);
        float bins = 170.0, b = floor(a * bins), f = fract(a * bins);
        float on = step(1.0 - 0.16 * uSpeedAmt, h21(vec2(b, floor(uSpeedT * 12.0))));
        float wdt = (0.06 + 0.12 * h21(vec2(b, 3.1))) * smoothstep(0.3, 0.9, rad);   // taper towards the centre
        float line = on * (1.0 - smoothstep(wdt * 0.5, wdt, abs(f - 0.5) * 2.0)) * smoothstep(0.34 + 0.2 * h21(vec2(b, 9.7)), 0.62, rad);
        col = mix(col, uInk, line * min(1.0, uSpeedAmt * 1.2) * 0.7);
      }
      // impact frame: posterised two-tone flash
      if (uImpact > 0.001) {
        float l = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 two = mix(uInk, mix(uPaper, vec3(1.0, 0.86, 0.25), 0.35), step(0.5, l));
        col = mix(col, two, uImpact);
      }
      vec2 vq = vUv - 0.5; col *= 1.0 - uVignette * smoothstep(0.35, 0.85, length(vq * vec2(uRes.x / uRes.y, 1.0)) / 1.2);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

class ComicPass extends ShaderPass {
  constructor(camera) { super(COMIC_SHADER); this.camera = camera; this.needsSwap = true; }
  render(renderer, writeBuffer, readBuffer, dt, mask) {
    const u = this.uniforms, c = this.camera;
    u.tDepth.value = readBuffer.depthTexture;
    u.uNear.value = c.near; u.uFar.value = c.far; u.uInvProj.value.copy(c.projectionMatrixInverse);
    super.render(renderer, writeBuffer, readBuffer, dt, mask);
  }
}

/**
 * Drop-in replacement for look.js setupPost: scene -> (bloom) -> comic pass (ink, print, FX) -> screen.
 * opts: { quality, samples, bloom, line, fxContainer }
 */
export function setupComicPost(renderer, scene, camera, opts = {}) {
  const hi = (opts.quality || "high") === "high";
  const isWebGL2 = renderer.capabilities.isWebGL2;
  const samples = isWebGL2 ? Math.min(opts.samples ?? 4, renderer.capabilities.maxSamples || 0) : 0;
  const mk = () => { const t = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
    t.depthTexture = new THREE.DepthTexture(1, 1); t.depthTexture.type = THREE.FloatType; return t; };
  const rt = mk();
  const composer = new EffectComposer(renderer, rt);
  composer.renderTarget2.dispose(); composer.renderTarget2 = mk();
  composer.writeBuffer = composer.renderTarget1; composer.readBuffer = composer.renderTarget2;
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.3, 2.6);
  bloom.enabled = opts.bloom ?? false;   // off by default: bloom's additive blend would corrupt the alpha object mask
  composer.addPass(bloom);
  const comic = new ComicPass(camera);
  composer.addPass(comic);
  if (!hi) { comic.uniforms.uWobble.value = 0.6; TOON.uTnHatch.value = 0.0; }
  const fx = createComicFX({ camera, renderer, comic, container: opts.fxContainer });
  if (typeof window !== "undefined") window.__comic = comic;
  let t = 0;
  function resize(w, h) {
    const pr = renderer.getPixelRatio();
    composer.setPixelRatio(pr); composer.setSize(w, h);
    comic.uniforms.uRes.value.set(Math.round(w * pr), Math.round(h * pr));
    comic.uniforms.uLine.value = (opts.line ?? 1.25) * pr;
    comic.uniforms.uMis.value = 0.7 * pr;
    TOON.uTnDotPx.value = (hi ? 4.2 : 5.0) * pr;
    TOON.uTnHatchPx.value = 3.6 * pr;
    fx.resize(w, h);
  }
  return {
    composer, bloom, comic, fx, twos, resize, aa: samples ? "msaa" : "none", samples,
    finish: { uniforms: { uGrain: comic.uniforms.uGrain, uVignette: comic.uniforms.uVignette, uTime: { value: 0 }, uAspect: { value: 1 } } },
    render(dt = 1 / 60) {
      t += dt;
      comic.uniforms.uBoil.value = Math.floor(t * 8) * 1.731;
      fx.update(dt);
      twos.hold(dt);
      composer.render(dt);
      twos.release();
    },
  };
}

// ================================================================== skate FX: hand-drawn comic smoke, bolts, sparks, skids
// Original procedural shapes (canvas), drawn as camera-facing instanced quads in the 3D scene: one draw call for
// all particles, one for all skid marks. Fixed pools, no per-frame allocation. Driven from duck state in fx.watch().
const SFX_CELLS = 4;   // atlas grid 4 x 2
function sfxAtlas() {
  const C = 128, cv = document.createElement("canvas"); cv.width = C * 4; cv.height = C * 2;
  const g = cv.getContext("2d"); const INKC = "#1B1430";
  let r = 7; const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const cell = (i, fn) => { g.save(); g.translate((i % 4) * C, Math.floor(i / 4) * C); g.beginPath(); g.rect(0, 0, C, C); g.clip(); fn(); g.restore(); };
  // billowy puff: union of circles, ink outline drawn as fat circles underneath, darker inner shading blob
  const puff = (n, rad) => () => {
    const bl = []; for (let k = 0; k < n; k++) { const a = k / n * Math.PI * 2 + rnd() * 0.5, d = rad * (0.42 + rnd() * 0.12); bl.push([64 + Math.cos(a) * d, 66 + Math.sin(a) * d * 0.85, rad * (0.38 + rnd() * 0.16)]); }
    bl.push([64, 66, rad * 0.55]);
    g.fillStyle = INKC; for (const [x, y, q] of bl) { g.beginPath(); g.arc(x, y, q + 6, 0, 7); g.fill(); }
    g.fillStyle = "#F3E6CC"; for (const [x, y, q] of bl) { g.beginPath(); g.arc(x, y, q, 0, 7); g.fill(); }
    g.save(); g.beginPath(); for (const [x, y, q] of bl) { g.moveTo(x + q, y); g.arc(x, y, q, 0, 7); } g.clip();
    g.fillStyle = "#CDB894"; for (const [x, y, q] of bl) { g.beginPath(); g.arc(x + q * 0.35, y + q * 0.45, q * 0.72, 0, 7); g.fill(); }
    g.fillStyle = "#FFFBF0"; g.beginPath(); g.arc(64 - rad * 0.32, 66 - rad * 0.36, rad * 0.2, 0, 7); g.fill();
    g.restore();
  };
  cell(0, puff(7, 40)); cell(1, puff(6, 36)); cell(2, puff(5, 30));
  // spark burst: jagged star, yellow with white core and ink edge
  cell(3, () => {
    const star = (R, Ri, n, fill, lw) => { g.beginPath(); for (let k = 0; k < n * 2; k++) { const a = k / (n * 2) * Math.PI * 2, rr = (k % 2 ? Ri : R) * (0.85 + rnd() * 0.3); g.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr); } g.closePath();
      if (lw) { g.lineWidth = lw; g.lineJoin = "miter"; g.strokeStyle = INKC; g.stroke(); } g.fillStyle = fill; g.fill(); };
    star(54, 22, 9, "#FFD23F", 9); star(26, 11, 7, "#FFFFFF", 0);
  });
  // 4-point glint
  cell(4, () => {
    const gl = (R, w, fill, lw) => { g.beginPath(); for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2 - Math.PI / 2, rr = k % 2 ? w : R; g.lineTo(64 + Math.cos(a) * rr, 64 + Math.sin(a) * rr); } g.closePath();
      if (lw) { g.lineWidth = lw; g.strokeStyle = INKC; g.lineJoin = "round"; g.stroke(); } g.fillStyle = fill; g.fill(); };
    gl(58, 13, "#FFFFFF", 8); gl(30, 7, "#FFE98A", 0);
  });
  // zig-zag bolts (pointing +x): pale gold with ink outline
  const bolt = (pts) => () => {
    const P = pts.map(([x, y]) => [x * 128, y * 128]);
    g.lineJoin = "miter"; g.lineCap = "butt";
    const path = () => { g.beginPath(); P.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
    path(); g.lineWidth = 9; g.strokeStyle = INKC; g.stroke(); g.fillStyle = "#FFE45C"; g.fill();
  };
  cell(5, bolt([[0.04, 0.52], [0.36, 0.3], [0.34, 0.47], [0.66, 0.26], [0.62, 0.44], [0.97, 0.38], [0.6, 0.62], [0.63, 0.5], [0.33, 0.72], [0.36, 0.56]]));
  cell(6, bolt([[0.03, 0.45], [0.3, 0.62], [0.33, 0.44], [0.6, 0.66], [0.6, 0.48], [0.97, 0.58], [0.58, 0.32], [0.57, 0.5], [0.31, 0.3], [0.29, 0.47]]));
  // speed streak: tapered stroke, ink with a white core
  cell(7, () => {
    const st = (h, fill) => { g.beginPath(); g.moveTo(4, 64); g.quadraticCurveTo(64, 64 - h, 124, 64 - h * 0.25); g.lineTo(124, 64 + h * 0.25); g.quadraticCurveTo(64, 64 + h, 4, 64); g.fillStyle = fill; g.fill(); };
    st(16, INKC); st(7, "#FFFFFF");
  });
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true;
  return t;
}
const SFX_VS = /* glsl */`
  attribute vec3 aPos; attribute vec4 aP; attribute vec3 aDir;   // aP: size (m), rotation, atlas cell, unused
  varying vec2 vUv;
  void main(){
    vec4 mv = viewMatrix * vec4(aPos, 1.0);
    float ang = aP.y, st = 1.0;
    float dl = length(aDir);
    if (dl > 1e-4) { vec4 m2 = viewMatrix * vec4(aPos + aDir / dl * 0.05, 1.0); vec2 d = m2.xy / -m2.z - mv.xy / -mv.z; ang += atan(d.y, d.x); st = max(1.0, dl); }
    vec2 c = position.xy * vec2(st, 1.0) * aP.x;
    float s = sin(ang), co = cos(ang);
    mv.xy += vec2(co * c.x - s * c.y, s * c.x + co * c.y);
    gl_Position = projectionMatrix * mv;
    float cell = aP.z;
    vUv = vec2((mod(cell, 4.0) + uv.x) * 0.25, (1.0 - floor(cell / 4.0)) * 0.5 + uv.y * 0.5 - 0.0);
  }`;
const SFX_FS = /* glsl */`
  uniform sampler2D map; varying vec2 vUv;
  void main(){ vec4 t = texture2D(map, vUv); if (t.a < 0.5) discard; gl_FragColor = vec4(t.rgb, 1.0); }`;
const SKID_VS = /* glsl */`
  attribute float aBirth; attribute float aSeed; uniform float uTime, uLife; varying float vA; varying vec2 vUv; varying float vSeed;
  void main(){ vUv = uv; vSeed = aSeed; float age = uTime - aBirth; vA = (1.0 - smoothstep(uLife * 0.55, uLife, age)) * step(0.0, age);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0); }`;
const SKID_FS = /* glsl */`
  uniform vec3 uInk; varying float vA; varying vec2 vUv; varying float vSeed;
  float h(float x){ return fract(sin(x * 91.7 + vSeed * 13.1) * 43758.5); }
  void main(){ float e = abs(vUv.y - 0.5) * 2.0; float rough = 0.72 + 0.28 * h(floor(vUv.x * 6.0));
    if (e > rough || vA < 0.01) discard; gl_FragColor = vec4(uInk, 0.85 * vA); }`;

export function createSkateFX(scene, opts = {}) {
  const phone = !!opts.phone;
  const MAX = phone ? 90 : 240, SKIDS = phone ? 120 : 360, SKID_LIFE = 4.0;
  const tex = sfxAtlas();
  // ---- particles
  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry(); geo.index = base.index; geo.attributes.position = base.attributes.position; geo.attributes.uv = base.attributes.uv;
  const aPos = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3), aP = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4), aDir = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
  for (const a of [aPos, aP, aDir]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("aPos", aPos); geo.setAttribute("aP", aP); geo.setAttribute("aDir", aDir); geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: tex } }, vertexShader: SFX_VS, fragmentShader: SFX_FS, depthWrite: false, depthTest: true });
  const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 20; mesh.name = "skate_fx";
  mesh.userData.lookFX = true; mesh.raycast = () => {}; mesh.castShadow = false; mesh.receiveShadow = false;
  scene.add(mesh);
  // particle state (struct of arrays)
  const P = { x: new Float32Array(MAX * 3), v: new Float32Array(MAX * 3), d: new Float32Array(MAX * 3), age: new Float32Array(MAX), life: new Float32Array(MAX),
    s0: new Float32Array(MAX), s1: new Float32Array(MAX), rot: new Float32Array(MAX), rv: new Float32Array(MAX), cell: new Uint8Array(MAX), kind: new Uint8Array(MAX), stretch: new Float32Array(MAX) };
  const P_KEYS = ["age", "life", "s0", "s1", "rot", "rv", "cell", "kind", "stretch"];
  let n = 0;
  let seed = 12345; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  // kinds: 0 smoke, 1 spark, 2 glint, 3 bolt, 4 streak
  function spawn(kind, x, y, z, vx, vy, vz, size, life, dir) {
    if (n >= MAX) return -1;
    const i = n++, k = i * 3;
    P.x[k] = x; P.x[k + 1] = y; P.x[k + 2] = z; P.v[k] = vx; P.v[k + 1] = vy; P.v[k + 2] = vz;
    P.d[k] = dir ? dir.x : 0; P.d[k + 1] = dir ? dir.y : 0; P.d[k + 2] = dir ? dir.z : 0;
    P.age[i] = 0; P.life[i] = life; P.kind[i] = kind; P.s0[i] = size; P.rot[i] = (rnd() - 0.5) * 6.28; P.rv[i] = (rnd() - 0.5) * 3; P.stretch[i] = 1;
    P.cell[i] = kind === 0 ? Math.floor(rnd() * 3) : kind === 1 ? 3 : kind === 2 ? 4 : kind === 3 ? 5 + (rnd() < 0.5 ? 1 : 0) : 7;
    if (kind === 3 || kind === 4) { P.rot[i] = kind === 3 ? (rnd() - 0.5) * 0.5 : 0; P.rv[i] = 0; }
    if (kind === 2) P.rot[i] = 0, P.rv[i] = 0;
    return i;
  }
  function kill(i) {
    const j = --n; if (i === j) return;
    for (const key of P_KEYS) P[key][i] = P[key][j];
    for (let a = 0; a < 3; a++) { P.x[i * 3 + a] = P.x[j * 3 + a]; P.v[i * 3 + a] = P.v[j * 3 + a]; P.d[i * 3 + a] = P.d[j * 3 + a]; }
  }
  // ---- skid marks: ring buffer of flat floor quads
  const sg = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const aBirth = new THREE.InstancedBufferAttribute(new Float32Array(SKIDS).fill(-99), 1), aSeed = new THREE.InstancedBufferAttribute(new Float32Array(SKIDS), 1);
  sg.setAttribute("aBirth", aBirth); sg.setAttribute("aSeed", aSeed);
  const smat = new THREE.ShaderMaterial({ uniforms: { uTime: { value: 0 }, uLife: { value: SKID_LIFE }, uInk: { value: new THREE.Color("#1B1430") } }, vertexShader: SKID_VS, fragmentShader: SKID_FS,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });   // keeps the comic mask alpha
  const skids = new THREE.InstancedMesh(sg, smat, SKIDS); skids.frustumCulled = false; skids.name = "skate_skids"; skids.renderOrder = 1;
  skids.userData.lookFX = true; skids.raycast = () => {}; skids.castShadow = false; skids.receiveShadow = false;
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), SV = new THREE.Vector3(), PV = new THREE.Vector3(), YA = new THREE.Vector3(0, 1, 0);
  M4.makeScale(0, 0, 0); for (let i = 0; i < SKIDS; i++) skids.setMatrixAt(i, M4);
  scene.add(skids);
  let sk = 0, time = 0;
  function skid(ax, az, bx, bz, y, w) {
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 1e-4) return;
    PV.set((ax + bx) / 2, y, (az + bz) / 2); Q.setFromAxisAngle(YA, Math.atan2(-dz, dx)); SV.set(L + w * 0.6, 1, w);
    M4.compose(PV, Q, SV); skids.setMatrixAt(sk, M4); aBirth.array[sk] = time; aSeed.array[sk] = rnd();
    sk = (sk + 1) % SKIDS; skids.instanceMatrix.needsUpdate = true; aBirth.needsUpdate = true; aSeed.needsUpdate = true;
  }
  const api = {
    phone, reducedMotion: false, mesh, skids,
    get count() { return n; },
    smoke(x, y, z, dx, dz, s = 1) { // dx,dz: direction to drift (backwards along travel)
      const sz = (0.05 + rnd() * 0.035) * s;
      const i = spawn(0, x + (rnd() - 0.5) * 0.01, y + 0.008, z + (rnd() - 0.5) * 0.01, dx * (0.12 + rnd() * 0.1) + (rnd() - 0.5) * 0.06, 0.05 + rnd() * 0.06, dz * (0.12 + rnd() * 0.1) + (rnd() - 0.5) * 0.06, sz, 0.4 + rnd() * 0.4);
      return i;
    },
    spark(x, y, z, s = 1) { const a = rnd() * 6.28, sp = 0.25 + rnd() * 0.45; return spawn(1, x, y + 0.01, z, Math.cos(a) * sp, 0.25 + rnd() * 0.5, Math.sin(a) * sp, (0.024 + rnd() * 0.018) * s, 0.25 + rnd() * 0.2); },
    glint(x, y, z, s = 1) { return spawn(2, x + (rnd() - 0.5) * 0.05, y + 0.02 + rnd() * 0.06, z + (rnd() - 0.5) * 0.05, 0, 0.02, 0, (0.045 + rnd() * 0.03) * s, 0.32 + rnd() * 0.14); },
    bolt(x, y, z, dir, s = 1) { const i = spawn(3, x, y, z, dir.x * 0.1, 0.02, dir.z * 0.1, (0.07 + rnd() * 0.04) * s, 0.18 + rnd() * 0.12, dir); if (i >= 0) P.stretch[i] = 1.6 + rnd() * 0.6; return i; },
    streak(x, y, z, dir, s = 1) { const i = spawn(4, x, y, z, -dir.x * 0.05, 0, -dir.z * 0.05, 0.024 * s, 0.14 + rnd() * 0.08, dir); if (i >= 0) P.stretch[i] = 4 + rnd() * 2; return i; },
    skid,
    update(dt) {
      time += dt; smat.uniforms.uTime.value = time;
      for (let i = n - 1; i >= 0; i--) {
        P.age[i] += dt; if (P.age[i] >= P.life[i]) { kill(i); continue; }
        const k = i * 3, kind = P.kind[i];
        const drag = kind === 0 ? Math.exp(-2.2 * dt) : 1;
        if (kind === 1) P.v[k + 1] -= 2.2 * dt;
        P.v[k] *= drag; P.v[k + 1] *= drag; P.v[k + 2] *= drag;
        P.x[k] += P.v[k] * dt; P.x[k + 1] += P.v[k + 1] * dt; P.x[k + 2] += P.v[k + 2] * dt;
        P.rot[i] += P.rv[i] * dt;
      }
      // write instance data
      const ap = aPos.array, apP = aP.array, ad = aDir.array;
      for (let i = 0; i < n; i++) {
        const k = i * 3, t = P.age[i] / P.life[i], kind = P.kind[i];
        let sc;
        if (kind === 0) sc = t < 0.18 ? 0.35 + 0.65 * (t / 0.18) * (1.25 - 0.25 * t / 0.18) : t < 0.8 ? 1 + 0.35 * (t - 0.18) / 0.62 : (1.35 + (t - 0.8) * 1.5) * (1 - Math.pow((t - 0.8) / 0.2, 2));   // pop: swell then vanish
        else if (kind === 1) sc = 1 - t * t;
        else if (kind === 2) sc = Math.sin(Math.PI * Math.min(1, t * 1.1));
        else if (kind === 3) sc = (Math.floor(P.age[i] * 30) % 2 ? 0.85 : 1.1) * (1 - t * 0.4);
        else sc = 1 - t;
        ap[k] = P.x[k]; ap[k + 1] = P.x[k + 1]; ap[k + 2] = P.x[k + 2];
        apP[i * 4] = P.s0[i] * Math.max(0, sc); apP[i * 4 + 1] = P.rot[i]; apP[i * 4 + 2] = P.cell[i]; apP[i * 4 + 3] = 0;
        const st = P.stretch[i]; ad[k] = P.d[k] * st; ad[k + 1] = P.d[k + 1] * st; ad[k + 2] = P.d[k + 2] * st;
      }
      geo.instanceCount = n;
      if (n) { aPos.needsUpdate = true; aP.needsUpdate = true; aDir.needsUpdate = true; }
    },
    clear() { n = 0; geo.instanceCount = 0; aBirth.array.fill(-99); aBirth.needsUpdate = true; },
  };
  return api;
}

// ================================================================== comic FX: stickers, speed lines, impact frames
const STICKERS = {
  bonk: { text: "BONK!", fill: "#FFD23F", ink: "#FF3E6C", burst: "#FFFFFF", size: 1.0, rot: -12, spikes: 13 },
  goal: { text: "GOAL!", fill: "#FFFFFF", ink: "#1B1430", burst: "#FFD23F", size: 1.35, rot: -6, spikes: 18 },
  zoom: { text: "ZOOM", fill: "#3DE0FF", ink: "#1B1430", burst: null, size: 0.95, rot: -8, skew: -14 },
  snap: { text: "SNAP!", fill: "#FFFFFF", ink: "#1B1430", burst: "#3DE0FF", size: 0.72, rot: 8, spikes: 10 },
  whee: { text: "WHEE!", fill: "#FFD23F", ink: "#1B1430", burst: "#C77DFF", size: 1.0, rot: 10, spikes: 14 },
  pow: { text: "POW!", fill: "#FFFFFF", ink: "#1B1430", burst: "#FF3E6C", size: 1.0, rot: -10, spikes: 12 },
};
let styleDone = false;
function injectStyle() {
  if (styleDone || typeof document === "undefined") return; styleDone = true;
  // Bangers is bundled locally (fonts/Bangers-Regular.woff2, OFL); declare it in case the page didn't
  if (![...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => r.cssText && r.cssText.includes("Bangers-Regular")); } catch (e) { return false; } })) {
    const ff = document.createElement("style"); ff.textContent = `@font-face{font-family:"Bangers";src:url("${new URL("./fonts/Bangers-Regular.woff2", import.meta.url).href}") format("woff2");font-display:swap}`; document.head.appendChild(ff);
  }
  const st = document.createElement("style");
  st.textContent = `
  .cfx-layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:6}
  .cfx{position:absolute;left:0;top:0;width:0;height:0;will-change:transform,opacity;transform-origin:0 0}
  .cfx svg{position:absolute;left:0;top:0;transform:translate(-50%,-50%);overflow:visible}
  .cfx b{position:absolute;left:0;top:0;display:block;font:400 var(--fs,44px)/1 Bangers,"Luckiest Guy",Anton,Impact,"Arial Black",sans-serif;letter-spacing:.04em;
    color:var(--fill);-webkit-text-stroke:calc(var(--fs,44px)*.09) var(--ink);paint-order:stroke fill;
    text-shadow:calc(var(--fs,44px)*.07) calc(var(--fs,44px)*.08) 0 var(--ink);white-space:nowrap;transform:translate(-50%,-50%) skewX(var(--skew,0deg))}`;
  document.head.appendChild(st);
}
function burstSVG(sz, spikes, fill, ink, seed) {
  let r = seed * 9301 % 233280; const rnd = () => (r = (r * 9301 + 49297) % 233280) / 233280;
  const pts = [], R = sz * 0.5, Ri = R * 0.68, n = spikes * 2;
  for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2, rr = (i % 2 ? Ri : R) * (0.86 + rnd() * 0.24); pts.push((Math.cos(a) * rr * 1.25).toFixed(1) + "," + (Math.sin(a) * rr * 0.92).toFixed(1)); }
  const id = "hd" + Math.floor(seed * 1e6);
  return `<svg width="${sz * 1.5}" height="${sz * 1.2}" viewBox="${-sz * 0.75} ${-sz * 0.6} ${sz * 1.5} ${sz * 1.2}">
    <defs><pattern id="${id}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(25)"><circle cx="3.5" cy="3.5" r="1.4" fill="${ink}" opacity=".22"/></pattern></defs>
    <polygon points="${pts.join(" ")}" fill="${ink}" transform="translate(${sz * 0.05},${sz * 0.06})"/>
    <polygon points="${pts.join(" ")}" fill="${fill}" stroke="${ink}" stroke-width="${Math.max(2, sz * 0.035)}" stroke-linejoin="round"/>
    <polygon points="${pts.join(" ")}" fill="url(#${id})"/></svg>`;
}

/**
 * fx.emit(type, worldPos, opts?)   type: bonk | goal | zoom | snap | whee | pow | any string (opts.text)
 *                                  opts: { text, scale, impact (0..1), speed (0..1), life (s), offsetY (m) }
 * fx.speed(worldPos, amount)       hold speed lines on a point this frame (amount 0..1); decays when not called
 * fx.impact(strength, worldPos?)   2-frame high-contrast impact flash (+ burst of speed lines)
 * fx.watch(agents, G, getControlled)  auto-emit from game state (falls, grabs, skating, goals)
 */
export function createComicFX({ camera, renderer, comic, container } = {}) {
  injectStyle();
  const layer = typeof document !== "undefined" ? document.createElement("div") : null;
  if (layer) { layer.className = "cfx-layer"; (container || document.body).appendChild(layer); }
  const live = [], tmp = new THREE.Vector3();
  let W = 1, H = 1, clock = 0, speedHold = 0, speedAmt = 0, speedPos = new THREE.Vector3(), impactT = 0, seed = 1;
  const project = (p) => { tmp.copy(p).project(camera); return [(tmp.x * 0.5 + 0.5) * W, (-tmp.y * 0.5 + 0.5) * H, tmp.z]; };
  const cooldown = new Map();
  const fx = {
    enabled: true, reducedMotion: false,
    emit(type, pos, opts = {}) {
      if (!this.enabled || !layer || !pos) return null;
      const key = type + (opts.key ?? "");
      if (opts.cooldown && clock - (cooldown.get(key) ?? -99) < opts.cooldown) return null;
      cooldown.set(key, clock);
      const S = { ...(STICKERS[type] || STICKERS.pow), ...(opts.text ? { text: opts.text } : {}) };
      const fs = Math.round(Math.min(W, H) * 0.075 * (S.size || 1) * (opts.scale || 1));
      const el = document.createElement("div"); el.className = "cfx";
      el.style.setProperty("--fs", fs + "px"); el.style.setProperty("--fill", S.fill); el.style.setProperty("--ink", S.ink);
      if (S.skew) el.style.setProperty("--skew", S.skew + "deg");
      seed = (seed * 16807) % 2147483647;
      el.innerHTML = (S.burst ? burstSVG(fs * 2.6, S.spikes || 12, S.burst, "#1B1430", seed / 2147483647) : "") + `<b>${S.text}</b>`;
      layer.appendChild(el);
      const s = { el, pos: pos.clone(), t: 0, life: opts.life ?? 1.1, rot: (S.rot || 0) + ((seed % 9) - 4), offY: opts.offsetY ?? 0.16, jitter: (seed % 7) / 7 };
      live.push(s);
      if (opts.impact) this.impact(opts.impact, pos);
      if (opts.speed) { speedPos.copy(pos); speedAmt = Math.max(speedAmt, opts.speed); speedHold = 0.25; }
      return s;
    },
    speed(pos, amount = 0.6) { speedPos.copy(pos); speedAmt = Math.max(speedAmt * 0.9, amount); speedHold = 0.12; },
    impact(strength = 1, pos) { impactT = 0.07 * strength + 0.03; if (pos) { speedPos.copy(pos); speedAmt = Math.max(speedAmt, 0.6); speedHold = 0.08; } },
    clear() { for (const s of live) s.el.remove(); live.length = 0; },
    resize(w, h) { W = w; H = h; },
    update(dt) {
      clock += dt;
      // stickers: pop in (overshoot), hold, pop out; follow their world anchor
      for (let i = live.length - 1; i >= 0; i--) {
        const s = live[i]; s.t += dt;
        const a = s.t / s.life;
        if (a >= 1) { s.el.remove(); live.splice(i, 1); continue; }
        const [x, y, z] = project(tmp.copy(s.pos).add(new THREE.Vector3(0, s.offY + s.t * 0.02, 0)));
        const pin = Math.min(1, s.t / 0.14), sc = s.t < 0.14 ? 0.2 + 1.05 * Math.sin(pin * Math.PI * 0.62) / Math.sin(Math.PI * 0.62) : a > 0.8 ? 1 + (a - 0.8) * 1.5 : 1;
        const op = a > 0.8 ? 1 - (a - 0.8) / 0.2 : 1;
        s.el.style.opacity = z > 1 ? 0 : op;
        s.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) rotate(${s.rot}deg) scale(${sc.toFixed(3)})`;
      }
      // speed lines + impact frame
      speedHold -= dt; if (speedHold <= 0) speedAmt = Math.max(0, speedAmt - dt * 7);
      impactT = Math.max(0, impactT - dt);
      if (comic) {
        const u = comic.uniforms;
        if (speedAmt > 0) { const [x, y] = project(speedPos); u.uSpeedC.value.set(x / W, 1 - y / H); }
        u.uSpeedAmt.value = this.reducedMotion ? 0 : speedAmt; u.uSpeedT.value = clock;
        u.uImpact.value = this.reducedMotion ? 0 : (impactT > 0 ? 0.85 : 0);
      }
      if (this._watch) this._watch(dt);
      if (this.skate) { this.skate.reducedMotion = this.reducedMotion; this.skate.update(dt); }
    },
    /** auto FX from game state: falls (WHEE!/BONK!), beak grabs (SNAP!), fast skating (ZOOM + speed lines), goals (GOAL!) */
    watch(agents, G, getControlled) {
      const st = new WeakMap(); let lastGoals = 0;
      const phone = typeof matchMedia !== "undefined" && matchMedia("(max-width: 720px), (pointer: coarse)").matches;
      const W0 = new THREE.Vector3(), W1 = new THREE.Vector3(), DIR = new THREE.Vector3(), BACK = new THREE.Vector3(), CAMP = new THREE.Vector3();
      const skidWheel = (Wp, last, on, y) => {
        if (!on) { last[0] = NaN; return; }
        if (Number.isNaN(last[0])) { last[0] = 1; last[1] = Wp.x; last[2] = Wp.z; return; }
        if (Math.hypot(Wp.x - last[1], Wp.z - last[2]) > 0.008) { this.skate.skid(last[1], last[2], Wp.x, Wp.z, y + 0.0015, 0.012 + 0.006 * Math.random()); last[1] = Wp.x; last[2] = Wp.z; }
      };
      // per-duck skate state -> smoke / bolts / sparks / glints / skids / streaks
      const skateFX = (a, s, dt, isC) => {
        const sfx = this.skate;
        const legs = a.duck && a.duck.legs;
        if (!a.skates || a.fall || !legs || !legs.left) { s.sk = null; return; }
        const k = s.sk || (s.sk = { sp: 0, yaw: a.yaw, px: a.pos.x, pz: a.pos.z, brakeT: 0, peak: 0, peakT: 9, acc: 0, smokeAcc: 0, boltAcc: 0, streakAcc: 0, lw: [NaN, 0, 0], rw: [NaN, 0, 0], stopped: true });
        // teleports / respawns: reset
        if (Math.hypot(a.pos.x - k.px, a.pos.z - k.pz) > 0.2) { k.sp = a.sv.length(); k.yaw = a.yaw; k.lw[0] = k.rw[0] = NaN; }
        k.px = a.pos.x; k.pz = a.pos.z;
        const sp = a.sv.length(), fx = Math.sin(a.yaw), fz = Math.cos(a.yaw);
        const acc = (sp - k.sp) / dt; k.acc += (acc - k.acc) * Math.min(1, dt * 12); k.sp = sp;
        let dy = a.yaw - k.yaw; dy -= Math.round(dy / 6.2832) * 6.2832; const yr = dy / dt; k.yaw = a.yaw;
        const slip = Math.abs(a.sv.x * fz - a.sv.z * fx);
        if (sp > k.peak || k.peakT > 2.2) { k.peak = sp; k.peakT = 0; } k.peakT += dt;
        const far = CAMP.distanceToSquared(a.pos) > (phone ? 4 : 9) || (a.lod || 0) >= 2;
        const rm = this.reducedMotion, rate = (phone ? 0.5 : 1) * (isC ? 1 : 0.6);
        legs.left.soleNode.getWorldPosition(W0); legs.right.soleNode.getWorldPosition(W1);
        const y = Math.min(W0.y, W1.y);
        BACK.set(-fx, 0, -fz);
        const drifting = sp > 0.12 && (slip > 0.045 || Math.abs(yr) > 1.5);
        const braking = sp > 0.06 && k.acc < -0.22;
        const pushing = k.acc > 0.1 && sp > 0.04;
        // skid marks (floor decals), also in reduced motion
        const skidOn = drifting || (braking && sp > 0.1);
        skidWheel(W0, k.lw, skidOn && !far, y); skidWheel(W1, k.rw, skidOn && !far, y);
        if (rm || far) return;
        // smoke: push-offs, acceleration, hard braking, drifting
        const smokeRate = (drifting ? 26 : braking ? 20 : pushing ? 12 : sp > 0.3 ? 7 : 0) * rate;
        k.smokeAcc += smokeRate * dt;
        while (k.smokeAcc >= 1) { k.smokeAcc -= 1; const W = Math.random() < 0.5 ? W0 : W1; sfx.smoke(W.x, y, W.z, BACK.x, BACK.z, drifting ? 1.25 : 1); }
        // zig-zag energy bolts: speed bursts and sharp turns
        const burst = (k.acc > 0.2 && sp > 0.2) || (Math.abs(yr) > 1.8 && sp > 0.15) || drifting;
        k.boltAcc += (burst ? 9 : sp > 0.34 ? 3 : 0) * rate * dt;
        while (k.boltAcc >= 1) { k.boltAcc -= 1; const side = Math.random() < 0.5 ? 1 : -1;
          DIR.set(-fx + fz * side * 0.5, 0.15 + Math.random() * 0.3, -fz - fx * side * 0.5).normalize();
          sfx.bolt(a.pos.x - fz * side * 0.05 + BACK.x * 0.03, y + 0.05 + Math.random() * 0.08, a.pos.z + fx * side * 0.05 + BACK.z * 0.03, DIR); }
        // speed streaks behind the wheels
        k.streakAcc += (sp > 0.25 ? (sp - 0.2) * 110 : 0) * rate * dt;
        DIR.set(fx, 0, fz);
        while (k.streakAcc >= 1) { k.streakAcc -= 1; const W = Math.random() < 0.5 ? W0 : W1; sfx.streak(W.x + BACK.x * 0.05, y + 0.01 + Math.random() * 0.02, W.z + BACK.z * 0.05, DIR); }
        // sparks while braking hard, plus a glint burst when a fast run comes to a stop
        if (braking && Math.random() < dt * 25 * rate) { const W = Math.random() < 0.5 ? W0 : W1; sfx.spark(W.x, y, W.z); }
        if (sp < 0.08 && k.peak > 0.2 && k.peakT < 2.2 && !k.stopped) {
          k.stopped = true; k.peak = 0;
          for (let i = 0; i < 6 * rate + 2; i++) { const W = i % 2 ? W0 : W1; sfx.spark(W.x, y, W.z, 1.2); }
          for (let i = 0; i < 4; i++) sfx.glint(a.pos.x, y + 0.03, a.pos.z, 1.3);
          for (let i = 0; i < 4 * rate + 1; i++) { const W = i % 2 ? W0 : W1; sfx.smoke(W.x, y, W.z, fx, fz, 1.1); }
          if (isC) this.impact(0.5);
        }
        if (sp > 0.15) k.stopped = false;
      };
      this._watch = (dt) => {
        const C = getControlled ? getControlled() : null;
        if (!this.skate && G && G.scene) this.skate = createSkateFX(G.scene, { phone });
        const sfx = this.skate; camera.getWorldPosition(CAMP);
        for (const a of agents) {
          const s = st.get(a) || { fall: null, held: null, bonkAt: -1 }; st.set(a, s);
          const p = a.duck && a.duck.root ? a.duck.root.position : a.pos;
          const isC = a === C;
          if (a.fall && !s.fall) {
            if (a.fall.kind === "edge") { this.emit("whee", p, { offsetY: 0.2, key: a.index }); s.bonkAt = clock + 0.62; }
            else this.emit("bonk", p, { impact: isC ? 1 : 0, key: a.index, offsetY: 0.12 });
          }
          if (s.bonkAt > 0 && clock >= s.bonkAt) { s.bonkAt = -1; this.emit("bonk", p, { impact: isC ? 1 : 0, key: a.index, offsetY: 0.08 }); }
          if (a.fall && a.fall.kind === "edge" && isC) this.speed(p, 0.5);
          if (a.held && !s.held) this.emit("snap", (a.held.prop && a.held.prop.object && a.held.prop.object.position) || p, { offsetY: 0.06, key: a.index, cooldown: 0.4 });
          if (s.fall && !a.fall && a.skates && sfx && !this.reducedMotion) for (let i = 0; i < 3; i++) sfx.glint(p.x, p.y + 0.02, p.z);
          s.fall = a.fall; s.held = a.held;
          if (sfx && dt > 0) skateFX(a, s, dt, isC);
          const sp = a.skates && a.sv ? a.sv.length() : 0;
          if (sp > 0.22) {
            if (isC) this.speed(p, Math.min(0.8, (sp - 0.18) * 2.5));
            this.emit("zoom", p, { offsetY: 0.2, key: a.index, cooldown: 2.8 });
          }
        }
        const fb = G && G.football;
        if (fb && fb.score) {
          const tot = fb.score[0] + fb.score[1];
          if (tot > lastGoals && fb.ball) this.emit("goal", fb.ball.object.position, { impact: 1, offsetY: 0.18, life: 1.5 });
          lastGoals = tot;
        }
      };
    },
  };
  return fx;
}
