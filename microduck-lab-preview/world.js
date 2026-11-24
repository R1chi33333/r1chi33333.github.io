// world.js — Microduck Lab living room (units: metres, Y up).
// The oak tabletop surface is y = 0 (unchanged from v1); the room floor is y = FLOOR_Y = -0.75.
// All textures are procedural. Static furniture is merged per material, repeated parts are instanced.
//
//   const world = buildWorld(scene, renderer, mats, { quality });
//   world.colliders, world.props, world.hazards, world.anchors, world.table, world.room
//   world.groundHeightAt(x, z, y?)   highest walkable surface at or just below y (+4 cm step); y omitted = highest surface
//   world.isOverDrop(x, z, y?)       true if standing at height y would be over a drop (y omitted = off the tabletop)
//   world.distanceToEdge(x, z)       distance to the nearest tabletop edge (negative = off the table)
//   world.clampCamera(pos)           keeps an orbit camera inside the room and out of furniture
//   world.addProp(p) / removeProp(p) registers a spawned prop for blob shadows
//   world.update(dt), world.setWeights({surface, xray, mind})

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  makeFoamCube, makeRing, makeRubberDuck, makePencil, makeSockBall, makeKey, makeBottleCap,
  makeCrayon, makeBreadCrust, makeToyBrick, placeProp,
  makeChessPawn, makeChessKnight, makeWickerBall, makeToyCar, makeCookie, makeToast, makeCroissant,
} from "./props.js";
import { assets } from "./assets.js";
import { toonify, toonifyTree, INK } from "./toon.js";

export const TABLE = { width: 1.6, depth: 1.0, thickness: 0.04, height: 0.75, legInset: 0.07 };
export const FLOOR_Y = -TABLE.height;
export const ROOM = { x0: -3, x1: 3, z0: -2.5, z1: 2.5, wallHeight: 2.5, floorY: FLOOR_Y };
const F = FLOOR_Y;

// ------------------------------------------------------------ procedural textures
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function makeNoise2(seed = 1) {
  const R = rng(seed), P = new Uint8Array(512), G = new Float32Array(256);
  for (let i = 0; i < 256; i++) { P[i] = i; G[i] = R(); }
  for (let i = 255; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [P[i], P[j]] = [P[j], P[i]]; }
  for (let i = 0; i < 256; i++) P[i + 256] = P[i];
  return (x, y, px = 256, py = 256) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const h = (a, b) => G[P[(((a % px) + px) % px & 255) + P[(((b % py) + py) % py) & 255]]];
    const a = h(xi, yi), b = h(xi + 1, yi), c = h(xi, yi + 1), d = h(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
function canvasFrom(w, h, fill) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d"); const img = g.createImageData(w, h);
  fill(img.data, w, h); g.putImageData(img, 0, 0); return c;
}
function tex(canvas, renderer, srgb, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
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
// wood: strips run along u; 1 texture tile = 1 m. Optional end joints for floor planks.
export function makeWoodTextures(renderer, { size = 1024, seed = 7, base = [186, 146, 104], stripMin = 0.055, stripMax = 0.09, joints = false, ringAmp = 1, warpAmp = 1 } = {}) {
  const w = size, h = size, N = makeNoise2(seed), R = rng(seed + 3);
  const strips = []; let v = 0;
  while (v < 1) {
    const sw = stripMin + R() * (stripMax - stripMin);
    const js = joints ? [R(), R() < 0.6 ? R() : -1] : [];
    strips.push({ v0: v, v1: Math.min(1, v + sw), tint: (R() - 0.5) * 0.16, warm: (R() - 0.5) * 0.08, phase: R() * 100, ring: 30 + R() * 30, joints: js });
    v += sw;
  }
  strips[strips.length - 1].v1 = 1;
  const H = new Float32Array(w * h), COL = new Float32Array(w * h * 3), RO = new Float32Array(w * h);
  let si = 0;
  for (let y = 0; y < h; y++) {
    const vv = y / h; while (si < strips.length - 1 && vv >= strips[si].v1) si++;
    const S = strips[si]; const local = (vv - S.v0) / (S.v1 - S.v0);
    const seam = Math.min(local, 1 - local) * (S.v1 - S.v0) * size;
    for (let x = 0; x < w; x++) {
      const uu = x / w;
      const warp = N(uu * 6, vv * 3 + S.phase, 6, 3) * 2.0;
      const g1 = N(uu * 4 + warp, vv * 160 + S.phase, 4, 160);
      const rings = 0.5 + 0.5 * Math.sin((local * S.ring * 0.35 + warp * 5 * warpAmp + N(uu * 2, vv * 20 + S.phase, 2, 20) * 7 * warpAmp) * Math.PI);
      const pores = Math.pow(N(uu * 60, vv * 700 + S.phase, 60, 700), 10) * 0.6;
      const fine = N(uu * 40, vv * 400, 40, 400);
      let jd = 99; for (const j of S.joints) if (j >= 0) jd = Math.min(jd, Math.abs(uu - j) * size);
      let tone = 1 + S.tint + (g1 - 0.5) * 0.2 + (rings - 0.5) * 0.12 * ringAmp - pores * 0.3 + (fine - 0.5) * 0.02;
      tone *= seam < 1.2 ? 0.72 + 0.28 * (seam / 1.2) : 1;
      tone *= jd < 1.2 ? 0.72 + 0.28 * (jd / 1.2) : 1;
      const i = y * w + x;
      COL[i * 3] = base[0] * tone * (1 + S.warm); COL[i * 3 + 1] = base[1] * tone; COL[i * 3 + 2] = base[2] * tone * (1 - S.warm);
      H[i] = rings * 0.08 + g1 * 0.12 - pores * 0.5 - (seam < 1.5 ? (1.5 - seam) * 0.6 : 0) - (jd < 1.5 ? (1.5 - jd) * 0.6 : 0) + fine * 0.05;
      RO[i] = 0.5 + pores * 0.25 + (1 - rings) * 0.06 + (seam < 1.5 || jd < 1.5 ? 0.15 : 0);
    }
  }
  const map = canvasFrom(w, h, (d) => { for (let i = 0; i < w * h; i++) { d[i * 4] = COL[i * 3]; d[i * 4 + 1] = COL[i * 3 + 1]; d[i * 4 + 2] = COL[i * 3 + 2]; d[i * 4 + 3] = 255; } });
  const rough = canvasFrom(w, h, (d) => { for (let i = 0; i < w * h; i++) { const r = Math.min(255, RO[i] * 255); d[i * 4] = r; d[i * 4 + 1] = r; d[i * 4 + 2] = r; d[i * 4 + 3] = 255; } });
  const normal = canvasFrom(w, h, normalFromHeight(H, w, h, 1.6));
  return { map: tex(map, renderer, true), roughnessMap: tex(rough, renderer, false), normalMap: tex(normal, renderer, false) };
}
// procedural tiling normal + roughness maps from a height function h(u, v) in [0,1]^2
function proceduralPBR(renderer, size, heightFn, { strength = 2, roughBase = 0.8, roughAmp = 0.1, repeat = [1, 1] } = {}) {
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) H[y * size + x] = heightFn(x / size, y / size);
  const normal = canvasFrom(size, size, normalFromHeight(H, size, size, strength));
  const rough = canvasFrom(size, size, (d) => { for (let i = 0; i < size * size; i++) { const r = Math.min(255, Math.max(0, (roughBase + (H[i] - 0.5) * roughAmp) * 255)); d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = r; d[i * 4 + 3] = 255; } });
  return { normalMap: tex(normal, renderer, false, repeat), roughnessMap: tex(rough, renderer, false, repeat) };
}
// comic planks: flat colour boards, inked seams and end joints, a few drawn grain strokes and knots
export function toonPlanks(renderer, { size = 1024, seed = 3, rows = 8, cols = 2, colours = ["#E9A85A", "#E19B4C", "#EDB46B", "#DE9445"], seam = "#7A4320", grain = "rgba(122,67,32,0.35)", seamPx = 3 } = {}) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d"); const R = rng(seed);
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    const y = r * rh; let x = -R() * size / cols;
    while (x < size) {
      const len = size / cols * (0.7 + R() * 0.6);
      g.fillStyle = colours[Math.floor(R() * colours.length)]; g.fillRect(x, y, len, rh);
      // grain strokes
      g.strokeStyle = grain; g.lineWidth = Math.max(1, size / 700); g.lineCap = "round";
      for (let k = 0; k < 3; k++) {
        const gy = y + rh * (0.2 + 0.6 * R()), gx = x + len * R() * 0.3, gl = len * (0.3 + 0.5 * R());
        g.beginPath(); g.moveTo(gx, gy); g.bezierCurveTo(gx + gl * 0.33, gy - rh * 0.08, gx + gl * 0.66, gy + rh * 0.08, gx + gl, gy); g.stroke();
      }
      if (R() < 0.25) { g.beginPath(); g.ellipse(x + len * (0.2 + 0.6 * R()), y + rh * 0.5, rh * 0.16, rh * 0.09, 0, 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = seam; g.fillRect(x - seamPx / 2, y, seamPx, rh);        // end joint
      x += len;
    }
    g.fillStyle = seam; g.fillRect(0, y - seamPx / 2, size, seamPx);        // long seam
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy(); return t;
}
// painted window view: flat sky bands, a sun, inked clouds and a two-layer skyline
function paintedView(w = 1024, h = 915) {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d"); const R = rng(8);
  const ink = "#1B1430", lw = Math.max(3, w / 220);
  const bands = ["#7FD3F7", "#9FDFFA", "#C4ECFB", "#FFE9B8"];
  bands.forEach((col, i) => { g.fillStyle = col; g.fillRect(0, i * h * 0.17, w, h * 0.17 + 1); });
  g.fillStyle = "#FFE9B8"; g.fillRect(0, h * 0.51, w, h);
  // sun with halftone ring
  g.fillStyle = "#FFD23F"; g.strokeStyle = ink; g.lineWidth = lw; g.beginPath(); g.arc(w * 0.78, h * 0.2, w * 0.075, 0, 7); g.fill(); g.stroke();
  for (let a = 0; a < 40; a++) { const ang = a / 40 * Math.PI * 2, rr = w * 0.1; g.fillStyle = "rgba(255,180,60,0.6)"; g.beginPath(); g.arc(w * 0.78 + Math.cos(ang) * rr, h * 0.2 + Math.sin(ang) * rr, w * 0.006, 0, 7); g.fill(); }
  // clouds
  const cloud = (cx, cy, s) => { g.fillStyle = "#FFFFFF"; g.beginPath(); for (const [dx, dy, r] of [[-1, 0, .55], [-.35, -.35, .7], [.35, -.25, .62], [.95, .05, .48], [0, .15, .6]]) g.arc(cx + dx * s, cy + dy * s, r * s, 0, 7); g.fill(); g.stroke(); };
  g.lineWidth = lw * 0.8; cloud(w * 0.2, h * 0.18, w * 0.07); cloud(w * 0.52, h * 0.3, w * 0.05);
  // skyline: far layer lilac, near layer teal, lit windows
  const layer = (base, hMin, hMax, col, win) => {
    let x = -10; g.lineWidth = lw * 0.8; g.strokeStyle = ink;
    while (x < w) { const bw = w * (0.06 + R() * 0.08), bh = h * (hMin + R() * (hMax - hMin));
      g.fillStyle = col; g.fillRect(x, h * base - bh, bw, bh + h); g.strokeRect(x, h * base - bh, bw, bh + h);
      if (win) for (let yy = h * base - bh + bw * 0.18; yy < h * base - bw * 0.2; yy += bw * 0.3) for (let xx = x + bw * 0.18; xx < x + bw - bw * 0.25; xx += bw * 0.28) if (R() < 0.55) { g.fillStyle = R() < 0.6 ? "#FFE27A" : "#2A2550"; g.fillRect(xx, yy, bw * 0.13, bw * 0.16); }
      x += bw + w * 0.004; }
  };
  layer(0.72, 0.18, 0.4, "#B9A2E8", false);
  layer(0.86, 0.12, 0.32, "#2F8F9D", true);
  // tree tops along the bottom
  g.fillStyle = "#3BB273"; g.strokeStyle = ink; g.lineWidth = lw;
  for (let x = 0; x < w + 60; x += w * 0.09) { g.beginPath(); g.arc(x, h * 0.93, w * (0.06 + R() * 0.03), 0, 7); g.fill(); g.stroke(); }
  g.fillStyle = "#3BB273"; g.fillRect(0, h * 0.95, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function drawCanvas(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); return c; }
function speckle(g, w, h, n, alpha, light, R) { for (let i = 0; i < n; i++) { g.fillStyle = light ? `rgba(255,255,255,${alpha * R()})` : `rgba(0,0,0,${alpha * R()})`; g.fillRect(R() * w, R() * h, 1 + R() * 1.5, 1 + R() * 1.5); } }

// ------------------------------------------------------------ static batching
// Collects (geometry, material) parts in world space and merges them per material into one mesh each.
class Batch {
  constructor() { this.groups = new Map(); }
  add(geo, mat, matrix) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!["position", "normal", "uv"].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    if (!g.attributes.normal) g.computeVertexNormals();
    if (matrix) g.applyMatrix4(matrix);
    if (!this.groups.has(mat)) this.groups.set(mat, []);
    this.groups.get(mat).push(g);
  }
  box(w, h, d, mat, x, y, z, ry = 0, r = 0) {
    const geo = r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new THREE.BoxGeometry(w, h, d);
    this.add(geo, mat, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1)));
  }
  build(parent, { cast = true, receive = true, name = "batch" } = {}) {
    const out = [];
    for (const [mat, list] of this.groups) {
      const m = new THREE.Mesh(mergeGeometries(list), mat); m.name = name + "_" + (mat.name || out.length);
      m.castShadow = cast; m.receiveShadow = receive; m.userData.lookNoContact = true;
      parent.add(m); out.push(m);
    }
    return out;
  }
}
const M4 = (x, y, z, rx = 0, ry = 0, rz = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(s, s, s));

