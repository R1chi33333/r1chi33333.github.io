// look.js — premium product "look" for the Microduck viewer (three@0.160.0)
// Everything procedural: no image files. World-space shading, so GLB UVs are not required.
//
//   setupRenderer(renderer, opts)
//   const stage = buildStage(scene, renderer, opts);  stage.fitTo(root); stage.resize(w,h); stage.update(dt); stage.setWeights(w)
//   const mats  = makeMaterials(opts)
//   const rig   = applyLook(gltf.scene, mats, { stage }); rig.setWeights({surface,xray,mind}); rig.update(dt)
//   const post  = setupPost(renderer, scene, camera, opts); post.resize(w,h); post.render(dt)

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { toCreasedNormals, mergeVertices, mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { toonify, toonifyTree, TOON, twos, setupComicPost, INK, FOCUS } from "./toon.js";
export { toonify, toonifyTree, TOON, twos, INK };

// ---------------------------------------------------------------- palette
export const PALETTE = {
  cream: "#FBF4E4",      // crisp comic cream shell
  creamAlt: "#F3EAD6",   // legs / secondary panels, a touch deeper
  orange: "#FF8A1F",     // saturated bill / feet / accents
  yellow: "#FFC928",     // eye ring + soles
  lilac: "#DCC9E2",      // soft TPU beak parts (CAD lilac)
  warmGrey: "#DCE0E7",   // face panel, hips, shins (light cool grey)
  graphite: "#97A0AE",   // frame, brackets: one flat slate with the servos
  lens: "#0B0C12",
  bezel: "#2A2B2E",
  servo: "#97A0AE",
  pcb: "#0C4A33",
  chip: "#5B6372",
  cyan: "#64D2FF",
  violet: "#BF5AF2",
  ember: "#FF9F0A",
};

export const FX_LAYER_FLAG = "lookFX"; // userData flag: excluded from contact shadows / shadow maps

export function detectQuality() {
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || Math.min(screen.width, screen.height) < 600;
  return mobile ? "low" : "high";
}

// Shared uniforms (same objects are injected into every look shader, so one write updates all).
export const uniforms = {
  uLkTime: { value: 0 },
  uLkSurface: { value: 1 },
  uLkXray: { value: 0 },
  uLkMind: { value: 0 },
  uLkScanY: { value: -1e4 },     // world-space Y of the scan plane
  uLkScanW: { value: 0.01 },     // world-space width of the scan line
  uLkNoiseScale: { value: 1 },   // 1 / model height  (set by applyLook / stage.fitTo)
  uLkXrayColor: { value: new THREE.Color(PALETTE.cyan) },
  uLkMindColor: { value: new THREE.Color(PALETTE.violet) },
};

const GLSL_COMMON = /* glsl */`
uniform float uLkTime, uLkSurface, uLkXray, uLkMind, uLkScanY, uLkScanW, uLkNoiseScale;
uniform vec3 uLkXrayColor, uLkMindColor;
float lkHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float lkHash2(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
float lkNoise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(lkHash(i),               lkHash(i+vec3(1,0,0)),f.x),
                 mix(lkHash(i+vec3(0,1,0)),   lkHash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(lkHash(i+vec3(0,0,1)),   lkHash(i+vec3(1,0,1)),f.x),
                 mix(lkHash(i+vec3(0,1,1)),   lkHash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
vec3 lkGrad(vec3 p){ float e = 0.2; float n = lkNoise(p);
  return vec3(lkNoise(p+vec3(e,0,0))-n, lkNoise(p+vec3(0,e,0))-n, lkNoise(p+vec3(0,0,e))-n) / e; }
float lkScan(float y){
  float d = (y - uLkScanY) / uLkScanW;
  float line = exp(-d*d*3.0);
  float trail = d < 0.0 ? exp(d/9.0) * 0.16 : 0.0;
  return line + trail;
}
`;

// ---------------------------------------------------------------- renderer
export function setupRenderer(renderer, opts = {}) {
  const q = opts.quality || detectQuality();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, opts.maxDPR ?? 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;      // comic look: flat colours, the comic pass handles output
  renderer.toneMappingExposure = opts.exposure ?? 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;   // smooth filtered shadow value; the toon shader thresholds it into one clean hard edge
  renderer.setClearColor(0x000000, 1);
  return q;
}

// ---------------------------------------------------------------- procedural textures
function canvasTex(size, draw, srgb = true) {
  const c = document.createElement("canvas"); c.width = c.height = size;
  draw(c.getContext("2d"), size);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function makeGlowTexture() {
  return canvasTex(128, (g, s) => {
    const img = g.createImageData(s, s);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const dx = (x + 0.5) / s * 2 - 1, dy = (y + 0.5) / s * 2 - 1, r = Math.sqrt(dx * dx + dy * dy);
      const v = Math.max(0, Math.exp(-r * r * 9) * 0.85 + Math.exp(-r * r * 60) * 0.6 - 0.002) * (r < 1 ? 1 : 0);
      const i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = 255; img.data[i + 3] = Math.min(255, v * 255);
    }
    g.putImageData(img, 0, 0);
  });
}

// ---------------------------------------------------------------- environment (PMREM studio)
function buildStudioEnv(renderer) {
  const env = new THREE.Scene();
  // room: soft vertical gradient so the clearcoat picks up a horizon, not black
  const roomGeo = new THREE.SphereGeometry(20, 48, 24);
  const cols = [];
  const pos = roomGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 20;
    const v = y > 0 ? THREE.MathUtils.lerp(0.035, 0.012, y) : THREE.MathUtils.lerp(0.035, 0.006, -y);
    cols.push(v, v * 0.99, v * 0.97);
  }
  roomGeo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(roomGeo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true })));

  const box = (w, h, p, intensity, tint = 0xffffff) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(intensity), side: THREE.DoubleSide }));
    m.position.set(...p); m.lookAt(0, 0, 0); env.add(m); return m;
  };
  box(7, 5, [6, 9, 8], 5.0, 0xfff6ea);       // key softbox, high front-right (warm)
  box(10, 10, [0, 14, 0], 1.4);              // overhead scrim
  box(1.4, 9, [-10, 3, -5], 7.0, 0xe6f0ff);  // left rim strip (cool)
  box(1.2, 7, [11, 2, -2], 3.5);             // right edge strip
  box(9, 1.0, [0, 4, -12], 2.0);             // back kicker
  box(5, 3, [-8, 2, 9], 0.9);                // soft front-left fill
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0x2a2724).multiplyScalar(0.5) }));
  floor.rotation.x = -Math.PI / 2; floor.position.y = -6; env.add(floor);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.035).texture;
  pmrem.dispose();
  env.traverse(o => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
  return tex;
}

