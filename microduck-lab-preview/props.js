// props.js — small graspable / kickable toys for Microduck Lab, plus accessories (roller skates, laser dot).
// Units: metres. Every factory returns a fresh prop in the shared format:
//   { id, kind, label, object, mass, shape, grip, footprint, graspable, kickable, initialPosition, initialQuaternion }
// shape is in the object's local frame (cuboid | cylinder (axis local y) | ball | compound of balls), optional shape.offset.
// grip.width is the jaw opening needed (all graspable props <= 0.022 m).
// Geometries and materials are cached per kind, so spawning many copies shares GPU resources.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { assets } from "./assets.js";
import { toonify } from "./toon.js";

const cache = new Map();
const once = (key, fn) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key); };
const phys = (o) => toonify(new THREE.MeshPhysicalMaterial(o));
const std = (o) => toonify(new THREE.MeshStandardMaterial(o));

function finish(id, label, object, spec) {
  object.name = "prop_" + id;
  object.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  // rest on y = 0 of the object's frame; caller sets object.position
  return {
    id, kind: id, label, object, graspable: true, kickable: false, ...spec,
    initialPosition: object.position.clone(), initialQuaternion: object.quaternion.clone(),
  };
}
/** place a fresh prop: position = resting contact point on a surface at height y */
export function placeProp(p, x, y, z, yaw = 0) {
  p.object.position.set(x, y + (p.restHeight || 0), z);
  p.object.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
  if (p.baseQuaternion) p.object.quaternion.multiply(p.baseQuaternion);
  p.object.updateMatrixWorld(true);
  p.initialPosition.copy(p.object.position); p.initialQuaternion.copy(p.object.quaternion);
  return p;
}

// ------------------------------------------------------------------ original tabletop props
export function makeFoamCube() {
  const S = 0.022;
  const R = once("foam", () => {
    const m = phys({ color: "#F0745A", roughness: 0.92, sheen: 0.9, sheenRoughness: 0.4, sheenColor: new THREE.Color("#ffd0c2"), envMapIntensity: 0.7 });
    m.onBeforeCompile = (s) => {
      s.vertexShader = "varying vec3 vObjP;\n" + s.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\nvObjP = position;");
      s.fragmentShader = "varying vec3 vObjP;\nfloat fh(vec3 p){ p = fract(p*0.3183+0.1)*17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }\n" + s.fragmentShader.replace("#include <color_fragment>",
        "#include <color_fragment>\n{ vec3 c = floor(vObjP * 1400.0); float pore = step(0.86, fh(c)); diffuseColor.rgb *= 1.0 - pore * 0.28; }");
    };
    m.customProgramCacheKey = () => "prop-foam";
    return { g: new RoundedBoxGeometry(S, S, S, 3, 0.003), m };
  });
  const g = new THREE.Group(); const mesh = new THREE.Mesh(R.g, R.m); mesh.position.y = S / 2; g.add(mesh);
  return finish("foam_cube", "Foam cube", g, { mass: 0.004, shape: { type: "cuboid", halfExtents: [S / 2, S / 2, S / 2], offset: [0, S / 2, 0] }, grip: { width: S, axis: "x" }, footprint: 0.05 });
}

export function makeRing() {
  const Rr = 0.016, r = 0.006;
  const R = once("ring", () => ({
    g: new THREE.TorusGeometry(Rr, r, 32, 96).rotateX(Math.PI / 2).translate(0, r, 0),
    m: phys({ color: "#6FB7A8", roughness: 0.45, clearcoat: 0.3, clearcoatRoughness: 0.3, sheen: 0.4, sheenColor: new THREE.Color("#c8fff2") }),
  }));
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.g, R.m));
  return finish("ring", "Ring", g, { mass: 0.008,
    shape: { type: "compound", parts: Array.from({ length: 10 }, (_, i) => ({ type: "ball", radius: r, offset: [Math.cos(i / 10 * Math.PI * 2) * Rr, r, Math.sin(i / 10 * Math.PI * 2) * Rr] })) },
    grip: { width: r * 2, axis: "tube" }, footprint: 0.06 });
}

