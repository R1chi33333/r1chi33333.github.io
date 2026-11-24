// house.js — the rest of the Microduck house around the living room: hallway (drag strip), kitchen (slippery
// tiles), kids' bedroom (bouncy bed), garden (grass, stone path, puddle, slope). Called from world.js buildWorld.
// Units: metres, floor y = F. Every room's static furniture is merged per material into its own group, so a
// room is a handful of draw calls and can be hidden as a whole when it's far from the camera.
//
// Layout (interior boxes, walls 12 cm):
//   bedroom x[-7,-3.12]  | living x[-3,3] | kitchen x[3.12,7]     z[-2.5, 2.5]
//   hallway  x[-7, 7]                                            z[2.62, 3.82]
//   garden   x[-3.5, 3.5] (outdoors, through the patio opening)  z[3.94, 7.6]

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export const WT = 0.12, DOOR_H = 2.0;
export const ROOMS = {
  living:  { x0: -3, x1: 3, z0: -2.5, z1: 2.5 },
  kitchen: { x0: 3.12, x1: 7, z0: -2.5, z1: 2.5 },
  bedroom: { x0: -7, x1: -3.12, z0: -2.5, z1: 2.5 },
  hallway: { x0: -7, x1: 7, z0: 2.62, z1: 3.82 },
  garden:  { x0: -3.5, x1: 3.5, z0: 3.94, z1: 7.6, outdoor: true },
};
// doorways (gaps in walls): wall line, along-axis range
export const DOORS = [
  { id: "living_hall",   axis: "x", at: 2.56, a: -0.45, b: 0.45 },
  { id: "bedroom_hall",  axis: "x", at: 2.56, a: -5.4, b: -4.6 },
  { id: "kitchen_hall",  axis: "x", at: 2.56, a: 4.6, b: 5.4 },
  { id: "living_bed",    axis: "z", at: -3.06, a: -1.2, b: -0.4 },
  { id: "living_kitchen", axis: "z", at: 3.06, a: -1.6, b: -0.8 },
  { id: "patio",         axis: "x", at: 3.88, a: -1.0, b: 1.0, h: 2.1 },
];
export const SURFACE_TYPES = {
  wood:  { friction: 0.7, bounce: 0 },
  rug:   { friction: 1.0, bounce: 0 },
  card:  { friction: 0.8, bounce: 0 },
  table: { friction: 0.65, bounce: 0 },
  tile:  { friction: 0.15, bounce: 0 },
  grass: { friction: 0.9, bounce: 0 },
  stone: { friction: 0.8, bounce: 0 },
  bed:   { friction: 0.9, bounce: 0.65 },
  water: { friction: 0.25, bounce: 0 },
};

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function canvas(w, h, draw) { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d"), w, h); return c; }
function ctex(c, renderer, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return t;
}
const INKC = "#1B1430";

// ------------------------------------------------------------------ see-through walls (comic cutaway)
// Wall fragments inside a capsule around the camera -> focus segment are cut away; a band of ink is kept at the
// cut edge. Shared uniforms: world.js updates camera + focus each frame.
export const CUT = { uCutCam: { value: new THREE.Vector3() }, uCutFocus: { value: new THREE.Vector3() }, uCutR: { value: 0.42 }, uCutOn: { value: 0 }, uCutTop: { value: 0 }, uCutInk: { value: new THREE.Color(INKC) } };
export function cutaway(mat) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = function (s, r) {
    if (prev) prev.call(this, s, r);
    Object.assign(s.uniforms, CUT);
    s.vertexShader = "varying vec3 vCutW;\n" + s.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n vCutW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    s.fragmentShader = "varying vec3 vCutW; uniform vec3 uCutCam, uCutFocus, uCutInk; uniform float uCutR, uCutOn, uCutTop; float cutInk = 0.0;\n" + s.fragmentShader
      .replace("#include <clipping_planes_fragment>", `#include <clipping_planes_fragment>
        if (uCutTop != 0.0) { if (vCutW.y > uCutTop) discard; cutInk = step(uCutTop - 0.03, vCutW.y); }   // dollhouse view: walls cut at a height, inked top edge
        if (uCutOn > 0.5) {
          vec3 ab = uCutFocus - uCutCam; float L2 = max(dot(ab, ab), 1e-4), L = sqrt(L2);
          float t = clamp(dot(vCutW - uCutCam, ab) / L2, 0.0, 1.0);
          float d = length(vCutW - (uCutCam + ab * t));
          float tEnd = 1.0 - 0.12 / L;                                   // never cut right at / behind the duck
          float R = uCutR * smoothstep(0.0, 0.08, t);
          if (t < tEnd) { if (d < R) discard; cutInk = 1.0 - step(R + 0.022, d); }
        }`)
      .replace("#include <dithering_fragment>", "#include <dithering_fragment>\n if (cutInk > 0.5) gl_FragColor.rgb = uCutInk;");
  };
  const key = mat.customProgramCacheKey;
  mat.customProgramCacheKey = () => (key && key !== THREE.Material.prototype.customProgramCacheKey ? key.call(mat) : "") + "|cut";
  mat.needsUpdate = true;
  return mat;
}