// ---------------------------------------------------------------- stage
const BACKDROP_VS = /* glsl */`varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.99999, 1.0); }`;
const BACKDROP_FS = /* glsl */`
varying vec2 vUv;
uniform float uAspect; uniform vec3 uInner, uMid, uOuter, uTint; uniform float uTintAmt; uniform vec2 uCenter;
float h2(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
void main(){
  vec2 p = vUv - uCenter; p.x *= uAspect;
  float d = length(p * vec2(0.85, 1.15));
  vec3 col = mix(uInner, uMid, smoothstep(0.0, 0.45, d));
  col = mix(col, uOuter, smoothstep(0.35, 1.05, d));
  // faint horizon lift where the cyc curves into the floor
  col += uMid * 0.18 * exp(-pow((vUv.y - (uCenter.y - 0.17)) * 7.0, 2.0)) * (1.0 - smoothstep(0.2, 0.9, abs(p.x)));
  col = mix(col, col * uTint * 2.2, uTintAmt);
  col += (h2(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const FLOOR_SHADER = {
  name: "LookFloor",
  uniforms: {
    color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
    uRadius: { value: 1 }, uPool: { value: new THREE.Color() }, uReflect: { value: 0.07 },
    uBlur: { value: 0.006 }, uOpacity: { value: 1 }, uHasRefl: { value: 1 },
  },
  vertexShader: /* glsl */`
    uniform mat4 textureMatrix; varying vec4 vUv; varying vec2 vLocal;
    void main(){ vUv = textureMatrix * vec4(position, 1.0); vLocal = position.xy;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uRadius, uReflect, uBlur, uOpacity, uHasRefl; uniform vec3 uPool;
    varying vec4 vUv; varying vec2 vLocal;
    float h2(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      float r = length(vLocal) / uRadius;
      float a = 1.0 - smoothstep(0.05, 1.0, r);
      vec3 col = uPool * (1.0 - 0.65 * smoothstep(0.0, 1.0, r));
      if (uHasRefl > 0.5) {
        vec2 uv = vUv.xy / vUv.w;
        float b = uBlur * (1.0 + 3.0 * r);
        vec3 refl = texture2D(tDiffuse, uv).rgb * 0.28;
        refl += texture2D(tDiffuse, uv + vec2( b, 0.0)).rgb * 0.18;
        refl += texture2D(tDiffuse, uv + vec2(-b, 0.0)).rgb * 0.18;
        refl += texture2D(tDiffuse, uv + vec2(0.0,  b)).rgb * 0.18;
        refl += texture2D(tDiffuse, uv + vec2(0.0, -b)).rgb * 0.18;
        col += refl * uReflect * (1.0 - smoothstep(0.0, 0.55, r));
      }
      col += (h2(gl_FragCoord.xy) - 0.5) / 255.0;
      gl_FragColor = vec4(col, a * uOpacity);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
};

const BLUR_FS = /* glsl */`
  uniform sampler2D tMap; uniform vec2 uDir; varying vec2 vUv;
  void main(){
    vec4 s = texture2D(tMap, vUv) * 0.2270270270;
    s += texture2D(tMap, vUv + uDir * 1.3846153846) * 0.3162162162;
    s += texture2D(tMap, vUv - uDir * 1.3846153846) * 0.3162162162;
    s += texture2D(tMap, vUv + uDir * 3.2307692308) * 0.0702702703;
    s += texture2D(tMap, vUv - uDir * 3.2307692308) * 0.0702702703;
    gl_FragColor = s;
  }`;

export function buildStage(scene, renderer, opts = {}) {
  trackRendering(renderer);
  const quality = opts.quality || detectQuality();
  const hi = quality === "high";
  scene.background = null;
  scene.environment = opts.pbr ? buildStudioEnv(renderer) : null;   // toon shading uses designed lights only

  const group = new THREE.Group(); group.name = "look_stage"; scene.add(group);
  const excluded = []; // never drawn into contact shadows

  // --- backdrop (screen-space cyclorama gradient, camera-independent so it never "rotates")
  const C = (h) => new THREE.Color(h);
  const bd = {
    surface: { inner: C("#55565C"), mid: C("#232428"), outer: C("#09090B") },
    xray: { tint: C("#5FA8D0") }, mind: { tint: C("#9A6AD8") },
  };
  const backdropMat = new THREE.ShaderMaterial({
    vertexShader: BACKDROP_VS, fragmentShader: BACKDROP_FS, depthTest: false, depthWrite: false,
    uniforms: {
      uAspect: { value: 1 }, uCenter: { value: new THREE.Vector2(0.5, 0.56) },
      uInner: { value: bd.surface.inner.clone() }, uMid: { value: bd.surface.mid.clone() }, uOuter: { value: bd.surface.outer.clone() },
      uTint: { value: new THREE.Color(1, 1, 1) }, uTintAmt: { value: 0 },
    },
  });
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), backdropMat);
  backdrop.frustumCulled = false; backdrop.renderOrder = -1000; backdrop.name = "look_backdrop";
  group.add(backdrop); excluded.push(backdrop);

  // --- floor: reflective, radially fading into the backdrop (seamless sweep)
  const floorGeo = new THREE.CircleGeometry(1, 96);
  let floor;
  const poolColor = C("#2C2D31");
  const wantFloor = opts.floor !== false;
  if (wantFloor && hi && opts.reflection !== false) {
    floor = new Reflector(floorGeo, { shader: FLOOR_SHADER, textureWidth: 512, textureHeight: 512, multisample: 0, clipBias: 0.0 });
  } else {
    floor = new THREE.Mesh(floorGeo, new THREE.ShaderMaterial({ ...FLOOR_SHADER, uniforms: THREE.UniformsUtils.clone(FLOOR_SHADER.uniforms) }));
    floor.material.uniforms.uHasRefl.value = 0; floor.material.uniforms.textureMatrix.value = new THREE.Matrix4(); floor.material.uniforms.color.value = new THREE.Color();
  }
  floor.material.transparent = true; floor.material.depthWrite = false;
  floor.material.uniforms.uPool.value = poolColor;
  floor.rotation.x = -Math.PI / 2; floor.renderOrder = -900; floor.name = "look_floor"; floor.visible = wantFloor;
  group.add(floor); excluded.push(floor);

  // --- shadow catcher for the key light's soft shadow map
  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.22, depthWrite: false }));
  catcher.rotation.x = -Math.PI / 2; catcher.receiveShadow = true; catcher.renderOrder = -800; catcher.name = "look_catcher";
  catcher.visible = wantFloor && opts.catcher !== false;
  group.add(catcher); excluded.push(catcher);

  // --- contact shadows (render-from-below + separable blur)
  const csRes = hi ? 512 : 256;
  const rtA = new THREE.WebGLRenderTarget(csRes, csRes, { type: THREE.HalfFloatType });
  const rtB = new THREE.WebGLRenderTarget(csRes, csRes, { type: THREE.HalfFloatType });
  rtA.texture.generateMipmaps = rtB.texture.generateMipmaps = false;
  const csCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  csCam.rotation.x = Math.PI / 2;
  const csDepth = new THREE.MeshDepthMaterial();
  csDepth.userData.darkness = { value: 1.4 };
  csDepth.onBeforeCompile = (s) => {
    s.uniforms.darkness = csDepth.userData.darkness;
    s.fragmentShader = "uniform float darkness;\n" + s.fragmentShader.replace(
      "gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );",
      "gl_FragColor = vec4( vec3( 0.0 ), pow(1.0 - fragCoordZ, 1.6) * darkness );");
  };
  csDepth.depthTest = false; csDepth.depthWrite = false;
  const blurMat = new THREE.ShaderMaterial({
    uniforms: { tMap: { value: null }, uDir: { value: new THREE.Vector2() } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader: BLUR_FS, depthTest: false, depthWrite: false,
  });
  const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMat); blurQuad.frustumCulled = false;
  const blurScene = new THREE.Scene(); blurScene.add(blurQuad);
  const blurCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: rtA.texture, transparent: true, opacity: opts.pbr ? 0.85 : 0.5, depthWrite: false, toneMapped: false }));
  contact.scale.y = -1; contact.renderOrder = -700; contact.name = "look_contact";
  contact.visible = !!opts.pbr;     // toon look: cast shadows + blob shadows instead (saves a pass)
  const csGroup = new THREE.Group(); csGroup.add(contact); csGroup.add(csCam);
  group.add(csGroup); excluded.push(contact);

  // --- lights
  const key = new THREE.DirectionalLight(0xfff3e6, opts.keyIntensity ?? 2.4);
  key.castShadow = true;
  // characters self-shadow with hard edges: on high quality use at least 4096 so a ~1.5 m frustum gives sub-mm texels
  const smap = Math.max(opts.shadowMapSize ?? 0, hi ? 4096 : 2048); key.shadow.mapSize.set(smap, smap);
  key.shadow.bias = -0.0002;   // + normalBias (setShadowExtent) keeps curved CAD shells free of acne
  // toon: one dominant key decides the bands; rim/kick only nudge silhouettes into the mid band
  const rim = new THREE.DirectionalLight(0xcfe3ff, opts.pbr ? 2.0 : 0.85);
  const kick = new THREE.DirectionalLight(0xffffff, opts.pbr ? 0.8 : 0.35);
  TOON.uTnKey.value = key.intensity;
  const hemi = new THREE.HemisphereLight(0xeef2ff, 0x2a2622, opts.hemiIntensity ?? 0.7);
  group.add(key, key.target, rim, rim.target, kick, kick.target, hemi);

  let size = 1, center = new THREE.Vector3(), floorY = 0, dirty = true;
  let extentOverride = opts.shadowExtent;
  const lightDirs = [[key, (opts.pbr ? new THREE.Vector3(0.55, 1.0, 0.75) : new THREE.Vector3(0.48, 1.05, 0.62)).normalize()], [rim, new THREE.Vector3(-0.8, 0.55, -0.7).normalize()], [kick, new THREE.Vector3(0.9, 0.3, -0.6).normalize()]];
  if (opts.keyDir) lightDirs[0][1].copy(opts.keyDir).normalize();
  function placeLights(p) { const dist = Math.max(size * 4, (extentOverride || 0) * 2.5); for (const [lt, v] of lightDirs) { lt.position.copy(p).addScaledVector(v, dist); lt.target.position.copy(p); } }
  /** game use: keep contact shadows + the key light's shadow frustum centred on a moving subject */
  // view-fitted shadow square: when the camera is close, the key light's frustum shrinks (quantised steps) so the
  // characters' self-shadows get several times the texel density (clean graphic edges); far views use the full extent
  const lastFollow = new THREE.Vector3(); let fitted = 0;
  function applyExtent(e) {
    const sc = key.shadow.camera; if (Math.abs(sc.right - e) < 1e-6) return;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.05; sc.far = Math.max(size * 8, (extentOverride || e) * 6); sc.updateProjectionMatrix();
    key.shadow.normalBias = Math.max(size * 0.004, e * 0.004); key.shadow.needsUpdate = true;
  }
  const fitProbe = new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3)),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false }));
  fitProbe.name = "look_shadowfit"; fitProbe.frustumCulled = false; fitProbe.castShadow = false; fitProbe.userData[FX_LAYER_FLAG] = true; fitProbe.raycast = () => {};
  fitProbe.onBeforeRender = (r, sc, cam) => {
    if (!extentOverride || !fitted || !cam.isPerspectiveCamera) return;
    const el = r.domElement; if (Math.abs(cam.aspect - el.width / Math.max(1, el.height)) > 0.02) return;   // main view only
    const d = cam.position.distanceTo(lastFollow);
    applyExtent(Math.min(extentOverride, Math.max(0.35, Math.ceil(d * 1.1 / 0.15) * 0.15)));
  };
  group.add(fitProbe);
  function follow(p, groundY = floorY) {
    lastFollow.copy(p); fitted = 1; FOCUS.pos.copy(p); FOCUS.set = true;
    csGroup.position.set(p.x, groundY + size * 0.001, p.z);
    // snap to shadow texels to avoid shimmering while moving
    const e = key.shadow.camera.right, texel = (2 * e) / key.shadow.mapSize.x;
    const q = new THREE.Vector3(Math.round(p.x / texel) * texel, p.y, Math.round(p.z / texel) * texel);
    placeLights(q);
  }
  const base = { key: key.intensity, rim: rim.intensity, kick: kick.intensity, hemi: hemi.intensity };

  function fitTo(object) {
    object.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(object);
    const s = box.getSize(new THREE.Vector3());
    size = Math.max(s.x, s.y, s.z); box.getCenter(center); floorY = box.min.y;
    uniforms.uLkNoiseScale.value = 1 / size;
    const R = size * 2.6;
    floor.position.set(center.x, floorY - size * 0.0005, center.z); floor.scale.setScalar(R);
    floor.material.uniforms.uRadius.value = 1; // local radius 1
    catcher.position.set(center.x, floorY + size * 0.0005, center.z); catcher.scale.setScalar(size * 3);
    const W = Math.max(s.x, s.z) * 2.2;
    csGroup.position.set(center.x, floorY + size * 0.001, center.z);
    contact.scale.set(W, -1, W); contact.scale.set(W, W, W); contact.scale.y = -W;
    csCam.left = -W / 2; csCam.right = W / 2; csCam.top = W / 2; csCam.bottom = -W / 2;
    csCam.near = 0; csCam.far = s.y * 0.55; csCam.updateProjectionMatrix();
    placeLights(center);
    const sc = key.shadow.camera; const e = extentOverride ?? size * 0.9;
    sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = extentOverride ? 0.05 : size * 0.5; sc.far = Math.max(size * 8, (extentOverride || 0) * 6); sc.updateProjectionMatrix();
    key.shadow.normalBias = size * 0.004;
    uniforms.uLkScanW.value = size * 0.012;
    dirty = true;
    return { size, center: center.clone(), floorY, box };
  }

  function renderContactShadows() {
    const hidden = [];
    scene.traverseVisible(o => { if (excluded.includes(o) || o.userData[FX_LAYER_FLAG] || o.userData.lookNoContact || o.isSprite || o.isLine || o.isPoints || o.isLight) hidden.push(o); });
    hidden.forEach(o => o.visible = false);
    const prevOverride = scene.overrideMaterial, prevBg = scene.background, prevRT = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha(); const prevColor = renderer.getClearColor(new THREE.Color());
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    scene.overrideMaterial = csDepth; scene.background = null;
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(rtA); renderer.clear(); renderer.render(scene, csCam);
    scene.overrideMaterial = prevOverride; scene.background = prevBg;
    hidden.forEach(o => o.visible = true);
    const pass = (amt) => {
      blurMat.uniforms.tMap.value = rtA.texture; blurMat.uniforms.uDir.value.set(amt / csRes, 0);
      renderer.setRenderTarget(rtB); renderer.render(blurScene, blurCam);
      blurMat.uniforms.tMap.value = rtB.texture; blurMat.uniforms.uDir.value.set(0, amt / csRes);
      renderer.setRenderTarget(rtA); renderer.render(blurScene, blurCam);
    };
    pass(3.0); pass(1.4); pass(0.6);
    renderer.setRenderTarget(prevRT); renderer.setClearColor(prevColor, prevAlpha);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
  }

  const weights = { surface: 1, xray: 0, mind: 0 };
  function setWeights(w) {
    Object.assign(weights, w);
    const fx = Math.min(1, weights.xray + weights.mind);
    const tint = bd.xray.tint.clone().lerp(bd.mind.tint, weights.mind / (weights.xray + weights.mind + 1e-5));
    backdropMat.uniforms.uTint.value.copy(tint);
    backdropMat.uniforms.uTintAmt.value = fx * 0.55;
    key.intensity = base.key * (1 - 0.35 * fx);
    rim.intensity = base.rim * (1 - 0.2 * fx);
    kick.intensity = base.kick; hemi.intensity = base.hemi * (1 - 0.3 * fx);
    catcher.material.opacity = 0.22 * (1 - 0.6 * fx);
    contact.material.opacity = (opts.pbr ? 0.85 : 0.5) * (1 - 0.45 * fx);
  }

  return {
    group, lights: { key, rim, kick, hemi }, floor, backdrop, contact, catcher, excluded,
    fitTo, follow, setWeights,
    /** runtime: half-size (m) of the key light's shadow square around the followed point; persists across fitTo() */
    setShadowExtent(e) {
      extentOverride = e; const sc = key.shadow.camera;
      sc.left = -e; sc.right = e; sc.top = e; sc.bottom = -e; sc.near = 0.05; sc.far = Math.max(size * 8, e * 6); sc.updateProjectionMatrix();
      key.shadow.normalBias = Math.max(size * 0.004, e * 0.004); key.shadow.needsUpdate = true;
    },
    get shadowExtent() { return key.shadow.camera.right; },
    /** call every frame (before rendering). Set stage.contactEveryFrame=false + stage.invalidate() for static models. */
    contactEveryFrame: true,
    invalidate() { dirty = true; },
    resize(w, h) {
      backdropMat.uniforms.uAspect.value = w / h;
      if (floor.isReflector) { const pr = renderer.getPixelRatio(); floor.getRenderTarget().setSize(Math.round(w * pr * 0.5), Math.round(h * pr * 0.5)); }
    },
    update(dt) { if (!opts.pbr) return; if (this.contactEveryFrame || dirty) { renderContactShadows(); dirty = false; } },
    get size() { return size; }, get center() { return center; }, get floorY() { return floorY; },
  };
}

