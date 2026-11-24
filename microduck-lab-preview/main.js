// main.js — Microduck Lab: bootstrap, the duck flock, input, camera, modes (Play / Sensors / Garage),
// inventory, laser pointer, football and racing, HUD.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { setupRenderer, buildStage, makeMaterials, applyLook, setupPost, createAdaptiveQuality, detectQuality, SKINS, setSkin } from "./look.js";
import { createCustomiser, loadChoice, saveChoice, defaultChoice, voicePresets, PAINT_PARTS } from "./customise.js";
import { buildWorld } from "./world.js";
import { adaptWorld } from "./adapter.js";
import { DuckBody, GAIT } from "./duck.js";
import { createPhysics } from "./physics.js";
import { Mind } from "./mind.js";
import { Workshop } from "./garage.js";
import { Voice, makeSerial, voiceParams } from "./voice.js";
import { createSfx } from "./sfx.js";
import { createThoughts } from "./thoughts.js";
import { CUT } from "./house.js";
import { Agent, SKATE } from "./agent.js";
import { Football, Race } from "./games.js";
import { createInventory } from "./inventory.js";
import { PROP_CATALOG, makeSkates, makeLaserDot, placeProp } from "./props.js";

// Merge each duck's small static internals (bearings, brackets, electronics) per body segment and material,
// so a flock of 8 needs far fewer draw calls. Garage parts (shells, legs, servos, eye) stay separate meshes.
const MERGE_RE = /^(bearing_|electronics_(?!camera)|frame_|head_motor|neck_bracket|neck_pitch_link|neck_yaw_roll_link|leg_.*bracket|leg_.*plate)/;
function mergeInternals(root) {
  const nodes = []; root.traverse(o => nodes.push(o));
  for (const node of nodes) {
    const groups = new Map();
    for (const c of node.children) if (c.isMesh && MERGE_RE.test(c.name) && !c.children.length) {
      const k = c.material.uuid; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geos = list.map(m => { m.updateMatrix(); let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
        for (const a of Object.keys(g.attributes)) if (a !== "position" && a !== "normal") g.deleteAttribute(a);
        return g.applyMatrix4(m.matrix); });
      let merged; try { merged = mergeGeometries(geos, false); } catch (e) { merged = null; }
      if (!merged) continue;
      const m0 = list[0], mesh = new THREE.Mesh(merged, m0.material);
      mesh.name = m0.name; mesh.userData = JSON.parse(JSON.stringify(m0.userData)); mesh.castShadow = true; mesh.receiveShadow = true;
      for (const m of list) node.remove(m);
      node.add(mesh);
    }
  }
}

const Q = new URLSearchParams(location.search);
const TEST = Q.has("test");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || Q.has("reduced");
const PHONE = matchMedia("(max-width: 720px), (pointer: coarse)").matches || Q.has("phone");
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const CAP = { ducks: PHONE ? 4 : 8, props: PHONE ? 12 : 24 }; // props = extra toys allowed beyond the room's own
const SKIN_NAMES = ["cream", "sky", "lavender", "graphite"];

// ------------------------------------------------------------------ loading UI
const loadingEl = $("loading"), loadingBar = $("loadingBar"), loadingText = $("loadingText");
function progress(p) { loadingBar.style.width = Math.round(p * 100) + "%"; }
function fail(msg) { loadingEl.classList.add("failed"); loadingEl.classList.remove("done"); loadingText.textContent = msg; }
window.addEventListener("error", (e) => { if (!window.__lab?.ready) fail("Something went wrong while starting. Please reload."); console.error(e.error || e.message); });

main().catch((e) => { console.error(e); fail("Microduck could not start: " + (e && e.message ? e.message : e)); });