// ------------------------------------------------------------------ textures
function tileCanvas(size, a, b, grout) {
  return canvas(size, size, (g, w) => {
    const n = 4, s = w / n;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? a : b; g.fillRect(x * s, y * s, s, s); }
    // shine ticks (comic gloss marks)
    g.strokeStyle = "rgba(255,255,255,0.75)"; g.lineWidth = w / 110; g.lineCap = "round";
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x * 3 + y) % 4 === 0) { g.beginPath(); g.moveTo(x * s + s * 0.18, y * s + s * 0.34); g.lineTo(x * s + s * 0.34, y * s + s * 0.18); g.stroke(); }
    g.strokeStyle = grout; g.lineWidth = w / 90;
    for (let i = 0; i <= n; i++) { g.beginPath(); g.moveTo(i * s, 0); g.lineTo(i * s, w); g.stroke(); g.beginPath(); g.moveTo(0, i * s); g.lineTo(w, i * s); g.stroke(); }
  });
}
function grassCanvas(size, seed, hi) {
  const R = rng(seed);
  return canvas(size, size, (g, w) => {
    g.fillStyle = "#7CCB5A"; g.fillRect(0, 0, w, w);
    // flat comic patches + drawn tufts
    for (let i = 0; i < 26; i++) { g.fillStyle = R() < 0.5 ? "#6FBE4E" : "#8AD866"; g.beginPath(); g.ellipse(R() * w, R() * w, w * (0.05 + R() * 0.08), w * (0.03 + R() * 0.05), R() * 3, 0, 7); g.fill(); }
    g.strokeStyle = "#3F8A38"; g.lineWidth = w / 260; g.lineCap = "round";
    for (let i = 0; i < (hi ? 160 : 70); i++) {
      const x = R() * w, y = R() * w, s = w * (0.012 + R() * 0.012);
      g.beginPath(); g.moveTo(x - s, y); g.lineTo(x - s * 0.4, y - s * 1.6); g.moveTo(x, y); g.lineTo(x + s * 0.1, y - s * 2.1); g.moveTo(x + s, y); g.lineTo(x + s * 0.5, y - s * 1.5); g.stroke();
    }
    g.fillStyle = "rgba(255,255,255,0.5)"; for (let i = 0; i < 30; i++) { g.beginPath(); g.arc(R() * w, R() * w, w / 260, 0, 7); g.fill(); }
  });
}
function skyCanvas(w, h) {
  const R = rng(5);
  return canvas(w, h, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, "#6CC6F2"); gr.addColorStop(0.6, "#A9E0FA"); gr.addColorStop(0.82, "#E6F6FD"); gr.addColorStop(1, "#E6F6FD");
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    const lw = Math.max(3, w / 600);
    const cloud = (cx, cy, s) => { g.fillStyle = "#FFFFFF"; g.strokeStyle = INKC; g.lineWidth = lw;
      const B = [[-1, 0, .55], [-.35, -.35, .7], [.35, -.25, .62], [.95, .05, .48], [0, .15, .6]];
      for (const [dx, dy, r] of B) { g.beginPath(); g.arc(cx + dx * s, cy + dy * s, r * s, 0, 7); g.stroke(); }
      for (const [dx, dy, r] of B) { g.beginPath(); g.arc(cx + dx * s, cy + dy * s, r * s, 0, 7); g.fill(); } };
    for (let i = 0; i < 9; i++) cloud(R() * w, h * (0.12 + R() * 0.3), h * (0.05 + R() * 0.04));
    // distant hedge + tree tops along the horizon
    const base = h * 0.8;
    g.fillStyle = "#4FA84A"; g.strokeStyle = INKC; g.lineWidth = lw;
    g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += w / 90) g.lineTo(x, base - h * 0.03 * (1 + Math.sin(x * 0.05) * 0.5) - R() * h * 0.01); g.lineTo(w, h); g.closePath(); g.fill(); g.stroke();
    for (let i = 0; i < 18; i++) { const x = R() * w, r = h * (0.05 + R() * 0.05); g.fillStyle = R() < 0.5 ? "#3E9A45" : "#58B250"; g.beginPath(); g.arc(x, base - r * 0.6, r, Math.PI, 0); g.closePath(); g.fill(); g.stroke(); }
    g.fillStyle = "#6CBF4F"; g.fillRect(0, base + h * 0.02, w, h);
  });
}

// ------------------------------------------------------------------ build
/**
 * ctx: { root, renderer, hi, phone, F, Batch, wallMat, trimMat, plankMat (living floor material), cuboid, convex, surface(s), blocker, tint, blobs }
 * returns { groups: {room: Group}, rooms (anchors), lights, props: [[factoryName, x, y, z, yaw]], dragStrip, raceHouse, spawn, drawInfo }
 */