// ---------------------------------------------------------------- material patching helper
// comic character shading for every duck material: two clean bands, a soft terminator (hides CAD faceting),
// subtle dots only on the shadow side, no hatching, a small clean highlight, and the duck object mask for the ink pass
// blend colour normally but leave destination alpha (the duck object mask) untouched
function keepAlpha(m) {
  m.blending = THREE.CustomBlending; m.blendEquation = THREE.AddEquation;
  m.blendSrc = THREE.SrcAlphaFactor; m.blendDst = THREE.OneMinusSrcAlphaFactor;
  m.blendSrcAlpha = THREE.ZeroFactor; m.blendDstAlpha = THREE.OneFactor; return m;
}
let catchTex = null;
function catchlightTexture() {
  if (catchTex) return catchTex;
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.beginPath(); g.ellipse(30, 30, 20, 16, -0.5, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(46, 46, 6, 0, Math.PI * 2); g.fill();
  catchTex = new THREE.CanvasTexture(c); catchTex.colorSpace = THREE.SRGBColorSpace; return catchTex;
}
/** white comic catchlight on the camera lens (billboard), for models without an eye_highlight mesh */
function addCatchlight(root) {
  if (root.getObjectByName("eye_highlight") || root.getObjectByName("eye_catchlight")) return;
  const lens = root.getObjectByName("electronics_camera_lens"); if (!lens) return;
  root.updateMatrixWorld(true);
  const b = new THREE.Box3().setFromObject(lens), c = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
  const r = Math.max(sz.x, sz.y) / 2;
  const wp = new THREE.Vector3(c.x - r * 0.35, c.y + r * 0.35, b.max.z + 0.0015);   // models face +Z at load
  const mat = keepAlpha(new THREE.SpriteMaterial({ map: catchlightTexture(), color: 0xffffff, toneMapped: false, transparent: true, depthWrite: false }));
  const sp = new THREE.Sprite(mat); sp.name = "eye_catchlight"; sp.scale.setScalar(r * 0.75); sp.renderOrder = 7;
  sp.position.copy(lens.worldToLocal(wp)); sp.userData[FX_LAYER_FLAG] = true; sp.raycast = () => {};
  // undo the lens node's scale so the sprite keeps its world size
  const ws = lens.getWorldScale(new THREE.Vector3()); sp.scale.divide(ws);
  lens.add(sp);
}
// characters: classic comic two-tone. Hard terminator (soft 0), matte (no specular, no rim), deep shadow tone
// (shade = albedo kept in shadow, deep = extra darkening), self-shadowing on so overhangs cast shapes.
export const CHAR_TOON = { rim: 0, lift: 0.06, hue: 0.3, twoBand: true, soft: 0, hatch: false, halftone: 0.4, mask: 0.5, spec: 0, specT: 0.9, shade: 0.16, deep: 0.9 };
function patch(material, key, { uniforms: own = {}, fragHead = "", vertHead = "", afterRoughness = "", afterNormal = "", afterClearcoatNormal = "", afterEmissive = "", toon = null }) {
  material.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, uniforms, own);
    s.vertexShader = "varying vec3 vLkWorld; varying vec3 vLkObj;\n" + vertHead + "\n" + s.vertexShader.replace("#include <project_vertex>",
      "#include <project_vertex>\n vLkObj = transformed; vLkWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = "varying vec3 vLkWorld; varying vec3 vLkObj;\n" + GLSL_COMMON + fragHead + "\n" + s.fragmentShader
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + afterRoughness)
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + afterNormal)
      .replace("#include <clearcoat_normal_fragment_maps>", "#include <clearcoat_normal_fragment_maps>\n" + afterClearcoatNormal)
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\n" + afterEmissive);
    Object.defineProperty(material.userData, "shader", { value: s, writable: true, configurable: true, enumerable: false });   // hidden from userData JSON copies (clone)
  };
  material.customProgramCacheKey = () => "look-" + key;
  // duck plastics: slight lift so the smooth toon shell keeps a broad clean lit band; gentler hue shift so
  // orange/yellow shadows stay warm instead of turning red
  return toonify(material, toon ? { ...CHAR_TOON, ...toon } : CHAR_TOON);
}

// micro-texture used by all plastics: orange-peel waviness on normal + clearcoat, fine grain on roughness
const PLASTIC_ROUGH = /* glsl */`
  vec3 lkP = vLkWorld * uLkNoiseScale;
  float lkFw = length(fwidth(lkP * uGrainFreq));
  float lkGrainFade = 1.0 - smoothstep(0.25, 0.9, lkFw);
  float lkG = lkNoise(lkP * uGrainFreq) * 0.65 + lkNoise(lkP * uGrainFreq * 2.3) * 0.35;
  roughnessFactor = clamp(roughnessFactor + (lkG - 0.5) * uGrainRough * lkGrainFade + (lkNoise(lkP*9.0)-0.5)*0.04, 0.03, 1.0);
`;
const PLASTIC_NORMAL = /* glsl */`
  {
    vec3 g = lkGrad(lkP * uPeelFreq) * uPeel + lkGrad(lkP * uGrainFreq) * uGrainBump * lkGrainFade;
    vec3 gv = (viewMatrix * vec4(g, 0.0)).xyz;
    normal = normalize(normal - (gv - dot(gv, normal) * normal));
  }
`;
const PLASTIC_CC = /* glsl */`
  #ifdef USE_CLEARCOAT
  {
    vec3 g = lkGrad(lkP * uPeelFreq) * uPeel * 0.6;
    vec3 gv = (viewMatrix * vec4(g, 0.0)).xyz;
    clearcoatNormal = normalize(clearcoatNormal - (gv - dot(gv, clearcoatNormal) * clearcoatNormal));
  }
  #endif
`;
// cyan rim + scan band on solids during X-ray, violet rim during Mind
const FX_EMISSIVE = /* glsl */`
  {
    float fres = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);
    float band = lkScan(vLkWorld.y);
    totalEmissiveRadiance += uLkXrayColor * (fres * 0.55 + band * 1.6) * uLkXray * uFxRim;
    totalEmissiveRadiance += uLkMindColor * fres * 0.35 * uLkMind * uFxRim;
  }
`;

function plastic(key, params, grain = {}) {
  const m = new THREE.MeshPhysicalMaterial(params);
  const own = {
    uGrainFreq: { value: grain.freq ?? 320 }, uGrainRough: { value: grain.rough ?? 0.14 },
    uGrainBump: { value: 0 }, uPeelFreq: { value: grain.peelFreq ?? 38 }, uPeel: { value: 0 },
    uFxRim: { value: grain.fxRim ?? 0 },
  };
  m.userData.lookUniforms = own;
  return patch(m, key, { uniforms: own, fragHead: "uniform float uGrainFreq, uGrainRough, uGrainBump, uPeelFreq, uPeel, uFxRim;\n",
    afterRoughness: PLASTIC_ROUGH, afterNormal: PLASTIC_NORMAL, afterClearcoatNormal: PLASTIC_CC, afterEmissive: FX_EMISSIVE });
}