const DUCK_COLOURS = { yellow: ["#FFD23F", "#F28C28"], pink: ["#FF9EC0", "#F2683C"], blue: ["#7CC4F2", "#F2A33C"], mint: ["#8FE0C0", "#F28C28"] };
export function makeRubberDuck(colour = "yellow") {
  const [body, beak] = DUCK_COLOURS[colour] || DUCK_COLOURS.yellow;
  const G = once("duckgeo", () => {
    const b = new THREE.SphereGeometry(0.014, 40, 28).scale(1.25, 0.85, 1.0).translate(0, 0.012, 0);
    const tail = new THREE.SphereGeometry(0.006, 20, 14).scale(1, 1.3, 0.8).translate(-0.016, 0.02, 0);
    const head = new THREE.SphereGeometry(0.0095, 40, 28).translate(0.009, 0.027, 0);
    const bk = new THREE.SphereGeometry(0.005, 20, 14).scale(1.4, 0.55, 1.0).translate(0.019, 0.025, 0);
    const eyes = mergeGeometries([new THREE.SphereGeometry(0.0015, 12, 10).translate(0.0155, 0.0305, -0.0055), new THREE.SphereGeometry(0.0015, 12, 10).translate(0.0155, 0.0305, 0.0055)]);
    return { body: mergeGeometries([b, tail, head]), beak: bk, eyes, eyeM: phys({ color: "#111", roughness: 0.1, clearcoat: 1 }) };
  });
  const M = once("duckmat_" + colour, () => ({
    body: phys({ color: body, roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.15, sheen: 0.3 }),
    beak: phys({ color: beak, roughness: 0.4, clearcoat: 0.5 }),
  }));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(G.body, M.body), new THREE.Mesh(G.beak, M.beak), new THREE.Mesh(G.eyes, G.eyeM));
  const id = colour === "yellow" ? "toy_duck" : "rubber_duck_" + colour;
  return finish(id, (colour[0].toUpperCase() + colour.slice(1)) + " rubber duck", g, { mass: 0.006,
    shape: { type: "compound", parts: [{ type: "ball", radius: 0.0125, offset: [0, 0.0125, 0] }, { type: "ball", radius: 0.0095, offset: [0.009, 0.027, 0] }] },
    grip: { width: 0.019, axis: "head (neck at y≈0.022)" }, footprint: 0.05 });
}

export function makePencil() {
  const L = 0.12, r = 0.0042, bodyL = L * 0.78;
  const R = once("pencil", () => {
    const mats = {
      lacq: phys({ color: "#F2B705", roughness: 0.25, clearcoat: 0.8, clearcoatRoughness: 0.08 }),
      wood: std({ color: "#E2C08D", roughness: 0.8 }), lead: std({ color: "#2A2A2C", roughness: 0.35, metalness: 0.4 }),
      ferrule: std({ color: "#C9CCD1", metalness: 1, roughness: 0.3 }), eraser: std({ color: "#E98A8A", roughness: 0.85 }),
    };
    const geos = {
      body: new THREE.CylinderGeometry(r, r, bodyL, 6, 1),
      tip: new THREE.CylinderGeometry(0.0012, r * 0.95, L * 0.12, 24).translate(0, bodyL / 2 + L * 0.06, 0),
      lead: new THREE.ConeGeometry(0.0012, 0.004, 16).translate(0, bodyL / 2 + L * 0.12 + 0.002, 0),
      ferrule: new THREE.CylinderGeometry(r * 1.02, r * 1.02, L * 0.05, 32).translate(0, -bodyL / 2 - L * 0.025, 0),
      eraser: new THREE.CylinderGeometry(r * 0.95, r * 0.95, L * 0.05, 32).translate(0, -bodyL / 2 - L * 0.075, 0),
    };
    return { mats, geos };
  });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(R.geos.body, R.mats.lacq), new THREE.Mesh(R.geos.tip, R.mats.wood), new THREE.Mesh(R.geos.lead, R.mats.lead),
    new THREE.Mesh(R.geos.ferrule, R.mats.ferrule), new THREE.Mesh(R.geos.eraser, R.mats.eraser));
  // lying flat: local Y (the pencil axis) is turned to horizontal by baseQuaternion
  const baseQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  g.quaternion.copy(baseQuaternion); g.position.y = r * 0.87;
  return finish("pencil", "Pencil", g, { mass: 0.006, baseQuaternion, restHeight: r * 0.87,
    shape: { type: "cylinder", radius: r, halfHeight: 0.062, offset: [0, 0.003, 0], axis: "local-y" },
    grip: { width: r * 2, axis: "across" }, footprint: 0.06 });
}

