// world.js — tabletop play arena for a 27 cm robot (units: metres, Y up, tabletop surface at y = 0)
// All textures procedural. Pairs with look.js (shared uniforms for X-ray / Mind tints).
//
//   const world = buildWorld(scene, renderer, mats, { quality });
//   world.colliders   -> static collider specs for Rapier
//   world.props       -> dynamic graspable props (object + collider spec + mass)
//   world.hazards     -> table-edge drops
//   world.groundHeightAt(x, z), world.isOverDrop(x, z)
//   world.update(dt), world.setWeights({surface, xray, mind})

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { uniforms as LK } from "./look.js";

export const TABLE = { width: 1.6, depth: 1.0, thickness: 0.04, height: 0.75, legInset: 0.07 };

// ------------------------------------------------------------ procedural textures
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeNoise2(seed = 1) {
  const R = rng(seed), P = new Uint8Array(512), G = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; G[i] = R(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  // tileable value noise with integer periods px, py
  return (x, y, px = 256, py = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (a, b) => G[P[(((a % px) + px) % px & 255) + P[(((b % py) + py) % py) & 255]]];
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function canvasFrom(size, w, h, fill) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); const img = g.createImageData(w, h);
  fill(img.data, w, h); g.putImageData(img, 0, 0); return c;
}
function tex(canvas, renderer, srgb, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  return t;
}
// height field -> tangent-space normal map
function normalFromHeight(H, w, h, strength) {
  return (d) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = H[y * w + ((x - 1 + w) % w)], r = H[y * w + ((x + 1) % w)];
      const u = H[((y - 1 + h) % h) * w + x], dn = H[((y + 1) % h) * w + x];
      let nx = (l - r) * strength, ny = (u - dn) * strength, nz = 1;
      const L = Math.hypot(nx, ny, nz); nx /= L; ny /= L; nz /= L;
      const i = (y * w + x) * 4; d[i] = (nx * 0.5 + 0.5) * 255; d[i + 1] = (ny * 0.5 + 0.5) * 255; d[i + 2] = (nz * 0.5 + 0.5) * 255; d[i + 3] = 255;
    }
  };
}

// light oak butcher-block: strips run along X (texture u), 1 texture tile = 1 m
export function makeWoodTextures(renderer, { size = 1024, seed = 7, base = [186, 146, 104] } = {}) {
  const w = size, h = size, N = makeNoise2(seed), R = rng(seed + 3);
  // strip layout across v
  const strips = []; let v = 0;
  while (v < 1) { const sw = 0.055 + R() * 0.035; strips.push({ v0: v, v1: Math.min(1, v + sw), tint: (R() - 0.5) * 0.14, warm: (R() - 0.5) * 0.08, phase: R() * 100, ring: 30 + R() * 30 }); v += sw; }
  strips[strips.length - 1].v1 = 1;
  const H = new Float32Array(w * h), COL = new Float32Array(w * h * 3), RO = new Float32Array(w * h);
  let si = 0;
  for (let y = 0; y < h; y++) {
    const vv = y / h; while (si < strips.length - 1 && vv >= strips[si].v1) si++;
    const S = strips[si]; const local = (vv - S.v0) / (S.v1 - S.v0);
    const seam = Math.min(local, 1 - local) * (S.v1 - S.v0) * size; // px from seam
    for (let x = 0; x < w; x++) {
      const uu = x / w;
      // long grain: noise stretched along u, warped
      const warp = N(uu * 6, vv * 3 + S.phase, 6, 3) * 2.0;
      const g1 = N(uu * 4 + warp, vv * 160 + S.phase, 4, 160);
      const rings = 0.5 + 0.5 * Math.sin((local * S.ring * 0.35 + warp * 5 + N(uu * 2, vv * 20 + S.phase, 2, 20) * 7) * Math.PI);
      const pores = Math.pow(N(uu * 60, vv * 700 + S.phase, 60, 700), 10) * 0.6;
      const fine = N(uu * 40, vv * 400, 40, 400);
      let tone = 1 + S.tint + (g1 - 0.5) * 0.2 + (rings - 0.5) * 0.12 - pores * 0.3 + (fine - 0.5) * 0.02;
      const seamDark = seam < 1.2 ? 0.72 + 0.28 * (seam / 1.2) : 1;
      tone *= seamDark;
      const i = y * w + x;
      COL[i * 3] = base[0] * tone * (1 + S.warm); COL[i * 3 + 1] = base[1] * tone; COL[i * 3 + 2] = base[2] * tone * (1 - S.warm);
      H[i] = rings * 0.08 + g1 * 0.12 - pores * 0.5 - (seam < 1.5 ? (1.5 - seam) * 0.6 : 0) + fine * 0.05;
      RO[i] = 0.5 + pores * 0.25 + (1 - rings) * 0.06 + (seam < 1.5 ? 0.15 : 0);
    }
  }
  const map = canvasFrom(size, w, h, (d) => { for (let i = 0; i < w * h; i++) { d[i * 4] = COL[i * 3]; d[i * 4 + 1] = COL[i * 3 + 1]; d[i * 4 + 2] = COL[i * 3 + 2]; d[i * 4 + 3] = 255; } });
  const rough = canvasFrom(size, w, h, (d) => { for (let i = 0; i < w * h; i++) { const r = Math.min(255, RO[i] * 255); d[i * 4] = r; d[i * 4 + 1] = r; d[i * 4 + 2] = r; d[i * 4 + 3] = 255; } });
  const normal = canvasFrom(size, w, h, normalFromHeight(H, w, h, 1.6));
  return { map: tex(map, renderer, true), roughnessMap: tex(rough, renderer, false), normalMap: tex(normal, renderer, false) };
}