// ---------------------------------------------------------------- materials
export function makeMaterials(opts = {}) {
  const quality = opts.quality || detectQuality();
  const P = { ...PALETTE, ...(opts.palette || {}) };
  const glow = makeGlowTexture();

  // premium injection-moulded shell: satin base, thin crisp clearcoat, soft sheen at grazing angles
  const shell = plastic("shell", {
    color: P.cream, roughness: 0.46, metalness: 0, clearcoat: 0.32, clearcoatRoughness: 0.14,
    sheen: 0.35, sheenRoughness: 0.75, sheenColor: new THREE.Color("#fff8ec"), specularIntensity: 0.55, ior: 1.46,
    envMapIntensity: 1.0,
  });
  const shellAlt = plastic("shellAlt", {
    color: P.creamAlt, roughness: 0.52, clearcoat: 0.2, clearcoatRoughness: 0.2,
    sheen: 0.3, sheenRoughness: 0.8, sheenColor: new THREE.Color("#fff4e2"), specularIntensity: 0.5, envMapIntensity: 1.0,
  });
  const beak = plastic("beak", {
    color: P.orange, roughness: 0.48, clearcoat: 0.22, clearcoatRoughness: 0.2,
    sheen: 0.45, sheenRoughness: 0.6, sheenColor: new THREE.Color("#ffc08a"), specularIntensity: 0.5, envMapIntensity: 0.95,
  }, { rough: 0.12 });
  const foot = plastic("foot", { // chunky orange feet, softer TPU-like finish
    color: P.orange, roughness: 0.66, clearcoat: 0.05, sheen: 0.6, sheenRoughness: 0.5,
    sheenColor: new THREE.Color("#ffb070"), specularIntensity: 0.4, envMapIntensity: 0.85,
  }, { rough: 0.2, bump: 0.004, freq: 420 });
  const rubber = plastic("rubber", {
    color: "#1C1D1F", roughness: 0.86, sheen: 0.7, sheenRoughness: 0.45, sheenColor: new THREE.Color("#5a5c60"), envMapIntensity: 0.6,
  }, { rough: 0.1, bump: 0.005, freq: 500 });
  const bezel = plastic("bezel", {
    color: P.bezel, roughness: 0.32, metalness: 0.0, clearcoat: 0.6, clearcoatRoughness: 0.1, envMapIntensity: 1.1,
  }, { rough: 0.08, fxRim: 1 });
  // CAD colour family, made premium
  const yellow = plastic("yellow", { // eye ring + soles: glossy saturated yellow
    color: P.yellow, roughness: 0.34, clearcoat: 0.45, clearcoatRoughness: 0.12, sheen: 0.3, sheenRoughness: 0.6,
    sheenColor: new THREE.Color("#ffe39a"), specularIntensity: 0.55, envMapIntensity: 1.0,
  }, { rough: 0.1 });
  const soft = plastic("soft", { // soft-touch TPU beak parts, pale lilac
    color: P.lilac, roughness: 0.72, clearcoat: 0.0, sheen: 0.8, sheenRoughness: 0.45, sheenColor: new THREE.Color("#f4e8ff"),
    specularIntensity: 0.35, envMapIntensity: 0.8,
  }, { rough: 0.12, bump: 0.004, freq: 460 });
  const warmGrey = plastic("warmGrey", { // face panel, hips, shins, brackets in the CAD warm grey
    color: P.warmGrey, roughness: 0.5, clearcoat: 0.18, clearcoatRoughness: 0.22, sheen: 0.25, sheenRoughness: 0.7,
    sheenColor: new THREE.Color("#f2ebe0"), specularIntensity: 0.5, envMapIntensity: 1.0,
  }, { fxRim: 0.6 });
  const graphite = plastic("graphite", { // dark structural parts: frame, brackets, motor supports
    color: P.graphite, roughness: 0.48, clearcoat: 0.25, clearcoatRoughness: 0.25, sheen: 0.3, sheenRoughness: 0.6,
    sheenColor: new THREE.Color("#6b7078"), specularIntensity: 0.5, envMapIntensity: 1.1,
  }, { fxRim: 1, rough: 0.12 });
  const steel = new THREE.MeshPhysicalMaterial({ color: "#AEB6C3", metalness: 1, roughness: 0.22, envMapIntensity: 1.3 });
  patch(steel, "steel", { uniforms: { uFxRim: { value: 1 } }, fragHead: "uniform float uFxRim;\n", afterEmissive: FX_EMISSIVE });

  // servos: one flat slate block each (comic look): no brushed streaks, no specular, rim or dots, so the
  // small CAD holes and chamfers don't read as speckle; a broad lit band with a single flat shadow tone
  const servo = new THREE.MeshPhysicalMaterial({ color: P.servo, metalness: 0.45, roughness: 0.36, clearcoat: 0.2, clearcoatRoughness: 0.3, envMapIntensity: 1.4 });
  patch(servo, "servo", {
    uniforms: { uFxRim: { value: 1 } }, fragHead: "uniform float uFxRim;\n",
    afterEmissive: FX_EMISSIVE,
    toon: { spec: 0, rim: 0, halftone: 0, lift: 0.06, soft: 0.0, shade: 0.05, deep: 0.62 },   // spot blacks in shadow
  });

  // PCB: glossy soldermask, procedural traces/pads, emissive trace pulses that intensify in X-ray
  const pcb = new THREE.MeshPhysicalMaterial({ color: P.pcb, roughness: 0.5, clearcoat: 0.7, clearcoatRoughness: 0.22, envMapIntensity: 1.0, emissive: 0x000000 });
  patch(pcb, "pcb", {
    uniforms: { uFxRim: { value: 0.7 }, uTraceGlow: { value: 0.25 } }, fragHead: /* glsl */`
      uniform float uFxRim, uTraceGlow;
      float lkTraces(vec2 p, out float pad){
        vec2 c = floor(p); vec2 f = fract(p);
        float r = lkHash2(c);
        float w = 0.07;
        float h = (r < 0.45) ? 1.0 - smoothstep(w, w + 0.03, abs(f.y - 0.5)) : 0.0;
        float v = (r > 0.35 && r < 0.8) ? 1.0 - smoothstep(w, w + 0.03, abs(f.x - 0.5)) : 0.0;
        pad = (r > 0.82) ? 1.0 - smoothstep(0.16, 0.2, length(f - 0.5)) : 0.0;
        return max(h, v);
      }`,
    afterEmissive: /* glsl */`
      {
        vec3 wn = abs(inverseTransformDirection(normal, viewMatrix));
        vec3 lp = vLkWorld * uLkNoiseScale * 60.0;
        vec2 uv = wn.y > max(wn.x, wn.z) ? lp.xz : (wn.x > wn.z ? lp.yz : lp.xy);
        float pad; float tr = lkTraces(uv, pad);
        float fw = length(fwidth(uv)); float fade = 1.0 - smoothstep(0.6, 1.6, fw);
        tr *= fade; pad *= fade;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.10, 0.42, 0.25), tr * 0.6);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.75, 0.55, 0.2), pad);
        float flow = pow(0.5 + 0.5 * sin(dot(uv, vec2(0.37, 0.61)) * 1.3 - uLkTime * 3.0), 10.0);
        vec3 tc = mix(mix(vec3(0.2, 1.0, 0.6), uLkXrayColor, uLkXray), uLkMindColor, uLkMind);
        totalEmissiveRadiance += tc * tr * (uTraceGlow * (0.4 + flow) + (uLkXray + uLkMind) * (0.6 + 3.0 * flow));
      }
      ` + FX_EMISSIVE,
  });
  const chip = new THREE.MeshPhysicalMaterial({ color: P.chip, roughness: 0.62, metalness: 0.0, clearcoat: 0.1, envMapIntensity: 0.9 });
  patch(chip, "chip", { uniforms: { uFxRim: { value: 1 } }, fragHead: "uniform float uFxRim;\n", afterEmissive: FX_EMISSIVE });
  const battery = new THREE.MeshPhysicalMaterial({ color: "#5B6372", roughness: 0.45, metalness: 0.3, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 1.0 });
  patch(battery, "battery", { uniforms: { uFxRim: { value: 1 } }, fragHead: "uniform float uFxRim;\n", afterEmissive: FX_EMISSIVE });

  // ---- X-ray ghost shell (fresnel + holographic scanlines + scan band)
  const ghost = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uColor: { value: new THREE.Color(P.cyan) }, uOpacity: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz;
        vec4 mv = viewMatrix * w; vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv; }`,
    fragmentShader: GLSL_COMMON + /* glsl */`
      uniform vec3 uColor; uniform float uOpacity;
      varying vec3 vN; varying vec3 vV; varying vec3 vW;
      void main(){
        float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
        float y = vW.y * uLkNoiseScale;
        float lines = pow(0.5 + 0.5 * sin(y * 420.0 - uLkTime * 1.5), 8.0);
        float band = lkScan(vW.y);
        vec3 col = uColor * (0.035 + 1.25 * f + lines * (0.05 + 0.35 * f) + band * (0.5 + 1.8 * f));
        gl_FragColor = vec4(col * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // ---- glowing edge lines (crease edges of the shell)
  const edge = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uColor: { value: new THREE.Color(P.cyan) }, uOpacity: { value: 0 } },
    vertexShader: "varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: GLSL_COMMON + /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; varying vec3 vW;
      void main(){ float band = lkScan(vW.y);
        gl_FragColor = vec4(uColor * (0.7 + band * 3.5) * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // ---- scanning plane (horizontal disc riding uLkScanY)
  const scanPlane = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uColor: { value: new THREE.Color(P.cyan) }, uOpacity: { value: 0 } },
    vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; varying vec2 vP;
      void main(){ float r = length(vP);
        float fill = (1.0 - smoothstep(0.0, 1.0, r)) * 0.05;
        float ring = exp(-pow((r - 0.98) * 40.0, 2.0)) * 0.25;
        float grid = (1.0 - smoothstep(0.0, 0.02, abs(fract(r * 8.0) - 0.5) - 0.47)) * 0.04 * (1.0 - r);
        gl_FragColor = vec4(uColor * (fill + ring + grid) * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });

  // ---- Mind: raymarched neural nebula (assign to a unit sphere; scale the mesh to the volume you want)
  const steps = quality === "high" ? 22 : 10;
  const mindVolume = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uOpacity: { value: 0 }, uColA: { value: new THREE.Color(P.violet) }, uColB: { value: new THREE.Color("#5E5CE6") }, uHot: { value: new THREE.Color(P.ember) }, uIntensity: { value: 2.2 } },
    defines: { STEPS: steps },
    vertexShader: /* glsl */`
      varying vec3 vObj; varying vec3 vCam;
      void main(){ vObj = position; vCam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: GLSL_COMMON + /* glsl */`
      uniform float uOpacity, uIntensity; uniform vec3 uColA, uColB, uHot;
      varying vec3 vObj; varying vec3 vCam;
      float fbm(vec3 p){ return lkNoise(p) * 0.6 + lkNoise(p * 2.1 + 3.1) * 0.3 + lkNoise(p * 4.3 + 7.7) * 0.1; }
      void main(){
        vec3 ro = vCam; vec3 rd = normalize(vObj - vCam);
        float b = dot(ro, rd); float c = dot(ro, ro) - 1.0; float h = b * b - c;
        if (h < 0.0) discard; h = sqrt(h);
        float t0 = max(-b - h, 0.0), t1 = -b + h;
        float dt = (t1 - t0) / float(STEPS);
        float j = lkHash2(gl_FragCoord.xy);
        vec3 acc = vec3(0.0);
        for (int i = 0; i < STEPS; i++){
          vec3 p = ro + rd * (t0 + (float(i) + j) * dt);
          float r = length(p);
          float fall = 1.0 - smoothstep(0.25, 1.0, r);
          vec3 q = p * 2.4 + vec3(0.0, uLkTime * 0.12, uLkTime * 0.05);
          float n = fbm(q);
          float fil = pow(1.0 - abs(2.0 * n - 1.0), 7.0);
          float spark = pow(lkNoise(p * 9.0 + uLkTime * 0.8), 14.0) * 6.0;
          float core = exp(-r * r * 7.0) * 0.35;
          vec3 col = mix(uColB, uColA, clamp(fil * 1.4, 0.0, 1.0)) * (fil + core) + uHot * spark * fil;
          acc += col * fall * dt;
        }
        gl_FragColor = vec4(acc * uIntensity * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, side: THREE.BackSide,
  });

  // ---- Mind graph pieces (factories, for the page's network)
  const mindNode = (color = P.violet, intensity = 2.5) => new THREE.SpriteMaterial({
    map: glow, color: new THREE.Color(color).multiplyScalar(intensity), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false });
  const mindLink = new THREE.ShaderMaterial({
    uniforms: { ...uniforms, uColor: { value: new THREE.Color(P.violet) }, uOpacity: { value: 0 } },
    vertexShader: "varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: GLSL_COMMON + /* glsl */`
      uniform vec3 uColor; uniform float uOpacity; varying vec3 vW;
      void main(){ vec3 p = vW * uLkNoiseScale;
        float pulse = pow(0.5 + 0.5 * sin(dot(p, vec3(-9.0, 6.0, 2.0)) * 3.0 + uLkTime * 4.0), 10.0);
        gl_FragColor = vec4(uColor * (0.25 + 2.2 * pulse) * uOpacity, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const mindPath = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.ember).multiplyScalar(3), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });

  return {
    quality, palette: P, textures: { glow },
    highlight: (() => { const m = keepAlpha(new THREE.MeshBasicMaterial({ name: "highlight", color: 0xffffff, toneMapped: false, transparent: true, depthWrite: false })); /* no depth -> no ink ring */ m.userData.toon = true; return m; })(),
    shell, shellAlt, beak, orange: beak, foot, rubber, bezel, servo, pcb, chip, battery,
    yellow, soft, warmGrey, graphite, steel,
    makeEye: (o) => makeEyeMaterial(P, o),
    ghost, edge, scanPlane, mindVolume, mindNode, mindLink, mindPath,
  };
}

// glossy black camera lens: fresnel-ring grooves, inner iris gradient, LED ring, pupil, catchlight
export function makeEyeMaterial(P = PALETTE, o = {}) {
  const m = new THREE.MeshPhysicalMaterial({ color: P.lens, roughness: 0.06, metalness: 0.0, clearcoat: 1.0, clearcoatRoughness: 0.02, ior: 1.7, specularIntensity: 1.0, envMapIntensity: 1.4 });
  const own = {
    uEyeC: { value: o.center || new THREE.Vector3() }, uEyeAx: { value: o.axis || new THREE.Vector3(0, 0, 1) },
    uEyeR: { value: o.radius || 1 }, uEyeHemi: { value: o.hemi ? 1 : 0 },
    uRingColor: { value: new THREE.Color(o.ringColor || P.cyan) }, uRingI: { value: o.ringIntensity ?? 0.5 },
    uFxRim: { value: 0 },
  };
  m.userData.lookUniforms = own;
  return patch(m, "eye", {
    uniforms: own,
    fragHead: "uniform vec3 uEyeC, uEyeAx, uRingColor; uniform float uEyeR, uEyeHemi, uRingI, uFxRim;\n",
    afterRoughness: /* glsl */`
      vec3 eq = vLkObj - uEyeC; float eAlong = dot(eq, uEyeAx);
      float er = length(eq - eAlong * uEyeAx) / uEyeR;
      float eFront = mix(1.0, smoothstep(-0.05, 0.35, eAlong / uEyeR), uEyeHemi);
      // iris: deep blue-violet glass gradient visible through the lens
      float iris = (1.0 - smoothstep(0.18, 0.62, er)) * smoothstep(0.12, 0.2, er);
      diffuseColor.rgb += vec3(0.006, 0.010, 0.022) * iris * eFront;
      // concentric fresnel grooves very slightly roughen the outer glass
      roughnessFactor = clamp(roughnessFactor + pow(0.5 + 0.5 * sin(er * 90.0), 6.0) * 0.08 * smoothstep(0.66, 0.75, er) * eFront, 0.02, 1.0);`,
    afterEmissive: /* glsl */`
      {
        vec3 ringC = mix(uRingColor, uLkMindColor, uLkMind);
        float ring = smoothstep(0.50, 0.535, er) * (1.0 - smoothstep(0.60, 0.635, er));
        float halo = exp(-pow((er - 0.57) * 9.0, 2.0)) * 0.05;
        float breathe = 0.85 + 0.15 * sin(uLkTime * 1.7);
        float segs = 0.75 + 0.25 * step(0.5, fract(atan(eq.y, eq.x) * 6.0 / 6.2831853 + eAlong * 0.0));
        totalEmissiveRadiance += ringC * (ring * segs + halo) * uRingI * breathe * eFront;
        totalEmissiveRadiance += vec3(0.004, 0.012, 0.03) * (1.0 - smoothstep(0.1, 0.45, er)) * smoothstep(0.08, 0.16, er) * eFront;
        // stylised catchlight so the eye always reads alive (spherical lenses only)
        vec3 Lh = normalize(vec3(-0.35, 0.45, 1.0));
        totalEmissiveRadiance += vec3(1.0) * pow(max(dot(normal, Lh), 0.0), 600.0) * 3.0 * uEyeHemi * eFront;
      }`,
  });
}

// ---------------------------------------------------------------- geometry prep / smoothing
function toFloat(attr) {
  if (!attr || (attr.array instanceof Float32Array && !attr.isInterleavedBufferAttribute)) return attr;
  const out = new Float32Array(attr.count * attr.itemSize);
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < attr.itemSize; c++) out[i * attr.itemSize + c] = attr.getComponent ? attr.getComponent(i, c) : [attr.getX(i), attr.getY(i), attr.getZ(i), attr.getW(i)][c];
  return new THREE.BufferAttribute(out, attr.itemSize);
}
function isFaceted(g) {
  const n = g.attributes.normal; if (!n) return true;
  const idx = g.index, triCount = idx ? idx.count / 3 : g.attributes.position.count / 3;
  const N = Math.min(triCount, 500); if (!N) return false;
  let flat = 0;
  const v = (k) => idx ? idx.getX(k) : k;
  for (let s = 0; s < N; s++) {
    const t = Math.floor((s / N) * triCount) * 3, a = v(t), b = v(t + 1), c = v(t + 2);
    const d = (p, q) => Math.abs(n.getX(p) - n.getX(q)) + Math.abs(n.getY(p) - n.getY(q)) + Math.abs(n.getZ(p) - n.getZ(q));
    if (d(a, b) < 1e-3 && d(a, c) < 1e-3) flat++;
  }
  return flat / N > 0.97; // CAD planar faces are flat too: only re-smooth meshes that are flat almost everywhere
}
function prepGeometry(mesh, creaseDeg, force) {
  let g = mesh.geometry;
  if (!g.attributes.position) return;
  if (mesh.userData.lookPrepped) return;
  mesh.userData.lookPrepped = true;
  // KHR_mesh_quantization -> float (needed for normal recompute, EdgesGeometry and smooth shading precision)
  if (!(g.attributes.position.array instanceof Float32Array) || (g.attributes.normal && !(g.attributes.normal.array instanceof Float32Array))) {
    g = g.clone();
    g.setAttribute("position", toFloat(g.attributes.position));
    if (g.attributes.normal) { const nn = toFloat(g.attributes.normal); g.setAttribute("normal", nn); }
    mesh.geometry = g;
  }
  if (g.attributes.normal && !force && !isFaceted(g)) {
    // renormalise (quantized normals are slightly off-unit)
    const n = g.attributes.normal, v = new THREE.Vector3();
    for (let i = 0; i < n.count; i++) { v.fromBufferAttribute(n, i).normalize(); n.setXYZ(i, v.x, v.y, v.z); }
    return;
  }
  g.computeBoundingBox();
  const lsize = Math.max(...g.boundingBox.getSize(new THREE.Vector3()).toArray()) || 1;
  const k = 1000 / lsize; // toCreasedNormals hashes positions at 0.01 units; work at model-relative precision
  g = g.clone(); g.deleteAttribute("normal"); g.scale(k, k, k);
  g = toCreasedNormals(g, THREE.MathUtils.degToRad(creaseDeg));
  g.scale(1 / k, 1 / k, 1 / k);
  try { g = mergeVertices(g, lsize * 1e-6); } catch (e) { /* keep non-indexed */ }
  mesh.geometry = g;
}