// ------------------------------------------------------------------ new props
// knit sock ball: soft, kickable, not graspable (too big for the beak)
function knitTexture() {
  return once("knitTex", () => {
    const w = 256, h = 256, c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
    const bands = ["#E8DCC8", "#D9534F", "#E8DCC8", "#3E6E8E", "#E8DCC8", "#F2B705"];
    for (let i = 0; i < 6; i++) { g.fillStyle = bands[i]; g.fillRect(0, i * h / 6, w, h / 6); }
    // knit "V" stitches
    for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
      g.strokeStyle = "rgba(0,0,0,0.18)"; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x + 0.5, y + 1); g.lineTo(x + 4, y + 7); g.lineTo(x + 7.5, y + 1); g.stroke();
      g.strokeStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.moveTo(x + 1.5, y + 1); g.lineTo(x + 4, y + 5.5); g.stroke();
    }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 1); t.anisotropy = 8;
    return t;
  });
}
export function makeSockBall() {
  const r = 0.03;
  const R = once("sock", () => ({
    g: new THREE.SphereGeometry(r, 48, 32).translate(0, r, 0),
    m: phys({ map: knitTexture(), roughness: 0.95, sheen: 1.0, sheenRoughness: 0.35, sheenColor: new THREE.Color("#fff1e0"), envMapIntensity: 0.6 }),
  }));
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.g, R.m));
  const p = finish("sock_ball", "Sock ball", g, { mass: 0.025, shape: { type: "ball", radius: r, offset: [0, r, 0] }, grip: null, footprint: 0.08, restitution: 0.35, rollingFriction: 0.02 });
  p.graspable = false; p.kickable = true;
  return p;
}

export function makeKey() {
  const R = once("key", () => {
    const m = phys({ color: "#C9A24A", metalness: 1, roughness: 0.28, clearcoat: 0.2 });
    const t = 0.0024;
    const bow = new THREE.TorusGeometry(0.0085, 0.0028, 12, 40).rotateX(Math.PI / 2).translate(-0.017, t / 2, 0);
    const bowFill = new THREE.CylinderGeometry(0.0086, 0.0086, t, 32).translate(-0.017, t / 2, 0);
    const hole = null;
    const shaft = new RoundedBoxGeometry(0.032, t, 0.0042, 2, 0.0008).translate(0.007, t / 2, 0);
    const bits = [[0.016, 0.0035], [0.019, 0.0028], [0.022, 0.0042]].map(([x, d]) => new THREE.BoxGeometry(0.0022, t, d).translate(x, t / 2, -0.0021 - d / 2));
    const geo = mergeGeometries([bow, bowFill.translate(0, 0, 0), shaft, ...bits].filter(Boolean).map(g => g.toNonIndexed()));
    geo.computeVertexNormals();
    return { g: geo, m };
  });
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.g, R.m));
  return finish("key", "Key", g, { mass: 0.004, shape: { type: "cuboid", halfExtents: [0.022, 0.0016, 0.0085], offset: [-0.004, 0.0016, 0] }, grip: { width: 0.0042, axis: "shaft" }, footprint: 0.05 });
}

export function makeBottleCap() {
  const r = 0.0145, h = 0.006;
  const R = once("cap", () => {
    const geo = new THREE.CylinderGeometry(r, r * 1.03, h, 42, 1, false);
    // crimped skirt: push alternate rim vertices in
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), y = p.getY(i); const a = Math.atan2(z, x); const rr = Math.hypot(x, z);
      if (rr > r * 0.9) { const k = 1 - 0.06 * (0.5 + 0.5 * Math.cos(a * 21)); p.setXYZ(i, x * k, y, z * k); } }
    geo.computeVertexNormals(); geo.translate(0, h / 2, 0);
    const top = new THREE.CircleGeometry(r * 0.86, 40).rotateX(-Math.PI / 2).translate(0, h + 0.0001, 0);
    return { geo, top, m: phys({ color: "#D7262B", metalness: 0.7, roughness: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.1 }),
      mt: phys({ color: "#F4F1EA", metalness: 0.2, roughness: 0.35, clearcoat: 0.6 }) };
  });
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.geo, R.m), new THREE.Mesh(R.top, R.mt));
  return finish("bottle_cap", "Bottle cap", g, { mass: 0.002, shape: { type: "cylinder", radius: r, halfHeight: h / 2, offset: [0, h / 2, 0] }, grip: { width: h, axis: "edge" }, footprint: 0.04 });
}