export function buildHouse(ctx) {
  const { root, renderer, hi, phone, F, Batch, wallMat, trimMat, cuboid, surface, tint } = ctx;
  const Q0 = [0, 0, 0, 1];
  const shell = ctx.shell;                     // living shell batch: all walls share the cutaway wall material
  const groups = {}, batches = {};
  for (const k of ["hallway", "kitchen", "bedroom", "garden"]) {
    const g = new THREE.Group(); g.name = "room_" + k; root.add(g); groups[k] = g; batches[k] = new Batch();
  }
  const std = (name, o) => tint(new THREE.MeshStandardMaterial({ name, roughness: 0.85, ...o }));
  const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 3, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));
  const M = (x, y, z, ry = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry), new THREE.Vector3(1, 1, 1));
  const box = (room, w, h, d, mat, x, y, z, ry = 0, r = 0) => batches[room].add(r > 0 ? rbox(w, h, d, r) : new THREE.BoxGeometry(w, h, d), mat, M(x, y, z, ry));
  const solid = (id, room, w, h, d, mat, x, y, z, r = 0) => { box(room, w, h, d, mat, x, y, z, 0, r); cuboid(id, x, y, z, w / 2, h / 2, d / 2); };
  const floorPlane = (room, mat, x0, x1, z0, z1, y = F) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0).rotateX(-Math.PI / 2), mat);
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2); m.receiveShadow = true; m.castShadow = false; m.userData.lookNoContact = true; m.name = "floor_" + room; groups[room].add(m); return m; };
  const WH = 2.5;

  // ================================================================ WALLS (shared shell; gaps = doorways, lintels above)
  const wallAlongX = (id, z, x0, x1, gaps = []) => {   // wall on line z, spanning x
    let a = x0; const segs = [];
    for (const g of [...gaps].sort((p, q) => p.a - q.a)) { segs.push([a, g.a]); a = g.b;
      const h = g.h || DOOR_H; shell.box(g.b - g.a, WH - h, WT, wallMat, (g.a + g.b) / 2, F + h + (WH - h) / 2, z);
      // door frame trim (jambs + head), both faces
      for (const s of [-1, 1]) { shell.box(0.05, h, WT + 0.03, trimMat, (s < 0 ? g.a : g.b) + s * 0.025, F + h / 2, z); }
      shell.box(g.b - g.a + 0.1, 0.05, WT + 0.03, trimMat, (g.a + g.b) / 2, F + h + 0.025, z);
    }
    segs.push([a, x1]);
    segs.forEach(([p, q], i) => { if (q - p < 1e-3) return; shell.box(q - p, WH, WT, wallMat, (p + q) / 2, F + WH / 2, z); cuboid(id + "_" + i, (p + q) / 2, F + WH / 2, z, (q - p) / 2, WH / 2, WT / 2); });
  };
  const wallAlongZ = (id, x, z0, z1, gaps = []) => {
    let a = z0; const segs = [];
    for (const g of [...gaps].sort((p, q) => p.a - q.a)) { segs.push([a, g.a]); a = g.b;
      const h = g.h || DOOR_H; shell.box(WT, WH - h, g.b - g.a, wallMat, x, F + h + (WH - h) / 2, (g.a + g.b) / 2);
      for (const s of [-1, 1]) shell.box(WT + 0.03, h, 0.05, trimMat, x, F + h / 2, (s < 0 ? g.a : g.b) + s * 0.025);
      shell.box(WT + 0.03, 0.05, g.b - g.a + 0.1, trimMat, x, F + h + 0.025, (g.a + g.b) / 2);
    }
    segs.push([a, z1]);
    segs.forEach(([p, q], i) => { if (q - p < 1e-3) return; shell.box(WT, WH, q - p, wallMat, x, F + WH / 2, (p + q) / 2); cuboid(id + "_" + i, x, F + WH / 2, (p + q) / 2, WT / 2, WH / 2, (q - p) / 2); });
  };
  const gapsOn = (axis, at) => DOORS.filter(d => d.axis === axis && Math.abs(d.at - at) < 1e-3);
  wallAlongX("wall_hall_back", 2.56, -7.12, 7.12, gapsOn("x", 2.56));          // living front / hallway back
  wallAlongX("wall_hall_front", 3.88, -7.12, 7.12, gapsOn("x", 3.88));         // hallway / garden (patio)
  wallAlongZ("wall_living_left", -3.06, -2.62, 2.5, gapsOn("z", -3.06));
  wallAlongZ("wall_living_right", 3.06, -2.62, 2.5, gapsOn("z", 3.06));
  wallAlongX("wall_kitchen_back", -2.56, 3.0, 7.12);
  wallAlongX("wall_bedroom_back", -2.56, -7.12, -3.0);
  wallAlongZ("wall_east", 7.06, -2.62, 3.94);
  wallAlongZ("wall_west", -7.06, -2.62, 3.94);
  // baseboards per room (skipping doorways)
  const BB = 0.08, BT = 0.015;
  const baseX = (z, x0, x1, inward) => { let a = x0; const gaps = DOORS.filter(d => d.axis === "x" && Math.abs(d.at - (z - inward * (WT / 2))) < 0.07 && d.b > x0 && d.a < x1);
    for (const g of gaps.sort((p, q) => p.a - q.a)) { if (g.a - a > 0.01) shell.box(g.a - a, BB, BT, trimMat, (a + g.a) / 2, F + BB / 2, z + inward * BT / 2); a = g.b; }
    if (x1 - a > 0.01) shell.box(x1 - a, BB, BT, trimMat, (a + x1) / 2, F + BB / 2, z + inward * BT / 2); };
  const baseZ = (x, z0, z1, inward) => { let a = z0; const gaps = DOORS.filter(d => d.axis === "z" && Math.abs(d.at - (x - inward * (WT / 2))) < 0.07 && d.b > z0 && d.a < z1);
    for (const g of gaps.sort((p, q) => p.a - q.a)) { if (g.a - a > 0.01) shell.box(BT, BB, g.a - a, trimMat, x + inward * BT / 2, F + BB / 2, (a + g.a) / 2); a = g.b; }
    if (z1 - a > 0.01) shell.box(BT, BB, z1 - a, trimMat, x + inward * BT / 2, F + BB / 2, (a + z1) / 2); };
  for (const k of ["living", "kitchen", "bedroom", "hallway"]) {
    const r = ROOMS[k];
    if (k !== "living") baseX(r.z0, r.x0, r.x1, 1);        // living's back baseboard is built with its window wall
    baseX(r.z1, r.x0, r.x1, -1); baseZ(r.x0, r.z0, r.z1, 1); baseZ(r.x1, r.z0, r.z1, -1);
  }

  // ================================================================ HALLWAY: long plank corridor + drag strip
  const H = ROOMS.hallway, hz = (H.z0 + H.z1) / 2;
  const hallMat = ctx.plankMat.clone(); hallMat.name = "hall_floor"; hallMat.map = ctx.plankMat.map.clone(); hallMat.map.needsUpdate = true;
  hallMat.map.repeat.set((H.x1 - H.x0) / 2.0, (H.z1 - H.z0) / 1.0); tint(hallMat);
  floorPlane("hallway", hallMat, H.x0 - 0.12, H.x1 + 0.12, H.z0 - 0.12, H.z1 + 0.12);   // runs under the walls / door thresholds
  const DRAG = { start: [-6.2, F, hz], finish: [6.2, F, hz], direction: [1, 0, 0], width: 0.95 };
  const chk = canvas(64, 512, (g, w, h) => { for (let y = 0; y < h; y += 32) for (let x = 0; x < w; x += 32) { g.fillStyle = ((x + y) / 32) % 2 ? "#111" : "#F4F1EA"; g.fillRect(x, y, 32, 32); } });
  const tapeMat = new THREE.MeshStandardMaterial({ name: "hall_tape", map: ctex(chk, renderer), roughness: 0.6 });
  const label = (text, col) => { const c = canvas(512, 128, (g, w, h) => { g.fillStyle = col; g.fillRect(0, 0, w, h); g.strokeStyle = INKC; g.lineWidth = 10; g.strokeRect(5, 5, w - 10, h - 10);
    g.font = "bold 84px Bangers, Impact, 'Arial Black', sans-serif"; g.textAlign = "center"; g.textBaseline = "middle"; g.lineWidth = 8; g.strokeStyle = INKC; g.strokeText(text, w / 2, h / 2 + 4); g.fillStyle = "#FFFFFF"; g.fillText(text, w / 2, h / 2 + 4); });
    return new THREE.MeshStandardMaterial({ name: "hall_label_" + text, map: ctex(c, renderer), roughness: 0.7 }); };
  for (const [p, txt, col, s] of [[DRAG.start, "START", "#FF5D73", 1], [DRAG.finish, "FINISH", "#3A86FF", -1]]) {
    batches.hallway.add(new THREE.PlaneGeometry(0.06, DRAG.width).rotateX(-Math.PI / 2), tapeMat, M(p[0], F + 0.0012, p[2]));
    batches.hallway.add(new THREE.PlaneGeometry(0.4, 0.1).rotateX(-Math.PI / 2), label(txt, col), M(p[0] - s * 0.3, F + 0.0012, p[2], s > 0 ? -Math.PI / 2 : Math.PI / 2));
  }
  // dashed centre tape down the strip
  const dashMat = std("hall_dash", { color: "#FFC43D" });
  for (let x = DRAG.start[0] + 0.4; x < DRAG.finish[0] - 0.3; x += 0.5) batches.hallway.add(new THREE.PlaneGeometry(0.22, 0.03).rotateX(-Math.PI / 2), dashMat, M(x, F + 0.0011, hz));
  // framed comic pictures on the walls, a coat rack with hooks, a shoe pair by the patio
  const frameMat = std("frame", { color: "#3D3B4F" });
  const picCols = ["#FF5D73", "#FFC43D", "#1FA6A0", "#7B61FF", "#3A86FF"];
  const picMats = picCols.map((c, i) => std("picture" + i, { color: c }));
  [-6.3, -3.6, -2.0, 2.0, 3.6, 6.3].forEach((x, i) => {
    const z = i % 2 ? H.z1 - 0.02 : H.z0 + 0.02;
    if (DOORS.some(d => d.axis === "x" && x > d.a - 0.45 && x < d.b + 0.45 && Math.abs(d.at - (i % 2 ? 3.88 : 2.56)) < 1e-3)) return;
    box("hallway", 0.5, 0.38, 0.03, frameMat, x, F + 1.45, z);
    box("hallway", 0.42, 0.3, 0.035, picMats[i % picMats.length], x, F + 1.45, z);
  });
  const hookMat = std("hooks", { color: "#FFC43D" });
  box("hallway", 0.9, 0.08, 0.03, frameMat, -2.6, F + 1.6, H.z1 - 0.02);
  for (let i = 0; i < 4; i++) box("hallway", 0.03, 0.08, 0.08, hookMat, -2.95 + i * 0.23, F + 1.56, H.z1 - 0.06, 0, 0.012);
  const shoeMat = std("shoe", { color: "#FF5D73" });
  for (const dx of [0, 0.14]) solid("shoe_" + dx, "hallway", 0.1, 0.07, 0.26, shoeMat, 1.45 + dx, F + 0.035, H.z1 - 0.2, 0.03);

  // ================================================================ KITCHEN: slippery chequer tiles, fridge, cabinets, table + chairs
  const K = ROOMS.kitchen;
  const tileTex = ctex(tileCanvas(hi ? 512 : 256, "#F4F1EA", "#6CC6B8", "#2A6B66"), renderer, [(K.x1 - K.x0) / 0.8, (K.z1 - K.z0) / 0.8]);
  const tileMat = tint(new THREE.MeshStandardMaterial({ name: "kitchen_tile", map: tileTex, roughness: 0.3 }));
  tileMat.userData.toonLift = 0.25;
  floorPlane("kitchen", tileMat, K.x0 - 0.12, K.x1 + 0.12, K.z0 - 0.12, K.z1);
  // cabinets along the back wall with a counter top, sink, oven door, upper cabinets
  const cabMat = std("cabinet", { color: "#FFF6E4" }), counterMat = std("counter", { color: "#3D3B4F", roughness: 0.4 }), knobMat = std("knob", { color: "#FFC43D" });
  const CAB = { x0: 3.3, x1: 5.9, d: 0.6, h: 0.86 };
  solid("kitchen_cabinets", "kitchen", CAB.x1 - CAB.x0, CAB.h, CAB.d, cabMat, (CAB.x0 + CAB.x1) / 2, F + CAB.h / 2, K.z0 + CAB.d / 2);
  box("kitchen", CAB.x1 - CAB.x0 + 0.04, 0.05, CAB.d + 0.04, counterMat, (CAB.x0 + CAB.x1) / 2, F + CAB.h + 0.025, K.z0 + CAB.d / 2, 0, 0.012);
  for (let x = CAB.x0 + 0.3; x < CAB.x1; x += 0.6) { box("kitchen", 0.56, 0.78, 0.02, cabMat, x, F + 0.43, K.z0 + CAB.d + 0.01, 0, 0.01); box("kitchen", 0.12, 0.025, 0.03, knobMat, x, F + 0.74, K.z0 + CAB.d + 0.03, 0, 0.01); }
  box("kitchen", 0.5, 0.02, 0.36, std("sink", { color: "#B9C3CF", roughness: 0.3 }), 4.4, F + CAB.h + 0.052, K.z0 + 0.3);
  box("kitchen", 0.04, 0.3, 0.04, counterMat, 4.4, F + CAB.h + 0.2, K.z0 + 0.1);
  for (let x = CAB.x0 + 0.3; x < CAB.x1; x += 0.6) box("kitchen", 0.56, 0.7, 0.34, cabMat, x, F + 1.75, K.z0 + 0.17, 0, 0.02);
  // fridge (mint, chunky), in the corner by the east wall
  const fridgeMat = std("fridge", { color: "#8FD3B6", roughness: 0.5 });
  ctx.blocker(K.x1 - 0.8, F, K.z0, K.x1, F + 1.9, K.z0 + 0.75); ctx.blocker(CAB.x0, F, K.z0, CAB.x1, F + 0.92, K.z0 + 0.62);
  solid("fridge", "kitchen", 0.72, 1.85, 0.68, fridgeMat, K.x1 - 0.42, F + 0.925, K.z0 + 0.38, 0.05);
  box("kitchen", 0.04, 0.45, 0.05, knobMat, K.x1 - 0.72, F + 1.4, K.z0 + 0.75, 0, 0.015);
  box("kitchen", 0.04, 0.35, 0.05, knobMat, K.x1 - 0.72, F + 0.75, K.z0 + 0.75, 0, 0.015);
  box("kitchen", 0.7, 0.015, 0.02, counterMat, K.x1 - 0.42, F + 1.15, K.z0 + 0.725);
  // kitchen table + 4 chairs: ducks run underneath, only the legs collide
  const KT = { x: 5.1, z: 0.6, w: 1.25, d: 0.8, h: 0.74 };
  const ktMat = std("kitchen_table", { color: "#FF8A3D" }), legMat = std("kitchen_leg", { color: "#3D3B4F" });
  box("kitchen", KT.w, 0.05, KT.d, ktMat, KT.x, F + KT.h, KT.z, 0, 0.02);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const lx = KT.x + sx * (KT.w / 2 - 0.07), lz = KT.z + sz * (KT.d / 2 - 0.07);
    batches.kitchen.add(new THREE.CylinderGeometry(0.025, 0.02, KT.h, 12), legMat, M(lx, F + KT.h / 2, lz));
    ctx.cylinder("kt_leg" + sx + sz, lx, F + KT.h / 2, lz, 0.025, KT.h / 2);
  }
  ctx.blocker(KT.x - KT.w / 2, F + KT.h - 0.03, KT.z - KT.d / 2, KT.x + KT.w / 2, F + KT.h + 0.05, KT.z + KT.d / 2);
  const chairMat = std("chair", { color: "#FFC43D" });
  [[KT.x - 0.32, KT.z - KT.d / 2 - 0.25, 0], [KT.x + 0.32, KT.z - KT.d / 2 - 0.25, 0], [KT.x - 0.32, KT.z + KT.d / 2 + 0.25, Math.PI], [KT.x + 0.32, KT.z + KT.d / 2 + 0.25, Math.PI]].forEach(([cx, cz, ry], i) => {
    box("kitchen", 0.4, 0.04, 0.4, chairMat, cx, F + 0.45, cz, 0, 0.012); ctx.blocker(cx - 0.22, F + 0.4, cz - 0.22, cx + 0.22, F + 0.92, cz + 0.22);
    const bz = cz + (ry ? 0.18 : -0.18); box("kitchen", 0.4, 0.42, 0.035, chairMat, cx, F + 0.68, bz, 0, 0.012);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) { const lx = cx + sx * 0.16, lz = cz + sz * 0.16;
      batches.kitchen.add(new THREE.CylinderGeometry(0.016, 0.014, 0.45, 10), legMat, M(lx, F + 0.225, lz)); ctx.cylinder("chair" + i + "_" + sx + sz, lx, F + 0.225, lz, 0.016, 0.225); }
  });
  // fruit bowl on the table (static)
  box("kitchen", 0.3, 0.06, 0.3, std("bowl", { color: "#3A86FF" }), KT.x, F + KT.h + 0.055, KT.z, 0, 0.03);
  for (const [dx, dz, c] of [[-0.05, 0, "#FF5D73"], [0.06, 0.03, "#FFC43D"], [0, -0.07, "#8FD35A"]]) batches.kitchen.add(new THREE.SphereGeometry(0.05, 14, 10), std("fruit_" + c, { color: c }), M(KT.x + dx, F + KT.h + 0.12, KT.z + dz));
  // a striped kitchen mat by the counter (stays tile for physics: it's a decal)
  const kitLight = new THREE.PointLight(0xffc887, 2.2, 5.5, 1.6); kitLight.position.set((K.x0 + K.x1) / 2, F + 2.15, 0.3); groups.kitchen.add(kitLight);
  box("kitchen", 0.36, 0.08, 0.36, std("lamp_k", { color: "#FFE9A8", emissive: new THREE.Color("#FFD27A"), emissiveIntensity: 0.6 }), kitLight.position.x, F + 2.3, kitLight.position.z, 0, 0.04);

  // ================================================================ BEDROOM: bouncy bed, block ramp, toy box, round rug
  const B = ROOMS.bedroom;
  const bedFloor = ctx.plankMat.clone(); bedFloor.name = "bed_floor"; bedFloor.map = ctx.plankMat.map.clone(); bedFloor.map.needsUpdate = true;
  bedFloor.map.repeat.set((B.x1 - B.x0) / 2.0, (B.z1 - B.z0) / 1.0); bedFloor.color = new THREE.Color("#F6E6FF"); tint(bedFloor);
  floorPlane("bedroom", bedFloor, B.x0 - 0.12, B.x1 + 0.12, B.z0 - 0.12, B.z1);
  // round rug with a target pattern
  const RUGB = { x: -4.95, z: 0.9, r: 1.0 };
  const rugTex = ctex(canvas(512, 512, (g, w) => { const c = ["#7B61FF", "#FFC43D", "#FF5D73", "#7B61FF", "#FFF6E4"];
    for (let i = 0; i < 5; i++) { g.fillStyle = c[i]; g.beginPath(); g.arc(w / 2, w / 2, w / 2 * (1 - i * 0.19), 0, 7); g.fill(); }
    g.strokeStyle = INKC; g.lineWidth = 6; for (let i = 0; i < 5; i++) { g.beginPath(); g.arc(w / 2, w / 2, w / 2 * (1 - i * 0.19) - 3, 0, 7); g.stroke(); } }), renderer);
  const rugBMat = tint(new THREE.MeshStandardMaterial({ name: "bed_rug", map: rugTex, roughness: 1 }));
  batches.bedroom.add(new THREE.CylinderGeometry(RUGB.r, RUGB.r, 0.006, 48), rugBMat, M(RUGB.x, F + 0.003, RUGB.z));
  surface({ id: "bedroom_rug", type: "rug", h: () => F + 0.006, test: (x, z) => (x - RUGB.x) ** 2 + (z - RUGB.z) ** 2 <= RUGB.r * RUGB.r });
  // low kids' bed along the back wall: frame + bouncy mattress + headboard + pillow + quilt
  const BED = { x0: -6.92, x1: -5.0, z0: -2.45, z1: -1.4, top: 0.15 };
  const bedMat = std("bed_frame", { color: "#3A86FF" }), mattMat = std("mattress", { color: "#FFF6E4" }), quiltMat = std("quilt", { color: "#FF5D73" }), pillowMat = std("pillow", { color: "#FFFFFF" });
  const bcx = (BED.x0 + BED.x1) / 2, bcz = (BED.z0 + BED.z1) / 2, bw = BED.x1 - BED.x0, bd = BED.z1 - BED.z0;
  solid("bed_frame", "bedroom", bw, 0.08, bd, bedMat, bcx, F + 0.04, bcz, 0.015);
  box("bedroom", bw - 0.04, BED.top - 0.08, bd - 0.04, mattMat, bcx, F + 0.08 + (BED.top - 0.08) / 2, bcz, 0, 0.03);
  cuboid("bed_mattress", bcx, F + 0.08 + (BED.top - 0.08) / 2, bcz, (bw - 0.04) / 2, (BED.top - 0.08) / 2, (bd - 0.04) / 2, Q0, 0.9);
  box("bedroom", bw * 0.55, 0.012, bd - 0.02, quiltMat, bcx + bw * 0.2, F + BED.top + 0.006, bcz, 0, 0.005);
  box("bedroom", 0.3, 0.06, 0.55, pillowMat, BED.x0 + 0.25, F + BED.top + 0.03, bcz, 0, 0.025);
  solid("bed_head", "bedroom", 0.08, 0.6, bd, bedMat, BED.x0 + 0.04, F + 0.3, bcz, 0.03);
  surface({ id: "bed", type: "bed", h: () => F + BED.top, test: (x, z) => x >= BED.x0 + 0.08 && x <= BED.x1 - 0.02 && z >= BED.z0 + 0.02 && z <= BED.z1 - 0.02 });
  // building-block ramp: floor -> foot of the bed (stacked colour blocks, one smooth slope underneath)
  const BR = { xa: -4.4, xb: BED.x1, z: -1.92, w: 0.34, h: BED.top };
  const slope = new THREE.Shape([new THREE.Vector2(BR.xb, 0), new THREE.Vector2(BR.xa, 0), new THREE.Vector2(BR.xb, BR.h)]);
  const rampGeo = new THREE.ExtrudeGeometry(slope, { depth: BR.w, bevelEnabled: false }); rampGeo.translate(0, 0, -BR.w / 2);
  const rampGeoW = rampGeo.clone().applyMatrix4(new THREE.Matrix4().makeTranslation(0, F, BR.z));
  batches.bedroom.add(rampGeo, std("block_ramp", { color: "#FFC43D" }), new THREE.Matrix4().makeTranslation(0, F, BR.z));
  const blockCols = ["#FF5D73", "#3A86FF", "#1FA6A0", "#7B61FF"].map((c, i) => std("block" + i, { color: c }));
  for (let i = 0; i < 4; i++) { const t0 = i / 4, x = BR.xa + (BR.xb - BR.xa) * (t0 + 0.125), hgt = BR.h * (t0 + 0.125);
    for (const s of [-1, 1]) box("bedroom", Math.abs(BR.xb - BR.xa) / 4 - 0.01, hgt * 0.8, 0.05, blockCols[(i + (s > 0 ? 1 : 0)) % 4], x, F + hgt * 0.4, BR.z + s * (BR.w / 2 + 0.025), 0, 0.006); }
  ctx.convex("block_ramp", [[BR.xa, F, BR.z - BR.w / 2], [BR.xa, F, BR.z + BR.w / 2], [BR.xb, F, BR.z - BR.w / 2], [BR.xb, F, BR.z + BR.w / 2], [BR.xb, F + BR.h, BR.z - BR.w / 2], [BR.xb, F + BR.h, BR.z + BR.w / 2]]);
  surface({ id: "block_ramp", type: "wood", test: (x, z) => x >= Math.min(BR.xa, BR.xb) && x <= Math.max(BR.xa, BR.xb) && Math.abs(z - BR.z) <= BR.w / 2, h: (x) => F + BR.h * (x - BR.xa) / (BR.xb - BR.xa) });
  void rampGeoW;
  // toy box with an open lid, a small bookcase, a star night light
  const toyMat = std("toy_box", { color: "#FF8A3D" });
  solid("toy_box", "bedroom", 0.55, 0.34, 0.38, toyMat, -3.65, F + 0.17, B.z0 + 0.25, 0.02);
  box("bedroom", 0.55, 0.03, 0.38, std("toy_lid", { color: "#FFC43D" }), -3.65, F + 0.5, B.z0 + 0.08, 0, 0.01);
  for (const [dx, c] of [[-0.12, "#3A86FF"], [0.05, "#1FA6A0"], [0.16, "#FF5D73"]]) box("bedroom", 0.12, 0.12, 0.12, std("toybox_block" + c, { color: c }), -3.65 + dx, F + 0.36, B.z0 + 0.25, dx * 3, 0.01);
  const caseMat = std("bookcase", { color: "#FFF6E4" });
  solid("bookcase", "bedroom", 0.3, 0.9, 0.9, caseMat, B.x0 + 0.15, F + 0.45, 1.6, 0.015);
  for (let i = 0; i < 6; i++) box("bedroom", 0.2, 0.2, 0.1, blockCols[i % 4], B.x0 + 0.17, F + 0.55 + (i > 2 ? 0.28 : 0), 1.3 + (i % 3) * 0.24);
  const bedLight = new THREE.PointLight(0x9cc2ff, 2.0, 5.0, 1.6); bedLight.position.set(-5.0, F + 2.1, 0.2); groups.bedroom.add(bedLight);
  const star = new THREE.Shape(); for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 0.07 : 0.16; i ? star.lineTo(Math.cos(a) * r, Math.sin(a) * r) : star.moveTo(Math.cos(a) * r, Math.sin(a) * r); }
  batches.bedroom.add(new THREE.ExtrudeGeometry(star, { depth: 0.04, bevelEnabled: false }), std("star_lamp", { color: "#FFE45C", emissive: new THREE.Color("#FFD23F"), emissiveIntensity: 0.7 }), M(-5.0, F + 2.25, 0.2));

  // ================================================================ GARDEN: grass, stone path, puddle, slope, fence, plants, sky
  const G = ROOMS.garden;
  const grassTex = ctex(grassCanvas(hi ? 512 : 256, 41, hi), renderer, [(G.x1 - G.x0) / 1.2, (G.z1 - G.z0) / 1.2]);
  const grassMat = tint(new THREE.MeshStandardMaterial({ name: "grass", map: grassTex, roughness: 1 })); grassMat.userData.toonLift = 0.35;
  floorPlane("garden", grassMat, G.x0, G.x1, G.z0, G.z1);
  // patio step / threshold slab just outside the door
  const stoneMat = std("stone", { color: "#C9C3D6" }); stoneMat.userData.toonLift = 0.35;
  box("garden", 2.2, 0.006, 0.5, stoneMat, 0, F + 0.003, G.z0 + 0.25, 0, 0.002);
  surface({ id: "patio", type: "stone", h: () => F + 0.006, test: (x, z) => Math.abs(x) <= 1.1 && z >= G.z0 && z <= G.z0 + 0.5 });
  // stepping-stone path curving out into the garden
  const stones = [];
  for (let i = 0; i < 7; i++) { const t = i / 6; stones.push([Math.sin(t * 2.4) * 0.9 - 0.2, G.z0 + 0.75 + t * 2.5, 0.2 + (i % 2) * 0.04]); }
  for (const [x, z, r] of stones) {
    batches.garden.add(new THREE.CylinderGeometry(r, r * 1.04, 0.012, 10), stoneMat, M(x, F + 0.003, z, x * 3));
    surface({ id: "stone", type: "stone", h: () => F + 0.008, test: (px, pz) => (px - x) ** 2 + (pz - z) ** 2 <= r * r });
  }
  // shallow puddle (splashable): flat water with ink rim and gloss ticks
  const PUD = { x: 1.45, z: 5.2, rx: 0.42, rz: 0.28 };
  const pudTex = ctex(canvas(256, 256, (g, w) => { g.fillStyle = INKC; g.beginPath(); g.ellipse(w / 2, w / 2, w / 2 - 2, w / 2 - 2, 0, 0, 7); g.fill();
    g.fillStyle = "#5BC0EB"; g.beginPath(); g.ellipse(w / 2, w / 2, w / 2 - 10, w / 2 - 10, 0, 0, 7); g.fill();
    g.fillStyle = "#8FD8F5"; g.beginPath(); g.ellipse(w / 2 + 14, w / 2 + 16, w / 2 - 40, w / 2 - 46, 0, 0, 7); g.fill();
    g.strokeStyle = "#FFFFFF"; g.lineWidth = 10; g.lineCap = "round"; for (const [x0, y0, x1, y1] of [[60, 80, 100, 64], [70, 110, 90, 102], [170, 180, 196, 168]]) { g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); } }), renderer);
  const pudMat = tint(new THREE.MeshStandardMaterial({ name: "puddle", map: pudTex, transparent: true, alphaTest: 0.5, roughness: 0.1 })); pudMat.userData.toonLift = 0.5;
  const pud = new THREE.Mesh(new THREE.PlaneGeometry(PUD.rx * 2, PUD.rz * 2).rotateX(-Math.PI / 2), pudMat); pud.position.set(PUD.x, F + 0.0015, PUD.z); pud.receiveShadow = true; pud.userData.lookNoContact = true; groups.garden.add(pud);
  // texture alpha: canvas fills only the ellipse; outside is transparent
  surface({ id: "puddle", type: "water", h: () => F, test: (x, z) => ((x - PUD.x) / PUD.rx) ** 2 + ((z - PUD.z) / PUD.rz) ** 2 <= 0.92 });
  // gentle grassy slope (rises east, 8 deg) with a plateau along the fence
  const SL = { xa: 1.7, xb: 2.9, x1: 3.45, z0: 5.9, z1: 7.5, h: 0.17 };
  const slopeShape = new THREE.Shape([new THREE.Vector2(SL.xa, 0), new THREE.Vector2(SL.x1, 0), new THREE.Vector2(SL.x1, SL.h), new THREE.Vector2(SL.xb, SL.h)]);
  const slopeGeo = new THREE.ExtrudeGeometry(slopeShape, { depth: SL.z1 - SL.z0, bevelEnabled: false }); slopeGeo.translate(0, 0, SL.z0);
  // planar UVs so the grass texture continues across the mound
  { const p = slopeGeo.attributes.position, uv = slopeGeo.attributes.uv; for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 1.2, p.getZ(i) / 1.2); }
  const slopeMat = grassMat.clone(); slopeMat.map = grassTex.clone(); slopeMat.map.repeat.set(1, 1); slopeMat.map.needsUpdate = true; slopeMat.userData = { ...grassMat.userData }; tint(slopeMat);
  batches.garden.add(slopeGeo, slopeMat, new THREE.Matrix4().makeTranslation(0, F, 0));
  ctx.convex("garden_slope", [[SL.xa, F, SL.z0], [SL.xa, F, SL.z1], [SL.x1, F, SL.z0], [SL.x1, F, SL.z1], [SL.xb, F + SL.h, SL.z0], [SL.xb, F + SL.h, SL.z1], [SL.x1, F + SL.h, SL.z0], [SL.x1, F + SL.h, SL.z1]]);
  surface({ id: "garden_slope", type: "grass", test: (x, z) => x >= SL.xa && x <= SL.x1 && z >= SL.z0 && z <= SL.z1, h: (x) => F + SL.h * Math.min(1, (x - SL.xa) / (SL.xb - SL.xa)) });
  // picket fence around the garden
  const fenceMat = std("fence", { color: "#FFFFFF" }); fenceMat.userData.toonLift = 0.4;
  const fenceRun = (id, ax, az, bx, bz) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.floor(L / 0.14), ry = Math.atan2(-(bz - az), bx - ax);
    for (let i = 0; i <= n; i++) { const t = i / n; box("garden", 0.07, 0.5, 0.025, fenceMat, ax + (bx - ax) * t, F + 0.25, az + (bz - az) * t, ry, 0.008); }
    for (const y of [0.15, 0.38]) box("garden", L, 0.05, 0.02, fenceMat, (ax + bx) / 2, F + y, (az + bz) / 2 - (az === bz ? 0.02 : 0), ry);
    cuboid(id, (ax + bx) / 2, F + 0.25, (az + bz) / 2, Math.abs(bx - ax) / 2 + 0.02, 0.25, Math.abs(bz - az) / 2 + 0.02);
  };
  fenceRun("fence_back", G.x0, G.z1, G.x1, G.z1);
  fenceRun("fence_left", G.x0, G.z0, G.x0, G.z1);
  fenceRun("fence_right", G.x1, G.z0, G.x1, G.z1);
  // potted plants (chunky terracotta pots, paddle leaves)
  const potMat = std("pot", { color: "#E07A4F" }), leafMat = std("plant_leaf", { color: "#3E9A45" }); leafMat.userData.toonLift = 0.3;
  [[-3.1, 4.35, 0.2], [-3.1, 7.15, 0.24], [3.05, 4.4, 0.18], [-1.6, 7.2, 0.17]].forEach(([x, z, r], i) => {
    batches.garden.add(new THREE.CylinderGeometry(r, r * 0.78, r * 1.4, 16), potMat, M(x, F + r * 0.7, z));
    ctx.cylinder("pot" + i, x, F + r * 0.7, z, r, r * 0.7);
    for (let k = 0; k < 5; k++) { const a = k / 5 * Math.PI * 2 + i;
      const leaf = new THREE.SphereGeometry(r * 0.55, 10, 8).scale(0.45, 1.3, 0.2).rotateZ(0.5).rotateY(a);
      batches.garden.add(leaf, leafMat, M(x + Math.cos(a) * r * 0.35, F + r * 1.4 + r * 0.5, z - Math.sin(a) * r * 0.35)); }
  });
  // flower tufts (desktop only; phones get the painted grass alone)
  if (!phone) {
    const flowerMat = std("flower", { color: "#FF5D73" }), flowerMat2 = std("flower2", { color: "#FFE45C" });
    const RF = rng(77);
    for (let i = 0; i < 26; i++) {
      const x = G.x0 + 0.3 + RF() * (G.x1 - G.x0 - 0.6), z = G.z0 + 0.7 + RF() * (G.z1 - G.z0 - 1.0);
      if (Math.abs(x - PUD.x) < 0.6 && Math.abs(z - PUD.z) < 0.45) continue;
      if (x > SL.xa - 0.1 && z > SL.z0) continue;
      if (stones.some(([sx, sz, r]) => Math.hypot(x - sx, z - sz) < r + 0.12)) continue;
      batches.garden.add(new THREE.CylinderGeometry(0.004, 0.004, 0.12, 5), leafMat, M(x, F + 0.06, z));
      batches.garden.add(new THREE.SphereGeometry(0.03, 8, 6).scale(1, 0.5, 1), i % 2 ? flowerMat : flowerMat2, M(x, F + 0.125, z));
    }
  }
  // sky drum around the garden (unlit painted sky, hedges, trees)
  const skyTex = new THREE.CanvasTexture(skyCanvas(hi ? 2048 : 1024, hi ? 512 : 256)); skyTex.colorSpace = THREE.SRGBColorSpace; skyTex.wrapS = THREE.RepeatWrapping; skyTex.repeat.x = 2;
  const sky = new THREE.Mesh(new THREE.CylinderGeometry(11, 11, 7, 48, 1, true), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, depthWrite: true, fog: false }));
  sky.position.set(0, F + 3.5 - 0.6, 2.5); sky.userData.lookNoContact = true; sky.userData.lookFX = true; sky.raycast = () => {}; sky.name = "garden_sky"; root.add(sky);
  const lawn = new THREE.Mesh(new THREE.CircleGeometry(11, 48).rotateX(-Math.PI / 2), tint(new THREE.MeshStandardMaterial({ name: "lawn_far", color: "#6CBF4F", roughness: 1 })));
  lawn.position.set(0, F - 0.02, 2.5); lawn.receiveShadow = true; lawn.userData.lookNoContact = true; lawn.name = "lawn_far"; root.add(lawn);

  // ================================================================ merge per room
  const drawInfo = {};
  for (const k of Object.keys(batches)) {
    const ms = batches[k].build(groups[k], { name: k });
    groups[k].traverse(o => { if (o.isMesh) { o.userData.roomOf = k; } });
    drawInfo[k] = groups[k].children.filter(o => o.isMesh).length;
  }

  // ================================================================ anchors
  const room = (k, spawns) => { const r = ROOMS[k]; return { center: [(r.x0 + r.x1) / 2, F, (r.z0 + r.z1) / 2], bounds: { min: [r.x0, F, r.z0], max: [r.x1, F + (r.outdoor ? 4 : WH), r.z1] },
    spawnPoints: spawns.map(([x, z, yaw], i) => ({ id: k + "_spawn" + (i + 1), position: [x, F, z], yaw })) }; };
  const rooms = {
    hallway: room("hallway", [[-5.8, hz, Math.PI / 2], [-2.5, hz, Math.PI / 2], [2.5, hz, -Math.PI / 2], [5.8, hz, -Math.PI / 2]]),
    kitchen: room("kitchen", [[3.8, 1.6, 0], [6.2, 1.5, -1.5], [4.2, -1.0, 0.5], [6.3, -0.6, -2]]),
    bedroom: room("bedroom", [[-4.2, 0.4, 0], [-5.6, 1.7, 1.2], [-3.8, 1.8, -0.4], [-6.3, -0.6, 0.8]]),
    garden: room("garden", [[-0.6, 5.2, 0], [0.8, 6.4, 2.6], [-2.2, 6.6, 1.5], [-2.4, 4.6, 0.3]]),
  };
  const raceHouse = {
    start: { position: [-2.4, F, hz], direction: [1, 0, 0], width: 0.95 },
    checkpoints: [
      { id: "h1", position: [2.6, F, hz], radius: 0.45 },
      { id: "h2", position: [5.0, F, 2.56], radius: 0.4 },
      { id: "h3", position: [5.3, F, -0.6], radius: 0.5 },
      { id: "h4", position: [3.06, F, -1.2], radius: 0.4 },
      { id: "h5", position: [0.4, F, -1.35], radius: 0.45 },
      { id: "h6", position: [-3.06, F, -0.8], radius: 0.4 },
      { id: "h7", position: [-4.6, F, 0.7], radius: 0.5 },
      { id: "h8", position: [-5.0, F, 2.56], radius: 0.4 },
      { id: "h9", position: [-3.6, F, hz], radius: 0.45 },
    ],
  };
  // fetchable props per room: [catalog key, x, z, yaw]
  const props = [
    ["strawberry", 4.3, 1.7, 0.3], ["grape", 5.9, 1.5, 0], ["cracker", 3.7, 0.2, 1.1], ["bread_crust", 6.2, -0.3, 0.4], ["strawberry", 5.6, -1.1, 2],
    ["toy_figure", -4.3, 0.9, 0.6], ["toy_brick", -5.4, 1.4, 0.3], ["crayon_red", -4.0, 1.6, 1.4], ["button", -5.8, 0.2, 0], ["toy_figure", -6.2, 1.9, 2.2],
    ["leaf", -0.8, 5.6, 0.7], ["pebble", 0.6, 6.1, 0], ["leaf", 2.2, 4.6, 2.0], ["pebble", -2.3, 5.9, 0], ["grape", -1.6, 4.4, 0],
    ["button", -1.5, hz, 0], ["crayon_green", 3.2, hz + 0.25, 1.4],
  ].filter((_, i) => !phone || i % 2 === 0);
  return { groups, drawInfo, rooms, dragStrip: DRAG, raceHouse, props, lights: { kitchen: kitLight, bedroom: bedLight }, sky, lawn,
    spawnPoints: Object.values(rooms).flatMap(r => r.spawnPoints) };
}