// ---------------------------------------------------------------- classify + apply
// [regex on node name (or any ancestor), material kind, ghost in X-ray?]
// ghost = outer housing that turns to glass; others stay solid "internals" (servos, electronics, frame, bearings)
export const RULES = [
  // leg mechanics (hip blocks, shins, brackets, plates): painted the servo slate so the mechanics read as one
  // simple block mass; solid in X-ray like the servos (they stay Garage leg members)
  [/^leg_.*(bracket|plate)|^leg_.*_(hip|shin)$/i, "servo", false],
  [/^electronics_camera_lens$/i, "eye", false],
  [/^electronics_camera_lens_holder/i, "bezel", false],
  [/^eye_highlight/i, "highlight", false],   // toon duck catchlight: pure white, unlit, in every skin and in X-ray
  [/^eye_/i, "yellow", true],
  [/^shell_beak_(upper|lower_soft)/i, "soft", true],
  [/^shell_beak|beak|bill|mouth/i, "orange", true],
  [/^shell_head_bottom/i, "orange", true],
  [/^shell_head_face/i, "warmGrey", true],
  [/^shell_/i, "shell", true],
  [/^foot_.*sole/i, "yellow", true],
  [/^foot_/i, "orange", true],
  [/^leg_.*thigh$/i, "shell", true],
  [/^leg_.*bracket/i, "graphite", false],
  [/^leg_/i, "warmGrey", true],
  [/^neck_.*bracket/i, "warmGrey", false],
  [/^neck_pitch_link/i, "steelGrey", false],
  [/^neck_/i, "graphite", false],
  [/^head_/i, "graphite", false],
  [/^frame_/i, "graphite", false],
  [/^bearing_/i, "steel", false],
  [/^servo_/i, "servo", false],
  [/^electronics_.*(servo_hat|main_board|pcb$|board)/i, "pcb", false],
  [/^electronics_battery_holder/i, "warmGrey", false],
  [/^electronics_battery/i, "battery", false],
  [/^electronics_.*(locker)/i, "graphite", false],
  [/^electronics_.*(speaker|chip|soc|imu|sensor|tof|module)/i, "chip", false],
  [/^electronics_/i, "chip", false],
];
// comic simplification (opts.simplify !== false): small hardware is never drawn; internal electronics only
// appear in X-ray. Matched on the mesh's own name; nodes stay in the rig (joints, markers, Garage parts intact).
// Garage-part members (leg_*_thigh_plate, leg_*_hip_yaw_bracket, ...) are deliberately NOT listed.
export const SIMPLIFY_HIDE = /^(bearing_|neck_bracket_|screw|bolt|nut_|horn_|servo_horn|cable)/i;
// electronics_servo_hat is kept: it is the board seen through the face window (reads as the face ToF sensor)
export const SIMPLIFY_INTERNAL = /^electronics_(battery|battery_holder|main_board|speaker|pcb_locker|cable)/i;
const GHOST_KINDS = new Set(["shell", "shellAlt", "beak", "orange", "yellow", "soft", "warmGrey", "foot", "rubber"]);

function nameChain(o) { const out = []; while (o) { if (o.name) out.push(o.name); o = o.parent; } return out; }
function classify(mesh) {
  for (const n of nameChain(mesh)) for (const [re, kind, ghost] of RULES) if (re.test(n)) return { kind, ghost };
  // fallback: CAD colour hints
  const c = mesh.material && mesh.material.color;
  if (c) {
    const hsl = {}; c.getHSL(hsl);
    if (hsl.s > 0.5 && hsl.h > 0.02 && hsl.h < 0.08) return { kind: "orange", ghost: true };
    if (hsl.s > 0.5 && hsl.h >= 0.08 && hsl.h < 0.16) return { kind: "yellow", ghost: true };
    if (hsl.l < 0.2) return { kind: "graphite", ghost: false };
    if (hsl.l < 0.35) return { kind: "servo", ghost: false };
  }
  return { kind: "shell", ghost: true };
}

// ------------------------------------------------------------------ ink contour lines (characters)
// Feature edges (crease >= INK_ANGLE, plus open boundaries) of the main structural parts, drawn as fat black
// lines parented to each mesh. Small closed details (screw holes, chamfer rings) are dropped by size.
const INK_ANGLE = 35;
const INK_KINDS = new Set(["shell", "shellAlt", "beak", "orange", "yellow", "soft", "warmGrey", "foot", "rubber"]);
const INK_SKIP = /(plate|bracket|bearing|horn|_hip$|_shin$|electronics_|eye_(?!camera_ring))/i;
const INK_MIN = 0.016;          // m: connected edge groups smaller than this (bbox diagonal) are dropped
const INK_PX = 2.4;             // line width in CSS px (scaled by the renderer's pixel ratio)
const inkCache = new WeakMap();
const _inkVP = new THREE.Vector4();
let inkMat = null;
function inkMaterial() {
  if (inkMat) return inkMat;
  inkMat = new LineMaterial({ color: INK.clone(), linewidth: INK_PX, worldUnits: false, transparent: false });
  inkMat.opacity = 0.5;           // not blended: alpha 0.5 just tags the pixels as "character" for the comic pass mask
  inkMat.toneMapped = false;
  // pull the line slightly towards the camera so it wins the depth test against its own surface
  inkMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace("vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );",
      "vec4 end = modelViewMatrix * vec4( instanceEnd, 1.0 );\n\t\t\tstart.xyz *= 0.9988; end.xyz *= 0.9988;");
  };
  inkMat.customProgramCacheKey = () => "ink-pull";
  return inkMat;
}
function inkEdges(geometry, scale) {
  if (inkCache.has(geometry)) return inkCache.get(geometry);
  const eg = new THREE.EdgesGeometry(geometry, INK_ANGLE);
  const P = eg.attributes.position.array, nSeg = P.length / 6;
  // connected components over shared endpoints
  const keyOf = (i) => Math.round(P[i] * 2e4) + "," + Math.round(P[i + 1] * 2e4) + "," + Math.round(P[i + 2] * 2e4);
  const parent = new Int32Array(nSeg).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  for (let k = 0; k < nSeg; k++) for (const off of [0, 3]) {
    const key = keyOf(k * 6 + off), o = owner.get(key);
    if (o === undefined) owner.set(key, k); else { const a = find(o), b = find(k); if (a !== b) parent[a] = b; }
  }
  const bb = new Map();
  for (let k = 0; k < nSeg; k++) {
    const r = find(k); let b = bb.get(r); if (!b) { b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; bb.set(r, b); }
    for (const off of [0, 3]) for (let a = 0; a < 3; a++) { const v = P[k * 6 + off + a] * scale; if (v < b[a]) b[a] = v; if (v > b[a + 3]) b[a + 3] = v; }
  }
  const out = [];
  for (let k = 0; k < nSeg; k++) {
    const b = bb.get(find(k)); const d = Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
    if (d >= INK_MIN) for (let a = 0; a < 6; a++) out.push(P[k * 6 + a]);
  }
  eg.dispose();
  let g = null;
  if (out.length) { g = new LineSegmentsGeometry(); g.setPositions(out); }
  inkCache.set(geometry, g);
  return g;
}
// eye ring: always fully lit flat yellow (no toon band, no dots); same program as the yellow plastic
function eyeRingMaterial(M) {
  if (M._eyeRing) return M._eyeRing;
  const src = M.yellow, m = src.clone();
  m.onBeforeCompile = src.onBeforeCompile; m.customProgramCacheKey = src.customProgramCacheKey;
  const U = {}; for (const [k, v] of Object.entries(src.userData.toonU || {})) U[k] = { value: v.value };
  if (U.uTnLift) U.uTnLift.value = 5.0; if (U.uTnHalftone) U.uTnHalftone.value = 0; if (U.uTnSpec) U.uTnSpec.value = 0; if (U.uTnRim) U.uTnRim.value = 0;
  m.userData = { ...src.userData, toonU: U };
  return (M._eyeRing = m);
}
function addInk(mesh, kind) {
  if (!INK_KINDS.has(kind) || INK_SKIP.test(mesh.name)) return null;
  if (mesh.children.some(c => c.userData.inkLine)) return null;
  const ws = mesh.getWorldScale(new THREE.Vector3());
  const g = inkEdges(mesh.geometry, (Math.abs(ws.x) + Math.abs(ws.y) + Math.abs(ws.z)) / 3);
  if (!g) return null;
  const mat = inkMaterial();
  const ln = new LineSegments2(g, mat);
  ln.userData.inkLine = true; ln.userData[FX_LAYER_FLAG] = true;     // FX flag: skipped by look traversals and the head-camera render
  ln.castShadow = false; ln.receiveShadow = false; ln.raycast = () => {}; ln.renderOrder = 2;
  // r160 LineSegments2 doesn't track the viewport itself: feed the current target size (device px) each draw
  ln.onBeforeRender = function (r) { r.getCurrentViewport(_inkVP); mat.resolution.set(Math.max(1, _inkVP.z), Math.max(1, _inkVP.w)); mat.linewidth = INK_PX * r.getPixelRatio(); };
  mesh.add(ln);
  return ln;
}