export function makeCrayon(colour = "#2F6FD6") {
  const r = 0.0045, L = 0.09;
  const R = once("crayon_geo", () => ({
    wax: mergeGeometries([new THREE.CylinderGeometry(r, r, L * 0.82, 24).toNonIndexed(), new THREE.CylinderGeometry(r * 0.35, r, L * 0.1, 24).translate(0, L * 0.46, 0).toNonIndexed()]),
    paper: new THREE.CylinderGeometry(r * 1.06, r * 1.06, L * 0.6, 24, 1, true).translate(0, -L * 0.08, 0),
    paperM: phys({ color: "#F3EBD7", roughness: 0.9, sheen: 0.3, side: THREE.DoubleSide }),
  }));
  const wax = once("crayon_" + colour, () => phys({ color: colour, roughness: 0.55, clearcoat: 0.15, sheen: 0.25 }));
  const g = new THREE.Group();
  g.add(new THREE.Mesh(R.wax, wax), new THREE.Mesh(R.paper, R.paperM));
  const baseQuaternion = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
  g.quaternion.copy(baseQuaternion); g.position.y = r;
  return finish("crayon", "Crayon", g, { mass: 0.005, baseQuaternion, restHeight: r,
    shape: { type: "cylinder", radius: r, halfHeight: L * 0.5, axis: "local-y" },
    grip: { width: r * 2, axis: "across" }, footprint: 0.055 });
}

export function makeBreadCrust() {
  const R = once("crust", () => {
    // bent rounded slab; vertex colours: golden crust on the outside, pale crumb where cut
    const geo = new RoundedBoxGeometry(0.052, 0.016, 0.02, 3, 0.004);
    const p = geo.attributes.position, cols = [];
    const crust = new THREE.Color("#B8742E"), dark = new THREE.Color("#8A5220"), crumb = new THREE.Color("#F1DEB4");
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      p.setY(i, y + 0.006 * (1 - Math.pow(x / 0.026, 2)));      // arch
      const outside = z < -0.006 || y > 0.006;                    // crust faces
      const c = (outside ? crust.clone().lerp(dark, Math.max(0, y / 0.008) * 0.6) : crumb.clone());
      const n = Math.sin(x * 900) * Math.sin(z * 700) * 0.04; c.offsetHSL(0, 0, n);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3)); geo.computeVertexNormals(); geo.translate(0, 0.008, 0);
    return { geo, m: phys({ vertexColors: true, roughness: 0.85, sheen: 0.5, sheenColor: new THREE.Color("#ffd9a0"), sheenRoughness: 0.5 }) };
  });
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.geo, R.m));
  return finish("bread_crust", "Bread crust", g, { mass: 0.003, shape: { type: "cuboid", halfExtents: [0.026, 0.009, 0.01], offset: [0, 0.009, 0] }, grip: { width: 0.02, axis: "z" }, footprint: 0.06 });
}

export function makeToyBrick(colour = "#D7262B") {
  const W = 0.016, H = 0.0096, sr = 0.0024, sh = 0.0017;
  const R = once("brick_geo", () => {
    const parts = [new RoundedBoxGeometry(W, H, W, 2, 0.0006).translate(0, H / 2, 0).toNonIndexed()];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(new THREE.CylinderGeometry(sr, sr, sh, 20).translate(sx * W / 4, H + sh / 2, sz * W / 4).toNonIndexed());
    const g = mergeGeometries(parts); g.computeVertexNormals(); return g;
  });
  const m = once("brick_" + colour, () => phys({ color: colour, roughness: 0.22, clearcoat: 0.6, clearcoatRoughness: 0.08, specularIntensity: 0.6 }));
  const g = new THREE.Group(); g.add(new THREE.Mesh(R, m));
  return finish("toy_brick", "Toy brick", g, { mass: 0.002, shape: { type: "cuboid", halfExtents: [W / 2, (H + sh) / 2, W / 2], offset: [0, (H + sh) / 2, 0] }, grip: { width: W, axis: "x" }, footprint: 0.035 });
}