// soft rounded-rectangle / disc shadow blob (alpha), drawn with canvas blur
// soft contact-shadow blob computed analytically (disc or rounded rect SDF) — no texture needed
function blobTexture(kind = "disc") { return kind; }
function blob(kind, w, d, opacity) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uOpacity: { value: opacity }, uRect: { value: kind === "rect" ? 1 : 0 }, uAspect: { value: new THREE.Vector2(1, 1) } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform float uOpacity, uRect; varying vec2 vUv;
      void main(){
        vec2 p = vUv * 2.0 - 1.0;
        float dist;
        if (uRect > 0.5) { vec2 q = abs(p) - vec2(0.58); dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12; }
        else dist = length(p) - 0.7;
        float t = clamp((dist + 0.2) / 0.5, 0.0, 1.0);
        float a = pow(1.0 - t * t * (3.0 - 2.0 * t), 1.3);
        gl_FragColor = vec4(0.0, 0.0, 0.0, a * uOpacity);
      }`,
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
  m.scale.set(w, 1, d); m.renderOrder = 2; m.userData.lookNoContact = true; m.raycast = () => {};
  return m;
}

// ------------------------------------------------------------ world
export function buildWorld(scene, renderer, mats, opts = {}) {
  const quality = opts.quality || "high";
  const hi = quality === "high";
  const root = new THREE.Group(); root.name = "world"; scene.add(root);
  const T = TABLE;
  const meshes = [];
  const add = (m, parent = root, contact = false) => {
    m.castShadow = true; m.receiveShadow = true; if (!contact) m.userData.lookNoContact = true;
    parent.add(m); meshes.push(m); return m;
  };
  const discBlob = blobTexture("disc"), rectBlob = blobTexture("rect");

  // --- tabletop: light oak, satin oiled finish
  const wood = makeWoodTextures(renderer, { size: hi ? 1024 : 512 });
  [wood.map, wood.roughnessMap, wood.normalMap].forEach(t => t.repeat.set(T.width, T.depth));
  const woodMat = new THREE.MeshPhysicalMaterial({
    map: wood.map, roughnessMap: wood.roughnessMap, normalMap: wood.normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    roughness: 1.0, clearcoat: 0.12, clearcoatRoughness: 0.4, sheen: 0.15, sheenRoughness: 0.6, sheenColor: new THREE.Color("#ffe8cc"),
    envMapIntensity: 0.55,
  });
  const top = add(new THREE.Mesh(new RoundedBoxGeometry(T.width, T.thickness, T.depth, 4, 0.006), woodMat));
  top.position.y = -T.thickness / 2; top.name = "world_tabletop";
  // legs + apron (dark walnut-stained, matte) so the drop reads when the camera looks over the edge
  const legMat = new THREE.MeshStandardMaterial({ color: "#3B2A20", roughness: 0.6, envMapIntensity: 0.6 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const leg = add(new THREE.Mesh(new RoundedBoxGeometry(0.045, T.height - T.thickness, 0.045, 2, 0.004), legMat));
    leg.position.set(sx * (T.width / 2 - T.legInset), -T.thickness - (T.height - T.thickness) / 2, sz * (T.depth / 2 - T.legInset));
  }
  const apronMat = legMat;
  const apronX = add(new THREE.Mesh(new THREE.BoxGeometry(T.width - 2 * T.legInset, 0.06, 0.02), apronMat)); apronX.position.set(0, -T.thickness - 0.03, T.depth / 2 - T.legInset);
  const apronX2 = apronX.clone(); apronX2.position.z *= -1; add(apronX2);
  // room floor far below: dark, softly lit pool under the table, fading into the backdrop
  const floorMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color("#1A1918") }, uR: { value: 2.4 } },
    vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform vec3 uColor; uniform float uR; varying vec2 vP;
      void main(){ float r = length(vP) / uR; gl_FragColor = vec4(uColor * (1.0 - 0.6 * r), 1.0 - smoothstep(0.3, 1.0, r));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`, transparent: true, depthWrite: false,
  });
  const floor = new THREE.Mesh(new THREE.CircleGeometry(2.4, 64), floorMat);
  floor.rotation.x = -Math.PI / 2; floor.position.y = -T.height; floor.userData.lookNoContact = true; floor.renderOrder = -500;
  root.add(floor);
  const tableShadow = blob(rectBlob, T.width * 1.5, T.depth * 1.7, 0.6); tableShadow.position.y = -T.height + 0.001; root.add(tableShadow);

  // --- raised platform with ramp (matte sage painted MDF)
  const paint = new THREE.MeshPhysicalMaterial({ color: "#A7B5A0", roughness: 0.72, sheen: 0.3, sheenRoughness: 0.7, sheenColor: new THREE.Color("#eef3ea"), envMapIntensity: 0.9 });
  const PLAT = { x: 0.48, z: 0.12, w: 0.3, d: 0.32, h: 0.04 };
  const plat = add(new THREE.Mesh(new RoundedBoxGeometry(PLAT.w, PLAT.h, PLAT.d, 3, 0.004), paint));
  plat.position.set(PLAT.x, PLAT.h / 2, PLAT.z); plat.name = "world_platform";
  const RAMP = { x0: PLAT.x - PLAT.w / 2 - 0.26, x1: PLAT.x - PLAT.w / 2, z: PLAT.z, d: 0.16, h: PLAT.h };
  const rampShape = new THREE.Shape([new THREE.Vector2(RAMP.x0, 0), new THREE.Vector2(RAMP.x1, 0), new THREE.Vector2(RAMP.x1, RAMP.h)]);
  const rampGeo = new THREE.ExtrudeGeometry(rampShape, { depth: RAMP.d, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2 });
  rampGeo.translate(0, 0, RAMP.z - RAMP.d / 2);
  const ramp = add(new THREE.Mesh(rampGeo, paint)); ramp.name = "world_ramp";
  const platBlob = blob(rectBlob, PLAT.w * 1.6, PLAT.d * 1.6, 0.42); platBlob.position.set(PLAT.x, 0.0006, PLAT.z); root.add(platBlob);

  // --- low step: a closed notebook (terracotta linen cover, cream page block)
  const NB = { x: -0.32, z: 0.2, w: 0.21, d: 0.15, h: 0.016, rot: 0.18 };
  const nb = new THREE.Group(); nb.position.set(NB.x, 0, NB.z); nb.rotation.y = NB.rot; root.add(nb);
  const coverMat = new THREE.MeshPhysicalMaterial({ color: "#B85C3C", roughness: 0.8, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffb59a") });
  const pagesMat = new THREE.MeshStandardMaterial({ color: "#F1EADB", roughness: 0.9 });
  const pages = add(new THREE.Mesh(new THREE.BoxGeometry(NB.w - 0.006, NB.h - 0.004, NB.d - 0.008), pagesMat), nb); pages.position.set(0.002, NB.h / 2, 0);
  for (const y of [0.001, NB.h - 0.001]) { const c = add(new THREE.Mesh(new RoundedBoxGeometry(NB.w, 0.002, NB.d, 2, 0.0009), coverMat), nb); c.position.y = y; }
  const spine = add(new THREE.Mesh(new RoundedBoxGeometry(0.006, NB.h, NB.d, 2, 0.0025), coverMat), nb); spine.position.set(-NB.w / 2 + 0.002, NB.h / 2, 0);
  const band = add(new THREE.Mesh(new THREE.BoxGeometry(0.004, NB.h + 0.0012, NB.d + 0.0012), new THREE.MeshStandardMaterial({ color: "#222", roughness: 0.5 })), nb); band.position.set(NB.w * 0.32, NB.h / 2, 0);
  const nbBlob = blob(rectBlob, NB.w * 1.6, NB.d * 1.6, 0.42); nbBlob.position.y = 0.0006; nb.add(nbBlob);

  // --- Garage workbench: aluminium turntable under a soft spotlight
  const TT = { x: -0.56, z: -0.3, r: 0.15, h: 0.012 };
  const ringTex = (() => {
    const s = 1024; const c = canvasFrom(s, s, s, (d) => {
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2), r = Math.hypot(dx, dy);
        const v = 150 + 25 * Math.sin(r * 700) * Math.sin(r * 53.0) + (r > 0.97 ? -30 : 0) + (Math.abs(r - 0.86) < 0.004 ? -45 : 0);
        const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v)); d[i + 3] = 255;
      }
    });
    return tex(c, renderer, false);
  })();
  const alu = new THREE.MeshPhysicalMaterial({ color: "#8E9297", metalness: 0.55, roughness: 0.8, roughnessMap: ringTex, envMapIntensity: 0.55, clearcoat: 0.2, clearcoatRoughness: 0.5 });
  const turntable = new THREE.Group(); turntable.position.set(TT.x, 0, TT.z); turntable.name = "world_turntable"; root.add(turntable);
  const base = add(new THREE.Mesh(new THREE.CylinderGeometry(TT.r * 0.92, TT.r * 0.95, TT.h * 0.5, 96), new THREE.MeshStandardMaterial({ color: "#2B2C2F", roughness: 0.5 })), turntable);
  base.position.y = TT.h * 0.25;
  const platter = new THREE.Group(); platter.position.y = TT.h * 0.5; turntable.add(platter);
  const disc = add(new THREE.Mesh(new THREE.CylinderGeometry(TT.r, TT.r, TT.h * 0.5, 128), alu), platter); disc.position.y = TT.h * 0.25;
  // planar UVs on the cap for the concentric texture
  { const g = disc.geometry, p = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2 * TT.r) + 0.5, p.getZ(i) / (2 * TT.r) + 0.5); }
  const glowRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#FFE2B8").multiplyScalar(1.6), toneMapped: true });
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(TT.r * 0.995, 0.0012, 8, 160), glowRingMat);
  glowRing.rotation.x = Math.PI / 2; glowRing.position.y = TT.h * 0.5 + 0.0004; glowRing.userData.lookNoContact = true; platter.add(glowRing);
  const ttBlob = blob(discBlob, TT.r * 3.6, TT.r * 3.6, 0.5); ttBlob.position.y = 0.0006; turntable.add(ttBlob);
  const spot = new THREE.SpotLight(0xffd9a8, 6, 1.6, 0.3, 0.55, 2);
  spot.position.set(TT.x + 0.1, 0.85, TT.z + 0.05); spot.target.position.set(TT.x, 0, TT.z);
  spot.castShadow = false; root.add(spot, spot.target);

  // ------------------------------------------------------------ props (graspable)
  const props = [];
  const addProp = (id, obj, spec) => {
    obj.name = "prop_" + id; obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    root.add(obj);
    const shadow = blob(discBlob, spec.footprint, spec.footprint, 0.5); root.add(shadow);
    props.push({ id, object: obj, shadow, ...spec, initialPosition: obj.position.clone(), initialQuaternion: obj.quaternion.clone() });
  };
  // foam cube (2.2 cm), coral, porous foam micro-texture
  const foamMat = new THREE.MeshPhysicalMaterial({ color: "#F0745A", roughness: 0.92, sheen: 0.9, sheenRoughness: 0.4, sheenColor: new THREE.Color("#ffd0c2"), envMapIntensity: 0.7 });
  foamMat.onBeforeCompile = (s) => {
    s.vertexShader = "varying vec3 vObjP;\n" + s.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjP = position;");
    s.fragmentShader = "varying vec3 vObjP;\nfloat fh(vec3 p){ p = fract(p*0.3183+0.1)*17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n" + s.fragmentShader.replace("#include <color_fragment>",
      "#include <color_fragment>\n{ vec3 c = floor(vObjP * 1400.0); float pore = step(0.86, fh(c)); diffuseColor.rgb *= 1.0 - pore * 0.28; }");
  };
  foamMat.customProgramCacheKey = () => "world-foam";
  const cubeS = 0.022;
  const cube = new THREE.Mesh(new RoundedBoxGeometry(cubeS, cubeS, cubeS, 3, 0.003), foamMat);
  cube.position.set(0.12, cubeS / 2, 0.12); cube.rotation.y = 0.5;
  addProp("foam_cube", cube, { mass: 0.004, shape: { type: "cuboid", halfExtents: [cubeS / 2, cubeS / 2, cubeS / 2] }, grip: { width: cubeS, axis: "x" }, footprint: 0.05 });

  // silicone ring / donut: outer Ø 4.4 cm, tube Ø 1.2 cm (beak grips the tube)
  const ringMat = new THREE.MeshPhysicalMaterial({ color: "#6FB7A8", roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: new THREE.Color("#c8fff2"), envMapIntensity: 1.0 });
  const RG = { R: 0.016, r: 0.006 };
  const ring = new THREE.Group();
  const torus = new THREE.Mesh(new THREE.TorusGeometry(RG.R, RG.r, 32, 96), ringMat); torus.rotation.x = Math.PI / 2; ring.add(torus);
  ring.position.set(-0.08, RG.r, 0.28);
  addProp("ring", ring, { mass: 0.008,
    shape: { type: "cylinder", radius: RG.R + RG.r, halfHeight: RG.r, axis: "local-y" },
    shapeExact: { type: "compound", parts: Array.from({ length: 10 }, (_, i) => ({ type: "ball", radius: RG.r, offset: [Math.cos(i / 10 * Math.PI * 2) * RG.R, 0, Math.sin(i / 10 * Math.PI * 2) * RG.R] })) },
    grip: { width: RG.r * 2, axis: "tube" }, footprint: 0.06 });

  // rubber duck toy (3.4 cm tall)
  const toyMat = new THREE.MeshPhysicalMaterial({ color: "#FFD23F", roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.15, sheen: 0.3, envMapIntensity: 1.0 });
  const toyBeak = new THREE.MeshPhysicalMaterial({ color: "#F28C28", roughness: 0.4, clearcoat: 0.5 });
  const toyEye = new THREE.MeshPhysicalMaterial({ color: "#111", roughness: 0.1, clearcoat: 1 });
  const toy = new THREE.Group();
  const tb = new THREE.Mesh(new THREE.SphereGeometry(0.014, 48, 32), toyMat); tb.scale.set(1.25, 0.85, 1.0); tb.position.y = 0.012; toy.add(tb);
  const tail = new THREE.Mesh(new THREE.SphereGeometry(0.006, 24, 16), toyMat); tail.position.set(-0.016, 0.02, 0); tail.scale.set(1, 1.3, 0.8); toy.add(tail);
  const th = new THREE.Mesh(new THREE.SphereGeometry(0.0095, 48, 32), toyMat); th.position.set(0.009, 0.027, 0); toy.add(th);
  const tbk = new THREE.Mesh(new THREE.SphereGeometry(0.005, 24, 16), toyBeak); tbk.scale.set(1.4, 0.55, 1.0); tbk.position.set(0.019, 0.025, 0); toy.add(tbk);
  for (const z of [-0.0055, 0.0055]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.0015, 16, 12), toyEye); e.position.set(0.0155, 0.0305, z); toy.add(e); }
  toy.position.set(0.3, 0, -0.22); toy.rotation.y = 2.4;
  addProp("toy_duck", toy, { mass: 0.006,
    shape: { type: "compound", parts: [{ type: "ball", radius: 0.0125, offset: [0, 0.0125, 0] }, { type: "ball", radius: 0.0095, offset: [0.009, 0.027, 0] }] },
    grip: { width: 0.019, axis: "head (neck at y≈0.022)" }, footprint: 0.05 });

  // pencil (hex, yellow lacquer, 12 cm) — lies along local Y rotated flat
  const PN = { L: 0.12, r: 0.0042 };
  const pencil = new THREE.Group();
  const lacq = new THREE.MeshPhysicalMaterial({ color: "#F2B705", roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.08 });
  const woodTip = new THREE.MeshStandardMaterial({ color: "#E2C08D", roughness: 0.8 });
  const lead = new THREE.MeshStandardMaterial({ color: "#2A2A2C", roughness: 0.35, metalness: 0.4 });
  const ferrule = new THREE.MeshStandardMaterial({ color: "#C9CCD1", metalness: 1, roughness: 0.3 });
  const eraser = new THREE.MeshStandardMaterial({ color: "#E98A8A", roughness: 0.85 });
  const bodyL = PN.L * 0.78;
  const pb = new THREE.Mesh(new THREE.CylinderGeometry(PN.r, PN.r, bodyL, 6, 1), lacq); pb.geometry.computeVertexNormals(); pencil.add(pb);
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, PN.r * 0.95, PN.L * 0.12, 24), woodTip); cone.position.y = bodyL / 2 + PN.L * 0.06; pencil.add(cone);
  const pt = new THREE.Mesh(new THREE.ConeGeometry(0.0012, 0.004, 16), lead); pt.position.y = bodyL / 2 + PN.L * 0.12 + 0.002; pencil.add(pt);
  const fr = new THREE.Mesh(new THREE.CylinderGeometry(PN.r * 1.02, PN.r * 1.02, PN.L * 0.05, 32), ferrule); fr.position.y = -bodyL / 2 - PN.L * 0.025; pencil.add(fr);
  const er = new THREE.Mesh(new THREE.CylinderGeometry(PN.r * 0.95, PN.r * 0.95, PN.L * 0.05, 32), eraser); er.position.y = -bodyL / 2 - PN.L * 0.075; pencil.add(er);
  pencil.rotation.set(0, 0.9, Math.PI / 2); pencil.position.set(-0.22, PN.r * 0.87, -0.06);
  addProp("pencil", pencil, { mass: 0.006, shape: { type: "cylinder", radius: PN.r, halfHeight: 0.062, offset: [0, 0.003, 0], axis: "local-y" }, grip: { width: PN.r * 2, axis: "across" }, footprint: 0.06 });

  // ------------------------------------------------------------ physics specs (metres, world frame)
  const q = (o) => { o.updateMatrixWorld(true); return new THREE.Quaternion().setFromRotationMatrix(o.matrixWorld).toArray(); };
  const colliders = [
    { id: "tabletop", type: "cuboid", halfExtents: [T.width / 2, T.thickness / 2, T.depth / 2], position: [0, -T.thickness / 2, 0], rotation: [0, 0, 0, 1], friction: 0.8 },
    { id: "platform", type: "cuboid", halfExtents: [PLAT.w / 2, PLAT.h / 2, PLAT.d / 2], position: [PLAT.x, PLAT.h / 2, PLAT.z], rotation: [0, 0, 0, 1], friction: 0.9 },
    { id: "ramp", type: "convex", points: [
        [RAMP.x0, 0, RAMP.z - RAMP.d / 2], [RAMP.x1, 0, RAMP.z - RAMP.d / 2], [RAMP.x1, RAMP.h, RAMP.z - RAMP.d / 2],
        [RAMP.x0, 0, RAMP.z + RAMP.d / 2], [RAMP.x1, 0, RAMP.z + RAMP.d / 2], [RAMP.x1, RAMP.h, RAMP.z + RAMP.d / 2]],
      position: [0, 0, 0], rotation: [0, 0, 0, 1], slopeDeg: THREE.MathUtils.radToDeg(Math.atan2(RAMP.h, RAMP.x1 - RAMP.x0)), friction: 0.9 },
    { id: "notebook", type: "cuboid", halfExtents: [NB.w / 2, NB.h / 2, NB.d / 2], position: [NB.x, NB.h / 2, NB.z], rotation: q(nb), friction: 0.7 },
    { id: "turntable", type: "cylinder", radius: TT.r, halfHeight: TT.h / 2, position: [TT.x, TT.h / 2, TT.z], rotation: [0, 0, 0, 1], friction: 0.9, kinematic: true, note: "rotate world.turntable.platter.rotation.y; mirror as a kinematic body if spinning" },
    { id: "room_floor", type: "cuboid", halfExtents: [3, 0.05, 3], position: [0, -T.height - 0.05, 0], rotation: [0, 0, 0, 1], friction: 0.8 },
  ];
  // hazards: every table edge is a drop of T.height
  const hx = T.width / 2, hz = T.depth / 2;
  const hazards = [
    { id: "edge_front", type: "drop", a: [-hx, hz], b: [hx, hz], outward: [0, 1], height: T.height },
    { id: "edge_back", type: "drop", a: [hx, -hz], b: [-hx, -hz], outward: [0, -1], height: T.height },
    { id: "edge_right", type: "drop", a: [hx, hz], b: [hx, -hz], outward: [1, 0], height: T.height },
    { id: "edge_left", type: "drop", a: [-hx, -hz], b: [-hx, hz], outward: [-1, 0], height: T.height },
  ];
  const safePolygon = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];   // xz, the tabletop
  const isOverDrop = (x, z) => Math.abs(x) > hx || Math.abs(z) > hz;
  const distanceToEdge = (x, z) => Math.min(hx - Math.abs(x), hz - Math.abs(z));
  const nbInv = new THREE.Matrix4().copy(nb.matrixWorld).invert();
  function groundHeightAt(x, z) {
    if (isOverDrop(x, z)) return -T.height;
    let y = 0;
    if (Math.abs(x - PLAT.x) <= PLAT.w / 2 && Math.abs(z - PLAT.z) <= PLAT.d / 2) y = Math.max(y, PLAT.h);
    if (x >= RAMP.x0 && x <= RAMP.x1 && Math.abs(z - RAMP.z) <= RAMP.d / 2) y = Math.max(y, RAMP.h * (x - RAMP.x0) / (RAMP.x1 - RAMP.x0));
    const l = new THREE.Vector3(x, 0, z).applyMatrix4(nbInv);
    if (Math.abs(l.x) <= NB.w / 2 && Math.abs(l.z) <= NB.d / 2) y = Math.max(y, NB.h);
    if (Math.hypot(x - TT.x, z - TT.z) <= TT.r) y = Math.max(y, TT.h);
    return y;
  }

  // ------------------------------------------------------------ per-frame + mode tint
  const baseCols = new Map();
  [woodMat, paint, coverMat, pagesMat, legMat].forEach(m => baseCols.set(m, (m.color || new THREE.Color(1, 1, 1)).clone()));
  const ringBase = glowRingMat.color.clone();
  const cyan = new THREE.Color("#64D2FF").multiplyScalar(2), violet = new THREE.Color("#BF5AF2").multiplyScalar(2);
  const spotBase = spot.intensity;
  const turntableState = { angularVelocity: 0 };
  let t = 0, ringFx = 0; const ringTint = new THREE.Color();
  return {
    root, meshes, props, colliders, hazards, safePolygon, table: { ...T },
    anchors: {
      start: { position: [0, 0, -0.12], yaw: 0 },
      workbench: { position: [TT.x, TT.h, TT.z], radius: TT.r },
      platformTop: { position: [PLAT.x, PLAT.h, PLAT.z] },
      rampFoot: { position: [RAMP.x0 - 0.04, 0, RAMP.z] },
    },
    turntable: { object: turntable, platter, spot, state: turntableState, topY: TT.h },
    groundHeightAt, isOverDrop, distanceToEdge,
    update(dt) {
      t += dt;
      platter.rotation.y += turntableState.angularVelocity * dt;
      // prop blob shadows follow props, fading with height above the surface
      for (const p of props) {
        const o = p.object, gy = groundHeightAt(o.position.x, o.position.z);
        const hgt = Math.max(0, o.position.y - gy - p.footprint * 0.2);
        p.shadow.position.set(o.position.x, gy + 0.0007, o.position.z);
        const k = Math.max(0, 1 - hgt / 0.12);
        p.shadow.material.uniforms.uOpacity.value = 0.5 * k; p.shadow.scale.set(p.footprint * (1 + hgt * 6), 1, p.footprint * (1 + hgt * 6));
        p.shadow.visible = gy > -T.height + 0.01 && k > 0.01;
      }
      glowRingMat.color.copy(ringBase).lerp(ringTint, ringFx).multiplyScalar(0.85 + 0.15 * Math.sin(t * 1.6));
    },
    setWeights(w) {
      const fx = Math.min(1, (w.xray || 0) + (w.mind || 0));
      for (const [m, c] of baseCols) m.color.copy(c).multiplyScalar(1 - 0.45 * fx);
      ringTint.copy(cyan).lerp(violet, (w.mind || 0) / ((w.xray || 0) + (w.mind || 0) + 1e-5)); ringFx = fx;
      spot.intensity = spotBase * (1 - 0.4 * fx);
    },
  };
}