// ------------------------------------------------------------------ per-duck draw-call merge
// Each duck's rigid meshes are merged per (bone, material) into proxy meshes parented to that bone, and its ink
// lines per bone into one LineSegments2. The originals stay in the scene untouched (picking, ground probes,
// X-ray ghosts, Garage part lists, skins), they are only skipped while the renderer draws (layers test below).
// Any change to an original (material swap, part condition, Garage slide/scale) drops the proxies at once and
// they are rebuilt after the rig has been stable for MERGE_SETTLE seconds. Proxy visibility follows the
// originals' .visible every draw (X-ray, sensor-eye render, ink LOD), shadow casting follows their castShadow.
let RENDERING = 0;
// three r160 defines render() per instance (in the constructor), so the instance is wrapped
export function trackRendering(renderer) {
  if (!renderer || renderer.__duckMergePatched) return; const r = renderer.render;
  renderer.render = function (s, c) { RENDERING++; try { return r.call(this, s, c); } finally { RENDERING--; } };
  renderer.__duckMergePatched = true;
}
const MERGE_SETTLE = 0.6;
function coverObject(o) {
  if (o.userData.mergeCover) return;
  const L = o.layers, test = L.test.bind(L);
  o.userData.mergeCover = { on: false };
  Object.defineProperty(o.userData, "mergeCover", { enumerable: false, writable: true, value: o.userData.mergeCover });
  L.test = (x) => (RENDERING && o.userData.mergeCover.on ? false : test(x));
}
function rigSignature(list) {
  let h = 0;
  for (let i = 0; i < list.length; i++) {
    const m = list[i], k = i + 1, p = m.position, q = m.quaternion, sc = m.scale;
    h += k * (m.material.id * 1.37 + (m.receiveShadow ? 7.1 : 0) + (m.parent ? m.parent.id * 0.71 : 0)
      + p.x * 101 + p.y * 103 + p.z * 107 + q.x * 109 + q.y * 113 + q.z * 127 + q.w * 131 + sc.x * 137 + sc.y * 139 + sc.z * 149);
  }
  return h;
}
function mergeEligible(m) {
  return m.isMesh && !m.isSkinnedMesh && !m.isInstancedMesh && m.parent && !m.userData.lookHidden && m.renderOrder === 0 && !Array.isArray(m.material)
    && m.material && !m.material.vertexColors && m.geometry && m.geometry.attributes.position && m.userData.lookKind !== "highlight";
}
function buildDuckMerge(rig) {
  const list = rig.meshes.filter(mergeEligible);
  const groups = new Map();
  for (const m of list) {
    const key = m.parent.uuid + "|" + m.material.uuid + "|" + (m.receiveShadow ? 1 : 0);
    let g = groups.get(key); if (!g) groups.set(key, g = { parent: m.parent, material: m.material, receive: m.receiveShadow, members: [] });
    g.members.push(m);
  }
  const proxies = [];
  const v4 = new THREE.Vector4();
  for (const g of groups.values()) {
    if (g.members.length < 2) continue;
    const allIndexed = g.members.every(m => m.geometry.index);
    const geos = g.members.map(m => {
      m.updateMatrix();
      let geo = allIndexed ? m.geometry.clone() : (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone());
      for (const k of Object.keys(geo.attributes)) if (k !== "position" && k !== "normal" && k !== "uv") geo.deleteAttribute(k);
      if (!geo.attributes.normal) geo.computeVertexNormals();
      if (!geo.attributes.uv) geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
      geo.morphAttributes = {}; geo.clearGroups();
      return geo.applyMatrix4(m.matrix);
    });
    let merged; try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
    geos.forEach(x => x.dispose());
    if (!merged) continue;
    merged.computeBoundingSphere();
    const px = new THREE.Mesh(merged, g.material);
    px.name = "merged_" + (g.members[0].name || "part"); px.userData.mergedProxy = true; px.raycast = () => {};
    px.receiveShadow = g.receive; px.onBeforeRender = (r) => trackRendering(r);
    const members = g.members;
    Object.defineProperty(px, "castShadow", { get: () => members.some(m => m.castShadow), set: () => {}, configurable: true });
    const t0 = px.layers.test.bind(px.layers);
    px.layers.test = (x) => { for (const m of members) if (!m.visible) return false; return t0(x); };
    g.parent.add(px); proxies.push(px);
    for (const m of members) { coverObject(m); m.userData.mergeCover.on = true; }
  }
  // ink lines: one fat-line mesh per bone
  const inkGroups = new Map();
  for (const m of list) for (const c of m.children) if (c.userData.inkLine && c.geometry && c.geometry.attributes.instanceStart) {
    let g = inkGroups.get(m.parent.uuid); if (!g) inkGroups.set(m.parent.uuid, g = { parent: m.parent, lines: [], material: c.material, onBR: c.onBeforeRender });
    g.lines.push(c);
  }
  const M = new THREE.Matrix4(), P = new THREE.Vector3();
  for (const g of inkGroups.values()) {
    if (g.lines.length < 2) continue;
    const pos = [];
    for (const ln of g.lines) {
      ln.updateMatrix(); ln.parent.updateMatrix(); M.multiplyMatrices(ln.parent.matrix, ln.matrix);
      const a = ln.geometry.attributes.instanceStart, b = ln.geometry.attributes.instanceEnd;
      for (let i = 0; i < a.count; i++) {
        P.fromBufferAttribute(a, i).applyMatrix4(M); pos.push(P.x, P.y, P.z);
        P.fromBufferAttribute(b, i).applyMatrix4(M); pos.push(P.x, P.y, P.z);
      }
    }
    const geo = new LineSegmentsGeometry(); geo.setPositions(pos);
    const px = new LineSegments2(geo, g.material);
    px.name = "merged_ink"; px.userData.mergedProxy = true; px.userData[FX_LAYER_FLAG] = true; px.userData.inkProxy = true;
    px.raycast = () => {}; px.castShadow = false; px.receiveShadow = false; px.renderOrder = 2; px.onBeforeRender = function (r, ...a) { trackRendering(r); return g.onBR.call(this, r, ...a); };
    const lines = g.lines;
    const t0 = px.layers.test.bind(px.layers);
    px.layers.test = (x) => { for (const ln of lines) if (!ln.visible || !ln.parent.visible) return false; return t0(x); };
    g.parent.add(px); proxies.push(px);
    for (const ln of lines) { coverObject(ln); ln.userData.mergeCover.on = true; }
  }
  return { list, proxies, sig: rigSignature(list) };
}
function dropDuckMerge(rig) {
  const st = rig._merge; if (!st || !st.built) return;
  for (const px of st.built.proxies) { if (px.parent) px.parent.remove(px); px.geometry.dispose(); }
  for (const m of st.built.list) { if (m.userData.mergeCover) m.userData.mergeCover.on = false; for (const c of m.children) if (c.userData.mergeCover) c.userData.mergeCover.on = false; }
  st.built = null;
}
/** per-frame upkeep (called from rig.update): rebuild once stable, drop on any change */
function updateDuckMerge(rig, dt) {
  const st = rig._merge || (rig._merge = { built: null, sig: NaN, stable: 0, enabled: true });
  if (!st.enabled) { dropDuckMerge(rig); return; }
  const list = st.built ? st.built.list : rig.meshes.filter(mergeEligible);
  const sig = rigSignature(list);
  if (st.built) { if (sig !== st.built.sig || list.some(m => !mergeEligible(m))) { dropDuckMerge(rig); st.stable = 0; st.sig = NaN; } return; }
  if (sig !== st.sig) { st.sig = sig; st.stable = 0; return; }
  st.stable += dt;
  if (st.stable >= MERGE_SETTLE) st.built = buildDuckMerge(rig);
}

/**
 * Assign look materials by node name; build X-ray ghosts, edge lines, scan plane and the Mind nebula.
 * Add `root` to the scene BEFORE calling (FX live in a sibling group that tracks world matrices).
 * opts: { stage, creaseAngle=40, smooth:'auto'|true, edges=true, edgeAngle=30, mindAnchor:Vector3(world),
 *         mindRadius, classify(mesh)->{kind,ghost}|null }
 */