// ------------------------------------------------------------------ real-model props (streamed)
// make() returns at once with a simple placeholder inside object; the PBR model replaces it when loaded.
// Collider shapes are sized to the real models (see assets/models/_manifest.json).
function modelProp(id, label, model, placeholder, spec, fit = {}) {
  const g = new THREE.Group(), vis = new THREE.Group(); vis.name = "visual"; vis.add(placeholder); g.add(vis);
  assets.swapIn(vis, model, { prio: fit.prio ?? 3, scale: fit.scale, rotationY: fit.rotationY }).then((m) => {
    if (m) m.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  });
  return finish(id, label, g, spec);
}
const ph = (geo, colour, rough = 0.5) => { const m = new THREE.Mesh(geo, once("ph_" + colour, () => phys({ color: colour, roughness: rough }))); return m; };
export function makeChessPawn() {
  return modelProp("chess_pawn", "Chess pawn", "pawn",
    ph(new THREE.LatheGeometry([[0.001, 0], [0.016, 0], [0.016, 0.006], [0.009, 0.012], [0.006, 0.03], [0.009, 0.034], [0.008, 0.042], [0.004, 0.05], [0.001, 0.05]].map(([r, y]) => new THREE.Vector2(r, y)), 24), "#EFE7DA", 0.3),
    { mass: 0.012, shape: { type: "cylinder", radius: 0.0158, halfHeight: 0.025, offset: [0, 0.025, 0] }, grip: { width: 0.013, axis: "neck" }, footprint: 0.045 });
}
export function makeChessKnight() {
  return modelProp("chess_knight", "Chess knight", "knight",
    ph(new THREE.CylinderGeometry(0.009, 0.0137, 0.055, 20).translate(0, 0.0275, 0), "#EFE7DA", 0.3),
    { mass: 0.015, shape: { type: "cylinder", radius: 0.0155, halfHeight: 0.0275, offset: [0, 0.0275, 0] }, grip: { width: 0.016, axis: "head" }, footprint: 0.045 });
}
export function makeWickerBall() {
  const R = once("wicker", () => {
    const c = document.createElement("canvas"); c.width = 256; c.height = 128; const g = c.getContext("2d");
    g.fillStyle = "#E8A85A"; g.fillRect(0, 0, 256, 128);
    g.strokeStyle = "#8A4F24"; g.lineWidth = 3;
    for (let i = 0; i < 12; i++) { g.beginPath(); g.moveTo(i * 256 / 12, 0); g.lineTo(i * 256 / 12, 128); g.stroke(); }
    for (let j = 0; j < 8; j++) for (let i = 0; i < 12; i++) if ((i + j) % 2 === 0) { g.fillStyle = "#F3C47E"; g.fillRect(i * 256 / 12 + 3, j * 16 + 3, 256 / 12 - 6, 10); }
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = THREE.RepeatWrapping;
    return { g: new THREE.SphereGeometry(0.03, 40, 24).translate(0, 0.03, 0), m: std({ map: t, roughness: 0.7 }) };
  });
  const g = new THREE.Group(); g.add(new THREE.Mesh(R.g, R.m));
  const p = finish("wicker_ball", "Wicker ball", g, { mass: 0.02, shape: { type: "ball", radius: 0.03, offset: [0, 0.03, 0] }, grip: null, footprint: 0.08, restitution: 0.45 });
  p.graspable = false; p.kickable = true; return p;
}
export function makeToyCar() {
  const p = modelProp("toy_car", "Toy car", "toycar", ph(new RoundedBoxGeometry(0.039, 0.024, 0.08, 2, 0.006).translate(0, 0.012, 0), "#C8372D", 0.3),
    { mass: 0.03, shape: { type: "cuboid", halfExtents: [0.0195, 0.012, 0.04], offset: [0, 0.012, 0] }, grip: null, footprint: 0.09 });
  p.graspable = false; p.kickable = true; return p;
}
export function makeCookie() {
  return modelProp("cookie", "Cookie", "cookie", ph(new THREE.CylinderGeometry(0.023, 0.023, 0.011, 24).translate(0, 0.0055, 0), "#C48A4E", 0.8),
    { mass: 0.008, shape: { type: "cylinder", radius: 0.023, halfHeight: 0.0057, offset: [0, 0.0057, 0] }, grip: { width: 0.0113, axis: "edge" }, footprint: 0.055 });
}
export function makeToast() {
  return modelProp("toast", "Toast", "toast", ph(new THREE.BoxGeometry(0.07, 0.0063, 0.058).translate(0, 0.0032, 0), "#D9A35E", 0.8),
    { mass: 0.01, shape: { type: "cuboid", halfExtents: [0.035, 0.0032, 0.029], offset: [0, 0.0032, 0] }, grip: { width: 0.0063, axis: "edge" }, footprint: 0.08 });
}
export function makeCroissant() {
  // scaled to 72 % so the beak can close around it (0.039 x 0.022 x 0.054 m)
  return modelProp("croissant", "Croissant", "croissant", ph(new THREE.CapsuleGeometry(0.011, 0.03, 4, 12).rotateX(Math.PI / 2).translate(0, 0.011, 0), "#D39552", 0.7),
    { mass: 0.01, shape: { type: "cuboid", halfExtents: [0.0195, 0.011, 0.027], offset: [0, 0.011, 0] }, grip: { width: 0.0219, axis: "y" }, footprint: 0.065 }, { scale: 0.72 });
}

