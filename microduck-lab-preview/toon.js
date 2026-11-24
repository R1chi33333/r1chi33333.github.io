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
  enabled: true, fps: 12, stepRoot: false, props: false,
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
    },
    /** auto FX from game state: falls (WHEE!/BONK!), beak grabs (SNAP!), fast skating (ZOOM + speed lines), goals (GOAL!) */
    watch(agents, G, getControlled) {
      const st = new WeakMap(); let lastGoals = 0;
      this._watch = (dt) => {
        const C = getControlled ? getControlled() : null;
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
          s.fall = a.fall; s.held = a.held;
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