export function applyLook(root, M, opts = {}) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = Math.max(...box.getSize(new THREE.Vector3()).toArray());
  const center = box.getCenter(new THREE.Vector3());
  uniforms.uLkNoiseScale.value = 1 / size;
  uniforms.uLkScanW.value = size * 0.012;

  // characters animate on twos: register the duck's outer root (DuckBody wraps the model in duck_root > duck_tilt)
  { let r = root; while (r.parent && r.name !== "duck_root") r = r.parent; if (r.name === "duck_root" && opts.twos !== false) twos.register(r); }
  const isDuck = opts.merge !== false && (() => { let r = root; while (r) { if (r.name === "duck_root") return true; r = r.parent; } return false; })();
  const fxGroup = new THREE.Group(); fxGroup.name = "look_fx"; fxGroup.userData[FX_LAYER_FLAG] = true;
  (opts.parent || root.parent || root).add(fxGroup);
  const fxParentIsRoot = !(opts.parent || root.parent);

  if (opts.catchlight !== false) addCatchlight(root);
  const meshes = []; root.traverse(o => { if (o.isMesh && !o.userData[FX_LAYER_FLAG]) meshes.push(o); });
  const groups = { shellSolids: [], ghosts: [], edges: [], internals: [], eyes: [], byKind: {}, hiddenDetail: [], hiddenInternal: [], ink: [] };
  const tracked = []; // [fxObject, sourceMesh]

  for (const mesh of meshes) {
    const cls = (opts.classify && opts.classify(mesh)) || classify(mesh);
    const kind = cls.kind, ghost = cls.ghost ?? GHOST_KINDS.has(kind);
    prepGeometry(mesh, ghost ? (opts.shellCrease ?? 65) : (opts.creaseAngle ?? 40), ghost || opts.smooth === true);   // shells: smooth shading normals, geometry unchanged
    let mat;
    if (kind === "eye") {
      const g = mesh.geometry; g.computeBoundingBox();
      const bb = g.boundingBox, s = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
      const dims = [s.x, s.y, s.z]; const sorted = [...dims].sort((a, b) => a - b);
      const thin = sorted[0] < sorted[1] * 0.6;
      const local = mesh.worldToLocal(center.clone());
      const outward = c.clone().sub(local).normalize();
      let axis;
      if (opts.eyeAxis) axis = opts.eyeAxis.clone();
      else if (thin) { const i = dims.indexOf(sorted[0]); axis = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0); if (axis.dot(outward) < 0) axis.negate(); }
      else if (Math.abs(sorted[0] - sorted[1]) < sorted[1] * 0.06 && Math.abs(sorted[2] - sorted[1]) > sorted[1] * 0.06 ||
               Math.abs(sorted[1] - sorted[2]) < sorted[2] * 0.06 && Math.abs(sorted[0] - sorted[1]) > sorted[1] * 0.06) {
        // cylinder / barrel: two equal extents, the odd one out is the optical axis
        const odd = Math.abs(sorted[0] - sorted[1]) < sorted[1] * 0.06 ? sorted[2] : sorted[0];
        const i = dims.indexOf(odd);
        axis = new THREE.Vector3(i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0); if (axis.dot(outward) < 0) axis.negate();
      } else {
        // pick the bbox axis best aligned with "outward"
        const ax = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
        let best = 0; ax.forEach((a, i) => { if (Math.abs(a.dot(outward)) > Math.abs(ax[best].dot(outward))) best = i; });
        axis = ax[best]; if (axis.dot(outward) < 0) axis.negate();
      }
      const ai = [Math.abs(axis.x), Math.abs(axis.y), Math.abs(axis.z)];
      const perp = dims.filter((_, i) => ai[i] < 0.9);
      const radius = (perp.length ? Math.max(...perp) : sorted[2]) / 2;
      mat = M.makeEye({ center: c, axis, radius, hemi: false });
      groups.eyes.push(mesh);
    } else if (/^eye_camera_ring/i.test(mesh.name) && M.yellow) mat = eyeRingMaterial(M);
    else mat = M[kind] || (kind === "steelGrey" ? M.servo : M.shell);
    if (kind === "highlight") { mesh.castShadow = false; mesh.receiveShadow = false; mesh.renderOrder = 6; mesh.userData.lookNoContact = true; }
    mesh.material = mat;
    mesh.userData.lookKind = kind; mesh.userData.lookGhost = !!ghost;
    mesh.castShadow = kind !== "highlight"; mesh.receiveShadow = kind !== "highlight" && opts.selfShadow !== false && !/^(eye_|electronics_camera)/i.test(mesh.name);   // hard self-shadows (visor onto face etc.); the small eye parts stay clean
    (groups.byKind[kind] ||= []).push(mesh);
    if (opts.simplify !== false && !ghost && (SIMPLIFY_HIDE.test(mesh.name) || SIMPLIFY_INTERNAL.test(mesh.name))) {
      const internal = SIMPLIFY_INTERNAL.test(mesh.name);
      mesh.visible = false; mesh.castShadow = false; mesh.userData.lookHidden = internal ? "internal" : "detail";
      mesh.raycast = () => {};
      (internal ? groups.hiddenInternal : groups.hiddenDetail).push(mesh);
    }

    // ink contours only on real characters (inside duck_root), not on the template pass
    if (opts.ink !== false && !mesh.userData.lookHidden && (() => { let r = root; while (r) { if (r.name === "duck_root") return true; r = r.parent; } return false; })()) {
      const ln = addInk(mesh, kind); if (ln) groups.ink.push(ln);
    }
    if (ghost) {
      groups.shellSolids.push(mesh);
      const gh = new THREE.Mesh(mesh.geometry, M.ghost);
      gh.userData[FX_LAYER_FLAG] = true; gh.renderOrder = 10; gh.visible = false; gh.raycast = () => {};
      gh.matrixAutoUpdate = false; fxGroup.add(gh); groups.ghosts.push(gh); tracked.push([gh, mesh]);
      if (opts.edges !== false && mesh.geometry.attributes.position.count < 400000) {
        const eg = new THREE.EdgesGeometry(mesh.geometry, opts.edgeAngle ?? 30);
        if (eg.attributes.position.count > 0) {
          const ln = new THREE.LineSegments(eg, M.edge);
          ln.userData[FX_LAYER_FLAG] = true; ln.renderOrder = 11; ln.visible = false; ln.raycast = () => {};
          ln.matrixAutoUpdate = false; fxGroup.add(ln); groups.edges.push(ln); tracked.push([ln, mesh]);
        }
      }
    } else groups.internals.push(mesh);
  }

  const inv = new THREE.Matrix4();
  function syncFX() {
    if (fxParentIsRoot) { root.updateMatrixWorld(); inv.copy(root.matrixWorld).invert(); }
    for (const [o, src] of tracked) { o.matrix.copy(src.matrixWorld); if (fxParentIsRoot) o.matrix.premultiply(inv); o.matrixWorldNeedsUpdate = true; }
  }
  syncFX();

  // scan plane
  const scan = new THREE.Mesh(new THREE.CircleGeometry(1, 96), M.scanPlane);
  const bsz = box.getSize(new THREE.Vector3());
  scan.rotation.x = -Math.PI / 2; scan.scale.setScalar(Math.max(bsz.x, bsz.z) * 0.6); scan.position.copy(center);
  scan.userData[FX_LAYER_FLAG] = true; scan.renderOrder = 12; scan.visible = false; scan.raycast = () => {};
  fxGroup.add(scan);

  // mind nebula: around the compute boards (the "brain"), else model centre
  let anchor = opts.mindAnchor, mindR = opts.mindRadius;
  if (!anchor) {
    // the head shell (where the compute lives on Microduck), else the PCBs, else the model centre
    const eb = new THREE.Box3(); meshes.filter(m => /^shell_head_(top|bottom)/i.test(m.name)).forEach(m => eb.expandByObject(m));
    if (eb.isEmpty()) (groups.byKind.pcb || []).forEach(m => eb.expandByObject(m));
    anchor = eb.isEmpty() ? center.clone() : eb.getCenter(new THREE.Vector3());
    if (!eb.isEmpty() && !mindR) { const hs = eb.getSize(new THREE.Vector3()); mindR = Math.min(hs.x, hs.y, hs.z) * 0.62; }
  }
  mindR = mindR || size * 0.22;
  const mind = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 24), M.mindVolume);
  mind.position.copy(anchor); mind.scale.set(1.5, 0.95, 1.25).multiplyScalar(mindR);
  mind.userData[FX_LAYER_FLAG] = true; mind.renderOrder = 9; mind.visible = false; mind.raycast = () => {};
  fxGroup.add(mind);

  const scanRange = [box.min.y - size * 0.03, box.max.y + size * 0.03];
  const cyan = new THREE.Color(M.palette.cyan), violet = new THREE.Color(M.palette.violet);
  let t = 0;
  const W = { surface: 1, xray: 0, mind: 0 };

  const rig = {
    groups, fxGroup, scan, mind, size, center, box,
    /** fixed 0..1 scan position (e.g. for screenshots); null = animated sweep */
    scanOverride: null,
    scanPeriod: 3.4,
    /** weights 0..1 for each layer; pass your eased crossfade values every frame */
    setWeights(w) {
      Object.assign(W, w);
      const s = W.surface, x = W.xray, m = W.mind, fxw = Math.min(1, x + m);
      uniforms.uLkSurface.value = s; uniforms.uLkXray.value = x; uniforms.uLkMind.value = m;
      for (const mat of new Set(groups.shellSolids.map(mm => mm.material))) {
        mat.opacity = s;
        const tr = s < 0.995; if (mat.transparent !== tr) { mat.transparent = tr; mat.needsUpdate = true; }
        mat.depthWrite = s > 0.5;
      }
      for (const mesh of groups.shellSolids) { mesh.visible = s > 0.01; mesh.castShadow = s > 0.5; }
      for (const mesh of groups.hiddenInternal) mesh.visible = x > 0.5;   // electronics show only in X-ray
      for (const ln of groups.ink) ln.visible = s > 0.5;
      const ghostCol = cyan.clone().lerp(violet, m / (x + m + 1e-5));
      M.ghost.uniforms.uColor.value.copy(ghostCol);
      M.ghost.uniforms.uOpacity.value = x * 1.0 + m * 0.3;
      M.edge.uniforms.uColor.value.copy(ghostCol);
      M.edge.uniforms.uOpacity.value = x * 0.32 + m * 0.08;
      groups.ghosts.forEach(g => g.visible = fxw > 0.01);
      groups.edges.forEach(g => g.visible = (x + m * 0.2) > 0.01);
      M.scanPlane.uniforms.uOpacity.value = x; scan.visible = x > 0.01;
      M.mindVolume.uniforms.uOpacity.value = m; mind.visible = m > 0.01;
      if (opts.stage) opts.stage.setWeights(W);
    },
    /** per-frame callbacks (e.g. markReplaced flashes); return false to remove */
    effects: [],
    addTracked(o, src) { o.matrixAutoUpdate = false; fxGroup.add(o); tracked.push([o, src]); syncFX(); },
    removeTracked(o) { const i = tracked.findIndex(([x]) => x === o); if (i >= 0) tracked.splice(i, 1); fxGroup.remove(o); },
    meshes,
    update(dt) {
      t += dt; uniforms.uLkTime.value = t;
      this.effects = this.effects.filter(fn => fn(dt) !== false);
      let u = this.scanOverride;
      if (u == null) { const ph = (t % this.scanPeriod) / this.scanPeriod; u = ph < 0.8 ? ph / 0.8 : 1.2; u = u <= 1 ? u * u * (3 - 2 * u) : 1.2; }
      uniforms.uLkScanY.value = THREE.MathUtils.lerp(scanRange[0], scanRange[1], u);
      scan.position.y = uniforms.uLkScanY.value;
      if (this.trackMotion) syncFX();
      if (isDuck) updateDuckMerge(this, dt);
    },
    /** draw-call merge of the duck's rigid meshes + ink (on by default for ducks); false restores the originals */
    setMerge(on, now = false) { const st = this._merge || (this._merge = { built: null, sig: NaN, stable: 0, enabled: true }); st.enabled = !!on; if (!on) dropDuckMerge(this); else if (now && !st.built) st.built = buildDuckMerge(this); },
    /** set true if the GLB animates (joints move) so ghosts/edges follow every frame */
    trackMotion: false,
    syncFX,
  };
  rig.setWeights(W);
  if (opts.stage) opts.stage.fitTo(root);
  return rig;
}