// ------------------------------------------------------------------ catalog (inventory bar)
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">${body}</svg>`;
export const PROP_CATALOG = {
  sock_ball:         { label: "Sock ball",      icon: svg('<circle cx="12" cy="12" r="9" fill="#E8DCC8"/><path d="M3.5 9h17M3 13h18M4 17h16" stroke="#D9534F" stroke-width="2"/>'), make: makeSockBall },
  foam_cube:         { label: "Foam cube",      icon: svg('<rect x="5" y="5" width="14" height="14" rx="3" fill="#F0745A"/>'), make: makeFoamCube },
  ring:              { label: "Ring",           icon: svg('<circle cx="12" cy="12" r="7" fill="none" stroke="#6FB7A8" stroke-width="4"/>'), make: makeRing },
  pencil:            { label: "Pencil",         icon: svg('<path d="M4 20l2-6L17 3l4 4L10 18z" fill="#F2B705"/><path d="M4 20l2-6 4 4z" fill="#E2C08D"/>'), make: makePencil },
  crayon:            { label: "Crayon",         icon: svg('<rect x="3" y="10" width="15" height="5" rx="1" fill="#2F6FD6"/><path d="M18 10l4 2.5-4 2.5z" fill="#2F6FD6"/><rect x="6" y="10" width="7" height="5" fill="#F3EBD7"/>'), make: () => makeCrayon() },
  key:               { label: "Key",            icon: svg('<circle cx="7" cy="12" r="4" fill="none" stroke="#C9A24A" stroke-width="2.5"/><path d="M11 12h10M17 12v3M20 12v2" stroke="#C9A24A" stroke-width="2.5"/>'), make: makeKey },
  bottle_cap:        { label: "Bottle cap",     icon: svg('<circle cx="12" cy="12" r="8" fill="#D7262B"/><circle cx="12" cy="12" r="5.5" fill="#F4F1EA"/>'), make: makeBottleCap },
  bread_crust:       { label: "Bread crust",    icon: svg('<path d="M3 15c2-7 16-7 18 0z" fill="#B8742E"/><path d="M6 15c2-4 10-4 12 0z" fill="#F1DEB4"/>'), make: makeBreadCrust },
  toy_brick:         { label: "Toy brick",      icon: svg('<rect x="4" y="10" width="16" height="9" rx="1" fill="#D7262B"/><rect x="6" y="7" width="4" height="3" fill="#D7262B"/><rect x="14" y="7" width="4" height="3" fill="#D7262B"/>'), make: () => makeToyBrick() },
  toy_duck:          { label: "Rubber duck",    icon: svg('<ellipse cx="11" cy="15" rx="8" ry="5" fill="#FFD23F"/><circle cx="15" cy="8" r="4" fill="#FFD23F"/><path d="M18.5 8h3l-3 2z" fill="#F28C28"/>'), make: () => makeRubberDuck("yellow") },
  rubber_duck_pink:  { label: "Pink duck",      icon: svg('<ellipse cx="11" cy="15" rx="8" ry="5" fill="#FF9EC0"/><circle cx="15" cy="8" r="4" fill="#FF9EC0"/><path d="M18.5 8h3l-3 2z" fill="#F2683C"/>'), make: () => makeRubberDuck("pink") },
  rubber_duck_blue:  { label: "Blue duck",      icon: svg('<ellipse cx="11" cy="15" rx="8" ry="5" fill="#7CC4F2"/><circle cx="15" cy="8" r="4" fill="#7CC4F2"/><path d="M18.5 8h3l-3 2z" fill="#F2A33C"/>'), make: () => makeRubberDuck("blue") },
  chess_pawn:        { label: "Chess pawn",     icon: svg('<path d="M9 20h6l-1-6 2-2-2-1a3 3 0 1 0-4 0l-2 1 2 2z" fill="#EFE7DA" stroke="#9a8f80" stroke-width="0.8"/>'), make: makeChessPawn },
  chess_knight:      { label: "Chess knight",   icon: svg('<path d="M8 20h9l-1-4c2-3 1-8-4-11l-1 2-3 3 1 2 3-1-3 5z" fill="#EFE7DA" stroke="#9a8f80" stroke-width="0.8"/>'), make: makeChessKnight },
  wicker_ball:       { label: "Wicker ball",    icon: svg('<circle cx="12" cy="12" r="8" fill="#B98B57"/><path d="M5 9c5 3 9 3 14 0M5 15c5-3 9-3 14 0M9 4.8c3 5 3 9 0 14.4M15 4.8c-3 5-3 9 0 14.4" stroke="#7a5530" stroke-width="1.2" fill="none"/>'), make: makeWickerBall },
  toy_car:           { label: "Toy car",        icon: svg('<path d="M3 15l2-5h11l4 4v3H3z" fill="#C8372D"/><circle cx="7.5" cy="17.5" r="2" fill="#222"/><circle cx="16.5" cy="17.5" r="2" fill="#222"/>'), make: makeToyCar },
  cookie:            { label: "Cookie",         icon: svg('<circle cx="12" cy="12" r="8" fill="#C48A4E"/><circle cx="9" cy="10" r="1.3" fill="#5a3a22"/><circle cx="14" cy="14" r="1.3" fill="#5a3a22"/><circle cx="14" cy="9" r="1" fill="#5a3a22"/>'), make: makeCookie },
  toast:             { label: "Toast",          icon: svg('<path d="M5 10a5 5 0 0 1 4-6h6a5 5 0 0 1 4 6v9H5z" fill="#D9A35E"/><path d="M7 11a3 3 0 0 1 3-4h4a3 3 0 0 1 3 4v6H7z" fill="#F3DCA8"/>'), make: makeToast },
  croissant:         { label: "Croissant",      icon: svg('<path d="M3 15c3-7 15-7 18 0-3-2-6-1-9 1-3-2-6-3-9-1z" fill="#D39552"/>'), make: makeCroissant },
  rubber_duck_mint:  { label: "Mint duck",      icon: svg('<ellipse cx="11" cy="15" rx="8" ry="5" fill="#8FE0C0"/><circle cx="15" cy="8" r="4" fill="#8FE0C0"/><path d="M18.5 8h3l-3 2z" fill="#F28C28"/>'), make: () => makeRubberDuck("mint") },
};