// ------------------------------------------------------------ soft blob shadows (one instanced draw call)
class BlobField {
  constructor(parent, max = 96) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: `attribute float aOpacity; attribute float aRect; varying vec2 vUv; varying float vO; varying float vR;
        void main(){ vUv = uv; vO = aOpacity; vR = aRect; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying vec2 vUv; varying float vO; varying float vR;
        void main(){ vec2 p = vUv * 2.0 - 1.0; float dist;
          if (vR > 0.5) { vec2 q = abs(p) - vec2(0.58); dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.12; }
          else dist = length(p) - 0.7;
          float t = clamp((dist + 0.2) / 0.5, 0.0, 1.0);
          gl_FragColor = vec4(0.16, 0.09, 0.3, pow(1.0 - t * t * (3.0 - 2.0 * t), 1.3) * vO * 0.8); }`,
      transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.op = new THREE.InstancedBufferAttribute(new Float32Array(max), 1); this.op.setUsage(THREE.DynamicDrawUsage);
    this.rect = new THREE.InstancedBufferAttribute(new Float32Array(max), 1);
    geo.setAttribute("aOpacity", this.op); geo.setAttribute("aRect", this.rect);
    this.mesh = new THREE.InstancedMesh(geo, mat, max); this.mesh.count = 0; this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2; this.mesh.userData.lookNoContact = true; this.mesh.raycast = () => {};
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    parent.add(this.mesh); this.m = new THREE.Matrix4(); this.free = [];
  }
  add(x, y, z, w, d, opacity, rect = false, ry = 0) {
    const i = this.free.length ? this.free.pop() : this.mesh.count++;
    this.set(i, x, y, z, w, d, opacity, ry); this.rect.setX(i, rect ? 1 : 0); this.rect.needsUpdate = true; return i;
  }
  set(i, x, y, z, w, d, opacity, ry = 0) {
    this.m.compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(w, 1, d));
    this.mesh.setMatrixAt(i, this.m); this.op.setX(i, opacity);
    this.mesh.instanceMatrix.needsUpdate = true; this.op.needsUpdate = true;
  }
  remove(i) { this.op.setX(i, 0); this.op.needsUpdate = true; this.free.push(i); }
}