// ---------------------------------------------------------------- post
const FINISH_SHADER = {
  uniforms: { tDiffuse: { value: null }, uVignette: { value: 0.32 }, uGrain: { value: 0.018 }, uTime: { value: 0 }, uAspect: { value: 1 } },
  vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uVignette, uGrain, uTime, uAspect; varying vec2 vUv;
    float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + uTime) * 43758.5453); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
      float v = 1.0 - uVignette * smoothstep(0.35, 1.15, length(p));
      c.rgb *= v;
      c.rgb += (h(gl_FragCoord.xy) - 0.5) * uGrain * (1.0 - c.rgb * 0.6);
      gl_FragColor = c;
    }`,
};

export function setupPost(renderer, scene, camera, opts = {}) {
  if (!opts.pbr) return setupComicPost(renderer, scene, camera, opts);
  return setupPostPBR(renderer, scene, camera, opts);
}
function setupPostPBR(renderer, scene, camera, opts = {}) {
  // Sharpness: MSAA on the HDR target (no FXAA blur), optional SMAA on top, no grain by default,
  // bloom only above a high threshold so it never haloes ordinary edges.
  const quality = opts.quality || detectQuality();
  const hi = quality === "high";
  const isWebGL2 = renderer.capabilities.isWebGL2;
  const maxSamples = isWebGL2 ? renderer.capabilities.maxSamples : 0;
  const samples = Math.min(opts.samples ?? 4, maxSamples || 0);
  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples });
  const composer = new EffectComposer(renderer, rt);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), opts.bloomStrength ?? 0.3, opts.bloomRadius ?? 0.35, opts.bloomThreshold ?? 2.4);
  bloom.enabled = opts.bloom !== false;
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  const aa = opts.aa ?? (samples > 0 ? "msaa" : "fxaa");   // 'msaa' | 'smaa' | 'fxaa' | 'none'
  let fxaa = null, smaa = null;
  if (aa === "fxaa") { fxaa = new ShaderPass(FXAAShader); composer.addPass(fxaa); }
  if (aa === "smaa") { smaa = new SMAAPass(1, 1); composer.addPass(smaa); }
  const finish = new ShaderPass(FINISH_SHADER); composer.addPass(finish);
  finish.uniforms.uGrain.value = opts.grain ?? 0.0;
  finish.uniforms.uVignette.value = opts.vignette ?? 0.22;
  const clock = { t: 0 };
  function resize(w, h) {
    const pr = renderer.getPixelRatio();
    composer.setPixelRatio(pr); composer.setSize(w, h);
    finish.uniforms.uAspect.value = w / h;
    if (fxaa) fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
    if (smaa) smaa.setSize(w * pr, h * pr);
  }
  return {
    composer, bloom, finish, resize, aa, samples,
    render(dt = 0.016) { clock.t = (clock.t + dt) % 100; finish.uniforms.uTime.value = clock.t; composer.render(dt); },
  };
}

/**
 * Adaptive resolution: holds DPR at max while frames are fast, steps down (never below min)
 * only when the smoothed frame time stays over budget, and climbs back when there is headroom.
 *   const aq = createAdaptiveQuality(renderer, { onChange: () => resize() });  ...  aq.tick(dt) every frame
 */
export function createAdaptiveQuality(renderer, opts = {}) {
  const max = Math.min(window.devicePixelRatio || 1, opts.max ?? 2);
  const min = Math.min(max, opts.min ?? 1);
  const budget = opts.budgetMs ?? 1000 / 50;   // step down when slower than ~50 fps
  const headroom = opts.headroomMs ?? 1000 / 75;
  let avg = budget * 0.8, slow = 0, fast = 0, warm = 0;
  let dpr = renderer.getPixelRatio();
  return {
    get dpr() { return dpr; },
    tick(dt) {
      if (warm++ < 30 || !dt) return;               // ignore start-up hitches
      avg += (dt * 1000 - avg) * 0.05;
      if (avg > budget) { slow += dt; fast = 0; } else if (avg < headroom) { fast += dt; slow = 0; } else { slow = fast = 0; }
      let next = dpr;
      if (slow > 1.0 && dpr > min) next = Math.max(min, dpr - 0.25);
      if (fast > 4.0 && dpr < max) next = Math.min(max, dpr + 0.25);
      if (next !== dpr) { dpr = next; slow = fast = 0; renderer.setPixelRatio(dpr); opts.onChange && opts.onChange(dpr); }
    },
  };
}

// ================================================================ skins (official colourways)
// roles: shell (main housing), accent (head bottom, jaw, feet), accent2 (eye ring, soles), soft (beak TPU), secondary (face panel, hips, shins)
export const SKINS = {
  cream:    { shell: "#FBF4E4", accent: "#FF8A1F", accent2: "#FFC928", soft: "#F3D9E8", secondary: "#DCE0E7" },
  graphite: { shell: "#4A505C", accent: "#FFC928", accent2: "#FFC928", soft: "#6B7280", secondary: "#353A44", dark: true },
  lavender: { shell: "#C3B2EC", accent: "#FFC928", accent2: "#FFD95A", soft: "#EEE6FA", secondary: "#9D93BD" },
  sky:      { shell: "#A6D8F5", accent: "#FF8A1F", accent2: "#FFC928", soft: "#E6F4FC", secondary: "#8FB0C8" },
};
const KIND_ROLE = { shell: "shell", shellAlt: "shell", orange: "accent", beak: "accent", foot: "accent", yellow: "accent2", soft: "soft", warmGrey: "secondary" };
/** semantic part groups usable in {parts: [...]} (or pass node names / name prefixes / RegExps) */
export const PART_GROUPS = {
  head: /^(shell_head|shell_beak|eye_)/i,
  beak: /^shell_beak/i,
  body: /^shell_body/i,
  legs: /^leg_/i,
  leftLeg: /^(leg_left|foot_left)/i,
  rightLeg: /^(leg_right|foot_right)/i,
  feet: /^foot_/i,
  shell: /^shell_/i,
};
function matchParts(rig, parts) {
  if (!parts) return rig.meshes.filter(m => KIND_ROLE[m.userData.lookKind]);
  const tests = (Array.isArray(parts) ? parts : [parts]).map(p =>
    p instanceof RegExp ? p : PART_GROUPS[p] || new RegExp("^" + String(p).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")));
  return rig.meshes.filter(m => KIND_ROLE[m.userData.lookKind] && tests.some(t => t.test(m.name)));
}
// give a mesh its own copy of its look material (same shader program, independent colour/roughness)
function ownMaterial(mesh) {
  if (mesh.userData.lookOwnMat) return mesh.material;
  const src = mesh.material, m = src.clone();
  m.onBeforeCompile = src.onBeforeCompile; m.customProgramCacheKey = src.customProgramCacheKey;
  m.userData = { ...src.userData, lookBase: { color: src.color.clone(), roughness: src.roughness, clearcoat: src.clearcoat, clearcoatRoughness: src.clearcoatRoughness, sheen: src.sheen } };
  mesh.material = m; mesh.userData.lookOwnMat = true;
  return m;
}
/**
 * Recolour the whole duck (parts omitted) or only some parts.
 *   setSkin(rig, 'graphite')                         whole duck
 *   setSkin(rig, 'sky', { parts: ['head'] })         mix & match: head shell only
 *   setSkin(rig, 'lavender', { parts: ['leg_left_thigh', /^foot_left/] })
 * Returns the list of meshes changed.
 */
export function setSkin(rig, name, opts = {}) {
  const skin = typeof name === "string" ? SKINS[name] : name;
  if (!skin) throw new Error("unknown skin " + name);
  const meshes = matchParts(rig, opts.parts);
  for (const mesh of meshes) {
    const role = KIND_ROLE[mesh.userData.lookKind];
    const m = ownMaterial(mesh);
    const b = m.userData.lookBase;
    m.color.set(skin[role] || b.color);
    b.color.copy(m.color);
    if (role === "shell" || role === "secondary") {
      // dark shells need a crisper coat to read their form; light shells stay satin
      const dark = skin.dark;
      b.roughness = dark ? 0.4 : (role === "shell" ? 0.46 : 0.5);
      b.clearcoat = dark ? 0.5 : (role === "shell" ? 0.32 : 0.18);
      b.clearcoatRoughness = dark ? 0.12 : 0.16;
      b.sheen = dark ? 0.5 : 0.3;
      if (m.sheenColor) m.sheenColor.set(dark ? "#8a9099" : "#fff6ea");
    }
    mesh.userData.lookSkin = typeof name === "string" ? name : "custom";
    applyCondition(mesh, mesh.userData.lookCondition || "default");
  }
  return meshes;
}
function applyCondition(mesh, cond) {
  const m = mesh.material, b = m.userData.lookBase; if (!b) return;
  mesh.userData.lookCondition = cond;
  m.color.copy(b.color); m.roughness = b.roughness; m.clearcoat = b.clearcoat; m.clearcoatRoughness = b.clearcoatRoughness; m.sheen = b.sheen;
  if (cond === "worn") {
    // original, well-handled part: duller, slightly greyed and yellowed, coat mostly rubbed off
    const hsl = {}; m.color.getHSL(hsl);
    m.color.setHSL(hsl.h + 0.005, hsl.s * 0.82, hsl.l * 0.93);
    m.roughness = Math.min(1, b.roughness + 0.16); m.clearcoat = b.clearcoat * 0.3; m.clearcoatRoughness = Math.min(1, b.clearcoatRoughness + 0.2); m.sheen = b.sheen * 0.6;
  } else if (cond === "new") {
    // fresh from the box: a touch brighter and glossier
    m.roughness = Math.max(0.05, b.roughness - 0.12); m.clearcoat = Math.min(1, b.clearcoat + 0.45); m.clearcoatRoughness = 0.05;
  }
}
/** condition: 'worn' (original part) | 'new' (replacement) | 'default' */
export function setPartCondition(rig, parts, condition) {
  const meshes = matchParts(rig, parts);
  meshes.forEach(mesh => { ownMaterial(mesh); applyCondition(mesh, condition); });
  return meshes;
}
// warm white fresnel outline + a highlight band that sweeps across the part once
const REPLACED_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uT: { value: 0 }, uFade: { value: 0 }, uColor: { value: new THREE.Color("#FFF1D6").multiplyScalar(1.5) }, uMinY: { value: 0 }, uMaxY: { value: 1 } },
  vertexShader: `varying vec3 vN; varying vec3 vV; varying vec3 vW;
    void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; vec4 mv = viewMatrix * w;
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uT, uFade, uMinY, uMaxY; uniform vec3 uColor; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    void main(){ float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 3.0);
      float y = (vW.y - uMinY) / max(uMaxY - uMinY, 1e-4);
      float band = exp(-pow((y - (uT * 1.6 - 0.3)) * 7.0, 2.0));
      gl_FragColor = vec4(uColor * (f * 0.6 + band * 0.18) * uFade, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4,
});
/**
 * Flash a freshly swapped part: outline + sweeping highlight for `duration` s, and set it to the 'new' condition.
 * Needs rig.update(dt) to be called every frame. Returns { cancel() }.
 */
export function markReplaced(rig, parts, opts = {}) {
  const duration = opts.duration ?? 2.4;
  const meshes = setPartCondition(rig, parts, opts.condition ?? "new");
  const overlays = meshes.map(src => {
    const o = new THREE.Mesh(src.geometry, REPLACED_MAT());
    o.userData[FX_LAYER_FLAG] = true; o.renderOrder = 12; o.raycast = () => {};
    rig.addTracked(o, src);
    const bb = new THREE.Box3().setFromObject(src);
    o.material.uniforms.uMinY.value = bb.min.y; o.material.uniforms.uMaxY.value = bb.max.y;
    return o;
  });
  let t = 0, done = false;
  const cleanup = () => { done = true; overlays.forEach(o => { rig.removeTracked(o); o.material.dispose(); }); };
  rig.effects.push((dt) => {
    if (done) return false;
    t += dt; const p = Math.min(1, t / duration);
    const fade = Math.min(1, p * 6) * (1 - Math.pow(p, 3));
    overlays.forEach(o => { o.material.uniforms.uT.value = p; o.material.uniforms.uFade.value = fade; });
    if (p >= 1) { cleanup(); return false; }
  });
  return { meshes, cancel: cleanup };
}