// ------------------------------------------------------------------ roller skates
/**
 * makeSkates() -> { left, right, wheels, height, spin(distance), setVisible(b), dispose() }
 * Each skate's origin is the top centre of the deck: parent it to a foot sole node (or place under it),
 * forward = +X along the deck (rotate to match the foot), and raise the duck by `height` while worn.
 */
export function makeSkates(opts = {}) {
  const deckColour = opts.deck || "#E6513D", wheelColour = opts.wheel || "#F5E6B8";
  const L = 0.056, Wd = 0.034, T = 0.006, wr = 0.0075, ww = 0.007;
  const R = once("skates_geo", () => ({
    deck: new RoundedBoxGeometry(L, T, Wd, 3, 0.0025).translate(0, -T / 2, 0),
    truck: mergeGeometries([new THREE.BoxGeometry(0.012, 0.004, Wd * 0.8).translate(-L * 0.3, -T - 0.002, 0).toNonIndexed(), new THREE.BoxGeometry(0.012, 0.004, Wd * 0.8).translate(L * 0.3, -T - 0.002, 0).toNonIndexed()]),
    wheel: new THREE.CylinderGeometry(wr, wr, ww, 28).rotateX(Math.PI / 2),
    hub: new THREE.CylinderGeometry(wr * 0.45, wr * 0.45, ww * 1.05, 16).rotateX(Math.PI / 2),
    stopper: new THREE.CylinderGeometry(0.004, 0.0045, 0.006, 16).rotateZ(Math.PI / 2).translate(L / 2 + 0.002, -T - 0.002, 0),
    truckM: std({ color: "#B9BEC4", metalness: 1, roughness: 0.3 }), hubM: std({ color: "#D6D9DD", metalness: 1, roughness: 0.25 }),
    stopM: std({ color: "#2A2A2C", roughness: 0.7 }),
  }));
  const deckM = phys({ color: deckColour, roughness: 0.35, clearcoat: 0.7, clearcoatRoughness: 0.1 });
  const wheelM = phys({ color: wheelColour, roughness: 0.45, clearcoat: 0.3, sheen: 0.3 });
  const wheels = [];
  const one = () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(R.deck, deckM), new THREE.Mesh(R.truck, R.truckM), new THREE.Mesh(R.stopper, R.stopM));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const w = new THREE.Group(); w.position.set(sx * L * 0.3, -T - 0.004 - wr * 0.6, sz * (Wd / 2 - ww / 2));
      w.add(new THREE.Mesh(R.wheel, wheelM), new THREE.Mesh(R.hub, R.hubM)); g.add(w); wheels.push(w);
    }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    return g;
  };
  const left = one(), right = one(); left.name = "skate_left"; right.name = "skate_right";
  const height = T + 0.004 + wr * 0.6 + wr; // deck top to floor
  return {
    left, right, wheels, height, wheelRadius: wr,
    /** roll the wheels by a travelled distance (metres, signed) */
    spin(distance) { const a = distance / wr; for (const w of wheels) w.rotation.z -= a; },
    /** spin each side separately (e.g. from each foot's travel) */
    spinSide(side, distance) { const a = distance / wr; const list = side === "left" ? wheels.slice(0, 4) : wheels.slice(4); for (const w of list) w.rotation.z -= a; },
    setVisible(b) { left.visible = right.visible = b; },
    dispose() { deckM.dispose(); wheelM.dispose(); },
  };
}

