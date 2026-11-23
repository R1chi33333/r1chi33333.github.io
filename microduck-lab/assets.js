// assets.js — streamed asset loading for Microduck Lab.
// Two texture tiers: desktop (1K) and phone (512, files named *.m.*). Models are meshopt-compressed glTF
// with WebP textures; the room environment is a small Radiance HDR. Everything loads through one
// priority queue so the floor and lighting arrive first, then furniture, then props.
//
//   import { assets } from "./assets.js";
//   assets.model("sofa", 1).then(group => ...)      // fresh clone per call (geometry/materials shared)
//   assets.texture("floor_color.webp", 0, { srgb: true, repeat: [6, 5] })
//   assets.env(renderer)                             // PMREM environment from the room HDRI (cached)
//   assets.onProgress(fn)  fn({ loaded, total, bytes })

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RGBELoader } from "three/addons/loaders/RGBELoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

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
const rgbeLoader = new RGBELoader();
const fileBytes = (url) => { try { const e = performance.getEntriesByName(url)[0]; return e ? e.encodedBodySize || e.transferSize || 0 : 0; } catch (e) { return 0; } };

const modelCache = new Map();
const texCache = new Map();
let envPromise = null;
let envTexture = null;
const envUsers = new Set();      // materials that should use the room environment

/** Make imported materials behave in a real-time scene: no transmission passes, shadows on. */
function tidy(root) {
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (!m) continue;
      if (m.transmission > 0) {                 // transmission needs an extra full-scene pass: fake glass instead
        m.transmission = 0; m.transparent = true; m.opacity = Math.min(m.opacity, 0.35);
        m.roughness = Math.min(m.roughness, 0.15); m.depthWrite = false; o.castShadow = false;
      }
      if (m.map) m.map.anisotropy = 8;
      envUsers.add(m);
      if (envTexture && !m.envMap) { m.envMap = envTexture; m.needsUpdate = true; }
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
        const root = g.scene; root.name = "model_" + name; tidy(root); return root;
      })));
    }
    return modelCache.get(name).then((tpl) => tidy(tpl.clone(true)));
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

  /** room environment (PMREM of the interior HDRI). Applied to every material registered via useEnv(). */
  env(renderer, prio = 0) {
    if (!envPromise) {
      const url = BASE + "textures/room_env.hdr";
      envPromise = enqueue(prio, () => rgbeLoader.loadAsync(url).then((hdr) => {
        stats.bytes += fileBytes(url);
        hdr.mapping = THREE.EquirectangularReflectionMapping;
        const pm = new THREE.PMREMGenerator(renderer);
        envTexture = pm.fromEquirectangular(hdr).texture; pm.dispose(); hdr.dispose();
        for (const m of envUsers) { m.envMap = envTexture; m.needsUpdate = true; }
        return envTexture;
      }));
    }
    return envPromise;
  },
  /** register materials that should reflect the room (instead of the studio environment used by the duck) */
  useEnv(...mats) { for (const m of mats.flat()) { if (!m) continue; envUsers.add(m); if (envTexture) { m.envMap = envTexture; m.needsUpdate = true; } } },
  get envTexture() { return envTexture; },

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
