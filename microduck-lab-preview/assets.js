// assets.js — streamed loading of the few glTF props Microduck Lab still ships (meshopt + WebP).
// Two tiers: desktop (*.glb) and phone (*.m.glb, smaller textures). Loaded models are converted to the
// comic look (toon shading, photo textures flattened to flat colours).
//
//   import { assets } from "./assets.js";
//   assets.model("pawn", 3).then(group => ...)      // fresh clone per call (geometry/materials shared)
//   assets.swapIn(holder, "pawn", opts)             // replace a placeholder group's children when loaded
//   assets.onProgress(fn)  fn({ loaded, total, bytes })

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { toonify } from "./toon.js";

const BASE = new URL("./assets/", import.meta.url).href;

export function isPhoneTier() {
  try {
    const q = new URLSearchParams(location.search).get("tier");
    if (q) return q === "phone";
  } catch (e) { /* ignore */ }
  const ua = navigator.userAgent || "";
  const small = Math.min(screen.width, screen.height) < 600;
  const lowMem = navigator.deviceMemory !== undefined && navigator.deviceMemory <= 4;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || small || lowMem;
}

const PHONE = isPhoneTier();
const tierName = (file) => {
  if (!PHONE) return file;
  const i = file.lastIndexOf(".");
  return file.slice(0, i) + ".m" + file.slice(i);
};

// ------------------------------------------------------------------ priority queue
const queue = [];
let active = 0;
const MAX_ACTIVE = 3;
const stats = { loaded: 0, total: 0, bytes: 0 };
const listeners = new Set();
function emit() { for (const fn of listeners) { try { fn({ ...stats }); } catch (e) { /* ignore */ } } }
function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    queue.sort((a, b) => a.prio - b.prio);
    const job = queue.shift(); active++;
    job.run().then(job.resolve, job.reject).finally(() => { active--; stats.loaded++; emit(); pump(); });
  }
}
function enqueue(prio, run) {
  stats.total++; emit();
  return new Promise((resolve, reject) => { queue.push({ prio, run, resolve, reject }); pump(); });
}

// ------------------------------------------------------------------ loaders
const gltfLoader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
const KEEP_MAPS = new Set(["toycar"]);   // decals that read well as flat colour
const fileBytes = (url) => { try { const e = performance.getEntriesByName(url)[0]; return e ? e.encodedBodySize || e.transferSize || 0 : 0; } catch (e) { return 0; } };

const modelCache = new Map();
const texCache = new Map();

// average colour of a texture (used to flatten photo textures into one comic colour)
function averageColour(tex) {
  try {
    const img = tex && tex.image; if (!img) return null;
    const c = document.createElement("canvas"); c.width = c.height = 8; const g = c.getContext("2d");
    g.drawImage(img, 0, 0, 8, 8); const d = g.getImageData(0, 0, 8, 8).data; let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4; return new THREE.Color().setRGB(r / n / 255, gg / n / 255, b / n / 255, THREE.SRGBColorSpace);
  } catch (e) { return null; }
}
/** Comic look for imported models: glass becomes flat translucent, textures flatten to their average colour
 *  unless the model keeps them (opts.keepMaps), every material becomes toon shading, shadows on. */
function tidy(root, opts = {}) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m || m.userData.toon) continue;
      if (m.transmission > 0) { m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.45); m.depthWrite = false; o.castShadow = false; }
      if (m.map && !opts.keepMaps) { const avg = averageColour(m.map); if (avg) { m.color.multiply(avg); m.map = null; } }
      toonify(m, { spec: m.roughness < 0.45 ? 0.8 : 0 });
    }
  });
  return root;
}

export const assets = {
  phone: PHONE,
  base: BASE,
  stats,
  onProgress(fn) { listeners.add(fn); fn({ ...stats }); return () => listeners.delete(fn); },

  /** load a model by name (assets/models/<name>.glb); resolves to a fresh clone */
  model(name, prio = 2) {
    if (!modelCache.has(name)) {
      const url = BASE + "models/" + tierName(name + ".glb");
      modelCache.set(name, enqueue(prio, () => gltfLoader.loadAsync(url).then((g) => {
        stats.bytes += fileBytes(url);
        const root = g.scene; root.name = "model_" + name; tidy(root, { keepMaps: KEEP_MAPS.has(name) }); return root;
      })));
    }
    return modelCache.get(name).then((tpl) => tpl.clone(true));
  },

  texture(file, prio = 1, opts = {}) {
    const key = file + JSON.stringify(opts);
    if (!texCache.has(key)) {
      const url = BASE + "textures/" + tierName(file);
      texCache.set(key, enqueue(prio, () => texLoader.loadAsync(url).then((t) => {
        stats.bytes += fileBytes(url);
        t.colorSpace = opts.srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        if (opts.repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...opts.repeat); }
        t.anisotropy = opts.anisotropy ?? 8;
        return t;
      })));
    }
    return texCache.get(key);
  },

  /** comic look: no HDRI. Kept for API compatibility (resolves to null; useEnv is a no-op). */
  env() { return Promise.resolve(null); },
  useEnv() {},
  get envTexture() { return null; },

  /**
   * Replace the children of `holder` with a loaded model once it arrives.
   * opts: { prio, position, rotationY, scale, onLoad(model) }
   */
  swapIn(holder, name, opts = {}) {
    return this.model(name, opts.prio ?? 2).then((m) => {
      if (opts.position) m.position.fromArray(opts.position);
      if (opts.rotationY) m.rotation.y = opts.rotationY;
      if (opts.scale) m.scale.setScalar(opts.scale);
      const old = [...holder.children];
      for (const c of old) holder.remove(c);
      holder.add(m);
      if (opts.onLoad) opts.onLoad(m, old);
      return m;
    }).catch((e) => { console.warn("asset failed:", name, e && e.message); return null; });
  },
};