async function main() {
  // ---------------------------------------------------------------- renderer
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    if (!renderer.capabilities.isWebGL2) throw new Error("WebGL2 unavailable");
  } catch (e) { fail("This browser could not start WebGL 2, so the 3D lab cannot run here. Try a recent Chrome, Safari or Firefox."); return; }
  const quality = Q.get("q") || detectQuality();
  setupRenderer(renderer, { quality, maxDPR: 2 });
  $("stage").appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 40);
  const stage = buildStage(scene, renderer, { quality, floor: false, shadowExtent: 0.4, shadowMapSize: quality === "high" ? 2048 : 1024, keyIntensity: 3.2, hemiIntensity: 0.35 });
  const mats = makeMaterials({ quality });
  const rawWorld = buildWorld(scene, renderer, mats, { quality });
  const world = adaptWorld(rawWorld);
  progress(0.08);

  // ---------------------------------------------------------------- model: parse once, clone per duck
  const b64 = await new THREE.FileLoader().loadAsync("./microduck_rig.glb.txt", (ev) => { if (ev.lengthComputable) progress(0.08 + 0.72 * ev.loaded / ev.total); else progress(Math.min(0.8, 0.08 + ev.loaded / 4.2e6 * 0.72)); });
  const bin = Uint8Array.from(atob(String(b64).trim()), (c) => c.charCodeAt(0));
  const tmpl = (await new GLTFLoader().parseAsync(bin.buffer, "./")).scene;
  progress(0.85);
  // prepare geometry + materials on the template; clones then share geometry and materials
  { const holder = new THREE.Group(); holder.add(tmpl); tmpl.updateMatrixWorld(true); const r = applyLook(tmpl, mats, { parent: new THREE.Group() }); holder.remove(tmpl); stage.fitTo(tmpl); void r; mergeInternals(tmpl); }
  if (stage.setShadowExtent) stage.setShadowExtent(1.5);

  // skins shared between ducks of the same colourway (role colours as in look.js setSkin)
  const KIND_ROLE = { shell: "shell", shellAlt: "shell", orange: "accent", beak: "accent", foot: "accent", yellow: "accent2", soft: "soft", warmGrey: "secondary" };
  const skinCache = new Map();
  function skinMaterial(src, skin, role) {
    const key = skin + "|" + src.uuid;
    if (skinCache.has(key)) return skinCache.get(key);
    const m = src.clone(); m.onBeforeCompile = src.onBeforeCompile; m.customProgramCacheKey = src.customProgramCacheKey; m.userData = { ...src.userData };
    const S = SKINS[skin]; m.color.set(S[role] || src.color);
    if (S.dark && (role === "shell" || role === "secondary")) { m.roughness = 0.4; m.clearcoat = 0.5; m.clearcoatRoughness = 0.12; }
    skinCache.set(key, m); return m;
  }
  function applySkinShared(rig, skin) {
    if (skin === "cream") return;
    for (const mesh of rig.meshes) { const role = KIND_ROLE[mesh.userData.lookKind]; if (role) mesh.material = skinMaterial(mesh.material, skin, role); }
  }

  const phys = await createPhysics(world);
  const mind = new Mind(world, scene);
  const voice = new Voice();
  try { voice.muted = localStorage.getItem("microduck.muted") === "1"; } catch (e) { /* storage blocked */ }
  const sfx = createSfx(voice, world, () => S.simTime);   // procedural footsteps, servos, skates, falls (through voice.master)
  progress(0.95);

  // ---------------------------------------------------------------- shared game context
  const agents = [];
  let ctlAgent = null;
  let inv = null, cam = { tween: 0 };
  const laser = { on: false, visible: false, point: V(), dot: makeLaserDot({ size: 0.042 }), from: V() };
  laser.dot.setVisible(false); scene.add(laser.dot.object);
  const G = {
    world, phys, voice, scene, agents, laser, camera,
    balls: [], football: null, race: null, rescueDelay: 1.4,
    now: () => S.simTime, controlled: () => ctlAgent, leader: () => ctlAgent,
    events: {}, hud: null,
    sound: (kind, agent, data) => sfx.event(kind, agent, data),
    // surface under a point: { type, friction, bounce }. world.surfaceAt() when the world provides it, else a heuristic
    // (world.surfaceAt reuses one object: read the fields right away, copy anything kept)
    surfaceAt: (x, y, z) => world.surfaceAt ? world.surfaceAt(x, z, y + 0.02) : sfx.surfaceInfo(V(x, y, z)),
  };
  const S = {
    mode: "play", layer: "surface", W: { surface: 1, xray: 0, mind: 0 },
    joy: { x: 0, y: 0, active: false }, intentMode: false, simTime: 0, lastToastAt: -10,
    lastInputAt: 0, camDragAt: -10, fxLog: [], touchDrift: false, bagOpen: false, garageBusy: false, playPose: null, testInput: null, spaceAt: -1, name: null,
  };

  function makeDuck(skin) {
    const model = tmpl.clone(true);
    let duck = null;
    duck = new DuckBody(model, { ground: (x, z) => world.groundHeightAt(x, z, (duck ? duck.baseY : 0) + 0.035) });
    scene.add(duck.root); duck.root.updateMatrixWorld(true);
    const rig = applyLook(model, mats, { parent: scene, edges: !PHONE });
    rig.trackMotion = false;
    const mindLocal = duck.headNode.worldToLocal(rig.mind.position.clone());
    const scanOff = rig.scan.position.clone().sub(duck.root.position);
    rig.follow = () => {
      duck.headNode.localToWorld(rig.mind.position.copy(mindLocal));
      rig.scan.position.x = duck.root.position.x + scanOff.x; rig.scan.position.z = duck.root.position.z + scanOff.z;
    };
    applySkinShared(rig, skin);
    return { duck, rig };
  }
  function spawnDuck(pos, yaw, skin) {
    if (agents.length >= CAP.ducks) return null;
    skin = skin || SKIN_NAMES[agents.length % SKIN_NAMES.length];
    const { duck, rig } = makeDuck(skin);
    const a = new Agent(G, { duck, rig, serial: makeSerial(), skin, index: agents.length });
    agents.push(a);
    duck.onSound = (kind, data) => sfx.event(kind, a, data);
    a.teleport(pos, yaw ?? Math.random() * Math.PI * 2);
    rig.setWeights(S.W);
    inv && inv.refresh();
    return a;
  }
  function removeDuck(a) {
    if (agents.length <= 1) { toast("Keep one duck", "You need at least one duck to play.", "info"); return; }
    const i = agents.indexOf(a); if (i < 0) return;
    if (a.skates) a.unequipSkates();
    a.remove(); agents.splice(i, 1);
    agents.forEach((b, k) => b.index = k);
    if (a === ctlAgent) setControlled(agents[0]);
    inv && inv.refresh();
  }

  // ---------------------------------------------------------------- first ducks
  const start = world.start;
  const nStart = Number(Q.get("ducks") || (PHONE ? 3 : 3));
  for (let i = 0; i < Math.min(nStart, CAP.ducks); i++) spawnDuck(world.spawnSpot(i, nStart), i === 0 ? start.yaw : start.yaw + (i - 1) * 0.6 - 0.3, i === 0 ? "cream" : undefined);
  const workshop = new Workshop({ scene, duck: agents[0].duck, rig: agents[0].rig, reduced });

  // controlled-duck ring marker
  const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#F5F5F7").multiplyScalar(1.3), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.085, 0.092, 64), ringMat);
  ring.rotation.x = -Math.PI / 2; ring.renderOrder = 23; ring.userData.lookNoContact = true; ring.userData.lookFX = true; scene.add(ring);
  // intent target marker
  const markMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#BF5AF2").multiplyScalar(1.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.024, 48), markMat);
  marker.rotation.x = -Math.PI / 2; marker.userData.lookNoContact = true; marker.userData.lookFX = true; marker.renderOrder = 23; scene.add(marker);

  function setControlled(a) {
    if (!a || a === ctlAgent) return;
    if (S.drag) stopDragStrip();
    if (ctlAgent) { ctlAgent.controlled = false; ctlAgent.speedMult = 1; ctlAgent.cancelTask(); ctlAgent.brain.t = 999; }
    ctlAgent = a; a.controlled = true; a.cancelTask();
    voice.setSerial(a.serial);
    cam.tween = 1;     // camera eases over to the new duck
    workshop.bind(a.duck, a.rig);
    a.chirp("hello", true);
  }
  setControlled(agents[0]);

  // ---------------------------------------------------------------- post + sizing
  const post = setupPost(renderer, scene, camera, { quality, samples: quality === "high" ? 4 : 2, aa: "msaa" });
  // ---- comic FX hook (toon.js): stickers / speed lines / impact frames driven from game state
  if (post.fx) { post.fx.reducedMotion = reduced; post.fx.watch(agents, G, () => ctlAgent); window.__fx = post.fx; }
  // ---- duck thoughts: comic speech bubbles over the AI ducks (what each one is doing / about to do)
  let wallMeshes = null;   // occluders for the bubbles: the merged wall meshes only (a few boxes, cheap to raycast)
  const occluders = () => { if (!wallMeshes) { wallMeshes = []; (rawWorld.root || scene).traverse(m => { if (m.isMesh && m.material && m.material.name === "wall") wallMeshes.push(m); }); } return wallMeshes; };
  const hudRects = []; let hudRectsAt = -1;
  const HUD_SEL = [".brand", ".tabs", ".tools", ".layers", "#moves", "#bar:not(.collapsed)", "#bagBtn", "#gameHud:not(.hidden)", ".joy", ".tbtns", "#viewBtn", "#help:not(.fade)", "#mindPanel:not(.hidden)", "#thPanel:not(.hidden)", ".toast.show", "#racePick:not([hidden])", ".credit", "body.view-open .view-pop", "body.view-open .play-chips"];
  function bubbleFree(x, y) {
    if (frame !== hudRectsAt && (frame - hudRectsAt > 20 || hudRectsAt < 0)) {
      hudRectsAt = frame; let n = 0;
      for (const sel of HUD_SEL) for (const el of document.querySelectorAll(sel)) {
        if (!el.offsetParent && getComputedStyle(el).position !== "fixed") continue;
        const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;
        const R = hudRects[n] || (hudRects[n] = { l: 0, t: 0, r: 0, b: 0 }); R.l = r.left; R.t = r.top; R.r = r.right; R.b = r.bottom; n++;
      }
      hudRects.length = n;
    }
    // the bubble sits above (x, y): roughly 170 x 58 px (smaller on phone)
    const hw = PHONE ? 66 : 88, h = PHONE ? 50 : 62;
    for (const R of hudRects) if (x + hw > R.l && x - hw < R.r && y > R.t && y - h < R.b) return false;
    return y - h > 0 && x - hw > 0 && x + hw < innerWidth;
  }
  // mirror of the wall cutaway shader (house.js): is this wall point currently cut away (so it doesn't hide a bubble)?
  const _ab = V(), _ap = V();
  function wallCut(pt) {
    if (CUT.uCutTop.value !== 0 && pt.y > CUT.uCutTop.value) return true;
    if (CUT.uCutOn.value <= 0.5) return false;
    const c = CUT.uCutCam.value, f = CUT.uCutFocus.value;
    if (pt.distanceTo(c) < CUT.uCutNear.value) return true;
    _ab.copy(f).sub(c); const L2 = Math.max(_ab.lengthSq(), 1e-4), t = Math.min(1, Math.max(0, _ap.copy(pt).sub(c).dot(_ab) / L2));
    const d = _ap.copy(c).addScaledVector(_ab, t).distanceTo(pt);
    return t < 1 - 0.12 / Math.sqrt(L2) && d < CUT.uCutR.value + 0.03;
  }
  const thoughts = createThoughts({ G, camera, world, occluders, isCut: wallCut, phone: PHONE, isFree: bubbleFree });
  { let on = true; try { on = localStorage.getItem("microduck.thoughts") !== "0"; } catch (e) { /* storage blocked */ } thoughts.enabled = on; }
  function setThoughts(on) {
    thoughts.enabled = !!on; $("thoughtsBtn").setAttribute("aria-pressed", String(thoughts.enabled));
    try { localStorage.setItem("microduck.thoughts", thoughts.enabled ? "1" : "0"); } catch (e) { /* storage blocked */ }
    if (!thoughts.enabled) thoughts.hideAll();
  }
  // skate tricks -> comic FX (the skate smoke / bolts / skids in toon.js react to the acceleration and slip by themselves)
  G.events.boost = (a, kind) => {
    S.fxLog.push(kind);
    if (!post.fx) return;
    const isC = a === ctlAgent, p = a.duck.root.position;
    if (kind === "boost") post.fx.emit("zoom", p, { impact: isC ? 1 : 0, speed: 1, offsetY: 0.15, key: a.index, cooldown: 0.5 });
    else post.fx.emit("whee", p, { impact: isC ? 0.5 : 0, speed: 0.8, offsetY: 0.15, key: a.index, cooldown: 0.5 });
  };
  G.events.drift = (a, on) => { if (on) S.fxLog.push("drift"); };
  // puddle: SPLASH! sticker (+ droplets from the skate FX pool when it exists)
  G.events.splash = (a, sp) => {
    S.fxLog.push("splash");
    if (!post.fx || reduced) return;
    const p = a.duck.root.position, isC = a === ctlAgent;
    if (isC || a.pos.distanceTo(camera.position) < 3) post.fx.emit("splash", p, { text: "SPLASH!", scale: isC ? 0.9 : 0.6, offsetY: 0.1, key: a.index, cooldown: 0.9, life: 0.9 });
    const P = post.fx.skate; if (P) {
      const y = p.y + 0.005, n = isC ? 7 : 3;
      for (let i = 0; i < n; i++) { const ang = Math.random() * Math.PI * 2; P.glint && P.glint(p.x + Math.cos(ang) * 0.04, y + 0.02 + Math.random() * 0.03, p.z + Math.sin(ang) * 0.04, 1.1); }
      for (let i = 0; i < (isC ? 3 : 1); i++) P.smoke && P.smoke(p.x, y, p.z, Math.cos(i * 2.1), Math.sin(i * 2.1), 0.7);
    }
  };
  G.events.boing = (a) => { S.fxLog.push("boing"); if (post.fx && !reduced && a === ctlAgent) post.fx.emit("whee", a.duck.root.position, { text: "BOING!", scale: 0.7, offsetY: 0.16, key: "boing" + a.index, cooldown: 1.2, life: 0.8 }); };
  G.events.crash = (a) => { S.fxLog.push("crash"); if (post.fx && a === ctlAgent) post.fx.impact(1, a.duck.root.position); };
  const eyeCam = new THREE.PerspectiveCamera(62, 1, 0.006, 6);
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h;
    camera.fov = w / h < 0.8 ? 52 : 40; camera.updateProjectionMatrix();
    post.resize(w, h); stage.resize(w, h);
  }
  addEventListener("resize", resize); resize();
  const aq = TEST ? null : createAdaptiveQuality(renderer, { onChange: resize, min: 1, max: 2, budgetMs: 20 });

  // ---------------------------------------------------------------- UI helpers
  const toastEl = $("toast"); let toastTimer = 0;
  function toast(title, sub = "", kind = "warn", ms = 2600) {
    $("toastT").textContent = title; $("toastS").textContent = sub; toastEl.classList.remove("bubble");
    toastEl.classList.toggle("violet", kind !== "warn"); $("toastIc").textContent = kind === "warn" ? "!" : "•";
    toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }
  function pulse() {
    const p = $("pulse"); p.classList.remove("go"); void p.offsetWidth; p.classList.add("go");
    if (!reduced) { document.body.classList.remove("shake"); void document.body.offsetWidth; document.body.classList.add("shake"); }
    try { navigator.vibrate && navigator.vibrate(35); } catch (e) {}
  }
  G.toast = toast; G.pulse = pulse;
  const help = $("help"); let helpTimer = setTimeout(() => help.classList.add("fade"), 12000);
  $("helpBtn").onclick = () => { help.classList.toggle("fade"); clearTimeout(helpTimer); helpTimer = setTimeout(() => help.classList.add("fade"), 15000); };
  $("infoBtn").onclick = () => $("credit").classList.toggle("open");
  const showMute = () => { $("soundBtn").setAttribute("aria-pressed", String(!voice.muted)); $("soundWave").style.opacity = voice.muted ? 0 : 1; };
  $("soundBtn").onclick = () => {
    voice.muted = !voice.muted; showMute(); voice.ensure();
    try { localStorage.setItem("microduck.muted", voice.muted ? "1" : "0"); } catch (e) { /* storage blocked */ }
    if (!voice.muted) voice.play("hello", { force: true });
  };
  showMute();
  $("safetyBtn").onclick = () => { mind.safety = !mind.safety; $("safetyBtn").setAttribute("aria-pressed", String(mind.safety)); toast(mind.safety ? "Safety reflex on" : "Safety reflex off", mind.safety ? "It will refuse to step off an edge." : "It will do what you say, even off an edge.", mind.safety ? "info" : "warn"); };
  $("intentBtn").onclick = () => setIntentMode(!S.intentMode);
  $("thoughtsBtn").onclick = () => setThoughts(!thoughts.enabled);
  $("thoughtsBtn").setAttribute("aria-pressed", String(thoughts.enabled));
  function setIntentMode(on) {
    S.intentMode = on; $("intentBtn").setAttribute("aria-pressed", String(on));
    renderer.domElement.classList.toggle("intent", on);
    if (on) { setLaser(false); toast("Intent mode", "Click the floor to send it there, click a toy to fetch it.", "info", 3400); }
    else if (ctlAgent.task && ctlAgent.task.kind === "go") ctlAgent.cancelTask();
  }

  // ---------------------------------------------------------------- HUD for games
  const gameHud = $("gameHud"), countEl = $("countdown");
  const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return (m ? m + ":" : "") + (m ? String(Math.floor(s)).padStart(2, "0") : Math.floor(s)) + "." + String(Math.floor((s % 1) * 10)); };
  G.hud = {
    hide() { gameHud.classList.add("hidden"); countEl.classList.remove("show"); },
    football(score, scored) {
      gameHud.classList.remove("hidden");
      gameHud.innerHTML = `<span class="team t0">Orange</span><b class="sc">${score[0]}<i>:</i>${score[1]}</b><span class="team t1">Teal</span><button class="x" id="hudX" aria-label="End game">×</button>`;
      $("hudX").onclick = () => toggleFootball(false);
      if (scored != null) { gameHud.classList.remove("flash"); void gameHud.offsetWidth; gameHud.classList.add("flash"); }
    },
    race(R) {
      gameHud.classList.remove("hidden");
      const P = R.prog.get(ctlAgent);
      if (R.frozen) {
        const n = Math.ceil(R.countdown - 0.6);
        countEl.textContent = n > 0 ? String(n) : "GO!"; countEl.classList.add("show");
      } else if (R.t > 0.8) countEl.classList.remove("show"); else { countEl.textContent = "GO!"; countEl.classList.add("show"); }
      const pos = R.standings().findIndex(s => s.a === ctlAgent) + 1;
      const lap = P ? Math.min(P.lap, R.laps) : 1;
      gameHud.innerHTML = `<span class="lbl">Lap</span><b>${lap}/${R.laps}</b><span class="lbl">Time</span><b class="mono">${fmt(R.frozen ? 0 : (P && P.done ? P.time : R.t))}</b><span class="lbl">Place</span><b>${pos}/${R.prog.size}</b><button class="x" id="hudX" aria-label="End race">×</button>`;
      $("hudX").onclick = () => toggleRace(false);
    },
  };
  Object.assign(G.events, {   // keep the skate-trick handlers added above
    goal(team, score) { for (const a of agents) if (a.team === team && !a.controlled) thoughts.event(a, "goal"); toast("GOAL!", (team === ctlAgent.team ? "Your team scores. " : "The other team scores. ") + score[0] + " : " + score[1], "info", 2200); voice.play("happy", { force: true, params: ctlAgent.voice }); pulse(); },
    countdown(n) { voice.play(n === 0 ? "happy" : "curious", { force: true, params: ctlAgent.voice }); },
    finish(a, place, t) { if (a === ctlAgent) toast(place === 1 ? "You win!" : `Finished ${["", "1st", "2nd", "3rd"][place] || place + "th"}`, "Time " + fmt(t), "info", 3400); },
    raceOver() { toast("Race over", "Press R or the Race button to go again.", "info"); },
    fetched(a, p) { if (a === ctlAgent) toast("Fetched the " + (p.spec.label || p.kind).toLowerCase(), "For you.", "info"); },
    grabFailed(a, why) { if (a === ctlAgent) toast(why === "missed" ? "Missed it" : "Couldn't get there", why === "missed" ? "Try again from a little closer." : "Something is in the way.", "info"); },
    edgeFall(a) { if (a === ctlAgent) pulse(); },
    rescue(a) {
      if (a === ctlAgent) { $("fadeText").textContent = "Picked up and put back"; $("fadeBlack").classList.add("on"); setTimeout(() => $("fadeBlack").classList.remove("on"), TEST ? 0 : 700); }
      a.teleport(world.spawnSpot(agents.indexOf(a), agents.length), start.yaw);
    },
  });

  // ---------------------------------------------------------------- modes + layers
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll(".layers button").forEach(b => b.onclick = () => setLayer(b.dataset.layer));
  function setLayer(l) { S.layer = l; document.querySelectorAll(".layers button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.layer === l))); updatePanels(); }
  function updatePanels() {
    const showMind = (S.layer === "mind" || S.mode === "sensors") && S.mode !== "garage";
    $("mindPanel").classList.toggle("hidden", !showMind);
    $("thPanel").classList.toggle("hidden", S.mode !== "garage");
    document.querySelectorAll(".mode-play").forEach(el => el.classList.toggle("hidden", S.mode === "garage"));
    document.body.classList.toggle("garage", S.mode === "garage");
  }
  function setMode(m) {
    if (S.garageBusy) return;
    const prev = S.mode; if (m === prev) return;
    S.mode = m; document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    if (prev === "garage") leaveGarage();
    if (m === "garage") enterGarage();
    if (m === "sensors") { setLayer("mind"); toast("Sensor view", "What your duck senses: depth grid, head camera, its own caution.", "info", 3400); }
    if (m === "play" && S.layer === "mind" && prev === "sensors") setLayer("surface");
    updatePanels();
  }

  // ---------------------------------------------------------------- moves (keyboard + buttons)
  function doMove(m) {
    const a = ctlAgent; if (!a || S.mode === "garage") return; voice.ensure();
    switch (m) {
      case "sit": a.setSit(!a.duck.sitTarget); break;
      case "crouch": a.setCrouch(!a.duck.crouchTarget); break;
      case "nod": case "shake": case "dance": case "look": a.emote(m); break;
      case "skates": toggleSkates(a); break;
      case "grab": grabKey(); break;
      case "beak": if (a.skates) return; beakDown(); setTimeout(beakUp, 0); break;
      case "boost": if (!a.skates) { toast("Skates first", PHONE ? "Tap Moves, then Skates." : "Press K to put skates on.", "info"); return; } a.boost(); break;
      case "drift": if (!a.skates) { toast("Skates first", PHONE ? "Tap Moves, then Skates." : "Press K to put skates on.", "info"); return; } toast("Drift", PHONE ? "Hold DRIFT and steer." : "Hold Space and steer with A/D.", "info", 1800); break;
      case "bag": setBag(!S.bagOpen); break;
      case "laser": setLaser(!laser.on); break;
      case "football": toggleFootball(); break;
      case "race": if (G.race && G.race.active) toggleRace(false); else if (S.drag) stopDragStrip(); else openRacePick(); break;
      case "next": { const i = agents.indexOf(a); setControlled(agents[(i + 1) % agents.length]); break; }
    }
    refreshMoves();
  }
  function refreshMoves() {
    const a = ctlAgent;
    const set = (k, on) => document.querySelectorAll(`[data-move="${k}"]`).forEach(b => b.setAttribute("aria-pressed", String(!!on)));
    set("sit", a.duck.sitTarget); set("crouch", a.duck.crouchTarget); set("skates", !!a.skates); set("laser", laser.on);
    set("football", G.football && G.football.active); set("race", (G.race && G.race.active) || !!S.drag); set("bag", S.bagOpen);
    const sk = !!a.skates; document.body.classList.toggle("skating", sk);
    document.querySelectorAll(".moves .skate-only").forEach(b => { b.setAttribute("aria-disabled", String(!sk)); b.title = sk ? "" : "Put skates on first"; });
  }
  // boost cooldown ring (moves row + phone button), updated every frame
  function updateBoostUI() {
    const a = ctlAgent, B = SKATE.boost, cd = a && a.skates ? a.boostCd / (B.time + B.cooldown) : 0;
    document.querySelectorAll(".boost-cd").forEach(el => { el.style.setProperty("--cd", cd.toFixed(3)); el.classList.toggle("cooling", cd > 0); el.classList.toggle("firing", !!(a && a.boostT > 0)); });
    $("tDrift").classList.toggle("on", !!(a && a.drifting));
    if (post.fx && a && a.boostT > 0 && !reduced) post.fx.speed(a.duck.root.position, 0.85);
  }
  // first time on skates: how to boost and drift (once per browser)
  function skateTutorial() {
    let seen = false; try { seen = localStorage.getItem("microduck.tut.skates") === "1"; localStorage.setItem("microduck.tut.skates", "1"); } catch (e) { /* storage blocked */ }
    if (seen && !Q.has("tut")) return false;
    toast(PHONE ? "BOOST and DRIFT buttons!" : "SHIFT to boost · hold SPACE to drift!", PHONE ? "Tap BOOST for a burst. Hold DRIFT and steer to slide." : "Steer while drifting, let go for a slingshot.", "info", 5200);
    toastEl.classList.add("bubble");
    return true;
  }
  // ---------------------------------------------------------------- bag (inventory bar, collapsed by default)
  function setBag(open) {
    open = !!open; if (open === S.bagOpen) return;
    S.bagOpen = open; $("bar").classList.toggle("collapsed", !open); document.body.classList.toggle("bag-open", open);
    $("bagBtn").setAttribute("aria-expanded", String(open));
    if (!open) { inv.select(null); inv.setTrash(false); }
    refreshMoves();
  }
  $("bagBtn").addEventListener("click", (e) => { e.stopPropagation(); voice.ensure(); setBag(!S.bagOpen); });
  addEventListener("pointerdown", (e) => {
    if (!S.bagOpen || inv.selected || inv.trash) return;
    const t = e.target; if (t.closest && (t.closest("#bar") || t.closest("#bagBtn") || t.closest('[data-move="bag"]'))) return;
    setBag(false);
  }, true);
  document.querySelectorAll("[data-move]").forEach(b => b.addEventListener("click", () => { doMove(b.dataset.move); if (PHONE && !["sit", "crouch", "skates", "laser"].includes(b.dataset.move)) $("moves").classList.remove("open"); }));
  $("tMore").addEventListener("click", () => { $("moves").classList.toggle("open"); $("tMore").setAttribute("aria-pressed", String($("moves").classList.contains("open"))); });

  // skates: one pair per duck, a shared spare pool
  const skatePool = [];
  function newSkates() { return skatePool.pop() || makeSkates({ deck: ["#E6513D", "#3D8BE6", "#9B5DE5", "#2EC4B6"][Math.floor(Math.random() * 4)] }); }
  const skatesWorn = () => agents.filter(a => a.skates).length;
  function toggleSkates(a) {
    if (a.skates) { skatePool.push(a.unequipSkates()); toast("Skates off", "", "info", 1200); }
    else { a.equipSkates(newSkates()); G.sound("clack", a); if (a === ctlAgent && !skateTutorial()) toast("Skates on!", PHONE ? "Joystick to push and steer. BOOST and DRIFT appear on the right." : "W to push, A/D to steer, S to brake, Shift to boost, hold Space to drift.", "info", 3000); }
    inv.refresh(); refreshMoves();
  }

  // ---------------------------------------------------------------- laser pointer
  function setLaser(on) {
    laser.on = on; laser.dot.setVisible(on && laser.visible); renderer.domElement.classList.toggle("laser", on);
    if (on) { if (S.intentMode) setIntentMode(false); toast("Laser pointer", PHONE ? "Drag your finger on the floor. Ducks chase the dot." : "Move the mouse over the floor. Ducks chase the dot.", "info", 3000); }
    else laser.visible = false;
    refreshMoves();
  }
  function laserAt(x, y) {
    const h = pickSurface(x, y);
    if (!h) { laser.visible = false; laser.dot.setVisible(false); return; }
    laser.point.copy(h.point); laser.visible = true; laser.dot.setVisible(true);
    laser.from.copy(camera.position).add(V(0.25, -0.05, 0).applyQuaternion(camera.quaternion));
    laser.dot.set(h.point, h.normal, laser.from);
  }

  // ---------------------------------------------------------------- football + race
  function ensureBall() {
    let b = G.balls.find(x => phys.props.includes(x));
    if (!b) b = spawnProp("sock_ball", V(...(world.football.ballSpawn || world.football.center)));
    return b;
  }
  function toggleFootball(on) {
    if (!G.football) G.football = new Football(G);
    const want = on ?? !G.football.active;
    if (want) { if (G.race && G.race.active) G.race.stop(); G.football.start(ensureBall()); toast("Football!", "Walk into the sock ball to kick it. Orange attacks the far goal.", "info", 3200); }
    else G.football.stop();
    refreshMoves();
  }
  // ---------------------------------------------------------------- race picker: living-room loop, whole-house race, hallway drag strip
  function houseTrack() {
    const H = world.anchors.raceHouse; if (!H) return null;
    return { checkpoints: [H.start.position, ...H.checkpoints.map(c => c.position)], radius: [H.start.width / 2, ...H.checkpoints.map(c => c.radius || 0.4)],
      startDir: H.start.direction, laps: 1, speedBoost: 2.6, builtIn: true, noOffset: true };
  }
  const racePick = $("racePick");
  function openRacePick() {
    racePick.querySelector('[data-track="house"]').hidden = !world.anchors.raceHouse;
    racePick.querySelector('[data-track="drag"]').hidden = !world.anchors.dragStrip;
    racePick.hidden = false; racePick.querySelector("button:not([hidden])").focus({ preventScroll: true });
  }
  const closeRacePick = () => { racePick.hidden = true; };
  function startTrack(kind) {
    closeRacePick();
    if (kind === "drag") { startDragStrip(); return; }
    if (S.drag) stopDragStrip(true);
    if (!G.race) G.race = new Race(G);
    G.race.setTrack(kind === "house" ? houseTrack() : null);
    toggleRace(true);
    if (kind === "house") toast("House race!", "Through the hallway, kitchen, living room and bedroom. One lap.", "info", 3200);
  }
  racePick.querySelectorAll("[data-track]").forEach(b => b.addEventListener("click", () => startTrack(b.dataset.track)));
  $("racePickX").addEventListener("click", closeRacePick);

  // drag strip: a timed straight sprint down the hallway (skates on, boost recommended)
  const DRAG_KEY = "microduck.drag.best";
  function startDragStrip() {
    const D = world.anchors.dragStrip; if (!D) return;
    if (G.race && G.race.active) toggleRace(false);
    if (G.football && G.football.active) toggleFootball(false);
    const a = ctlAgent, dir = V(D.direction[0], 0, D.direction[2]).normalize(), start = V(...D.start), finish = V(...D.finish);
    if (!a.skates) toggleSkates(a);
    a.cancelTask(); a.releaseHeld();
    a.teleport(start.clone().addScaledVector(dir, -0.12).setY(world.groundHeightAt(start.x, start.z, start.y + 0.05)), Math.atan2(dir.x, dir.z));
    // clear the strip: other ducks wait in the living room
    agents.forEach((b, i) => { if (b !== a && world.roomAt(b.pos.x, b.pos.z) === "hallway") b.teleport(world.spawnSpot(i + 1, agents.length + 2), b.yaw); });
    let best = null; try { best = Number(localStorage.getItem(DRAG_KEY)) || null; } catch (e) { /* storage blocked */ }
    S.drag = { phase: "count", cd: 3.6, t: 0, dir, start, len: finish.clone().sub(start).dot(dir), best, done: 0 };
    cam.tYaw = a.yaw + Math.PI - 0.35; cam.tPitch = 0.3; cam.tDist = 1.0; cam.tween = 1;
    refreshMoves(); dragHud();
  }
  function stopDragStrip(silent) { ctlAgent.speedMult = 1; S.drag = null; G.hud.hide(); refreshMoves(); if (!silent) countEl.classList.remove("show"); }
  function updateDragStrip(dt) {
    const D = S.drag, a = ctlAgent;
    if (D.phase === "count") {
      D.cd -= dt; const n = Math.ceil(D.cd - 0.6);
      if (D.lastN !== n) { D.lastN = n; voice.play(n <= 0 ? "happy" : "curious", { force: true, params: a.voice }); }
      if (D.cd <= 0.6) { D.phase = "run"; D.t = 0; a.speedMult = 1.6; }   // the strip is fast: higher top speed for the run
    } else if (D.phase === "run") {
      D.t += dt;
      const prog = a.pos.clone().sub(D.start).dot(D.dir);
      if (prog >= D.len) {
        D.phase = "done"; D.done = 0; a.speedMult = 1; const t = D.t;
        const rec = !D.best || t < D.best; if (rec) { D.best = t; try { localStorage.setItem(DRAG_KEY, String(t)); } catch (e) { /* storage blocked */ } }
        toast(rec ? "New record!" : "Finish!", "Drag strip: " + fmt(t) + " s" + (rec ? "" : " · best " + fmt(D.best)), "info", 3600);
        if (post.fx) post.fx.emit("pow", a.duck.root.position, { text: rec ? "RECORD!" : "FINISH!", impact: 1, offsetY: 0.18, life: 1.5 });
        a.chirp("happy", true);
      }
      if (D.t > 40) stopDragStrip();
    } else if (D.phase === "done") { D.done += dt; if (D.done > 4.5) { stopDragStrip(); return; } }
    if (S.drag) dragHud();
  }
  function dragHud() {
    const D = S.drag; if (!D) return;
    gameHud.classList.remove("hidden");
    if (D.phase === "count") { const n = Math.ceil(D.cd - 0.6); countEl.textContent = n > 0 ? String(n) : "GO!"; countEl.classList.add("show"); }
    else if (D.phase === "run" && D.t > 0.8) countEl.classList.remove("show"); else if (D.phase === "run") { countEl.textContent = "GO!"; countEl.classList.add("show"); }
    const t = D.phase === "count" ? 0 : D.t;
    gameHud.innerHTML = `<span class="lbl">Drag strip</span><b class="mono">${fmt(t)}</b><span class="lbl">Best</span><b class="mono">${D.best ? fmt(D.best) : "–"}</b><button class="x" id="hudX" aria-label="End drag strip">×</button>`;
    $("hudX").onclick = () => stopDragStrip();
  }
  function toggleRace(on) {
    if (!G.race) G.race = new Race(G);
    const want = on ?? !G.race.active;
    if (want) { if (G.football && G.football.active) G.football.stop(); for (const a of agents) if (a.skates && a !== ctlAgent) skatePool.push(a.unequipSkates()); G.race.start(); cam.tween = 1; }
    else G.race.stop();
    refreshMoves();
  }

  // ---------------------------------------------------------------- spawning props
  const spawned = new Set();
  // Room toys don't count against the cap: the cap is the starting toy count plus a per-device allowance.
  let PROP_BASE = null;
  const propCap = () => { if (PROP_BASE === null) PROP_BASE = Math.max(0, phys.props.length - spawned.size); return PROP_BASE + CAP.props; };
  function spawnProp(kind, point, yaw = Math.random() * Math.PI * 2) {
    const entry = PROP_CATALOG[kind]; if (!entry) return null;
    if (phys.props.length >= propCap()) { toast("That's plenty of toys", "Delete some with the trash slot first.", "info"); return null; }
    const p = entry.make();
    placeProp(p, point.x, point.y, point.z, yaw);
    scene.add(p.object);
    world.addProp(p);
    const rec = phys.addProp(p, { restitution: p.restitution ?? 0.15, linearDamping: kind === "sock_ball" ? 0.25 : 0.4, angularDamping: kind === "sock_ball" ? 0.3 : 0.8 });
    spawned.add(rec);
    if (p.kickable || kind === "sock_ball") G.balls.push(rec);
    inv && inv.refresh();
    return rec;
  }
  function removeProp(rec) {
    if (rec.holder) rec.holder.releaseHeld();
    phys.removeProp(rec); scene.remove(rec.object); world.removeProp(rec.spec);
    if (rec.spec.shadow) scene.remove(rec.spec.shadow);
    G.balls = G.balls.filter(b => b !== rec);
    if (G.football && G.football.ball === rec) G.football.stop();
    inv && inv.refresh();
  }
  // world props that are balls count too
  for (const p of phys.props) if (p.spec.kickable) G.balls.push(p);

  // ---------------------------------------------------------------- picking
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(x, y, objects) {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objects, true).find(h => h.object.visible !== false && !h.object.userData.lookFX);
  }
  const surfaceMeshes = () => world.meshes.length ? world.meshes : [world.root];
  function pickSurface(x, y) {
    const h = pick(x, y, surfaceMeshes()); if (!h) return null;
    const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : V(0, 1, 0);
    if (n.y < 0.6) return null;
    return { point: h.point.clone(), normal: n, object: h.object, distance: h.distance };
  }
  function agentOfObject(o) { for (const a of agents) { let p = o; while (p) { if (p === a.duck.root) return a; p = p.parent; } } return null; }
  function propOfObject(o) { for (const p of phys.props) { let q = o; while (q) { if (q === p.object) return p; q = q.parent; } } return null; }
  const duckMeshes = () => agents.flatMap(a => a.rig.meshes.filter(m => m.visible));
  // hovering an AI duck pops its thought bubble right away (throttled pick)
  let hoverAt = 0, hovered = null;
  function hoverDuck(x, y) {
    const now = performance.now(); if (now - hoverAt < 140 || S.customising || S.mode === "garage") return; hoverAt = now;
    const h = pick(x, y, duckMeshes()), a = h ? agentOfObject(h.object) : null;
    if (a && !a.controlled && a !== hovered) thoughts.poke(a);
    hovered = a;
  }

  // ---------------------------------------------------------------- inventory
  const DUCK_ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M6 6.5c0-2 2-3.5 6-3.5s6 1.5 6 3.5v3H6z" fill="#EFE6D2"/><path d="M6 9.5h12v1.5H6z" fill="#F28C28"/><circle cx="9" cy="7" r="1.6" fill="#F5B324"/><rect x="10.8" y="11" width="2.4" height="3" fill="#44484E"/><rect x="8" y="14" width="8" height="4.5" rx="1.5" fill="#EFE6D2"/><path d="M7.5 21h3.5l-.6-2.5H8zM13 21h3.5l-.5-2.5h-2.4z" fill="#F28C28"/></svg>';
  const SKATE_ICON = '<svg viewBox="0 0 24 24" width="24" height="24"><path d="M4 14h15a1 1 0 0 1 0 2H4z" fill="#E6513D"/><path d="M6 6h5l1 6h6v2H6z" fill="#F5F5F7"/><circle cx="7" cy="18.5" r="2" fill="#F5E6B8"/><circle cx="16" cy="18.5" r="2" fill="#F5E6B8"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#FF6961" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/></svg>';
  const propCount = () => phys.props.length;
  const items = [
    { key: "duck", label: "Duck", icon: DUCK_ICON, count: () => agents.length, cap: () => CAP.ducks, can: () => agents.length < CAP.ducks },
    { key: "skates", label: "Skates", icon: SKATE_ICON, count: () => skatesWorn(), cap: () => agents.length, can: () => agents.some(a => !a.skates) },
    ...Object.entries(PROP_CATALOG).map(([k, e]) => ({ key: k, label: e.label, icon: e.icon, count: () => phys.props.filter(p => p.kind === k).length, cap: () => 0, can: () => propCount() < propCap() })),
    { key: "trash", label: "Delete", icon: TRASH_ICON, count: () => 0, cap: () => 0, can: () => true },
  ];
  const ghostObject = (key) => {
    if (key === "duck") { const g = new THREE.Group(); const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.04, 0.12, 4, 12), new THREE.MeshBasicMaterial()); m.position.y = 0.11; g.add(m); return g; }
    if (key === "skates") { const s = makeSkates(); const g = new THREE.Group(); s.left.position.set(0.04, s.height, 0); s.right.position.set(-0.04, s.height, 0); s.left.rotation.y = s.right.rotation.y = -Math.PI / 2; g.add(s.left, s.right); return g; }
    const e = PROP_CATALOG[key]; if (!e) return null; const p = e.make(); placeProp(p, 0, 0, 0, 0); return p.object;
  };
  function placementHit(x, y, key) {
    const h = pickSurface(x, y); if (!h) return null;
    const P = h.point;
    let ok = Math.abs(world.groundHeightAt(P.x, P.z, P.y + 0.01) - P.y) < 0.01;
    let target = null;
    if (key === "skates") { // drop onto a duck (or near one)
      const dh = pick(x, y, duckMeshes()); target = dh ? agentOfObject(dh.object) : null;
      if (!target) { let best = null, bd = 0.15; for (const a of agents) { const d = a.pos.distanceTo(P); if (d < bd && !a.skates) { bd = d; best = a; } } target = best; }
      ok = !!target && !target.skates;
      if (target) P.copy(target.pos);
    }
    if (key === "duck") ok = ok && world.isOpen(P.x, P.z, 0.05) && agents.every(a => a.pos.distanceTo(P) > 0.1);
    return { point: P, ok, target, yaw: key === "duck" ? Math.atan2(camera.position.x - P.x, camera.position.z - P.z) : null };
  }
  inv = createInventory({
    bar: $("bar"), scene, items,
    pick: placementHit,
    pickObject: (x, y) => {
      const ph = pick(x, y, phys.props.map(p => p.object)), dh = pick(x, y, duckMeshes());
      if (ph && (!dh || ph.distance <= dh.distance)) return { prop: propOfObject(ph.object) };
      if (dh) return { agent: agentOfObject(dh.object) };
      return null;
    },
    ghostObject,
    onPlace(key, hit) {
      voice.ensure();
      if (key === "duck") { const a = spawnDuck(hit.point, hit.yaw); if (a) { a.chirp("hello", true); toast("New duck!", `Say hi to ${a.serial}. Click it to take control.`, "info"); } }
      else if (key === "skates") { if (hit.target) { hit.target.equipSkates(newSkates()); if (hit.target === ctlAgent && !skateTutorial()) toast("Skates on!", "Push with W, brake with S.", "info"); } }
      else { const r = spawnProp(key, hit.point); if (r && key === "sock_ball" && !(G.football && G.football.active)) toast("Sock ball", "Walk into it to kick. Press F for a football match.", "info"); }
      setTimeout(() => setBag(false), 0);
      refreshMoves();
    },
    onDelete(obj) { deleteThing(obj); },
    onFull(it) { toast(it.key === "duck" ? `${CAP.ducks} ducks max` : it.key === "skates" ? "Every duck has skates" : "Toy limit reached", it.key === "duck" ? "Delete a duck to add another." : "", "info"); },
    onTrash(on) { renderer.domElement.classList.toggle("trash", on); if (on) toast("Delete", "Click a toy or a duck to remove it. Right-click (or long-press) works too.", "info"); },
  });
  function deleteThing(obj) {
    if (!obj) return;
    if (obj.prop) { removeProp(obj.prop); voice.play("curious", { force: true }); }
    else if (obj.agent) { if (obj.agent.skates && obj.agent !== ctlAgent) { skatePool.push(obj.agent.unequipSkates()); } removeDuck(obj.agent); }
    inv.refresh();
  }

  // ---------------------------------------------------------------- input: keyboard
  const keys = new Set();
  const KEYMOVE = { x: "sit", c: "crouch", 1: "nod", 2: "shake", 3: "dance", 4: "look", k: "skates", l: "laser", f: "football", r: "race", tab: "next" };
  addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    if (S.customising) return;
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " ", "tab"].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k); S.lastInputAt = S.simTime; voice.ensure();
    if (k === " " && !ctlAgent.skates) beakDown();          // on skates Space is held for drifting instead
    if (k === "shift") doMove("boost");
    if (k === "b") setBag(!S.bagOpen);
    if (k === "t") { setThoughts(!thoughts.enabled); toast(thoughts.enabled ? "Duck thoughts on" : "Duck thoughts off", "", "info", 1200); }
    if (k === "e") grabKey();
    if (k === "v") setLayer({ surface: "xray", xray: "mind", mind: "surface" }[S.layer]);
    if (!racePick.hidden) {
      const m = { 1: "living", 2: "house", 3: "drag" }[k];
      if (m && !racePick.querySelector(`[data-track="${m}"]`).hidden) { startTrack(m); return; }
      if (k === "escape") { closeRacePick(); return; }
    }
    if (k === "escape") { inv.select(null); inv.setTrash(false); if (laser.on) setLaser(false); setBag(false); }
    if (KEYMOVE[k]) doMove(KEYMOVE[k]);
  });
  addEventListener("keyup", (e) => { const k = e.key.toLowerCase(); keys.delete(k); if (k === " " && !ctlAgent.skates) beakUp(); });
  addEventListener("blur", () => keys.clear());
  function keyInput() {
    const f = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const t = (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    let fwd = f, turn = t;
    if (S.joy.active) { fwd = -S.joy.y; turn = -S.joy.x; if (Math.hypot(fwd, turn) < 0.15) { fwd = 0; turn = 0; } }
    let drift = keys.has(" ") || S.touchDrift;
    if (S.testInput) { fwd = S.testInput.fwd; turn = S.testInput.turn; if (S.testInput.drift != null) drift = S.testInput.drift; }
    return { fwd, turn, drift };
  }
  function beakDown() {
    const a = ctlAgent; if (S.mode === "garage" || a.fall) return;
    if (a.beakOpen) { a.beakOpen = false; S.spaceAt = -1; } else { a.beakOpen = true; S.spaceAt = S.simTime; }
    if (a.held && a.beakOpen) a.releaseHeld();
    $("tBeak").classList.toggle("on", a.beakOpen);
  }
  function beakUp() { if (S.spaceAt >= 0 && ctlAgent.beakOpen && S.simTime - S.spaceAt > 0.32) { ctlAgent.beakOpen = false; $("tBeak").classList.remove("on"); } S.spaceAt = -1; }
  function grabKey() {
    const a = ctlAgent; if (S.mode === "garage" || a.fall) return; voice.ensure();
    if (a.held) { a.startDrop(); return; }
    const p = a.nearestGraspable(); if (p) a.startGrab(p); else { toast("Nothing to grab nearby", "Walk up to a toy, or drag one in from the bar.", "info"); a.task = { kind: "peck", t: 0 }; }
  }

  // ---------------------------------------------------------------- input: pointer (orbit, zoom, click, laser, place)
  cam = { yaw: start.yaw + Math.PI - 0.7, pitch: 0.44, dist: 0.85, tYaw: start.yaw + Math.PI - 0.7, tPitch: 0.44, tDist: 0.85, target: V(), tween: 0 };
  const pointers = new Map(); let drag = null, pinch = null, longT = 0;
  const cv = renderer.domElement;
  cv.addEventListener("contextmenu", (e) => { e.preventDefault(); const o = inv ? null : null; const t = pickObjectAt(e.clientX, e.clientY); if (t) deleteThing(t); });
  function pickObjectAt(x, y) {
    const ph = pick(x, y, phys.props.map(p => p.object)), dh = pick(x, y, duckMeshes());
    if (ph && (!dh || ph.distance <= dh.distance)) return { prop: propOfObject(ph.object) };
    if (dh) return { agent: agentOfObject(dh.object) };
    return null;
  }
  cv.addEventListener("pointerdown", (e) => {
    voice.ensure(); cv.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cv.setPointerCapture(e.pointerId);
    if (pointers.size === 1) {
      drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, id: e.pointerId, laser: laser.on && e.pointerType !== "mouse" };
      if (drag.laser) laserAt(e.clientX, e.clientY);
      clearTimeout(longT);
      if (e.pointerType !== "mouse") longT = setTimeout(() => { if (drag && !drag.moved && !drag.laser) { const t = pickObjectAt(drag.sx, drag.sy); if (t) { deleteThing(t); drag.consumed = true; try { navigator.vibrate && navigator.vibrate(20); } catch (er) {} } } }, 600);
    }
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.tDist }; drag = null; }
  });
  cv.addEventListener("pointermove", (e) => {
    if (laser.on && e.pointerType === "mouse") laserAt(e.clientX, e.clientY);
    if (e.pointerType === "mouse" && !pointers.size) { inv.hover(e.clientX, e.clientY); hoverDuck(e.clientX, e.clientY); }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); cam.tDist = clamp(pinch.dist * pinch.d / Math.max(d, 1), 0.22, 2.4); return; }
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.laser) { laserAt(e.clientX, e.clientY); return; }
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { drag.moved = true; cv.classList.add("dragging"); clearTimeout(longT); }
    if (drag.moved) { cam.tYaw -= dx * 0.0065; cam.tPitch = clamp(cam.tPitch + dy * 0.005, 0.06, 1.35); S.camDragAt = S.simTime; }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId); cv.classList.remove("dragging"); clearTimeout(longT);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.id === e.pointerId) { if (!drag.moved && !drag.laser && !drag.consumed && e.type === "pointerup" && e.button !== 2) click(e.clientX, e.clientY); if (drag.laser) { laser.visible = false; laser.dot.setVisible(false); } drag = null; }
  };
  cv.addEventListener("pointerup", endPointer); cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("pointerleave", () => { if (laser.on) { laser.visible = false; laser.dot.setVisible(false); } inv.hideGhost(); });
  cv.addEventListener("wheel", (e) => { e.preventDefault(); cam.tDist = clamp(cam.tDist * Math.exp(e.deltaY * 0.0012), 0.22, 2.4); }, { passive: false });

  function click(x, y) {
    if (S.customising) { const h = pick(x, y, ctlAgent.rig.meshes.filter(m => m.visible)); if (h) ctlAgent.emote("dance"); return; }
    if (inv.tap(x, y)) return;
    if (S.mode === "garage") {
      const h = pick(x, y, workshop.pickMeshes().filter(m => m.visible));
      if (h) selectPart(workshop.partOfMesh(h.object)); else selectPart(null);
      return;
    }
    const a = ctlAgent;
    const duckHit = pick(x, y, duckMeshes());
    const propHit = pick(x, y, phys.props.map(p => p.object));
    const floorHit = pickSurface(x, y);
    const dist = (h) => h ? h.distance : Infinity;
    const hitAgent = duckHit ? agentOfObject(duckHit.object) : null;
    if (hitAgent && hitAgent !== a && dist(duckHit) <= dist(floorHit) + 0.01) { setControlled(hitAgent); refreshMoves(); toast("Now driving " + hitAgent.serial, "", "info", 1400); return; }
    if (a.fall) return;
    if (S.intentMode) {
      if (propHit && dist(propHit) <= dist(floorHit) + 0.01) { const p = propOfObject(propHit.object); if (p && a.graspable(p)) { a.startFetch(p); a.chirp("curious", true); return; } }
      if (floorHit && dist(floorHit) < dist(duckHit)) { a.startGo(floorHit.point); marker.position.copy(floorHit.point).add(V(0, 0.002, 0)); a.chirp("curious", true); return; }
    }
    if (hitAgent === a && dist(duckHit) <= dist(floorHit)) { a.poke(ray.ray.direction); pulse(); toast("You knocked it over", "It will get back up.", "warn"); }
  }

  // ---------------------------------------------------------------- input: touch joystick + buttons
  const joy = $("joy"), knob = $("joyKnob");
  joy.addEventListener("pointerdown", (e) => { joy.setPointerCapture(e.pointerId); S.joy.active = true; joyMove(e); voice.ensure(); });
  joy.addEventListener("pointermove", (e) => { if (S.joy.active) joyMove(e); });
  const joyEnd = () => { S.joy = { x: 0, y: 0, active: false }; knob.style.transform = ""; };
  joy.addEventListener("pointerup", joyEnd); joy.addEventListener("pointercancel", joyEnd);
  function joyMove(e) {
    const r = joy.getBoundingClientRect(); const R = r.width / 2 - 14;
    let dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    const L = Math.hypot(dx, dy); if (L > R) { dx *= R / L; dy *= R / L; }
    S.joy.x = dx / R; S.joy.y = dy / R; knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }
  const tBeak = $("tBeak");
  tBeak.addEventListener("pointerdown", (e) => { e.preventDefault(); tBeak.setPointerCapture(e.pointerId); beakDown(); });
  tBeak.addEventListener("pointerup", () => beakUp()); tBeak.addEventListener("pointercancel", () => beakUp());
  $("tGrab").addEventListener("click", () => grabKey());
  $("tBoost").addEventListener("click", () => doMove("boost"));
  const tDrift = $("tDrift");
  tDrift.addEventListener("pointerdown", (e) => { e.preventDefault(); tDrift.setPointerCapture(e.pointerId); S.touchDrift = true; voice.ensure(); });
  for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) tDrift.addEventListener(ev, () => { S.touchDrift = false; });
  // the Drift row in the moves panel works as a hold button too
  document.querySelectorAll('[data-move="drift"]').forEach(b => { b.addEventListener("pointerdown", () => { if (ctlAgent.skates) S.touchDrift = true; }); b.addEventListener("pointerup", () => { S.touchDrift = false; }); b.addEventListener("pointerleave", () => { S.touchDrift = false; }); });
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // ---------------------------------------------------------------- simulation step
  const DT = 1 / 60;
  // ---------------------------------------------------------------- players: input -> controlled duck
  // One local player today. A player = an input source that yields { fwd, turn } each step, plus the agent it
  // drives. controlledCommand() only sees that input object, never the keyboard/joystick directly.
  // Multiplayer (not built): give each player its own input (split keys / gamepad / network messages) and its
  // own agent; run controlledCommand per player in simStep; make `agent.controlled` per player; route actions
  // (beak, moves) through the player instead of the global ctlAgent; and decide the camera (split screen,
  // shared framing, or one camera per client online). Online would also need an authoritative sim host.
  const players = [{ id: 0, input: { read: keyInput }, get agent() { return ctlAgent; } }];
  function controlledCommand(a, ki, dt) {
    const moving = Math.abs(ki.fwd) > 0.01 || Math.abs(ki.turn) > 0.01;
    if (S.mode === "garage" || S.customising || a.fall) return { v: 0, w: 0 };
    if (G.race && G.race.active && G.race.frozen) return { v: 0, w: 0 };
    if (S.drag && S.drag.phase === "count") return { v: 0, w: 0 };
    if (moving && a.task && a.task.kind !== "drop") { a.cancelTask(); markMat.opacity = 0; }
    const tc = a._runTask(dt);
    if (tc) { markMat.opacity = a.task && a.task.kind === "go" ? 0.9 : 0; return tc; }
    markMat.opacity = 0;
    if (!moving && laser.on && laser.visible && !a.skates) {
      // chase the dot; pounce when close
      const d = Math.hypot(laser.point.x - a.pos.x, laser.point.z - a.pos.z);
      a.duck.look.target = laser.point; a.duck.look.weight = 0.9;
      if (!a.pounce && d < 0.1 && S.simTime - (a.lastPounce || -9) > 1.4) { a.pounce = { t: 0 }; a.lastPounce = S.simTime; a.chirp("happy", true); }
      if (d < 0.06) return { v: 0, w: 0 };
      const s = a.steer(laser.point, null, 0.05); return { v: s.v, w: s.w };
    }
    if (a.duck.look.target === laser.point) a.duck.look.target = null;
    const boost = G.race && G.race.active ? (G.race.R.speedBoost || 1) : 1;
    return { v: ki.fwd * (ki.fwd > 0 ? GAIT.maxSpeed * boost : GAIT.maxSpeed * 0.45), w: ki.turn * GAIT.maxYawRate * (ki.fwd !== 0 ? 0.75 : 1) };
  }
  function simStep(dt) {
    S.simTime += dt;
    const C = ctlAgent;
    // LOD by distance to the camera
    for (const a of agents) { const d = a.controlled ? 0 : a.pos.distanceTo(camera.position); a.lod = a.controlled ? 0 : d > 1.9 ? 2 : d > 1.1 ? 1 : 0; }
    // commands
    const ki0 = players[0].input.read();
    for (const a of agents) a.driftHeld = a === C && !!ki0.drift && !!a.skates && S.mode !== "garage" && !S.customising;
    const cmdC = controlledCommand(C, ki0, dt);
    for (const a of agents) {
      if (a === C) {
        a.step(dt, cmdC, (cmd) => {
          const F = mind.filter(cmd, { pos: a.pos, yaw: a.yaw, dt, carriedMass: a.held ? a.held.prop.mass : 0 });
          if (a.skates && F.kind === "backoff") F.v = -0.02;
          if ((F.kind === "refuse" || F.kind === "backoff") && Math.abs(cmd.v) > 0.01 && S.simTime - S.lastToastAt > 2.6) {
            S.lastToastAt = S.simTime; a.memory.refusals++;
            toast("Nope!", F.kind === "backoff" ? "Too close to the edge. It backed away." : "Edge ahead. It won't step off.", "warn"); pulse(); a.chirp("startled", true);
          }
          return F;
        });
      } else {
        const cmd = S.mode === "garage" ? { v: 0, w: 0 } : a.think(dt);
        a.step(dt, cmd);
      }
    }
    // the flock never overlaps: gentle push-apart between close ducks
    for (let i = 0; i < agents.length; i++) for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i], b = agents[j]; if (a.fall || b.fall) continue;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz), min = 0.125;
      if (d < min && d > 1e-5 && Math.abs(a.pos.y - b.pos.y) < 0.05) {
        const k = (min - d) * 0.5 / d;
        a.body.moveChar(V(-dx * k, 0, -dz * k)); a.body.charPosition(a.pos);
        b.body.moveChar(V(dx * k, 0, dz * k)); b.body.charPosition(b.pos);
      }
    }
    phys.step(); phys.syncProps();
    for (const p of phys.props) { const o = p.object.position; if (!p.held && (o.y < world.floorY - 0.3 || o.x < world.room.x0 || o.x > world.room.x1 || o.z < world.room.z0 || o.z > world.room.z1)) phys.resetProp(p); }
    // sensors follow the controlled duck
    const duck = C.duck;
    const trunkUp = V(0, 1, 0).applyQuaternion(duck.trunk.getWorldQuaternion(new THREE.Quaternion()));
    const tilt = Math.max(0, Math.acos(clamp(trunkUp.y, -1, 1)) - duck.pitchExtra - Math.abs(duck.lean) - duck.sitW * 0.2);
    const speed = C.skates ? C.sv.length() : Math.hypot(C.vel.x, C.vel.z);
    mind.estimate({ duck, dt, pos: C.pos, yaw: C.yaw, speed, cmdDir: Math.abs(C.cmd.v) > 0.005 ? V(Math.sin(C.yaw) * Math.sign(C.cmd.v), 0, Math.cos(C.yaw) * Math.sign(C.cmd.v)) : null, carriedMass: C.held ? C.held.prop.mass : 0, tilt, props: phys.props, falling: C.fall && (C.fall.kind === "edge" || C.fall.t < 0.6) });
    // games
    if (G.football) G.football.update(dt);
    if (G.race) G.race.update(dt);
    if (S.drag) updateDragStrip(dt);
    // skates lying on the floor get picked up by a duck that walks over them
    if (S.mode === "garage" || S.customising) updateGarage(dt);
    if (S.customising) customiseTick(dt);
    if (S.pendingAsk && S.simTime >= S.pendingAsk.at) { const l = S.pendingAsk.label; S.pendingAsk = null; S.garageBusy = false; refreshParts(); voice.play("happy", { force: true }); toast("New part fitted", l, "info", 1800); }
    workshop.update(dt);
    sfx.update(dt, agents, camera);
    if (S.simTime - S.lastInputAt > 16 && S.simTime - (S.lastIdleChirp || 0) > 18) { S.lastIdleChirp = S.simTime; C.chirp("curious"); }
  }

  // ---------------------------------------------------------------- camera
  const camPos = V();
  function updateCamera(dt) {
    const C = ctlAgent; let tgt;
    if (S.customising) {
      // close framing on the stage; nudge the target so the duck sits beside the panel (desktop) or above the sheet (phone)
      const wb = world.workbench.position;
      tgt = V(wb[0], wb[1] + 0.11, wb[2]);
      const half = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * cam.dist;
      if (innerWidth / innerHeight >= 0.8) { const shift = innerWidth > 900 ? 0.36 * half * camera.aspect : 0; tgt.add(V(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)).multiplyScalar(shift)); }
      else tgt.y -= 0.5 * half * 1.3;
    } else if (S.mode === "garage") {
      const wb = world.workbench.position;
      tgt = V(wb[0], wb[1] + 0.105, wb[2]);
      if (!reduced && S.simTime - S.camDragAt > 3) cam.tYaw += dt * 0.12;
    } else if (S.camOverride) {
      tgt = S.camOverride.clone();
    } else {
      tgt = C.duck.root.position.clone(); tgt.y = (C.fall ? C.duck.root.position.y : C.duck.baseY) + 0.125;
      const moving = Math.abs(C.v) > 0.02 || (C.skates && C.sv.length() > 0.05);
      if (moving && S.simTime - S.camDragAt > 2.5 && !reduced) {
        const behind = C.yaw + Math.PI - 0.45 * Math.sign(wrap(cam.tYaw - C.yaw - Math.PI) || 1);
        cam.tYaw += wrap(behind - cam.tYaw) * (1 - Math.exp(-0.6 * dt));
      }
    }
    cam.slow = Math.max(0, (cam.slow || 0) - dt);
    const k = 1 - Math.exp(-(reduced ? 12 : cam.slow > 0 ? 2.2 : 7) * dt);
    if (innerWidth / innerHeight < 0.8 && !S.customising) tgt.y -= S.mode === "garage" ? 0.09 : 0.03;
    if (!cam.init) { cam.target.copy(tgt); cam.init = true; }
    // tween to a newly selected duck: slower follow for a moment, then normal
    cam.tween = Math.max(0, cam.tween - dt * 1.2);
    cam.target.lerp(tgt, 1 - Math.exp(-(cam.slow > 0 ? 2.4 : cam.tween > 0 ? 3.2 : 6) * dt));
    cam.yaw += wrap(cam.tYaw - cam.yaw) * k; cam.pitch += (cam.tPitch - cam.pitch) * k; cam.dist += (cam.tDist - cam.dist) * k;
    const portrait = innerWidth / innerHeight < 0.8;
    const off = V(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch)).multiplyScalar(cam.dist * (portrait ? (S.mode === "garage" || S.customising ? 1.9 : 1.7) : 1));
    camPos.copy(cam.target).add(off);
    world.clampCamera(camPos);
    camera.position.copy(camPos); camera.lookAt(cam.target);
  }

  // ---------------------------------------------------------------- render
  const eyeBox = $("eyeBox"), tofCv = $("tof");
  const EYE_W = 160, EYE_H = 160;
  const eyeRT = new THREE.WebGLRenderTarget(EYE_W, EYE_H, { samples: 0 }); eyeRT.texture.colorSpace = THREE.SRGBColorSpace;
  const eyePx = new Uint8Array(EYE_W * EYE_H * 4); const eyeCtx = eyeBox.getContext("2d"); const eyeImg = eyeCtx.createImageData(EYE_W, EYE_H);
  function renderEye() {
    const duck = ctlAgent.duck; const f = duck.headDir(V());
    duck.markers.cam.getWorldPosition(eyeCam.position).addScaledVector(f, 0.012);
    eyeCam.lookAt(eyeCam.position.clone().add(f)); eyeCam.aspect = 1; eyeCam.updateProjectionMatrix();
    const hidden = []; scene.traverse(o => { if ((o.userData.lookFX || o.name === "mind_fx") && o.visible) { hidden.push(o); o.visible = false; } });
    ctlAgent.rig.meshes.forEach(m => { if (m.visible && /^(shell_head|eye_|electronics_camera|shell_beak)/.test(m.name)) { hidden.push(m); m.visible = false; } });
    const exp = renderer.toneMappingExposure; renderer.toneMappingExposure = 0.8;
    renderer.setRenderTarget(eyeRT); renderer.clear(); renderer.render(scene, eyeCam); renderer.setRenderTarget(null);
    renderer.toneMappingExposure = exp;
    hidden.forEach(o => o.visible = true);
    renderer.readRenderTargetPixels(eyeRT, 0, 0, EYE_W, EYE_H, eyePx);
    const d = eyeImg.data;
    for (let y = 0; y < EYE_H; y++) { const src = (EYE_H - 1 - y) * EYE_W * 4; d.set(eyePx.subarray(src, src + EYE_W * 4), y * EYE_W * 4); }
    eyeCtx.putImageData(eyeImg, 0, 0);
  }
  let frame = 0;
  function render(dt) {
    frame++;
    const C = ctlAgent;
    const t = { surface: S.layer === "surface" ? 1 : 0, xray: S.layer === "xray" ? 1 : 0, mind: S.layer === "mind" ? 1 : 0 };
    const k = reduced || TEST || dt === 0 ? 1 : 1 - Math.exp(-5 * dt);
    for (const key in t) S.W[key] = lerp(S.W[key], t[key], k);
    const fx = S.W.xray + S.W.mind > 0.01;
    for (const a of agents) { a.rig.setWeights(S.W); a.rig.trackMotion = fx; }
    stage.setWeights(S.W); world.setWeights(S.W);
    world.setFocus && world.setFocus(S.mode === "garage" ? null : C.duck.root.position);   // wall cutaway follows our duck
    updateCamera(dt || DT);
    { const t = cam.target; stage.follow(t, world.groundHeightAt(t.x, t.z, t.y + 0.05 - 0.125)); }
    world.update(dt); laser.dot.update(dt); scene.updateMatrixWorld(true);
    for (const a of agents) { a.rig.follow(); a.rig.update(dt); }
    mind.updateVisuals(dt, { pos: C.pos, yaw: C.yaw, vChosen: S.mode === "garage" ? 0 : C.v, wChosen: S.mode === "garage" ? 0 : C.w, vCmd: C.cmd.v, wCmd: C.cmd.w, override: C.filtered.kind }, S.mode === "garage" ? 0 : S.W.mind);
    marker.scale.setScalar(1 + 0.15 * Math.sin(S.simTime * 6));
    ring.visible = S.mode !== "garage" && agents.length > 1;
    ring.position.set(C.pos.x, C.duck.baseY + 0.0015, C.pos.z); ring.scale.setScalar(1 + 0.05 * Math.sin(S.simTime * 3));
    stage.update(dt);
    updateDetailLOD();
    post.render(dt);
    const mindVisible = !$("mindPanel").classList.contains("hidden") && getComputedStyle(eyeBox.parentElement).display !== "none";
    if (mindVisible && (TEST || frame % 3 === 0)) renderEye();
    if (!$("mindPanel").classList.contains("hidden")) mind.drawDepth(tofCv);
    updateHUD(); updateBoostUI();
    if (!S.customising && S.mode !== "garage") thoughts.update(dt || DT); else thoughts.hideAll();
  }

  // ---------------------------------------------------------------- detail LOD: far ducks lose ink lines + shadows, far props stop casting
  const LOD = { duckFar: 3.0, propFar: 4.0 };
  function lodParts(a) {
    const old = a._lodParts;
    if (old && old.root === a.duck.root && (frame - old.at) < 120) return old;   // re-scan now and then (ink lines are added lazily)
    if (old) { for (const o of old.ink) o.visible = true; for (const o of old.cast) o.castShadow = true; }
    const ink = [], cast = [];
    a.duck.root.traverse(o => { if (o.userData && o.userData.inkLine) ink.push(o); else if (o.isMesh && o.castShadow) cast.push(o); });
    return (a._lodParts = { root: a.duck.root, at: frame, ink, cast, far: null });
  }
  function updateDetailLOD() {
    const cp = camera.position;
    const groups = world.house && world.house.groups;
    for (const a of agents) {
      // ducks standing in a room the world has culled (far away / out of view) are hidden with it
      if (groups) { const r = world.roomAt(a.pos.x, a.pos.z), g = r && groups[r]; const hide = !a.controlled && !!g && !g.visible; if (a.duck.root.visible === hide) a.duck.root.visible = !hide; }
      // rig.setWeights() re-shows ink / shell shadows every frame, so far ducks are re-hidden every frame (cheap)
      const L = lodParts(a), far = !a.controlled && a.duck.root.position.distanceTo(cp) > LOD.duckFar;
      if (!far && L.far === false) continue;
      L.far = far;
      for (const o of L.ink) o.visible = !far && o.visible;
      if (far) for (const o of L.ink) o.visible = false;
      for (const o of L.cast) o.castShadow = !far;
    }
    if ((frame & 7) === 0) for (const p of phys.props) {
      const o = p.object; if (o.userData._cast === undefined) { let c = false; o.traverse(m => { if (m.isMesh && m.castShadow) c = true; }); o.userData._cast = c; }
      if (!o.userData._cast) continue;
      const far = o.position.distanceTo(cp) > LOD.propFar;
      if (o.userData._far === far) continue;
      o.userData._far = far; o.traverse(m => { if (m.isMesh) m.castShadow = !far; });
    }
  }

  // ---------------------------------------------------------------- HUD (sensor panel)
  const gArc = $("gArc"), gNum = $("gNum");
  function updateHUD() {
    if ($("mindPanel").classList.contains("hidden")) return;
    const C = ctlAgent;
    const r = Math.round(mind.risk * 100);
    gArc.setAttribute("stroke-dasharray", `${r} 100`); gNum.textContent = r;
    $("uNum").textContent = Math.round(mind.uncertainty * 100) + "%";
    $("eNum").textContent = mind.dAheadEst >= 0.49 ? "far" : Math.round(mind.dAheadEst * 100) + " cm";
    const pill = $("statePill");
    let st = "Calm", warn = false;
    if (C.fall) { st = "Falling!"; warn = true; }
    else if (C.filtered.kind === "refuse") { st = "Refusing"; warn = true; }
    else if (C.filtered.kind === "backoff") { st = "Backing away"; warn = true; }
    else if (C.filtered.kind === "slow") { st = "Slowing down"; warn = true; }
    else if (C.skates) st = C.duck.wobble > 0.5 ? "Wobbly!" : "Skating";
    else if (C.held) st = "Carrying " + (C.held.prop.spec.label || "a toy").toLowerCase();
    else if (C.duck.sitW > 0.5) st = "Sitting";
    else if (mind.uncertainty > 0.45) st = "Unsure";
    else if (mind.risk > 0.4) { st = "Careful"; warn = true; }
    pill.textContent = st; pill.classList.toggle("warn", warn);
  }

  // ---------------------------------------------------------------- Garage (edits the controlled duck)
  const partsList = $("partsList"), servoList = $("servoList");
  let selected = null;
  function buildPartsUI() {
    partsList.innerHTML = ""; servoList.innerHTML = "";
    for (const p of workshop.parts) {
      const li = document.createElement("li"); const b = document.createElement("button");
      b.innerHTML = `<span>${p.label}</span><span class="st">original</span>`; b.setAttribute("aria-pressed", "false");
      b.onclick = () => selectPart(p); p.btn = b; li.appendChild(b);
      (p.servo ? servoList : partsList).appendChild(li);
    }
    refreshParts();
  }
  function refreshParts() {
    for (const p of workshop.parts) {
      if (!p.btn) continue;
      const st = p.btn.querySelector(".st"); st.textContent = p.replaced ? (p.swaps > 1 ? `new ×${p.swaps}` : "new") : "original"; st.classList.toggle("new", p.replaced);
      p.btn.setAttribute("aria-pressed", String(p === selected));
    }
    const o = workshop.originals, n = workshop.total;
    $("origNum").textContent = `${o} / ${n}`; $("origBar").style.width = (o / n * 100) + "%";
    $("servoCount").textContent = workshop.parts.filter(p => p.servo && !p.replaced).length + " original";
    $("replaceBtn").disabled = !selected || workshop.busy;
    $("selName").textContent = selected ? selected.label : "";
    $("voiceSerial").textContent = ctlAgent.serial; $("bodySerial").textContent = ctlAgent.serial;
    $("garageSkates").textContent = ctlAgent.skates ? "Take off skates" : "Put on skates";
    renderMemories();
  }
  function selectPart(p) {
    selected = p; workshop.highlight(p); refreshParts();
    if (p && p.servo) $("servoList").parentElement.open = true;
    if (p && innerWidth > 720 && p.btn) p.btn.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }
  $("replaceBtn").onclick = () => replaceSelected();
  function replaceSelected() {
    if (!selected || workshop.busy) return;
    const p = selected; const dur = workshop.replace(p); voice.play("startled", { force: true });
    S.garageBusy = true; selected = null; refreshParts();
    S.pendingAsk = { at: S.simTime + dur + 0.15, label: p.label };
    return dur;
  }
  document.querySelectorAll("#swatches button").forEach(b => b.onclick = () => {
    const target = $("skinTarget").value; workshop.skin(b.dataset.skin, target);
    if (target === "all") { ctlAgent.skin = b.dataset.skin; document.querySelectorAll("#swatches button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); }
    voice.play("happy", { force: true });
  });
  let prevVoice = null;
  $("voiceSwap").onclick = () => { const a = ctlAgent; prevVoice = a.serial; a.serial = makeSerial(); a.voice = (voice.setSerial(a.serial), voice.p); refreshParts(); voice.play("hello", { force: true }); };
  $("voiceBefore").onclick = () => { const s = prevVoice || ctlAgent.serial; voice.setSerial(s); voice.play("hello", { force: true }); voice.setSerial(ctlAgent.serial); };
  $("voiceAfter").onclick = () => { voice.setSerial(ctlAgent.serial); voice.play("hello", { force: true }); };
  $("garageSkates").onclick = () => { toggleSkates(ctlAgent); refreshParts(); };

  function renderMemories() {
    const m = ctlAgent.memory, out = [];
    const fav = Object.entries(m.fetched).sort((a, b) => b[1] - a[1])[0];
    if (fav) out.push(`Favourite toy: ${(PROP_CATALOG[fav[0]] && PROP_CATALOG[fav[0]].label.toLowerCase()) || fav[0]} (${fav[1]}×)`);
    if (m.kicks) out.push(`Kicked the sock ball ${m.kicks}×`);
    if (m.falls) out.push(`Fell off an edge ${m.falls === 1 ? "once" : m.falls + " times"}`);
    if (m.knocks) out.push(`Was knocked over ${m.knocks === 1 ? "once" : m.knocks + " times"}`);
    if (m.refusals) out.push(`Refused to step off an edge ${m.refusals === 1 ? "once" : m.refusals + " times"}`);
    const ul = $("memList"); ul.innerHTML = "";
    if (!out.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing yet. Go play with it."; ul.appendChild(li); }
    for (const t of out) { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); }
  }
  function enterGarage() {
    const a = ctlAgent;
    a.releaseHeld(); a.cancelTask(); markMat.opacity = 0; setLaser(false);
    if (G.race && G.race.active) toggleRace(false);
    if (G.football && G.football.active) toggleFootball(false);
    if (a.fall) { a.fall = null; a.duck.fall = null; }
    a.duck.sitTarget = false;
    S.playPose = { pos: a.pos.clone(), yaw: a.yaw };
    const wb = world.workbench.position;
    // send any duck standing on the turntable away first
    for (const b of agents) if (b !== a && Math.hypot(b.pos.x - wb[0], b.pos.z - wb[2]) < 0.25) b.teleport(world.spawnSpot(agents.indexOf(b) + 1, agents.length + 2), b.yaw);
    a.teleport(V(wb[0], wb[1], wb[2]), 0.35);
    if (!a.worn) { workshop.wear(); a.worn = true; }
    rawWorld.turntable.state.angularVelocity = reduced ? 0 : 0.22;
    cam.tYaw = a.yaw + 0.5; cam.tPitch = 0.42; cam.tDist = 0.58; cam.init = false;
    if (S.layer === "mind") setLayer("surface");
    buildPartsUI();
  }
  function leaveGarage() {
    rawWorld.turntable.state.angularVelocity = 0; selectPart(null);
    const p = S.playPose || { pos: start.position.clone(), yaw: start.yaw };
    ctlAgent.teleport(p.pos, p.yaw);
    cam.tYaw = p.yaw + Math.PI - 0.7; cam.tPitch = 0.44; cam.tDist = 0.85; cam.init = false;
  }
  function updateGarage(dt) { const a = ctlAgent; a.yaw = wrap(a.yaw + rawWorld.turntable.state.angularVelocity * dt); }

  // ---------------------------------------------------------------- customise screen (start flow)
  const VOICES = voicePresets();
  const czPanel = $("customPanel");
  let lastEmoteAt = 0;
  function applyChoice(a, c) {
    setSkin(a.rig, c.skin);
    for (const p of PAINT_PARTS) if (c.parts[p.id]) setSkin(a.rig, c.parts[p.id], { parts: p.groups });
    a.skin = c.skin;
    a.serial = VOICES[c.voice].serial; a.voice = voiceParams(a.serial); voice.setSerial(a.serial);
  }
  const customiser = createCustomiser(czPanel, loadChoice() || defaultChoice(), VOICES, {
    onChange(c, what) {
      const a = ctlAgent; applyChoice(a, c);
      if (what !== "voice" && S.simTime - lastEmoteAt > 0.6) { lastEmoteAt = S.simTime; a.emote(what === "random" ? "dance" : ["nod", "look", "dance"][Math.floor(Math.random() * 3)]); }
      voice.ensure();
    },
    onPlayVoice(i) { voice.ensure(); voice.play("hello", { force: true, params: voiceParams(VOICES[i].serial) }); ctlAgent.emote("nod"); },
    onGo(c) { letsGo(c); },
  });
  function backgroundSpots() {
    // between the stage and the middle of the room, so the flock plays behind the duck
    const wb = world.workbench.position, dir = V(-Math.sin(cam.tYaw), 0, -Math.cos(cam.tYaw));
    const side = V(dir.z, 0, -dir.x);
    return [[1.0, -0.5], [1.15, 0.55], [1.45, -0.65], [1.65, 0.6]].map(([d, s]) => {
      const p = V(wb[0], 0, wb[2]).addScaledVector(dir, d).addScaledVector(side, s);
      const LR = rawWorld.livingRoom || world.room;   // the customise stage lives in the living room
      p.x = clamp(p.x, LR.x0 + 0.2, LR.x1 - 0.2); p.z = clamp(p.z, LR.z0 + 0.2, LR.z1 - 0.2);
      // never closer to the turntable than the stage keep-out (+ a margin)
      const dx = p.x - wb[0], dz = p.z - wb[2], L = Math.hypot(dx, dz), R = STAGE_R + 0.15;
      if (L < R) { const u = L > 1e-4 ? [dx / L, dz / L] : [dir.x, dir.z]; p.x = wb[0] + u[0] * R; p.z = wb[2] + u[1] * R; }
      p.y = world.groundHeightAt(p.x, p.z, world.floorY + 0.05); return p;
    });
  }
  const STAGE_R = PHONE ? 0.75 : 0.65; // background ducks stay this far from the turntable while customising
  const CZCAM = { yaw: 1.2, pitch: 0.3, dist: 0.74, distPhone: 0.5, yawPhone: 2.0 };
  function enterCustomise() {
    S.customising = true; G.customising = true; document.body.classList.add("customise");
    { const w = world.workbench.position; G.stage = { x: w[0], z: w[2], r: STAGE_R }; }
    const a = ctlAgent;
    applyChoice(a, customiser.choice);
    cam.tYaw = PHONE ? CZCAM.yawPhone : CZCAM.yaw; cam.tPitch = CZCAM.pitch; cam.tDist = PHONE ? CZCAM.distPhone : CZCAM.dist; cam.yaw = cam.tYaw; cam.pitch = cam.tPitch; cam.dist = cam.tDist; cam.init = false;
    const wb = world.workbench.position;
    a.teleport(V(wb[0], wb[1], wb[2]), cam.tYaw);
    rawWorld.turntable.state.angularVelocity = reduced ? 0 : 0.3;
    // 3-4 ducks playing behind it
    const want = Math.min(CAP.ducks, PHONE ? 4 : 5);
    while (agents.length < want) if (!spawnDuck(V(0, world.floorY, 0), 0)) break;
    const spots = backgroundSpots();
    agents.filter(b => b !== a).forEach((b, i) => { const p = spots[i % spots.length]; b.teleport(p, Math.random() * 6.28); b.brain.state = ["ball", "toy", "wander", "ball"][i % 4]; b.brain.t = 0; b.brain.dur = 10 + i * 3; });
    // a sock ball for them to kick
    const near = G.balls.find(x => phys.props.includes(x) && x.object.position.distanceTo(spots[0]) < 1.0);
    if (!near) spawnProp("sock_ball", spots[0].clone().lerp(spots[1], 0.5));
    lastEmoteAt = -9;
  }
  function customiseTick(dt) {
    const a = ctlAgent;
    if (!a.duck.emote && S.simTime - lastEmoteAt > 4.5) { lastEmoteAt = S.simTime; a.duck.playEmote(Math.random() < 0.7 ? "look" : "nod"); }
  }
  function letsGo(c) {
    if (!S.customising) return;
    const a = ctlAgent;
    applyChoice(a, c); saveChoice(c);
    S.customising = false; G.customising = false; G.stage = null; document.body.classList.remove("customise");
    rawWorld.turntable.state.angularVelocity = 0;
    if (c.skates && !a.skates) toggleSkates(a);
    if (!c.skates && a.skates) toggleSkates(a);
    a.emote("dance"); voice.ensure(); voice.play("happy", { force: true, params: a.voice });
    // tween out to the normal play camera; stay on the stage side so the flock is in view, not in the lens
    cam.tYaw = (PHONE ? CZCAM.yawPhone : CZCAM.yaw) + 0.25; cam.tPitch = 0.44; cam.tDist = 0.85; cam.slow = reduced ? 0 : 2.2; cam.tween = 1.5;
    setMode("play"); updatePanels(); refreshMoves(); inv.refresh();
    toast("Let's go!", PHONE ? "Joystick to walk. Drag toys in from the bar." : "WASD to walk. Drag toys in from the bar. Press ? for all moves.", "info", 3600);
  }
  // keyboard on the customise screen: Enter starts
  addEventListener("keydown", (e) => { if (S.customising && e.key === "Enter" && !(e.target && e.target.tagName === "BUTTON")) { e.preventDefault(); customiser.go(); } }, true);

  // ---------------------------------------------------------------- loop
  progress(1);
  updatePanels(); refreshMoves(); inv.refresh();
  let acc = 0, last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (TEST || document.hidden) return;
    acc += dt; let n = 0;
    while (acc >= DT && n < 3) { simStep(DT); acc -= DT; n++; }
    if (n === 3) acc = 0;
    render(dt);
    aq && aq.tick(dt);
  }
  for (let i = 0; i < 3; i++) simStep(DT);
  render(0);
  loadingEl.classList.add("done");
  if (!TEST || Q.has("custom")) { enterCustomise(); for (let i = 0; i < 3; i++) simStep(DT); render(0); setTimeout(() => customiser.focusGo(), 50); }
  requestAnimationFrame(loop);

  // ---------------------------------------------------------------- test hook (deterministic stepping)
  const project = (p) => { const v = p.clone().project(camera); return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight]; };
  let H = 0.05; // test hooks: surface level to resolve heights at (0 = tabletop, -0.75 = floor)
  window.__lab = {
    level(y) { H = y + 0.05; },
    ready: true, S, G, agents, renderer,
    drawCalls() { renderer.info.autoReset = true; render(DT); return renderer.info.render.calls; }, mind, phys, world, workshop, camera, cam, inv,
    get C() { return ctlAgent; },
    advance(sec, input) { if (input) S.testInput = input; const n = Math.round(sec / DT); for (let i = 0; i < n; i++) simStep(DT); return this.state(); },
    render(n = 1) { for (let i = 0; i < n; i++) render(DT); },
    input(fwd = 0, turn = 0) { S.testInput = { fwd, turn }; },
    state() { const C = ctlAgent; return { n: agents.length, ctl: agents.indexOf(C), pos: C.pos.toArray().map(v => +v.toFixed(3)), yaw: +C.yaw.toFixed(3), v: +C.v.toFixed(3), sv: +C.sv.length().toFixed(3), held: C.held && C.held.prop.kind, task: C.task && (C.task.kind + ":" + (C.task.phase || "")), fall: C.fall && C.fall.kind, sit: +C.duck.sitW.toFixed(2), wob: +C.duck.wobble.toFixed(2), brains: agents.map(a => a.controlled ? "you" : a.brain.state), props: phys.props.length, score: G.football && G.football.score, race: G.race && G.race.active ? { t: +G.race.t.toFixed(2), frozen: G.race.frozen, cd: +G.race.countdown.toFixed(2) } : null }; },
    teleport(x, z, yaw, i) { const a = i == null ? ctlAgent : agents[i]; a.teleport(V(x, world.groundHeightAt(x, z, H), z), yaw); if (a === ctlAgent) { cam.tYaw = yaw + Math.PI - 0.7; cam.yaw = cam.tYaw; cam.init = false; } },
    camera(yawOff, pitch, dist) { cam.tYaw = cam.yaw = ctlAgent.yaw + Math.PI + yawOff; cam.tPitch = cam.pitch = pitch; cam.tDist = cam.dist = dist; cam.init = false; },
    camAbs(yaw, pitch, dist) { cam.tYaw = cam.yaw = yaw; cam.tPitch = cam.pitch = pitch; cam.tDist = cam.dist = dist; cam.init = false; },
    lookAt(x, y, z) { S.camOverride = x == null ? null : V(x, y, z); cam.init = false; },
    snap() { cam.yaw = cam.tYaw; cam.pitch = cam.tPitch; cam.dist = cam.tDist; cam.init = false; cam.tween = 0; },
    setMode, setLayer: (l) => { setLayer(l); for (const k in S.W) S.W[k] = k === l ? 1 : 0; }, setIntentMode, grabKey, beakDown, beakUp,
    move: (m) => doMove(m), control: (i) => setControlled(agents[i]),
    spawnDuck: (x, z, yaw, skin) => { const a = spawnDuck(V(x, world.groundHeightAt(x, z, H), z), yaw, skin); return a ? agents.indexOf(a) : -1; },
    spawnProp: (kind, x, z) => { const r = spawnProp(kind, V(x, world.groundHeightAt(x, z, H), z)); return r ? phys.props.indexOf(r) : -1; },
    laserAtWorld: (x, z) => { laser.on = true; laser.point.set(x, world.groundHeightAt(x, z, H) + 0.003, z); laser.visible = true; laser.dot.setVisible(true); laser.from.copy(camera.position); laser.dot.set(laser.point, V(0, 1, 0), camera.position.clone().add(V(0.2, 0, 0))); refreshMoves(); },
    laserOff: () => setLaser(false),
    football: (on) => toggleFootball(on), race: (on) => toggleRace(on),
    track: (kind) => startTrack(kind), thoughts: { get on() { return thoughts.enabled; }, set: (on) => setThoughts(on), get bubbles() { return thoughts.bubbles; }, line: (i) => thoughts.lineOf(agents[i]), poke: (i) => thoughts.poke(agents[i]), debug: () => thoughts.debug() }, lod: LOD,
    spreadDucks: () => { const pts = world.anchors.houseSpawnPoints || []; agents.forEach((a, i) => { if (a === ctlAgent || !pts.length) return; const sp = pts[(i * 5) % pts.length]; a.teleport(V(...sp.position), sp.yaw || 0); }); }, get drag() { return S.drag && { phase: S.drag.phase, t: +S.drag.t.toFixed(2), best: S.drag.best }; },
    kickBall: (x, z) => { const b = G.balls[0]; if (b) phys.impulse(b, V(x, 0.0, z)); },
    placeBall: (x, z) => { const b = G.balls[0]; if (b) phys.place(b, V(x, world.groundHeightAt(x, z, H) + 0.002, z)); },
    dragItem: (key, wx, wz, hold) => { const p = V(wx, world.groundHeightAt(wx, wz, H), wz); camera.updateMatrixWorld(); const [x, y] = project(p); return inv.dragTo(key, x, y, hold); },
    showDragIcon: (key, wx, wz) => { const p = V(wx, world.groundHeightAt(wx, wz, H), wz); const [x, y] = project(p); let el = document.querySelector(".drag-ico"); if (!el) { el = document.createElement("div"); el.className = "drag-ico"; document.body.appendChild(el); } el.innerHTML = items.find(i => i.key === key).icon; el.style.transform = `translate(${x}px, ${y}px)`; },
    selectItem: (k) => inv.select(k), clickAt: (x, y) => click(x, y), project: (x, y, z) => project(V(x, y, z)),
    selectPart: (id) => selectPart(workshop.parts.find(p => p.id === id)), replaceSelected,
    sfx: { audio: () => voice.ctx ? voice.ctx.state + " t=" + voice.ctx.currentTime.toFixed(2) : "none", counts: sfx.counts, reset: () => sfx.reset(), surfaceAt: (x, y, z) => sfx.surfaceAt(V(x, y, z)) },
    skate: () => { const C = ctlAgent; return { sp: +C.sv.length().toFixed(3), boostT: +C.boostT.toFixed(2), cd: +C.boostCd.toFixed(2), drifting: C.drifting, driftT: +C.driftT.toFixed(2), slip: +C.slip.toFixed(3), lean: +C.duck.leanW.toFixed(3), fall: C.fall && C.fall.kind, fx: S.fxLog.slice(-6), skateFx: window.__fx && window.__fx.skate ? window.__fx.skate.count : -1 }; },
    boost: () => ctlAgent.boost(), bag: (open) => setBag(open), get bagOpen() { return S.bagOpen; },
    custom: { cam: CZCAM, stageGap: () => { const w = world.workbench.position; return Math.min(...agents.filter(a => a !== ctlAgent).map(a => Math.hypot(a.pos.x - w[0], a.pos.z - w[2]))); }, enter: () => enterCustomise(), set: (c) => { customiser.set(c); applyChoice(ctlAgent, customiser.choice); }, randomise: () => customiser.randomise(), go: () => customiser.go(), get choice() { return customiser.choice; }, voices: VOICES },
    toast, skin: (n, t) => workshop.skin(n, t),
    safety: (on) => { mind.safety = on; $("safetyBtn").setAttribute("aria-pressed", String(on)); },
    poke: (x, z) => ctlAgent.poke(V(x, 0, z)),
  };
}