// ------------------------------------------------------------------ laser dot
/**
 * makeLaserDot() -> { object, dot, beam, set(point, normal, from), setVisible(b), update(dt) }
 * object goes in the scene; call set(hitPoint, surfaceNormal, beamOrigin) per frame. The dot glows
 * (bright enough for bloom) and the beam is a faint additive line from `from` to the dot.
 */
export function makeLaserDot(opts = {}) {
  const colour = new THREE.Color(opts.colour || "#FF2A2A");
  const object = new THREE.Group(); object.name = "laser";
  const dotMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: colour.clone().multiplyScalar(6) }, uT: { value: 0 } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform vec3 uColor; uniform float uT; varying vec2 vUv;
      void main(){ float r = length(vUv - 0.5) * 2.0;
        float core = smoothstep(0.22, 0.0, r); float halo = exp(-r * r * 6.0) * (0.55 + 0.08 * sin(uT * 40.0));
        vec3 c = uColor * halo + vec3(1.0, 0.9, 0.9) * core * 4.0;
        gl_FragColor = vec4(c, clamp(halo + core, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const dot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), dotMat); dot.scale.setScalar(opts.size || 0.03); dot.renderOrder = 20;
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: colour.clone().multiplyScalar(1.6) }, uOpacity: { value: opts.beamOpacity ?? 0.25 } },
    vertexShader: "varying float vT; void main(){ vT = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: `uniform vec3 uColor; uniform float uOpacity; varying float vT;
      void main(){ gl_FragColor = vec4(uColor * uOpacity * (0.25 + 0.75 * vT), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.0008, 0.0008, 1, 6, 1, true).translate(0, 0.5, 0), beamMat); beam.renderOrder = 19;
  object.add(dot, beam);
  object.traverse(o => { o.userData.lookFX = true; o.raycast = () => {}; o.castShadow = false; });
  const up = new THREE.Vector3(0, 1, 0), tmp = new THREE.Vector3(), q = new THREE.Quaternion();
  let t = 0;
  return {
    object, dot, beam,
    set(point, normal = up, from = null) {
      dot.position.copy(point).addScaledVector(normal, 0.0008);
      dot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      if (from) {
        tmp.subVectors(point, from); const len = tmp.length();
        beam.visible = len > 0.01; beam.position.copy(from); beam.scale.set(1, len, 1);
        q.setFromUnitVectors(up, tmp.normalize()); beam.quaternion.copy(q);
      } else beam.visible = false;
    },
    setVisible(b) { object.visible = b; },
    update(dt) { t += dt; dotMat.uniforms.uT.value = t; },
  };
}