// ------------------------------------------------------------ world
export function buildWorld(scene, renderer, mats, opts = {}) {
  const quality = opts.quality || "high";
  const hi = quality === "high";
  const root = new THREE.Group(); root.name = "world"; scene.add(root);
  const T = TABLE;
  const meshes = [];          // pickable / walkable meshes (for floor picking)
  const colliders = [];
  const surfaces = [];        // walkable surfaces for groundHeightAt
  const camBlockers = [];     // AABBs the camera must stay out of
  const tintMats = [];        // materials dimmed in Sensors / Garage modes
  const batch = new Batch();
  const shell = new Batch();   // walls, trim, window frame: receive light but cast no shadows (the key light sits outside the room)
  const blobs = new BlobField(root);
  const add = (m, parent = root, contact = false) => {
    m.castShadow = true; m.receiveShadow = true; if (!contact) m.userData.lookNoContact = true;
    parent.add(m); meshes.push(m); return m;
  };
  const Q0 = [0, 0, 0, 1];
  const qY = (a) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a).toArray();
  const cuboid = (id, cx, cy, cz, hx, hy, hz, rot = Q0, friction = 0.8) => colliders.push({ id, type: "cuboid", halfExtents: [hx, hy, hz], position: [cx, cy, cz], rotation: rot, friction });
  const rect = (x0, x1, z0, z1, h, id) => surfaces.push({ id, h: () => h, test: (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1 });
  const disc = (cx, cz, r, h, id) => surfaces.push({ id, h: () => h, test: (x, z) => (x - cx) ** 2 + (z - cz) ** 2 <= r * r });
  const blocker = (x0, y0, z0, x1, y1, z1) => camBlockers.push(new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1)));
  const tint = (m) => { tintMats.push([m, m.color.clone()]); return m; };

  // ================================================================ ROOM SHELL
  // floor: comic honey planks (12.5 cm boards), drawn seams, no photo texture
  const RW = ROOM.x1 - ROOM.x0, RD = ROOM.z1 - ROOM.z0;
  const plankTex = toonPlanks(renderer, { size: hi ? 1024 : 512, seed: 21, rows: 8, cols: 2 });
  plankTex.repeat.set(RW / 2.0, RD / 1.0);
  const floorMat = tint(new THREE.MeshStandardMaterial({ name: "floor", map: plankTex, roughness: 0.8 }));
  const floor = add(new THREE.Mesh(new THREE.PlaneGeometry(RW, RD).rotateX(-Math.PI / 2), floorMat));
  floor.position.set((ROOM.x0 + ROOM.x1) / 2, F, (ROOM.z0 + ROOM.z1) / 2); floor.castShadow = false; floor.name = "world_floor";
  cuboid("room_floor", 0, F - 0.05, 0, 3.2, 0.05, 2.7);

  // walls: warm plaster, white baseboard, window on the back wall
  const wallMat = tint(new THREE.MeshStandardMaterial({ name: "wall", color: "#FFF0D2", roughness: 1 }));
  const trimMat = tint(new THREE.MeshStandardMaterial({ name: "trim", color: "#FFFFFF", roughness: 0.8 }));
  wallMat.userData.toonLift = 0.7; trimMat.userData.toonLift = 0.6;      // walls read as clean flat colour; only cast shadows band them
  const WH = ROOM.wallHeight, WT = 0.12;
  const WIN = { x: 0.9, w: 1.4, y0: F + 0.85, h: 1.25 };
  // back wall with window opening (4 pieces around the hole)
  const bz = ROOM.z0 - WT / 2;
  shell.box(WIN.x - WIN.w / 2 - ROOM.x0, WH, WT, wallMat, (ROOM.x0 + WIN.x - WIN.w / 2) / 2, F + WH / 2, bz);
  shell.box(ROOM.x1 - (WIN.x + WIN.w / 2), WH, WT, wallMat, (ROOM.x1 + WIN.x + WIN.w / 2) / 2, F + WH / 2, bz);
  shell.box(WIN.w, WIN.y0 - F, WT, wallMat, WIN.x, (F + WIN.y0) / 2, bz);
  shell.box(WIN.w, F + WH - (WIN.y0 + WIN.h), WT, wallMat, WIN.x, (WIN.y0 + WIN.h + F + WH) / 2, bz);
  shell.box(WT, WH, RD + 2 * WT, wallMat, ROOM.x0 - WT / 2, F + WH / 2, 0);
  shell.box(WT, WH, RD + 2 * WT, wallMat, ROOM.x1 + WT / 2, F + WH / 2, 0);
  shell.box(RW, WH, WT, wallMat, 0, F + WH / 2, ROOM.z1 + WT / 2);
  cuboid("wall_back", 0, F + WH / 2, bz, RW / 2 + WT, WH / 2, WT / 2);
  cuboid("wall_front", 0, F + WH / 2, ROOM.z1 + WT / 2, RW / 2 + WT, WH / 2, WT / 2);
  cuboid("wall_left", ROOM.x0 - WT / 2, F + WH / 2, 0, WT / 2, WH / 2, RD / 2 + WT);
  cuboid("wall_right", ROOM.x1 + WT / 2, F + WH / 2, 0, WT / 2, WH / 2, RD / 2 + WT);
  // baseboards (8 cm) — also the duck-height bump along the walls
  const BB = 0.08, BT = 0.015;
  shell.box(RW, BB, BT, trimMat, 0, F + BB / 2, ROOM.z0 + BT / 2);
  shell.box(RW, BB, BT, trimMat, 0, F + BB / 2, ROOM.z1 - BT / 2);
  shell.box(BT, BB, RD, trimMat, ROOM.x0 + BT / 2, F + BB / 2, 0);
  shell.box(BT, BB, RD, trimMat, ROOM.x1 - BT / 2, F + BB / 2, 0);
  // window frame, mullions and sill
  const FW = 0.06;
  shell.box(WIN.w + 0.12, FW, 0.16, trimMat, WIN.x, WIN.y0 - FW / 2 + 0.01, ROOM.z0 + 0.02);                   // sill
  shell.box(WIN.w, FW, 0.08, trimMat, WIN.x, WIN.y0 + WIN.h - FW / 2, ROOM.z0 - 0.03);
  shell.box(FW, WIN.h, 0.08, trimMat, WIN.x - WIN.w / 2 + FW / 2, WIN.y0 + WIN.h / 2, ROOM.z0 - 0.03);
  shell.box(FW, WIN.h, 0.08, trimMat, WIN.x + WIN.w / 2 - FW / 2, WIN.y0 + WIN.h / 2, ROOM.z0 - 0.03);
  shell.box(0.035, WIN.h, 0.05, trimMat, WIN.x, WIN.y0 + WIN.h / 2, ROOM.z0 - 0.04);
  shell.box(WIN.w, 0.035, 0.05, trimMat, WIN.x, WIN.y0 + WIN.h * 0.55, ROOM.z0 - 0.04);
  // the view outside: soft daylight sky + a hint of garden (emissive, gentle bloom on the brightest part)
  const skyMat = new THREE.ShaderMaterial({
    uniforms: { uDim: { value: 1 }, uView: { value: paintedView(hi ? 1024 : 512, hi ? 915 : 458) } },
    vertexShader: "varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }",
    fragmentShader: `uniform float uDim; uniform sampler2D uView; varying vec2 vUv; varying vec3 vW;
      void main(){
        // a little parallax so the painted view sits "outside"
        vec3 d = normalize(vW - cameraPosition);
        vec2 uv = clamp(vUv * 0.86 + 0.07 + d.xy / max(0.2, -d.z) * vec2(0.035, 0.025), 0.0, 1.0);
        gl_FragColor = vec4(texture2D(uView, uv).rgb * uDim, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(WIN.w, WIN.h), skyMat);
  sky.position.set(WIN.x, WIN.y0 + WIN.h / 2, ROOM.z0 - 0.09); sky.userData.lookNoContact = true; root.add(sky);
  // sheer curtains (rippled planes)
  const curtainGeo = (() => { const g = new THREE.PlaneGeometry(0.42, WIN.h + 0.45, 24, 1); const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) p.setZ(i, Math.sin(p.getX(i) * 48) * 0.018); g.computeVertexNormals(); return g; })();
  const curtainMat = tint(new THREE.MeshPhysicalMaterial({ name: "curtain", color: "#F4EEE3", roughness: 0.9, sheen: 1, sheenRoughness: 0.4, sheenColor: new THREE.Color("#ffffff"),
    transparent: true, opacity: 0.82, side: THREE.DoubleSide, envMapIntensity: 0.6 }));
  for (const sx of [-1, 1]) {
    const c = new THREE.Mesh(curtainGeo, curtainMat); c.position.set(WIN.x + sx * (WIN.w / 2 + 0.1), WIN.y0 + WIN.h / 2 + 0.1, ROOM.z0 + 0.07);
    c.userData.lookNoContact = true; root.add(c);
  }
  // sunlight through the window: a directional fill (no shadow) and a soft light patch on the floor
  const sun = new THREE.DirectionalLight(0xfff0dc, 1.0);
  sun.position.set(WIN.x + 0.6, F + 2.3, ROOM.z0 - 1.2); sun.target.position.set(WIN.x - 0.3, F, ROOM.z0 + 1.6); root.add(sun, sun.target);
  const bounce = new THREE.HemisphereLight(0xfff1df, 0xa88462, 0.35); root.add(bounce);   // warm floor bounce
  const patchMat = new THREE.ShaderMaterial({
    uniforms: { uO: { value: 0.22 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform float uO; varying vec2 vUv;
      void main(){ vec2 p = abs(vUv - 0.5) * 2.0; float a = (1.0 - smoothstep(0.75, 1.0, p.x)) * (1.0 - smoothstep(0.7, 1.0, p.y));
        float bars = smoothstep(0.02, 0.05, abs(vUv.x - 0.5)) * smoothstep(0.015, 0.04, abs(vUv.y - 0.45));
        gl_FragColor = vec4(vec3(1.0, 0.86, 0.66) * a * bars * uO, 1.0); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const patch = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), patchMat);
  patch.geometry.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, 0, 0, 0.35, 0));
  patch.scale.set(WIN.w * 1.05, 1, 1.3); patch.position.set(WIN.x - 0.15, F + 0.002, ROOM.z0 + 1.0); patch.renderOrder = 3; patch.userData.lookNoContact = true; root.add(patch);

  // ================================================================ OAK TABLE (unchanged footprint; tabletop y = 0)
  const tableTex = toonPlanks(renderer, { size: hi ? 1024 : 512, seed: 7, rows: 14, cols: 1, colours: ["#F3C47E", "#EFBC72", "#F6CC8A"], seam: "#B7743A", grain: "rgba(183,116,58,0.4)", seamPx: 2 });
  tableTex.repeat.set(T.width, T.depth);
  const woodMat = tint(new THREE.MeshStandardMaterial({ name: "oak", map: tableTex, roughness: 0.6 }));
  const top = add(new THREE.Mesh(new RoundedBoxGeometry(T.width, T.thickness, T.depth, 4, 0.006), woodMat));
  top.position.y = -T.thickness / 2; top.name = "world_tabletop";
  const legMat = tint(new THREE.MeshStandardMaterial({ name: "walnut", color: "#6B3F2A", roughness: 0.6 }));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = sx * (T.width / 2 - T.legInset), lz = sz * (T.depth / 2 - T.legInset), lh = T.height - T.thickness;
    batch.box(0.045, lh, 0.045, legMat, lx, -T.thickness - lh / 2, lz, 0, 0.004);
    cuboid("table_leg", lx, -T.thickness - lh / 2, lz, 0.0225, lh / 2, 0.0225);
    blobs.add(lx, F + 0.001, lz, 0.14, 0.14, 0.45);
  }
  batch.box(T.width - 2 * T.legInset, 0.06, 0.02, legMat, 0, -T.thickness - 0.03, T.depth / 2 - T.legInset);
  batch.box(T.width - 2 * T.legInset, 0.06, 0.02, legMat, 0, -T.thickness - 0.03, -(T.depth / 2 - T.legInset));
  cuboid("tabletop", 0, -T.thickness / 2, 0, T.width / 2, T.thickness / 2, T.depth / 2);
  rect(-T.width / 2, T.width / 2, -T.depth / 2, T.depth / 2, 0, "tabletop");
  blobs.add(0, F + 0.001, 0, T.width * 1.3, T.depth * 1.4, 0.35, true);
  blocker(-T.width / 2 - 0.02, -T.thickness - 0.07, -T.depth / 2 - 0.02, T.width / 2 + 0.02, 0.005, T.depth / 2 + 0.02);

  // tabletop platform + ramp (sage MDF), notebook step — as in v1
  const paint = tint(new THREE.MeshPhysicalMaterial({ name: "sage", color: "#8FD3B6", roughness: 0.72, sheen: 0.3, sheenRoughness: 0.7, sheenColor: new THREE.Color("#eef3ea"), envMapIntensity: 0.9 }));
  const PLAT = { x: 0.48, z: 0.12, w: 0.3, d: 0.32, h: 0.04 };
  batch.box(PLAT.w, PLAT.h, PLAT.d, paint, PLAT.x, PLAT.h / 2, PLAT.z, 0, 0.004);
  const RAMP = { x0: PLAT.x - PLAT.w / 2 - 0.26, x1: PLAT.x - PLAT.w / 2, z: PLAT.z, d: 0.16, h: PLAT.h };
  const rampGeo = new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(RAMP.x0, 0), new THREE.Vector2(RAMP.x1, 0), new THREE.Vector2(RAMP.x1, RAMP.h)]),
    { depth: RAMP.d, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2 });
  rampGeo.translate(0, 0, RAMP.z - RAMP.d / 2); batch.add(rampGeo, paint);
  colliders.push({ id: "platform", type: "cuboid", halfExtents: [PLAT.w / 2, PLAT.h / 2, PLAT.d / 2], position: [PLAT.x, PLAT.h / 2, PLAT.z], rotation: Q0, friction: 0.9 });
  colliders.push({ id: "ramp", type: "convex", points: [
    [RAMP.x0, 0, RAMP.z - RAMP.d / 2], [RAMP.x1, 0, RAMP.z - RAMP.d / 2], [RAMP.x1, RAMP.h, RAMP.z - RAMP.d / 2],
    [RAMP.x0, 0, RAMP.z + RAMP.d / 2], [RAMP.x1, 0, RAMP.z + RAMP.d / 2], [RAMP.x1, RAMP.h, RAMP.z + RAMP.d / 2]],
    position: [0, 0, 0], rotation: Q0, slopeDeg: THREE.MathUtils.radToDeg(Math.atan2(RAMP.h, RAMP.x1 - RAMP.x0)), friction: 0.9 });
  rect(PLAT.x - PLAT.w / 2, PLAT.x + PLAT.w / 2, PLAT.z - PLAT.d / 2, PLAT.z + PLAT.d / 2, PLAT.h, "platform");
  surfaces.push({ id: "table_ramp", test: (x, z) => x >= RAMP.x0 && x <= RAMP.x1 && Math.abs(z - RAMP.z) <= RAMP.d / 2, h: (x) => RAMP.h * (x - RAMP.x0) / (RAMP.x1 - RAMP.x0) });
  blobs.add(PLAT.x, 0.0006, PLAT.z, PLAT.w * 1.6, PLAT.d * 1.6, 0.42, true);
  const NB = { x: -0.32, z: 0.2, w: 0.21, d: 0.15, h: 0.016, rot: 0.18 };
  const coverMat = tint(new THREE.MeshPhysicalMaterial({ name: "linen", color: "#FF5D73", roughness: 0.8, sheen: 0.6, sheenRoughness: 0.5, sheenColor: new THREE.Color("#ffb59a") }));
  const pagesMat = tint(new THREE.MeshStandardMaterial({ name: "pages", color: "#F1EADB", roughness: 0.9 }));
  const nbM = (lx, ly, lz) => { const v = new THREE.Vector3(lx, ly, lz).applyAxisAngle(new THREE.Vector3(0, 1, 0), NB.rot); return [NB.x + v.x, ly, NB.z + v.z]; };
  batch.add(new THREE.BoxGeometry(NB.w - 0.006, NB.h - 0.004, NB.d - 0.008), pagesMat, M4(...nbM(0.002, NB.h / 2, 0), 0, NB.rot));
  for (const y of [0.001, NB.h - 0.001]) batch.add(new RoundedBoxGeometry(NB.w, 0.002, NB.d, 2, 0.0009), coverMat, M4(...nbM(0, y, 0), 0, NB.rot));
  batch.add(new RoundedBoxGeometry(0.006, NB.h, NB.d, 2, 0.0025), coverMat, M4(...nbM(-NB.w / 2 + 0.002, NB.h / 2, 0), 0, NB.rot));
  const bandMat = new THREE.MeshStandardMaterial({ name: "band", color: "#222", roughness: 0.5 });
  batch.add(new THREE.BoxGeometry(0.004, NB.h + 0.0012, NB.d + 0.0012), bandMat, M4(...nbM(NB.w * 0.32, NB.h / 2, 0), 0, NB.rot));
  colliders.push({ id: "notebook", type: "cuboid", halfExtents: [NB.w / 2, NB.h / 2, NB.d / 2], position: [NB.x, NB.h / 2, NB.z], rotation: qY(NB.rot), friction: 0.7 });
  const nbInv = new THREE.Matrix4().compose(new THREE.Vector3(NB.x, 0, NB.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), NB.rot), new THREE.Vector3(1, 1, 1)).invert();
  surfaces.push({ id: "notebook", h: () => NB.h, test: (x, z) => { const l = new THREE.Vector3(x, 0, z).applyMatrix4(nbInv); return Math.abs(l.x) <= NB.w / 2 && Math.abs(l.z) <= NB.d / 2; } });
  blobs.add(NB.x, 0.0006, NB.z, NB.w * 1.6, NB.d * 1.6, 0.42, true, NB.rot);

  // ================================================================ CARDBOARD SWITCHBACK (floor -> tabletop)
  // flight 1 climbs +X from the floor to a box landing; flight 2 climbs back -X onto the table's right edge.
  const kraft = drawCanvas(512, 512, (g, w, h) => {
    const R = rng(9); g.fillStyle = "#B98B57"; g.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 6) { g.fillStyle = `rgba(90,60,30,${0.05 + 0.03 * Math.sin(x)})`; g.fillRect(x, 0, 2, h); }
    speckle(g, w, h, 5000, 0.08, false, R); speckle(g, w, h, 3000, 0.07, true, R);
  });
  void kraft;
  const cardMat = tint(new THREE.MeshStandardMaterial({ name: "cardboard", color: "#E3A866", roughness: 0.95 }));
  cardMat.userData.toonLift = 0.4;
  const chevron = drawCanvas(256, 1024, (g, w, h) => {
    const R = rng(4); g.fillStyle = "#C49663"; g.fillRect(0, 0, w, h); speckle(g, w, h, 3000, 0.08, false, R);
    g.fillStyle = "rgba(240,233,220,0.9)"; g.fillRect(w * 0.08, 0, w * 0.04, h); g.fillRect(w * 0.88, 0, w * 0.04, h);   // tape edges
    g.strokeStyle = "#F2B705"; g.lineWidth = 18; g.lineCap = "round";
    for (let y = 90; y < h; y += 170) { g.beginPath(); g.moveTo(w * 0.3, y + 50); g.lineTo(w * 0.5, y); g.lineTo(w * 0.7, y + 50); g.stroke(); }
  });
  const chevTex = tex(chevron, renderer, true); chevTex.wrapS = THREE.ClampToEdgeWrapping;
  const chevMat = tint(new THREE.MeshStandardMaterial({ name: "ramp_top", map: chevTex, roughness: 0.9, envMapIntensity: 0.5 }));
  const ACC = { z1: -0.3, z2: 0.12, w: 0.22, xTop: T.width / 2, xLand0: 2.2, xLand1: 2.55, xFoot: 0.95, hLand: 0.375 };
  const rail = 0.025, railT = 0.012;
  // build a sloped block: x from xa (height ha above floor) to xb (height hb), centred on z, width w
  const slopedBlock = (id, xa0, ha0, xb0, hb0, zc, w) => {
    const up = xb0 > xa0;                                   // climbing direction (for the printed arrows)
    const [xa, ha, xb, hb] = up ? [xa0, ha0, xb0, hb0] : [xb0, hb0, xa0, ha0];   // geometry always built low-x -> high-x
    const geo = new THREE.BoxGeometry(1, 1, 1, 1, 1, 1); const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const sx = p.getX(i) > 0 ? 1 : 0, top = p.getY(i) > 0, x = sx ? xb : xa;
      p.setXYZ(i, x, F + (top ? (sx ? hb : ha) : 0), zc + p.getZ(i) * w);
    }
    geo.computeVertexNormals(); batch.add(geo, cardMat);
    // printed top (slightly above)
    const len = Math.hypot(xb - xa, hb - ha);
    const topG = new THREE.PlaneGeometry(w * 0.98, len).rotateX(-Math.PI / 2);
    const ang = Math.atan2(Math.abs(hb - ha), Math.abs(xb - xa));
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), up ? -Math.PI / 2 : Math.PI / 2);
    const qTilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), up ? ang : -ang);
    batch.add(topG, chevMat, new THREE.Matrix4().compose(new THREE.Vector3((xa + xb) / 2, F + (ha + hb) / 2 + 0.0015, zc), qTilt.multiply(qYaw), new THREE.Vector3(1, 1, 1)));
    const pts = [];
    for (const z of [zc - w / 2, zc + w / 2]) pts.push([xa, F, z], [xb, F, z], [xa, F + ha, z], [xb, F + hb, z]);
    colliders.push({ id, type: "convex", points: pts, position: [0, 0, 0], rotation: Q0, friction: 0.95, slopeDeg: THREE.MathUtils.radToDeg(Math.abs(Math.atan2(hb - ha, xb - xa))) });
    surfaces.push({ id, test: (x, z) => x >= Math.min(xa, xb) && x <= Math.max(xa, xb) && Math.abs(z - zc) <= w / 2, h: (x) => F + ha + (hb - ha) * (x - xa) / (xb - xa) });
    // little side rails so a wobbly duck doesn't step off
    for (const sz of [-1, 1]) {
      const rz = zc + sz * (w / 2 + railT / 2);
      const g2 = new THREE.BoxGeometry(1, 1, 1); const q = g2.attributes.position;
      for (let i = 0; i < q.count; i++) { const hiX = q.getX(i) > 0, topv = q.getY(i) > 0, base = F + (hiX ? hb : ha);
        q.setXYZ(i, hiX ? xb : xa, base + (topv ? rail : 0), rz + q.getZ(i) * railT); }
      g2.computeVertexNormals(); batch.add(g2, cardMat);
      const rp = []; for (const z of [rz - railT / 2, rz + railT / 2]) rp.push([xa, F + ha, z], [xb, F + hb, z], [xa, F + ha + rail, z], [xb, F + hb + rail, z]);
      colliders.push({ id: id + "_rail", type: "convex", points: rp, position: [0, 0, 0], rotation: Q0, friction: 0.6 });
    }
  };
  slopedBlock("access_flight1", ACC.xFoot, 0, ACC.xLand0, ACC.hLand, ACC.z2, ACC.w);
  slopedBlock("access_flight2", ACC.xLand0, ACC.hLand, ACC.xTop, T.height, ACC.z1, ACC.w);
  // landing box joining both flights
  const LZ0 = ACC.z1 - ACC.w / 2 - railT, LZ1 = ACC.z2 + ACC.w / 2 + railT;
  batch.box(ACC.xLand1 - ACC.xLand0, ACC.hLand, LZ1 - LZ0, cardMat, (ACC.xLand0 + ACC.xLand1) / 2, F + ACC.hLand / 2, (LZ0 + LZ1) / 2);
  batch.box(ACC.xLand1 - ACC.xLand0 - 0.02, 0.002, 0.05, trimMat, (ACC.xLand0 + ACC.xLand1) / 2, F + ACC.hLand + 0.001, (LZ0 + LZ1) / 2); // tape strip
  // landing back wall (stops the duck walking off the far side)
  batch.box(railT, rail, LZ1 - LZ0, cardMat, ACC.xLand1 - railT / 2, F + ACC.hLand + rail / 2, (LZ0 + LZ1) / 2);
  cuboid("access_landing", (ACC.xLand0 + ACC.xLand1) / 2, F + ACC.hLand / 2, (LZ0 + LZ1) / 2, (ACC.xLand1 - ACC.xLand0) / 2, ACC.hLand / 2, (LZ1 - LZ0) / 2, Q0, 0.95);
  cuboid("access_landing_rail", ACC.xLand1 - railT / 2, F + ACC.hLand + rail / 2, (LZ0 + LZ1) / 2, railT / 2, rail / 2, (LZ1 - LZ0) / 2);
  rect(ACC.xLand0, ACC.xLand1, LZ0, LZ1, F + ACC.hLand, "access_landing");
  blobs.add((ACC.xFoot + ACC.xLand1) / 2, F + 0.001, (LZ0 + LZ1) / 2, (ACC.xLand1 - ACC.xFoot) * 1.25, (LZ1 - LZ0) * 1.6, 0.4, true);
  blocker(ACC.xFoot, F, LZ0, ACC.xLand1, F + ACC.hLand + 0.03, LZ1);

  // ================================================================ SOFA, COFFEE TABLE, SHELF, PLANT, POUF
  // Chunky, slightly exaggerated comic furniture: flat colours, rounded shapes, bold silhouettes.
  // Footprints and colliders match v3 (sized from the real models it replaces).
  const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 4, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  const sofaMat = tint(new THREE.MeshStandardMaterial({ name: "sofa", color: "#1FA6A0", roughness: 0.9 }));
  const cushionMat = tint(new THREE.MeshStandardMaterial({ name: "cushion", color: "#FFC43D", roughness: 0.9 }));
  const pinkMat = tint(new THREE.MeshStandardMaterial({ name: "pink", color: "#FF5D73", roughness: 0.9 }));
  for (const m of [sofaMat, cushionMat, pinkMat]) m.userData.toonLift = 0.3;
  const SOFA = { x: -1.66, z: ROOM.z0 + 0.54, L: 2.19, D: 1.02, seat: 0.46, back: 0.72, arm: 0.6 };
  const sx0 = SOFA.x - SOFA.L / 2, sz0 = SOFA.z - SOFA.D / 2;
  batch.add(rbox(SOFA.L - 0.06, 0.26, SOFA.D - 0.08, 0.08), sofaMat, M4(SOFA.x, F + 0.09 + 0.13, SOFA.z + 0.02));                       // base
  for (const k of [-1, 1]) {
    batch.add(rbox(SOFA.L / 2 - 0.2, 0.15, SOFA.D - 0.32, 0.07), sofaMat, M4(SOFA.x + k * (SOFA.L / 4 - 0.05), F + SOFA.seat - 0.075, SOFA.z + 0.1));   // seat cushions
    batch.add(rbox(SOFA.L / 2 - 0.24, 0.44, 0.24, 0.1), sofaMat, M4(SOFA.x + k * (SOFA.L / 4 - 0.06), F + SOFA.seat + 0.19, sz0 + 0.24, -0.18));       // back cushions
    batch.add(rbox(0.2, SOFA.arm - 0.06, SOFA.D - 0.02, 0.09), sofaMat, M4(SOFA.x + k * (SOFA.L / 2 - 0.1), F + 0.09 + (SOFA.arm - 0.09) / 2, SOFA.z));  // arms
    batch.add(new THREE.CylinderGeometry(0.03, 0.018, 0.09, 16), legMat, M4(SOFA.x + k * (SOFA.L / 2 - 0.12), F + 0.045, SOFA.z + 0.36));
    batch.add(new THREE.CylinderGeometry(0.03, 0.018, 0.09, 16), legMat, M4(SOFA.x + k * (SOFA.L / 2 - 0.12), F + 0.045, SOFA.z - 0.36));
  }
  batch.add(rbox(SOFA.L - 0.04, SOFA.back - 0.09, 0.2, 0.08), sofaMat, M4(SOFA.x, F + 0.09 + (SOFA.back - 0.09) / 2, sz0 + 0.1));                 // back frame
  batch.add(rbox(0.42, 0.4, 0.13, 0.09), cushionMat, M4(SOFA.x - 0.58, F + SOFA.seat + 0.2, sz0 + 0.38, -0.3, 0.25, 0.1));                       // throw cushions
  batch.add(rbox(0.36, 0.34, 0.12, 0.08), pinkMat, M4(SOFA.x + 0.62, F + SOFA.seat + 0.18, sz0 + 0.38, -0.3, -0.3, -0.12));
  cuboid("sofa", SOFA.x, F + SOFA.seat / 2, SOFA.z, SOFA.L / 2, SOFA.seat / 2, SOFA.D / 2);
  cuboid("sofa_back", SOFA.x, F + SOFA.back / 2, sz0 + 0.12, SOFA.L / 2, SOFA.back / 2, 0.12);
  for (const k of [-1, 1]) cuboid("sofa_arm", SOFA.x + k * (SOFA.L / 2 - 0.08), F + SOFA.arm / 2, SOFA.z, 0.08, SOFA.arm / 2, SOFA.D / 2);
  rect(sx0, sx0 + SOFA.L, sz0, sz0 + SOFA.D, F + SOFA.seat, "sofa_seat");
  blobs.add(SOFA.x, F + 0.001, SOFA.z, SOFA.L * 1.12, SOFA.D * 1.3, 0.55, true);
  blocker(sx0 - 0.03, F, sz0 - 0.05, sx0 + SOFA.L + 0.03, F + 0.8, sz0 + SOFA.D + 0.03);

  // coffee table: thick rounded oak top, chunky tapered legs; a teacup and two magazines
  const CT = { x: -1.66, z: -1.0, w: 1.0, d: 0.48, h: 0.4, t: 0.035 };
  batch.add(rbox(CT.w, CT.t + 0.01, CT.d, 0.02), woodMat, M4(CT.x, F + CT.h - (CT.t + 0.01) / 2, CT.z));
  const steel = tint(new THREE.MeshStandardMaterial({ name: "steel", color: "#3D3B4F", roughness: 0.5 }));
  const brass = tint(new THREE.MeshStandardMaterial({ name: "brass", color: "#FFC43D", roughness: 0.3 }));
  for (const lx of [-1, 1]) for (const lz of [-1, 1]) {
    const px = CT.x + lx * (CT.w / 2 - 0.06), pz = CT.z + lz * (CT.d / 2 - 0.06);
    batch.add(new THREE.CylinderGeometry(0.026, 0.016, CT.h - CT.t - 0.02, 20), legMat, M4(px, F + 0.02 + (CT.h - CT.t - 0.02) / 2, pz, -lz * 0.06, 0, lx * 0.06));
    batch.add(new THREE.CylinderGeometry(0.017, 0.015, 0.024, 16), brass, M4(px + lx * 0.0105, F + 0.012, pz + lz * 0.0105));
    colliders.push({ id: "coffee_leg", type: "cylinder", radius: 0.016, halfHeight: (CT.h - CT.t) / 2, position: [px, F + (CT.h - CT.t) / 2, pz], rotation: Q0, friction: 0.6 });
  }
  cuboid("coffee_table_top", CT.x, F + CT.h - CT.t / 2, CT.z, CT.w / 2, CT.t / 2, CT.d / 2);
  rect(CT.x - CT.w / 2, CT.x + CT.w / 2, CT.z - CT.d / 2, CT.z + CT.d / 2, F + CT.h, "coffee_table");
  const mugMat = tint(new THREE.MeshStandardMaterial({ name: "mug", color: "#FFFFFF", roughness: 0.3 }));
  {
    const cx = CT.x + 0.28, cz = CT.z - 0.05, y = F + CT.h;
    batch.add(new THREE.LatheGeometry([[0.001, 0], [0.075, 0], [0.078, 0.006], [0.07, 0.01], [0.001, 0.01]].map(([r, h]) => new THREE.Vector2(r, h)), 32), mugMat, M4(cx, y, cz));        // saucer
    batch.add(new THREE.LatheGeometry([[0.001, 0.01], [0.028, 0.01], [0.045, 0.035], [0.05, 0.06], [0.045, 0.062]].map(([r, h]) => new THREE.Vector2(r, h)), 32), pinkMat, M4(cx, y, cz)); // cup
    batch.add(new THREE.CircleGeometry(0.043, 24).rotateX(-Math.PI / 2), legMat, M4(cx, y + 0.052, cz));                                                                              // tea
    batch.add(new THREE.TorusGeometry(0.018, 0.006, 10, 20, Math.PI * 1.3), pinkMat, M4(cx + 0.052, y + 0.038, cz, 0, 0, -0.8));
  }
  const magA = tint(new THREE.MeshStandardMaterial({ name: "magazineA", color: "#FFC43D", roughness: 0.6 }));
  const magB = tint(new THREE.MeshStandardMaterial({ name: "magazineB", color: "#7B61FF", roughness: 0.6 }));
  batch.add(new THREE.BoxGeometry(0.21, 0.008, 0.28), magB, M4(CT.x - 0.2, F + CT.h + 0.004, CT.z, 0, 0.2));
  batch.add(new THREE.BoxGeometry(0.21, 0.008, 0.28), magA, M4(CT.x - 0.17, F + CT.h + 0.012, CT.z + 0.02, 0, -0.15));
  blobs.add(CT.x, F + 0.001, CT.z, CT.w * 1.25, CT.d * 1.5, 0.3, true);
  blocker(CT.x - CT.w / 2 - 0.02, F + CT.h - CT.t - 0.02, CT.z - CT.d / 2 - 0.02, CT.x + CT.w / 2 + 0.02, F + CT.h + 0.1, CT.z + CT.d / 2 + 0.02);

  // low shelf under the window, with chunky books, a vase of flowers and a boom box
  const SH = { x: 0.9, z: ROOM.z0 + 0.19, w: 1.3, d: 0.34, h: 0.46 };
  const shelfMat = tint(new THREE.MeshStandardMaterial({ name: "shelf", color: "#FFF8EC", roughness: 0.6 }));
  shelfMat.userData.toonLift = 0.35;
  batch.add(rbox(SH.w, 0.035, SH.d, 0.012), shelfMat, M4(SH.x, F + SH.h - 0.0175, SH.z));
  batch.add(rbox(SH.w, 0.035, SH.d, 0.012), shelfMat, M4(SH.x, F + 0.065, SH.z));
  for (const k of [-1, 0, 1]) batch.add(rbox(0.035, SH.h - 0.05, SH.d, 0.01), shelfMat, M4(SH.x + k * (SH.w / 2 - 0.0175), F + 0.05 + (SH.h - 0.05) / 2, SH.z));
  batch.box(SH.w, SH.h - 0.05, 0.012, shelfMat, SH.x, F + 0.05 + (SH.h - 0.05) / 2, SH.z - SH.d / 2 + 0.006);
  for (const lx of [-1, 1]) batch.add(new THREE.CylinderGeometry(0.02, 0.014, 0.05, 12), legMat, M4(SH.x + lx * (SH.w / 2 - 0.05), F + 0.025, SH.z));
  const bookCols = ["#3A86FF", "#FF5D73", "#FFC43D", "#1FA6A0", "#7B61FF", "#FF8A3D"];
  const bookMats = bookCols.map((c, i) => tint(new THREE.MeshStandardMaterial({ name: "book" + i, color: c, roughness: 0.7 })));
  const BR = rng(12); let bx = SH.x - SH.w / 2 + 0.06;
  while (bx < SH.x - 0.08) { const bw = 0.035 + BR() * 0.03, bh = 0.2 + BR() * 0.12, tilt = bx > SH.x - 0.2 ? 0.28 : 0;
    batch.add(rbox(bw, bh, 0.22, 0.006), bookMats[Math.floor(BR() * bookMats.length)], M4(bx + bw / 2 + tilt * 0.1, F + 0.083 + bh / 2, SH.z + 0.02, 0, 0, -tilt)); bx += bw + 0.003; }
  // vase + flowers
  {
    const vx = SH.x + 0.35, vz = SH.z + 0.02, vy = F + SH.h;
    const vaseMat = tint(new THREE.MeshStandardMaterial({ name: "vase", color: "#3A86FF", roughness: 0.35 }));
    batch.add(new THREE.LatheGeometry([[0.001, 0], [0.05, 0], [0.07, 0.06], [0.06, 0.12], [0.032, 0.17], [0.038, 0.19], [0.03, 0.19]].map(([r, h]) => new THREE.Vector2(r, h)), 32), vaseMat, M4(vx, vy, vz));
    const stemM = tint(new THREE.MeshStandardMaterial({ name: "stem", color: "#3BB273", roughness: 0.8 }));
    const petal = [pinkMat, cushionMat, tint(new THREE.MeshStandardMaterial({ name: "petal_w", color: "#FFFFFF", roughness: 0.8 }))];
    [[-0.06, 0.34, 0.02], [0.05, 0.38, -0.02], [0.0, 0.42, 0.04], [0.08, 0.31, 0.05]].forEach(([dx, h, dz], i) => {
      const top = new THREE.Vector3(vx + dx, vy + h, vz + dz), from = new THREE.Vector3(vx, vy + 0.15, vz), dir = top.clone().sub(from);
      batch.add(new THREE.CylinderGeometry(0.004, 0.005, 1, 6).translate(0, 0.5, 0), stemM, new THREE.Matrix4().compose(from, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()), new THREE.Vector3(1, dir.length(), 1)));
      for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2; batch.add(new THREE.SphereGeometry(0.02, 12, 8), petal[i % 3], new THREE.Matrix4().compose(top.clone().add(new THREE.Vector3(Math.cos(a) * 0.022, 0, Math.sin(a) * 0.022)), new THREE.Quaternion(), new THREE.Vector3(1, 0.55, 1))); }
      batch.add(new THREE.SphereGeometry(0.013, 12, 8), cushionMat, M4(top.x, top.y + 0.006, top.z));
    });
  }
  // boom box: chunky body, two speakers, handle, buttons
  {
    const bx0 = SH.x - 0.3, bz0 = SH.z + 0.02, by = F + SH.h;
    const boxMat = tint(new THREE.MeshStandardMaterial({ name: "boombox", color: "#FF5D73", roughness: 0.4 }));
    const dark = tint(new THREE.MeshStandardMaterial({ name: "boombox_dark", color: "#2B2440", roughness: 0.5 }));
    batch.add(rbox(0.34, 0.2, 0.12, 0.04), boxMat, M4(bx0, by + 0.1, bz0));
    for (const sx of [-1, 1]) {
      batch.add(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 32).rotateX(Math.PI / 2), dark, M4(bx0 + sx * 0.095, by + 0.1, bz0 + 0.058));
      batch.add(new THREE.CylinderGeometry(0.022, 0.022, 0.024, 20).rotateX(Math.PI / 2), shelfMat, M4(bx0 + sx * 0.095, by + 0.1, bz0 + 0.06));
    }
    batch.add(new THREE.TorusGeometry(0.11, 0.012, 10, 32, Math.PI), dark, M4(bx0, by + 0.19, bz0));
    for (let i = 0; i < 3; i++) batch.add(rbox(0.018, 0.012, 0.02, 0.004), cushionMat, M4(bx0 - 0.02 + i * 0.022, by + 0.205, bz0 + 0.02));
  }
  cuboid("shelf", SH.x, F + SH.h / 2, SH.z, SH.w / 2, SH.h / 2, SH.d / 2);
  rect(SH.x - SH.w / 2, SH.x + SH.w / 2, SH.z - SH.d / 2, SH.z + SH.d / 2, F + SH.h, "shelf_top");
  blobs.add(SH.x, F + 0.001, SH.z, SH.w * 1.15, SH.d * 1.6, 0.4, true);
  blocker(SH.x - SH.w / 2 - 0.02, F, SH.z - SH.d / 2 - 0.02, SH.x + SH.w / 2 + 0.02, F + SH.h + 0.32, SH.z + SH.d / 2 + 0.02);

  // potted plant in the back-right corner: chunky pot, big paddle leaves (instanced)
  const PL = { x: 2.52, z: -2.08, r: 0.23, h: 0.336 };
  {
    const potMat = tint(new THREE.MeshStandardMaterial({ name: "terracotta", color: "#FF7A45", roughness: 0.8 }));
    batch.add(new THREE.LatheGeometry([[0.001, 0], [PL.r * 0.72, 0], [PL.r * 0.92, PL.h * 0.8], [PL.r, PL.h * 0.82], [PL.r, PL.h], [PL.r * 0.86, PL.h], [PL.r * 0.86, PL.h * 0.92], [0.001, PL.h * 0.92]].map(([r, h]) => new THREE.Vector2(r, h)), 40), potMat, M4(PL.x, F, PL.z));
    const leafMat = tint(new THREE.MeshStandardMaterial({ name: "leaf", color: "#3BB273", roughness: 0.6, side: THREE.DoubleSide }));
    const leafShape = new THREE.Shape(); leafShape.moveTo(0, 0); leafShape.bezierCurveTo(0.16, 0.07, 0.17, 0.3, 0, 0.42); leafShape.bezierCurveTo(-0.17, 0.3, -0.16, 0.07, 0, 0);
    const leafGeo = new THREE.ExtrudeGeometry(leafShape, { depth: 0.006, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.006, bevelSegments: 2, curveSegments: 14 });
    { const p = leafGeo.attributes.position; for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, p.getZ(i) - Math.abs(x) * 0.35 + y * y * 0.5); } leafGeo.computeVertexNormals(); }
    const NL = 11, leaves = new THREE.InstancedMesh(leafGeo, leafMat, NL); const LR = rng(5), lm = new THREE.Matrix4();
    const stemMat = tint(new THREE.MeshStandardMaterial({ name: "plant_stem", color: "#2E8F57", roughness: 0.8 }));
    for (let i = 0; i < NL; i++) {
      const a = i * 2.39996, len = 0.28 + LR() * 0.42, lean = 0.15 + (len - 0.28) * 1.1;
      const base = new THREE.Vector3(PL.x + Math.cos(a) * lean * 0.5, F + PL.h + len * 0.8, PL.z + Math.sin(a) * lean * 0.5);
      const sc = 1.0 + LR() * 0.4;
      lm.compose(base, new THREE.Quaternion().setFromEuler(new THREE.Euler(-(0.7 + LR() * 0.6), -a + Math.PI / 2, (LR() - 0.5) * 0.4, "YXZ")), new THREE.Vector3(sc, sc, sc));
      leaves.setMatrixAt(i, lm);
      const from = new THREE.Vector3(PL.x, F + PL.h - 0.03, PL.z), dir = base.clone().sub(from);
      batch.add(new THREE.CylinderGeometry(0.006, 0.009, 1, 6).translate(0, 0.5, 0), stemMat, new THREE.Matrix4().compose(from, new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()), new THREE.Vector3(1, dir.length(), 1)));
    }
    leaves.castShadow = true; leaves.receiveShadow = true; leaves.userData.lookNoContact = true; leaves.name = "plant_leaves"; root.add(leaves);
  }
  colliders.push({ id: "plant_pot", type: "cylinder", radius: PL.r, halfHeight: PL.h / 2, position: [PL.x, F + PL.h / 2, PL.z], rotation: Q0, friction: 0.8 });
  disc(PL.x, PL.z, PL.r, F + PL.h, "plant_pot");
  blobs.add(PL.x, F + 0.001, PL.z, PL.r * 3, PL.r * 3, 0.5);
  blocker(PL.x - 0.4, F, PL.z - 0.4, PL.x + 0.4, F + 0.9, PL.z + 0.4);

  // pouf between the sofa and the shelf: squashy drum with a button
  const PF = { x: -0.15, z: -2.06, r: 0.3, h: 0.2 };
  {
    const poufMat = tint(new THREE.MeshStandardMaterial({ name: "pouf", color: "#7B61FF", roughness: 0.9 }));
    const g = new THREE.SphereGeometry(1, 40, 20); g.scale(PF.r, PF.h / 2, PF.r);
    { const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const y = p.getY(i); const k = 1 + 0.18 * (1 - Math.pow(y / (PF.h / 2), 2)); p.setX(i, Math.max(-PF.r, Math.min(PF.r, p.getX(i) * k * 0.92))); p.setZ(i, Math.max(-PF.r, Math.min(PF.r, p.getZ(i) * k * 0.92))); } g.computeVertexNormals(); }
    batch.add(g, poufMat, M4(PF.x, F + PF.h / 2, PF.z));
    batch.add(new THREE.SphereGeometry(0.03, 16, 10).scale(1, 0.5, 1), cushionMat, M4(PF.x, F + PF.h - 0.004, PF.z));
  }
  colliders.push({ id: "pouf", type: "cylinder", radius: PF.r, halfHeight: PF.h / 2, position: [PF.x, F + PF.h / 2, PF.z], rotation: Q0, friction: 0.9 });
  disc(PF.x, PF.z, PF.r, F + PF.h, "pouf");
  blobs.add(PF.x, F + 0.001, PF.z, PF.r * 2.8, PF.r * 2.8, 0.45);
  blocker(PF.x - PF.r, F, PF.z - PF.r, PF.x + PF.r, F + PF.h + 0.02, PF.z + PF.r);

  // ================================================================ RUG + FOOTBALL PITCH
  const RUG = { x: -1.93, z: 0.73, w: 1.85, d: 3.1, t: 0.006 };
  const PITCH = { w: 1.3, d: 2.5 };   // inside the rug
  const rugCanvas = drawCanvas(hi ? 1024 : 512, Math.round((hi ? 1024 : 512) * RUG.d / RUG.w), (g, w, h) => {
    const R = rng(17), sx = w / RUG.w, sz = h / RUG.d;
    g.fillStyle = "#F4E6CC"; g.fillRect(0, 0, w, h);
    // border bands
    g.strokeStyle = "#3A86FF"; g.lineWidth = 0.06 * sx; g.strokeRect(0.07 * sx, 0.07 * sz, w - 0.14 * sx, h - 0.14 * sz);
    g.strokeStyle = "#FFC43D"; g.lineWidth = 0.016 * sx; g.strokeRect(0.12 * sx, 0.12 * sz, w - 0.24 * sx, h - 0.24 * sz);
    // pitch panel
    const px = (RUG.w - PITCH.w) / 2 * sx, pz = (RUG.d - PITCH.d) / 2 * sz, pw = PITCH.w * sx, pd = PITCH.d * sz;
    for (let i = 0; i < 10; i++) { g.fillStyle = i % 2 ? "#6CC56A" : "#7DD47A"; g.fillRect(px, pz + i * pd / 10, pw, pd / 10 + 1); }
    g.strokeStyle = "rgba(250,248,240,0.95)"; g.lineWidth = 0.02 * sx;
    g.strokeRect(px, pz, pw, pd);
    g.beginPath(); g.moveTo(px, pz + pd / 2); g.lineTo(px + pw, pz + pd / 2); g.stroke();
    g.beginPath(); g.arc(px + pw / 2, pz + pd / 2, 0.22 * sx, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "rgba(250,248,240,0.95)"; g.beginPath(); g.arc(px + pw / 2, pz + pd / 2, 0.02 * sx, 0, Math.PI * 2); g.fill();
    for (const end of [0, 1]) {
      const y0 = end ? pz + pd : pz, dir = end ? -1 : 1;
      g.strokeRect(px + pw / 2 - 0.36 * sx, end ? y0 - 0.38 * sz : y0, 0.72 * sx, 0.38 * sz);
      g.strokeRect(px + pw / 2 - 0.18 * sx, end ? y0 - 0.14 * sz : y0, 0.36 * sx, 0.14 * sz);
      g.beginPath(); g.arc(px + pw / 2, y0 + dir * 0.27 * sz, 0.012 * sx, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(px + pw / 2, y0 + dir * 0.38 * sz, 0.16 * sx, end ? Math.PI + 0.75 : 0.75, end ? 2 * Math.PI - 0.75 : Math.PI - 0.75); g.stroke();
    }
    // wool fibre speckle
    void R;
  });
  const rugMat = tint(new THREE.MeshPhysicalMaterial({ name: "rug", map: tex(rugCanvas, renderer, true), roughness: 1, sheen: 1, sheenRoughness: 0.55,
    sheenColor: new THREE.Color("#fff6e6"), envMapIntensity: 0.4 }));
  rugMat.map.wrapS = rugMat.map.wrapT = THREE.ClampToEdgeWrapping;
  const rug = add(new THREE.Mesh(new RoundedBoxGeometry(RUG.w, RUG.t, RUG.d, 2, 0.003), rugMat));
  rug.position.set(RUG.x, F + RUG.t / 2, RUG.z); rug.castShadow = false; rug.name = "world_rug";
  cuboid("rug", RUG.x, F + RUG.t / 2, RUG.z, RUG.w / 2, RUG.t / 2, RUG.d / 2, Q0, 0.95);
  rect(RUG.x - RUG.w / 2, RUG.x + RUG.w / 2, RUG.z - RUG.d / 2, RUG.z + RUG.d / 2, F + RUG.t, "rug");
  // goals: white posts + net, mouths face the pitch centre
  const GOAL = { w: 0.34, h: 0.16, d: 0.12, post: 0.007 };
  const postMat = new THREE.MeshPhysicalMaterial({ name: "goalpost", color: "#FAFAF7", roughness: 0.35, clearcoat: 0.6 });
  const netMat = tint(new THREE.MeshStandardMaterial({ name: "net", color: "#FFFFFF", roughness: 0.8, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    alphaTest: 0.1, map: tex(drawCanvas(64, 64, (g, w, h) => { g.clearRect(0, 0, w, h); g.strokeStyle = "#fff"; g.lineWidth = 3; for (let i = 0; i <= 64; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, h); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(w, i); g.stroke(); } }), renderer, true, [6, 3]) }));
  const goals = [];
  const gy = F + RUG.t;
  for (const end of [-1, 1]) {
    const mz = RUG.z + end * PITCH.d / 2, backZ = mz + end * GOAL.d, cx = RUG.x;
    for (const sxp of [-1, 1]) {
      batch.add(new THREE.CylinderGeometry(GOAL.post, GOAL.post, GOAL.h, 12), postMat, M4(cx + sxp * GOAL.w / 2, gy + GOAL.h / 2, mz));
      colliders.push({ id: "goal_post", type: "cylinder", radius: GOAL.post, halfHeight: GOAL.h / 2, position: [cx + sxp * GOAL.w / 2, gy + GOAL.h / 2, mz], rotation: Q0, friction: 0.5 });
      // side nets
      batch.add(new THREE.PlaneGeometry(GOAL.d, GOAL.h).rotateY(Math.PI / 2), netMat, M4(cx + sxp * GOAL.w / 2, gy + GOAL.h / 2, mz + end * GOAL.d / 2));
      cuboid("goal_side", cx + sxp * GOAL.w / 2, gy + GOAL.h / 2, mz + end * GOAL.d / 2, 0.003, GOAL.h / 2, GOAL.d / 2, Q0, 0.4);
    }
    batch.add(new THREE.CylinderGeometry(GOAL.post, GOAL.post, GOAL.w + GOAL.post * 2, 12).rotateZ(Math.PI / 2), postMat, M4(cx, gy + GOAL.h, mz));
    batch.add(new THREE.PlaneGeometry(GOAL.w, GOAL.h), netMat, M4(cx, gy + GOAL.h / 2, backZ));
    batch.add(new THREE.PlaneGeometry(GOAL.w, GOAL.d).rotateX(-Math.PI / 2), netMat, M4(cx, gy + GOAL.h, mz + end * GOAL.d / 2));
    cuboid("goal_bar", cx, gy + GOAL.h, mz, GOAL.w / 2 + GOAL.post, GOAL.post, GOAL.post, Q0, 0.4);
    cuboid("goal_back", cx, gy + GOAL.h / 2, backZ, GOAL.w / 2, GOAL.h / 2, 0.003, Q0, 0.3);
    cuboid("goal_roof", cx, gy + GOAL.h, mz + end * GOAL.d / 2, GOAL.w / 2, 0.003, GOAL.d / 2, Q0, 0.3);
    blobs.add(cx, gy + 0.0005, mz + end * GOAL.d / 2, GOAL.w * 1.5, GOAL.d * 2.2, 0.3, true);
    goals.push({ id: end < 0 ? "goal_back" : "goal_front", team: end < 0 ? "A" : "B",
      position: [cx, gy, mz], facing: [0, 0, -end], width: GOAL.w, height: GOAL.h, depth: GOAL.d,
      scoreBox: { min: [cx - GOAL.w / 2, gy, Math.min(mz, backZ)], max: [cx + GOAL.w / 2, gy + GOAL.h, Math.max(mz, backZ)] } });
  }

  // ================================================================ RACE TRACK (taped start line + cones, loop around the table)
  const RACE = { start: [0.0, F, 1.05], dir: [1, 0, 0], width: 0.7 };
  const checker = drawCanvas(64, 512, (g, w, h) => { for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) { g.fillStyle = ((x + y) / 32) % 2 ? "#111" : "#F4F1EA"; g.fillRect(x, y, 32, 32); } });
  const tapeMat = new THREE.MeshStandardMaterial({ name: "tape", map: tex(checker, renderer, true), roughness: 0.6 });
  const startLine = new THREE.Mesh(new THREE.PlaneGeometry(0.05, RACE.width).rotateX(-Math.PI / 2), tapeMat);
  startLine.position.set(RACE.start[0], F + 0.0012, RACE.start[2]); startLine.receiveShadow = true; startLine.userData.lookNoContact = true; root.add(startLine);
  const tapeArrowMat = new THREE.MeshStandardMaterial({ name: "tape_blue", color: "#3E7CC2", roughness: 0.6 });
  const checkpoints = [
    { id: "cp1", position: [2.78, F, 0.72], radius: 0.32 },
    { id: "cp2", position: [2.3, F, -1.45], radius: 0.32 },
    { id: "cp3", position: [-0.45, F, -1.25], radius: 0.32 },
    { id: "cp4", position: [-0.72, F, 1.0], radius: 0.32 },
  ];
  // instanced cones (one draw call for body, one for the white band)
  const coneGeo = new THREE.LatheGeometry([new THREE.Vector2(0.001, 0.1), new THREE.Vector2(0.011, 0.1), new THREE.Vector2(0.034, 0.012), new THREE.Vector2(0.034, 0.012)], 32);
  const coneBase = new RoundedBoxGeometry(0.085, 0.012, 0.085, 2, 0.003).translate(0, 0.006, 0);
  const coneBody = mergeGeometries([coneGeo.toNonIndexed(), coneBase.toNonIndexed()]); coneBody.computeVertexNormals();
  const coneMat = new THREE.MeshPhysicalMaterial({ name: "cone", color: "#F26B1D", roughness: 0.45, clearcoat: 0.5 });
  const bandGeo = new THREE.CylinderGeometry(0.0185, 0.0245, 0.022, 32, 1, true).translate(0, 0.058, 0);
  const bandMat2 = new THREE.MeshStandardMaterial({ name: "cone_band", color: "#F4F1EA", roughness: 0.5, side: THREE.DoubleSide });
  const cones = new THREE.InstancedMesh(coneBody, coneMat, checkpoints.length), bands = new THREE.InstancedMesh(bandGeo, bandMat2, checkpoints.length);
  checkpoints.forEach((c, i) => {
    const m = new THREE.Matrix4().makeTranslation(c.position[0], F, c.position[2]); cones.setMatrixAt(i, m); bands.setMatrixAt(i, m);
    colliders.push({ id: "cone_" + c.id, type: "cylinder", radius: 0.03, halfHeight: 0.05, position: [c.position[0], F + 0.05, c.position[2]], rotation: Q0, friction: 0.6 });
    blobs.add(c.position[0], F + 0.001, c.position[2], 0.16, 0.16, 0.45);
    // little tape arrow pointing to the next checkpoint
    const next = i + 1 < checkpoints.length ? checkpoints[i + 1].position : RACE.start;
    const a = Math.atan2(next[2] - c.position[2], next[0] - c.position[0]);
    const arrow = new THREE.Shape([new THREE.Vector2(-0.05, -0.012), new THREE.Vector2(0.02, -0.012), new THREE.Vector2(0.02, -0.03), new THREE.Vector2(0.06, 0),
      new THREE.Vector2(0.02, 0.03), new THREE.Vector2(0.02, 0.012), new THREE.Vector2(-0.05, 0.012)]);
    batch.add(new THREE.ShapeGeometry(arrow).rotateX(-Math.PI / 2), tapeArrowMat, new THREE.Matrix4().compose(
      new THREE.Vector3(c.position[0] + Math.cos(a) * 0.14, F + 0.0011, c.position[2] + Math.sin(a) * 0.14),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a), new THREE.Vector3(1, 1, 1)));
  });
  for (const im of [cones, bands]) { im.castShadow = true; im.receiveShadow = true; im.userData.lookNoContact = true; root.add(im); }


  // ================================================================ GARAGE CORNER (floor turntable on a rubber mat)
  const GA = { x: 2.2, z: 1.78, mw: 1.25, md: 1.0, r: 0.2, h: 0.018 };
  const matCanvas = drawCanvas(512, 412, (g, w, h) => { const R = rng(33); g.fillStyle = "#3B3E43"; g.fillRect(0, 0, w, h);
    g.strokeStyle = "rgba(255,255,255,0.07)"; g.lineWidth = 1; for (let x = 0; x < w; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke(); } for (let y = 0; y < h; y += 20) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
    g.strokeStyle = "#F2B705"; g.lineWidth = 10; g.setLineDash([26, 18]); g.strokeRect(14, 14, w - 28, h - 28); speckle(g, w, h, 4000, 0.08, true, R); });
  const garageMatMat = tint(new THREE.MeshStandardMaterial({ name: "garage_mat", map: tex(matCanvas, renderer, true), roughness: 0.85, envMapIntensity: 0.4 }));
  garageMatMat.map.wrapS = garageMatMat.map.wrapT = THREE.ClampToEdgeWrapping;
  const gmat = add(new THREE.Mesh(new RoundedBoxGeometry(GA.mw, 0.004, GA.md, 2, 0.002), garageMatMat)); gmat.position.set(GA.x, F + 0.002, GA.z); gmat.castShadow = false;
  rect(GA.x - GA.mw / 2, GA.x + GA.mw / 2, GA.z - GA.md / 2, GA.z + GA.md / 2, F + 0.004, "garage_mat");
  const ringTex = (() => { const s = 1024; return tex(canvasFrom(s, s, (d) => { for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const dx = (x - s / 2) / (s / 2), dy = (y - s / 2) / (s / 2), r = Math.hypot(dx, dy);
    const v = 150 + 25 * Math.sin(r * 700) * Math.sin(r * 53.0) + (r > 0.97 ? -30 : 0) + (Math.abs(r - 0.86) < 0.004 ? -45 : 0);
    const i = (y * s + x) * 4; d[i] = d[i + 1] = d[i + 2] = Math.max(0, Math.min(255, v)); d[i + 3] = 255; } }), renderer, false); })();
  const alu = tint(new THREE.MeshPhysicalMaterial({ name: "platter", color: "#34383D", metalness: 0.2, roughness: 0.75, roughnessMap: ringTex, envMapIntensity: 0.6, sheen: 0.4, sheenRoughness: 0.5, sheenColor: new THREE.Color("#9aa3ad") }));
  const turntable = new THREE.Group(); turntable.position.set(GA.x, F + 0.004, GA.z); turntable.name = "world_turntable"; root.add(turntable);
  add(new THREE.Mesh(new THREE.CylinderGeometry(GA.r * 0.92, GA.r * 0.95, GA.h * 0.5, 96), steel), turntable).position.y = GA.h * 0.25;
  const platter = new THREE.Group(); platter.position.y = GA.h * 0.5; turntable.add(platter);
  const disc0 = add(new THREE.Mesh(new THREE.CylinderGeometry(GA.r, GA.r, GA.h * 0.5, 128), alu), platter); disc0.position.y = GA.h * 0.25;
  { const g = disc0.geometry, p = g.attributes.position, uv = g.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / (2 * GA.r) + 0.5, p.getZ(i) / (2 * GA.r) + 0.5); }
  const rimMat = tint(new THREE.MeshPhysicalMaterial({ name: "alu_rim", color: "#C9CDD2", metalness: 1, roughness: 0.3 }));
  add(new THREE.Mesh(new THREE.CylinderGeometry(GA.r + 0.006, GA.r + 0.006, GA.h * 0.5, 128, 1, true), rimMat), platter).position.y = GA.h * 0.25;
  const glowRingMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#FFE2B8").multiplyScalar(1.6) });
  const glowRing = new THREE.Mesh(new THREE.TorusGeometry(GA.r * 0.995, 0.0015, 8, 160), glowRingMat);
  glowRing.rotation.x = Math.PI / 2; glowRing.position.y = GA.h * 0.5 + 0.0004; glowRing.userData.lookNoContact = true; platter.add(glowRing);
  blobs.add(GA.x, F + 0.0045, GA.z, GA.r * 3.6, GA.r * 3.6, 0.5);
  colliders.push({ id: "turntable", type: "cylinder", radius: GA.r, halfHeight: GA.h / 2, position: [GA.x, F + 0.004 + GA.h / 2, GA.z], rotation: Q0, friction: 0.9, kinematic: true });
  disc(GA.x, GA.z, GA.r, F + 0.004 + GA.h, "turntable");
  const spot = new THREE.SpotLight(0xffd9a8, 4.5, 2.6, 0.34, 0.6, 2);
  spot.position.set(GA.x + 0.15, F + 1.9, GA.z - 0.1); spot.target.position.set(GA.x, F, GA.z); spot.castShadow = false; root.add(spot, spot.target);
  // a red toolbox and a small parts tray beside the turntable
  const toolMat = tint(new THREE.MeshPhysicalMaterial({ name: "toolbox", color: "#C8372D", roughness: 0.35, clearcoat: 0.7 }));
  batch.box(0.32, 0.16, 0.17, toolMat, GA.x + 0.38, F + 0.084, GA.z + 0.28, -0.2, 0.012);
  batch.box(0.22, 0.012, 0.03, steel, GA.x + 0.38, F + 0.176, GA.z + 0.28, -0.2);
  batch.box(0.2, 0.025, 0.14, steel, GA.x - 0.4, F + 0.017, GA.z + 0.3, 0.3, 0.004);
  cuboid("toolbox", GA.x + 0.38, F + 0.084, GA.z + 0.28, 0.16, 0.08, 0.085, qY(-0.2));
  blobs.add(GA.x + 0.38, F + 0.005, GA.z + 0.28, 0.45, 0.28, 0.4, true, -0.2);

  // ================================================================ build merged statics
  const statics = [...batch.build(root, { name: "static" }), ...shell.build(root, { name: "shell", cast: false })];
  toonifyTree(root);   // every standard material in the room becomes banded toon shading
  statics.forEach(m => meshes.push(m));

  // ================================================================ PROPS
  const props = [];
  const propShadow = new Map();
  function addProp(p) {
    toonifyTree(p.object);
    if (!p.object.parent) root.add(p.object);
    props.includes(p) || props.push(p);
    propShadow.set(p, blobs.add(p.object.position.x, p.object.position.y, p.object.position.z, p.footprint, p.footprint, 0.5));
    return p;
  }
  function removeProp(p) {
    const i = props.indexOf(p); if (i >= 0) props.splice(i, 1);
    if (propShadow.has(p)) { blobs.remove(propShadow.get(p)); propShadow.delete(p); }
    if (p.object.parent === root) root.remove(p.object);
  }
  // tabletop toys (same spots as v1)
  addProp(placeProp(makeFoamCube(), 0.12, 0, 0.12, 0.5));
  addProp(placeProp(makeRing(), -0.08, 0, 0.28));
  addProp(placeProp(makeRubberDuck("yellow"), 0.3, 0, -0.22, 2.4));
  addProp(placeProp(makePencil(), -0.22, 0, -0.06, 0.9));
  // floor toys
  const gF = F + RUG.t;
  addProp(placeProp(makeSockBall(), RUG.x, gF, RUG.z));                         // centre spot
  addProp(placeProp(makeKey(), -0.25, F, -0.95, 0.7));
  addProp(placeProp(makeBottleCap(), 0.55, F, 1.55));
  addProp(placeProp(makeCrayon(), 1.45, F, -0.95, 2.2));
  addProp(placeProp(makeBreadCrust(), -0.55, F, 1.6, 0.4));
  addProp(placeProp(makeToyBrick(), 1.55, F, 1.0, 0.3));
  addProp(placeProp(makeRubberDuck("pink"), -1.25, gF, 1.9, -0.6));
  addProp(placeProp(makeRubberDuck("blue"), -1.6, gF, -0.45, 1.2));
  addProp(placeProp(makeRubberDuck("mint"), 1.9, F + 0.004, 1.45, 2.6));
  // streamed real-model toys
  addProp(placeProp(makeChessPawn(), -0.5, 0, -0.25));
  addProp(placeProp(makeChessKnight(), -0.58, 0, -0.3, 0.8));
  addProp(placeProp(makeWickerBall(), -2.45, gF, 1.95));
  addProp(placeProp(makeToyCar(), 1.75, F + 0.004, 2.0, 0.7));
  addProp(placeProp(makeCookie(), -0.95, F, -1.55));
  addProp(placeProp(makeToast(), 0.35, F, 1.35, 0.4));
  addProp(placeProp(makeCroissant(), -0.85, F, 0.25, 1.1));

  // ================================================================ queries
  const STEP = 0.04;
  function groundHeightAt(x, z, y) {
    let best = F, any = false;
    for (const s of surfaces) {
      if (!s.test(x, z)) continue;
      const h = s.h(x, z);
      if (y !== undefined && h > y + STEP) continue;
      if (h > best || !any) { best = Math.max(best, h); any = true; }
    }
    return best;
  }
  const hx = T.width / 2, hz = T.depth / 2;
  const isOverDrop = (x, z, y) => {
    if (y === undefined) return Math.abs(x) > hx || Math.abs(z) > hz;          // v1 meaning: off the tabletop
    return groundHeightAt(x, z, y) < y - 0.06;
  };
  const distanceToEdge = (x, z) => Math.min(hx - Math.abs(x), hz - Math.abs(z));

  const hazards = [
    { id: "edge_front", type: "drop", a: [-hx, hz], b: [hx, hz], outward: [0, 1], height: T.height, landing: "floor" },
    { id: "edge_back", type: "drop", a: [hx, -hz], b: [-hx, -hz], outward: [0, -1], height: T.height, landing: "floor" },
    { id: "edge_right", type: "drop", a: [hx, hz], b: [hx, -hz], outward: [1, 0], height: T.height, landing: "floor", note: "the cardboard ramp meets this edge at z = " + ACC.z1 },
    { id: "edge_left", type: "drop", a: [-hx, -hz], b: [-hx, hz], outward: [-1, 0], height: T.height, landing: "floor" },
    { id: "landing_front", type: "drop", a: [ACC.xLand0, LZ1], b: [ACC.xLand1, LZ1], outward: [0, 1], height: ACC.hLand, landing: "floor" },
    { id: "landing_back", type: "drop", a: [ACC.xLand1, LZ0], b: [ACC.xLand0, LZ0], outward: [0, -1], height: ACC.hLand, landing: "floor" },
  ];
  const safePolygon = [[-hx, -hz], [hx, -hz], [hx, hz], [-hx, hz]];

  // camera: stay inside the room, above the floor, and out of furniture
  const cameraBounds = { min: [ROOM.x0 + 0.12, F + 0.05, ROOM.z0 + 0.12], max: [ROOM.x1 - 0.12, F + ROOM.wallHeight - 0.15, ROOM.z1 - 0.12] };
  function clampCamera(pos) {
    pos.x = THREE.MathUtils.clamp(pos.x, cameraBounds.min[0], cameraBounds.max[0]);
    pos.z = THREE.MathUtils.clamp(pos.z, cameraBounds.min[2], cameraBounds.max[2]);
    pos.y = THREE.MathUtils.clamp(pos.y, cameraBounds.min[1], cameraBounds.max[1]);
    for (const b of camBlockers) {
      if (!b.containsPoint(pos)) continue;
      // push out through the nearest face (never downward through the floor)
      const d = [pos.x - b.min.x, b.max.x - pos.x, b.max.y - pos.y, pos.z - b.min.z, b.max.z - pos.z];
      const k = d.indexOf(Math.min(...d));
      if (k === 0) pos.x = b.min.x - 0.01; else if (k === 1) pos.x = b.max.x + 0.01; else if (k === 2) pos.y = b.max.y + 0.01;
      else if (k === 3) pos.z = b.min.z - 0.01; else pos.z = b.max.z + 0.01;
    }
    const g = groundHeightAt(pos.x, pos.z, pos.y);
    if (pos.y < g + 0.04) pos.y = g + 0.04;
    return pos;
  }

  // ================================================================ anchors
  const spawnPoints = [
    [-0.15, F, 1.55, 0], [0.55, F, 1.85, -0.4], [1.35, F, -1.1, 2.6], [-0.3, F, -1.75, 1.2],
    [-1.55, gF, 0.15, 0], [-2.35, gF, 1.25, 0.6], [-1.45, gF, 1.55, -0.6], [1.1, F, 1.55, 3.0],
  ].map(([x, y, z, yaw], i) => ({ id: "spawn" + (i + 1), position: [x, y, z], yaw }));
  const anchors = {
    start: { position: [0, 0, -0.12], yaw: 0 },
    floorStart: { position: [-0.15, F, 1.55], yaw: 0 },
    spawnPoints,
    workbench: { position: [GA.x, F + 0.004 + GA.h, GA.z], radius: GA.r },
    garage: { position: [GA.x, F + 0.004 + GA.h, GA.z], radius: GA.r, mat: { center: [GA.x, F, GA.z], size: [GA.mw, GA.md] }, spot },
    platformTop: { position: [PLAT.x, PLAT.h, PLAT.z] },
    rampFoot: { position: [RAMP.x0 - 0.04, 0, RAMP.z] },
    tableAccess: {
      kind: "cardboard switchback",
      bottom: [ACC.xFoot - 0.12, F, ACC.z2], landing: [(ACC.xLand0 + ACC.xLand1) / 2, F + ACC.hLand, (LZ0 + LZ1) / 2], top: [ACC.xTop - 0.08, 0, ACC.z1],
      path: [[ACC.xFoot - 0.12, F, ACC.z2], [ACC.xLand0, F + ACC.hLand, ACC.z2], [(ACC.xLand0 + ACC.xLand1) / 2, F + ACC.hLand, (ACC.z1 + ACC.z2) / 2], [ACC.xLand0, F + ACC.hLand, ACC.z1], [ACC.xTop - 0.08, 0, ACC.z1]],
      slopeDeg: [THREE.MathUtils.radToDeg(Math.atan2(ACC.hLand, ACC.xLand0 - ACC.xFoot)), THREE.MathUtils.radToDeg(Math.atan2(T.height - ACC.hLand, ACC.xLand0 - ACC.xTop))],
      width: ACC.w,
    },
    pitch: { center: [RUG.x, gF, RUG.z], size: [PITCH.w, PITCH.d], ballSpawn: [RUG.x, gF, RUG.z] },
    goals,
    raceStart: { position: RACE.start, direction: RACE.dir, width: RACE.width, lineA: [RACE.start[0], F, RACE.start[2] - RACE.width / 2], lineB: [RACE.start[0], F, RACE.start[2] + RACE.width / 2] },
    checkpoints,
    window: { center: [WIN.x, WIN.y0 + WIN.h / 2, ROOM.z0], size: [WIN.w, WIN.h] },
  };

  // ================================================================ per-frame + modes
  const turntableState = { angularVelocity: 0 };
  const ringBase = glowRingMat.color.clone(), ringTint = new THREE.Color();
  const cyan = new THREE.Color("#64D2FF").multiplyScalar(2), violet = new THREE.Color("#BF5AF2").multiplyScalar(2);
  const spotBase = spot.intensity, sunBase = sun.intensity;
  let t = 0, ringFx = 0;
  return {
    root, meshes, statics, props, colliders, hazards, safePolygon, anchors,
    table: { ...T }, room: { ...ROOM }, floorY: F, cameraBounds, cameraBlockers: camBlockers,
    turntable: { object: turntable, platter, spot, state: turntableState, topY: F + 0.004 + GA.h },
    groundHeightAt, isOverDrop, distanceToEdge, clampCamera, addProp, removeProp,
    update(dt) {
      t += dt;
      platter.rotation.y += turntableState.angularVelocity * dt;
      for (const p of props) {
        const i = propShadow.get(p); if (i === undefined) continue;
        const o = p.object; if (!o.parent || !o.visible) { blobs.set(i, 0, -99, 0, 0.001, 0.001, 0); continue; }
        const gy = groundHeightAt(o.position.x, o.position.z, o.position.y);
        const hgt = Math.max(0, o.position.y - gy - p.footprint * 0.2), k = Math.max(0, 1 - hgt / 0.15);
        const s = p.footprint * (1 + hgt * 6);
        blobs.set(i, o.position.x, gy + 0.0008, o.position.z, s, s, 0.5 * k);
      }
      glowRingMat.color.copy(ringBase).lerp(ringTint, ringFx).multiplyScalar(0.85 + 0.15 * Math.sin(t * 1.6));
    },
    setWeights(w) {
      const fx = Math.min(1, (w.xray || 0) + (w.mind || 0));
      for (const [m, c] of tintMats) m.color.copy(c).multiplyScalar(1 - 0.45 * fx);
      ringTint.copy(cyan).lerp(violet, (w.mind || 0) / ((w.xray || 0) + (w.mind || 0) + 1e-5)); ringFx = fx;
      spot.intensity = spotBase * (1 - 0.4 * fx); sun.intensity = sunBase * (1 - 0.5 * fx); bounce.intensity = 0.35 * (1 - 0.5 * fx);
      skyMat.uniforms.uDim.value = 1 - 0.5 * fx;
    },
  };
}
