// main.js — Microduck Lab: bootstrap, input, simulation loop, camera, modes (Play / Sensors / Garage), UI.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { setupRenderer, buildStage, makeMaterials, applyLook, setupPost, createAdaptiveQuality, detectQuality, setPartCondition } from "./look.js";
import { buildWorld } from "./world.js";
import { DuckBody, GAIT } from "./duck.js";
import { createPhysics } from "./physics.js";
import { Mind } from "./mind.js";
import { Workshop, MemoryOrb } from "./garage.js";
import { Voice, makeSerial } from "./voice.js";

const Q = new URLSearchParams(location.search);
const TEST = Q.has("test");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches || Q.has("reduced");
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));
const approach = (cur, target, rate) => cur + clamp(target - cur, -rate, rate);
const PROP_NAMES = { foam_cube: "foam cube", ring: "silicone ring", toy_duck: "rubber duck", pencil: "pencil" };

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
  } catch (e) {
    fail("This browser could not start WebGL 2, so the 3D lab cannot run here. Try a recent Chrome, Safari or Firefox.");
    return;
  }
  const quality = Q.get("q") || detectQuality();
  setupRenderer(renderer, { quality, maxDPR: 2 });
  $("stage").appendChild(renderer.domElement);
  renderer.domElement.tabIndex = 0;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.01, 30);
  const stage = buildStage(scene, renderer, { quality, floor: false, shadowExtent: 0.4, shadowMapSize: quality === "high" ? 2048 : 1024, keyIntensity: 3.2, hemiIntensity: 0.35 });
  const mats = makeMaterials({ quality });
  const world = buildWorld(scene, renderer, mats, { quality });
  progress(0.08);

  // ---------------------------------------------------------------- model (base64 text → GLB)
  const b64 = await new THREE.FileLoader().loadAsync("./microduck_rig.glb.txt", (ev) => { if (ev.lengthComputable) progress(0.08 + 0.72 * ev.loaded / ev.total); else progress(Math.min(0.8, 0.08 + ev.loaded / 4.3e6 * 0.72)); });
  const bin = Uint8Array.from(atob(String(b64).trim()), (c) => c.charCodeAt(0));
  const glbBuffer = bin.buffer;
  progress(0.85);
  const loader = new GLTFLoader();
  const parseDuck = async () => (await loader.parseAsync(glbBuffer.slice(0), "./")).scene;

  function makeDuck(model, withStage) {
    const duck = new DuckBody(model, { ground: (x, z) => world.groundHeightAt(x, z) });
    scene.add(duck.root);
    duck.root.updateMatrixWorld(true);
    const rig = applyLook(model, mats, { stage: withStage ? stage : undefined, parent: scene });
    rig.trackMotion = true;
    // the Mind nebula and X-ray scan plane were placed at load; keep them riding on the walking duck
    const mindLocal = duck.headNode.worldToLocal(rig.mind.position.clone());
    const scanOff = rig.scan.position.clone().sub(duck.root.position);
    rig.follow = () => {
      duck.headNode.localToWorld(rig.mind.position.copy(mindLocal));
      rig.scan.position.x = duck.root.position.x + scanOff.x; rig.scan.position.z = duck.root.position.z + scanOff.z;
    };
    return { duck, rig };
  }
  const first = makeDuck(await parseDuck(), true);
  progress(0.95);

  const phys = await createPhysics(world);
  const mind = new Mind(world, scene);
  const voice = new Voice();

  // ---------------------------------------------------------------- state
  const start = world.anchors.start;
  const S = {
    mode: "play", layer: "surface", W: { surface: 1, xray: 0, mind: 0 },
    pos: new THREE.Vector3(...start.position), yaw: start.yaw || 0, v: 0, w: 0, vel: new THREE.Vector3(),
    input: { fwd: 0, turn: 0 }, joy: { x: 0, y: 0, active: false },
    intentMode: false, task: null, held: null, beakOpen: false, spaceAt: 0,
    fall: null, simTime: 0, lastToastAt: -10, lastOverride: null,
    
    lastInputAt: 0, cmd: { v: 0, w: 0 }, filtered: { v: 0, w: 0, kind: null },
    camDragAt: -10, garageBusy: false, playPose: null, transfer: null,
  };
  const D = { ...first, serial: makeSerial(), voiceSerial: null, memory: newMemory() };
  D.voiceSerial = D.serial; voice.setSerial(D.voiceSerial);
  let companion = null; // reserved for a second duck
  D.duck.teleport(S.pos, S.yaw); phys.setCharPosition(S.pos);
  const workshop = new Workshop({ scene, duck: D.duck, rig: D.rig, reduced });
  const orb = new MemoryOrb(scene);

  function newMemory(name = null) { return { name, fetched: {}, falls: [], knocks: 0, refusals: 0, climbed: false, born: Date.now(), notes: [] }; }

  // intent target marker
  const markMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#BF5AF2").multiplyScalar(1.8), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.018, 0.024, 48), markMat);
  marker.rotation.x = -Math.PI / 2; marker.userData.lookNoContact = true; marker.renderOrder = 23; scene.add(marker);

  // ---------------------------------------------------------------- post + sizing
  const post = setupPost(renderer, scene, camera, { quality, samples: quality === "high" ? 4 : 2, aa: "msaa" });
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
    $("toastT").textContent = title; $("toastS").textContent = sub;
    toastEl.classList.toggle("violet", kind !== "warn"); $("toastIc").textContent = kind === "warn" ? "!" : "•";
    toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
  }
  function pulse() {
    const p = $("pulse"); p.classList.remove("go"); void p.offsetWidth; p.classList.add("go");
    if (!reduced) { document.body.classList.remove("shake"); void document.body.offsetWidth; document.body.classList.add("shake"); }
    try { navigator.vibrate && navigator.vibrate(35); } catch (e) {}
  }
  const help = $("help"); let helpTimer = setTimeout(() => help.classList.add("fade"), 9000);
  $("helpBtn").onclick = () => { help.classList.toggle("fade"); clearTimeout(helpTimer); helpTimer = setTimeout(() => help.classList.add("fade"), 9000); if (matchMedia("(max-width:720px)").matches) toast("Joystick to walk", "Beak to open/close · Grab to fetch the nearest toy · drag to look", "info", 4000); };
  $("infoBtn").onclick = () => $("credit").classList.toggle("open");
  $("soundBtn").onclick = () => { voice.muted = !voice.muted; $("soundBtn").setAttribute("aria-pressed", String(!voice.muted)); $("soundWave").style.opacity = voice.muted ? 0 : 1; if (!voice.muted) voice.play("hello", { force: true }); };
  $("safetyBtn").onclick = () => { mind.safety = !mind.safety; $("safetyBtn").setAttribute("aria-pressed", String(mind.safety)); toast(mind.safety ? "Safety reflex on" : "Safety reflex off", mind.safety ? "It will refuse to step off the edge." : "It will do what you say, even off the edge.", mind.safety ? "info" : "warn"); };
  $("intentBtn").onclick = () => setIntentMode(!S.intentMode);
  function setIntentMode(on) {
    S.intentMode = on; $("intentBtn").setAttribute("aria-pressed", String(on));
    renderer.domElement.classList.toggle("intent", on);
    if (on) toast("Intent mode", "Click the floor to send it there, click a toy to fetch it. Its policy moves the body.", "info", 3600);
    else { S.task = S.task && S.task.kind === "go" ? null : S.task; }
  }

  // tabs + layers
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setMode(b.dataset.mode));
  document.querySelectorAll(".layers button").forEach(b => b.onclick = () => setLayer(b.dataset.layer));
  function setLayer(l) {
    S.layer = l; document.querySelectorAll(".layers button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.layer === l)));
    updatePanels();
  }
  function updatePanels() {
    const showMind = (S.layer === "mind" || S.mode === "sensors") && S.mode !== "garage";
    $("mindPanel").classList.toggle("hidden", !showMind);
    $("thPanel").classList.toggle("hidden", S.mode !== "garage");
    document.querySelectorAll(".mode-play").forEach(el => el.classList.toggle("hidden", S.mode === "garage"));
  }
  function setMode(m) {
    if (S.transfer || S.garageBusy) return;
    const prev = S.mode; if (m === prev) return;
    S.mode = m; document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.mode === m)));
    document.body.classList.toggle("garage", m === "garage");
    if (prev === "garage") leaveGarage();
    if (m === "garage") enterGarage();
    if (m === "sensors") { setLayer("mind"); toast("Sensor view", "See the table through its depth sensor and camera. Walk it near the edge.", "info", 3800); }
    if (m === "play" && S.layer === "mind" && prev === "sensors") setLayer("surface");
    updatePanels();
  }

  // ---------------------------------------------------------------- input: keyboard
  const keys = new Set();
  addEventListener("keydown", (e) => {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "SELECT")) return;
    const k = e.key.toLowerCase();
    if (["arrowup", "arrowdown", "arrowleft", "arrowright", " "].includes(k)) e.preventDefault();
    if (e.repeat) return;
    keys.add(k); S.lastInputAt = S.simTime; voice.ensure();
    if (!$("help").classList.contains("fade") && /^(w|a|s|d|arrow)/.test(k)) { clearTimeout(helpTimer); helpTimer = setTimeout(() => help.classList.add("fade"), 4000); }
    if (k === " ") beakDown();
    if (k === "e") grabKey();
    if (k === "1") setLayer("surface"); if (k === "2") setLayer("xray"); if (k === "3") setLayer("mind");
  });
  addEventListener("keyup", (e) => { const k = e.key.toLowerCase(); keys.delete(k); if (k === " ") beakUp(); });
  addEventListener("blur", () => keys.clear());
  function keyInput() {
    const f = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    const t = (keys.has("a") || keys.has("arrowleft") ? 1 : 0) - (keys.has("d") || keys.has("arrowright") ? 1 : 0);
    let fwd = f, turn = t;
    if (S.joy.active) { fwd = -S.joy.y; turn = -S.joy.x; if (Math.hypot(fwd, turn) < 0.15) { fwd = 0; turn = 0; } }
    if (S.testInput) { fwd = S.testInput.fwd; turn = S.testInput.turn; }
    return { fwd, turn };
  }
  function beakDown() {
    if (S.mode === "garage" || S.fall) return;
    if (S.beakOpen) { S.beakOpen = false; S.spaceAt = -1; }
    else { S.beakOpen = true; S.spaceAt = S.simTime; }
    if (S.held && S.beakOpen) releaseHeld();
    updateBeakBtn();
  }
  function beakUp() { if (S.spaceAt >= 0 && S.beakOpen && S.simTime - S.spaceAt > 0.32) { S.beakOpen = false; updateBeakBtn(); } S.spaceAt = -1; }
  function updateBeakBtn() { $("tBeak").classList.toggle("on", S.beakOpen); }

  // ---------------------------------------------------------------- input: pointer (orbit, zoom, click)
  const cam = { yaw: S.yaw + Math.PI - 0.7, pitch: 0.44, dist: 0.85, tYaw: S.yaw + Math.PI - 0.7, tPitch: 0.44, tDist: 0.85, target: new THREE.Vector3(), auto: true };
  const pointers = new Map(); let drag = null, pinch = null;
  const cv = renderer.domElement;
  cv.addEventListener("pointerdown", (e) => {
    voice.ensure(); cv.focus({ preventScroll: true });
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cv.setPointerCapture(e.pointerId);
    if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false, id: e.pointerId };
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.tDist }; drag = null; }
  });
  cv.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); cam.tDist = clamp(pinch.dist * pinch.d / Math.max(d, 1), 0.22, 1.8); return; }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 6) { drag.moved = true; cv.classList.add("dragging"); }
    if (drag.moved) { cam.tYaw -= dx * 0.0065; cam.tPitch = clamp(cam.tPitch + dy * 0.005, 0.06, 1.35); S.camDragAt = S.simTime; }
  });
  const endPointer = (e) => {
    pointers.delete(e.pointerId); cv.classList.remove("dragging");
    if (pointers.size < 2) pinch = null;
    if (drag && drag.id === e.pointerId) { if (!drag.moved && e.type === "pointerup") click(e.clientX, e.clientY); drag = null; }
  };
  cv.addEventListener("pointerup", endPointer); cv.addEventListener("pointercancel", endPointer);
  cv.addEventListener("wheel", (e) => { e.preventDefault(); cam.tDist = clamp(cam.tDist * Math.exp(e.deltaY * 0.0012), 0.22, 1.8); }, { passive: false });

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(x, y, objects) {
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera);
    return ray.intersectObjects(objects, true).find(h => h.object.visible !== false && !h.object.userData.lookFX);
  }
  function click(x, y) {
    if (S.mode === "garage") {
      if (S.transfer) return;
      const h = pick(x, y, workshop.pickMeshes().filter(m => m.visible));
      if (h) selectPart(workshop.partOfMesh(h.object)); else selectPart(null);
      return;
    }
    if (S.fall) return;
    const duckHit = pick(x, y, D.rig.meshes.filter(m => m.visible));
    const propHit = pick(x, y, phys.props.map(p => p.object));
    const floorHit = pick(x, y, world.meshes);
    const dist = (h) => h ? h.distance : Infinity;
    if (S.intentMode) {
      if (propHit && dist(propHit) <= dist(floorHit) + 0.01) {
        const p = phys.props.find(pp => { let o = propHit.object; while (o) { if (o === pp.object) return true; o = o.parent; } return false; });
        if (p) { startFetch(p); return; }
      }
      if (floorHit && dist(floorHit) < dist(duckHit)) { startGo(floorHit.point); return; }
    }
    if (duckHit && dist(duckHit) <= dist(floorHit)) { poke(ray.ray.direction); return; }
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
  document.addEventListener("gesturestart", (e) => e.preventDefault());

  // ---------------------------------------------------------------- props: grip points
  const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
  function gripPoint(p, from) {
    const o = p.object; o.updateWorldMatrix(true, false);
    if (p.id === "toy_duck") return new THREE.Vector3(0.009, 0.026, 0).applyMatrix4(o.matrixWorld);
    if (p.id === "ring") {
      const R = 0.016; let best = null, bd = 1e9;
      for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const w = new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0).applyMatrix4(o.matrixWorld); const d = w.distanceToSquared(from); if (d < bd) { bd = d; best = w; } }
      return best;
    }
    return o.getWorldPosition(new THREE.Vector3());
  }
  const gripWidth = (p) => (p.spec.grip && p.spec.grip.width) || 0.015;
  function propBetweenTips() {
    const duck = D.duck; const U = duck.markers.upper.getWorldPosition(new THREE.Vector3()), L = duck.markers.lower.getWorldPosition(new THREE.Vector3());
    const seg = L.clone().sub(U); const len2 = Math.max(seg.lengthSq(), 1e-8);
    let best = null, bd = 1e9;
    for (const p of phys.props) {
      if (p.held) continue;
      const g = gripPoint(p, U.clone().lerp(L, 0.5));
      const t = clamp(g.clone().sub(U).dot(seg) / len2, 0, 1);
      const d = U.clone().addScaledVector(seg, t).distanceTo(g);
      const tol = gripWidth(p) * 0.5 + 0.014;
      if (d < tol && d < bd) { bd = d; best = p; }
    }
    return best;
  }
  function attach(p) {
    phys.hold(p);
    const head = D.duck.headNode; head.updateWorldMatrix(true, false);
    const inv = head.matrixWorld.clone().invert();
    const local = inv.clone().multiply(p.object.matrixWorld);
    const gap = D.duck.beakGap(new THREE.Vector3()).applyMatrix4(inv);
    const g = gripPoint(p, D.duck.beakGap(new THREE.Vector3())).applyMatrix4(inv);
    S.held = { prop: p, local, settle: gap.sub(g), settleT: 0, prevPos: p.object.position.clone() };
    D.duck.jawStop = 0;
    const m = D.memory; m.fetched[p.id] = (m.fetched[p.id] || 0) + 1;
    voice.play("happy"); D.duck.happyWiggle = 1;
  }
  function releaseHeld() {
    if (!S.held) return;
    const p = S.held.prop; const vel = p.object.position.clone().sub(S.held.prevPos).multiplyScalar(60);
    vel.clampLength(0, 0.25);
    phys.release(p, vel); S.held = null; D.duck.jawStop = 0;
  }
  function updateHeld(dt) {
    const h = S.held; if (!h) return;
    const duck = D.duck; const head = duck.headNode; head.updateWorldMatrix(true, false);
    h.settleT = Math.min(1, h.settleT + dt / 0.25);
    const local = h.local.clone(); const off = h.settle.clone().multiplyScalar(h.settleT);
    local.premultiply(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
    const wm = head.matrixWorld.clone().multiply(local);
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), sc = new THREE.Vector3(); wm.decompose(pos, quat, sc);
    h.prevPos.copy(h.prop.object.position);
    phys.setHeldPose(h.prop, pos, quat);
    // jaw closes until it touches the prop
    if (duck.jaw > 0.02 && duck.beakOpening() <= gripWidth(h.prop) + 0.0015 && duck.jawStop === 0) duck.jawStop = duck.jaw;
  }

  // ---------------------------------------------------------------- tasks: go / grab / drop / fetch
  function steer(target, face = null, tol = 0.015) {
    const dx = target.x - S.pos.x, dz = target.z - S.pos.z, dist = Math.hypot(dx, dz);
    const lookAt = face || target;
    const desired = dist > tol ? Math.atan2(dx, dz) : Math.atan2(lookAt.x - S.pos.x, lookAt.z - S.pos.z);
    const err = wrap(desired - S.yaw);
    const w = clamp(err * 4.5, -GAIT.maxYawRate, GAIT.maxYawRate);
    let v = dist > tol ? GAIT.maxSpeed * clamp(1 - Math.abs(err) / 0.9, 0, 1) * clamp(dist / 0.12, 0.25, 1) : 0;
    return { v, w, dist, err };
  }
  function startGo(point) { S.task = { kind: "go", target: point.clone(), t: 0 }; marker.position.set(point.x, point.y + 0.002, point.z); voice.play("curious"); }
  function startGrab(p, then = null) {
    S.task = { kind: "grab", prop: p, phase: "approach", t: 0, then };
    D.duck.look.target = null;
  }
  function startFetch(p) {
    if (S.held) { startDrop(); return; }
    marker.position.copy(p.object.position).setY(0.002);
    startGrab(p, { kind: "return", home: S.pos.clone(), homeYaw: S.yaw });
    S.task.fetch = true; voice.play("curious");
  }
  function startDrop(then = null) { if (!S.held) return; S.task = { kind: "drop", phase: "lower", t: 0, then }; }
  function grabKey() {
    if (S.mode === "garage" || S.fall) return;
    voice.ensure();
    if (S.held) { startDrop(); return; }
    // nearest prop in front within reach
    const fwd = new THREE.Vector3(Math.sin(S.yaw), 0, Math.cos(S.yaw));
    let best = null, bs = 1e9;
    for (const p of phys.props) {
      const d = p.object.position.clone().sub(S.pos); d.y = 0; const L = d.length();
      if (L > 0.42 || p.object.position.y < -0.1) continue;
      const ang = Math.acos(clamp(d.normalize().dot(fwd), -1, 1));
      const score = L + ang * 0.12;
      if (ang < 1.4 && score < bs) { bs = score; best = p; }
    }
    if (best) startGrab(best); else { toast("Nothing to grab nearby", "Walk up to a toy, or use Intent mode and click one.", "info"); peck(); }
  }
  function peck() { S.task = { kind: "peck", t: 0 }; }

  function runTask(dt) {
    const T = S.task; if (!T) return null;
    T.t += dt; const duck = D.duck;
    if (T.kind === "go") {
      const s = steer(T.target);
      markMat.opacity = 0.9;
      if (s.dist < 0.02 || T.t > 20) { S.task = null; markMat.opacity = 0; if (s.dist < 0.03) voice.play("happy"); }
      return { v: s.v, w: s.w };
    }
    if (T.kind === "peck") {
      const f = new THREE.Vector3(Math.sin(S.yaw), 0, Math.cos(S.yaw));
      duck.reach.target = S.pos.clone().addScaledVector(f, 0.1).setY(0.03); duck.reach.weight = T.t < 0.55 ? 0.6 : 0;
      if (T.t > 1.2) { S.task = null; duck.reach.weight = 0; }
      return { v: 0, w: 0 };
    }
    if (T.kind === "grab") {
      const p = T.prop, P = p.object.position;
      if (P.y < -0.2) { S.task = null; duck.reach.weight = 0; toast("It fell off the table", "That toy is out of reach.", "info"); return { v: 0, w: 0 }; }
      if (T.phase === "approach") {
        markMat.opacity = T.fetch ? 0.9 : 0; if (T.fetch) marker.position.set(P.x, Math.max(0, world.groundHeightAt(P.x, P.z)) + 0.002, P.z);
        const g = gripPoint(p, S.pos.clone().setY(0.03));
        const dir = new THREE.Vector3(g.x - S.pos.x, 0, g.z - S.pos.z); const L = dir.length(); dir.normalize();
        const standoff = 0.088;
        const stand = new THREE.Vector3(g.x - dir.x * standoff, 0, g.z - dir.z * standoff);
        const s = steer(L < standoff + 0.03 ? S.pos.clone().addScaledVector(dir, L - standoff) : stand, g, 0.01);
        duck.look.target = g; duck.look.weight = 1;
        if ((Math.abs(L - standoff) < 0.018 && Math.abs(s.err) < 0.12) || (T.t > 9)) { T.phase = "reach"; T.t = 0; S.beakOpen = true; duck.look.target = null; }
        if (T.t > 9 && Math.abs(L - standoff) > 0.05) { S.task = null; duck.look.target = null; toast("Couldn't get there", "Something is in the way.", "info"); }
        return { v: s.v, w: s.w };
      }
      if (T.phase === "reach") {
        const g = gripPoint(p, duck.beakGap(new THREE.Vector3()));
        duck.reach.target = g.clone().setY(Math.max(g.y, 0.017)); duck.reach.weight = 1; S.beakOpen = true;
        if ((duck.reach.w > 0.9 && (duck.reach.err ?? 1) < 0.014) || T.t > 1.8) { T.phase = "close"; T.t = 0; S.beakOpen = false; }
        return { v: 0, w: 0 };
      }
      if (T.phase === "close") {
        S.beakOpen = false;
        if (S.held) { T.phase = "lift"; T.t = 0; }
        else if (T.t > 0.6) { T.phase = "lift"; T.t = 0; T.missed = true; }
        return { v: 0, w: 0 };
      }
      if (T.phase === "lift") {
        duck.reach.weight = 0; duck.look.target = null;
        if (T.t > 0.55) {
          if (T.missed) { toast("Missed it", "Try again from a little closer.", "info"); voice.play("sad"); S.task = null; markMat.opacity = 0; return { v: 0, w: 0 }; }
          if (T.then && T.then.kind === "return") { S.task = { kind: "return", home: T.then.home, t: 0, prop: p }; return { v: 0, w: 0 }; }
          S.task = null; markMat.opacity = 0;
        }
        return { v: 0, w: 0 };
      }
    }
    if (T.kind === "return") {
      markMat.opacity = 0.6; marker.position.set(T.home.x, Math.max(0, world.groundHeightAt(T.home.x, T.home.z)) + 0.002, T.home.z);
      const s = steer(T.home, null, 0.03);
      if (s.dist < 0.035 || T.t > 20) { startDrop({ kind: "fetched", prop: T.prop }); markMat.opacity = 0; }
      return { v: s.v, w: s.w };
    }
    if (T.kind === "drop") {
      const f = new THREE.Vector3(Math.sin(S.yaw), 0, Math.cos(S.yaw));
      if (T.phase === "lower") {
        const gy = Math.max(0, world.groundHeightAt(S.pos.x + f.x * 0.09, S.pos.z + f.z * 0.09));
        duck.reach.target = S.pos.clone().addScaledVector(f, 0.092).setY(gy + 0.026); duck.reach.weight = 1;
        if (duck.reach.w > 0.85 || T.t > 1.4) { T.phase = "open"; T.t = 0; S.beakOpen = true; releaseHeld(); }
      } else if (T.phase === "open") {
        if (T.t > 0.3) { T.phase = "up"; T.t = 0; duck.reach.weight = 0; }
      } else if (T.phase === "up") {
        if (T.t > 0.3) S.beakOpen = false;
        if (T.t > 0.6) {
          S.task = null;
          if (T.then && T.then.kind === "fetched") { voice.play("happy"); duck.happyWiggle = 1.2; toast("Fetched the " + (PROP_NAMES[T.then.prop.id] || "toy"), D.memory.name ? "For you, " + D.memory.name + "." : "", "info"); }
        }
      }
      return { v: 0, w: 0 };
    }
    return null;
  }

  // ---------------------------------------------------------------- falls
  function poke(dir) {
    if (S.fall || S.mode === "garage") return;
    const d = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    releaseHeld(); S.task = null; D.duck.reach.weight = 0;
    S.fall = { kind: "tip", t: 0 };
    D.duck.startTip(d);
    D.memory.knocks++;
    voice.play("startled"); pulse();
    toast("You knocked it over", "It will get back up.", "warn");
  }
  function startEdgeFall() {
    const dir = S.vel.clone().setY(0); if (dir.lengthSq() < 1e-6) dir.set(Math.sin(S.yaw), 0, Math.cos(S.yaw));
    dir.normalize();
    releaseHeld(); S.task = null; D.duck.reach.weight = 0;
    S.fall = { kind: "edge", t: 0, vel: dir.clone().multiplyScalar(Math.max(0.14, S.vel.length())), y: 0 };
    D.duck.startTumble(dir);
    const edge = Math.abs(S.pos.x) / (world.table.width / 2) > Math.abs(S.pos.z) / (world.table.depth / 2) ? (S.pos.x > 0 ? "right" : "left") : (S.pos.z > 0 ? "front" : "back");
    D.memory.falls.push({ edge, x: S.pos.x, z: S.pos.z });
    voice.play("startled", { force: true }); pulse();
    S.v = 0; S.w = 0;
  }
  D.duck.onGotUp = onGotUp;
  function onGotUp() {
    if (!S.fall) return;
    if (S.fall.kind === "edge" || S.fall.kind === "floor") {
      S.fall.kind = "rescue"; S.fall.t = 0;
    } else { S.fall = null; voice.play("curious"); }
  }
  function respawn() {
    S.fall = null; S.pos.set(...start.position); S.yaw = start.yaw || 0; S.v = S.w = 0; S.vel.set(0, 0, 0);
    D.duck.teleport(S.pos, S.yaw); phys.setCharPosition(S.pos); phys.syncDuckParts(D.duck); phys.snapDuckParts();
    cam.tYaw = S.yaw + Math.PI - 0.7;
  }

  // ---------------------------------------------------------------- simulation step
  const DT = 1 / 60;
  function simStep(dt) {
    S.simTime += dt;
    const duck = D.duck;
    // ---------- command
    const ki = keyInput();
    let cmd = { v: 0, w: 0 };
    const userMoving = Math.abs(ki.fwd) > 0.01 || Math.abs(ki.turn) > 0.01;
    if (S.mode !== "garage" && !S.fall) {
      if (userMoving && S.task && !(S.task.kind === "drop")) { S.task = null; duck.reach.weight = 0; duck.look.target = null; markMat.opacity = 0; }
      const tc = runTask(dt);
      if (tc) cmd = tc;
      else cmd = { v: ki.fwd * (ki.fwd > 0 ? GAIT.maxSpeed : GAIT.maxSpeed * 0.45), w: ki.turn * GAIT.maxYawRate * (ki.fwd !== 0 ? 0.75 : 1) };
    }
    S.cmd = cmd;
    const carried = S.held ? S.held.prop.mass : 0;
    const F = mind.filter(cmd, { pos: S.pos, yaw: S.yaw, dt, carriedMass: carried });
    S.filtered = F;
    if ((F.kind === "refuse" || F.kind === "backoff") && Math.abs(cmd.v) > 0.01) {
      if (S.simTime - S.lastToastAt > 2.6) {
        S.lastToastAt = S.simTime; D.memory.refusals++;
        toast("Nope!", F.kind === "backoff" ? "Too close to the edge. It backed away." : "Edge ahead. It won't step off.", "warn");
        pulse(); voice.play("startled");
      }
    }
    // ---------- motion (smooth accel/decel)
    if (!S.fall) {
      const accel = Math.abs(F.v) > Math.abs(S.v) ? 0.55 : 1.0;
      S.v = approach(S.v, F.v, accel * dt);
      S.w = approach(S.w, F.w, 7 * dt);
      S.yaw = wrap(S.yaw + S.w * dt);
      const before = S.pos.clone();
      if (S.mode !== "garage") {
        const d = new THREE.Vector3(Math.sin(S.yaw) * S.v * dt, -0.004, Math.cos(S.yaw) * S.v * dt);
        phys.moveChar(d);
        phys.charPosition(S.pos);
      }
      S.vel.copy(S.pos).sub(before).divideScalar(dt); S.vel.y = 0;
      if (world.isOverDrop(S.pos.x, S.pos.z)) startEdgeFall();
      if (S.pos.y > world.anchors.platformTop.position[1] - 0.005 && !D.memory.climbed && Math.abs(S.pos.x - world.anchors.platformTop.position[0]) < 0.15) { D.memory.climbed = true; toast("Made it to the top", "It will remember the ramp.", "info"); voice.play("happy"); }
    }
    // ---------- fall motion
    let yOverride;
    if (S.fall) {
      S.fall.t += dt;
      if (S.fall.kind === "edge") {
        const f = S.fall; f.vel.y -= 9.81 * dt; f.vel.x *= 0.995; f.vel.z *= 0.995;
        S.pos.x += f.vel.x * dt; S.pos.z += f.vel.z * dt; f.y += f.vel.y * dt;
        const floorY = -world.table.height;
        if (f.y <= floorY) { f.y = floorY; f.kind = "floor"; duck.landTumble(); duck.fall && (duck.fall.lieTime = 1.0); voice.play("sad", { force: true }); }
        yOverride = f.y;
      } else if (S.fall.kind === "floor" || S.fall.kind === "rescue") {
        yOverride = -world.table.height;
        if (S.fall.kind === "rescue") {
          if (S.fall.t > 0.6 && !S.fall.faded) { S.fall.faded = true; $("fadeText").textContent = "Picked up and put back on the table"; $("fadeBlack").classList.add("on"); }
          if (S.fall.t > 1.6) { respawn(); $("fadeBlack").classList.remove("on"); toast("It remembers that fall", "See its memories in the Garage.", "info"); return; }
        }
      }
      S.vel.set(0, 0, 0); S.v = 0; S.w = 0;
    }
    // ---------- jaw
    duck.jawTarget = S.beakOpen ? 0.6 : 0;
    if (!S.beakOpen && !S.held && duck.jaw > 0.05 && !S.fall) { const p = propBetweenTips(); if (p) attach(p); }
    if (S.held && S.beakOpen && duck.jaw > (duck.jawStop || 0) + 0.12) releaseHeld();
    if (!S.held) duck.jawStop = 0;
    // ---------- body
    duck.update(dt, { pos: S.pos, yaw: S.yaw, vel: S.vel, yawRate: S.fall ? 0 : S.w, yOverride });
    updateHeld(dt);
    if (companion) companion.duck.update(dt, { pos: companion.pos, yaw: companion.yaw, vel: new THREE.Vector3(), yawRate: 0 });
    // ---------- physics
    if (!S.fall) phys.syncDuckParts(duck);
    phys.step(); phys.syncProps();
    for (const p of phys.props) if (!p.held && p.object.position.y < -world.table.height - 0.2) phys.resetProp(p);
    // ---------- mind
    const trunkUp = new THREE.Vector3(0, 1, 0).applyQuaternion(duck.trunk.getWorldQuaternion(_q));
    const tilt = Math.max(0, Math.acos(clamp(trunkUp.y, -1, 1)) - duck.pitchExtra - Math.abs(duck.lean));
    const speed = Math.hypot(S.vel.x, S.vel.z);
    mind.estimate({ duck, dt, pos: S.pos, yaw: S.yaw, speed, cmdDir: Math.abs(S.cmd.v) > 0.005 ? new THREE.Vector3(Math.sin(S.yaw) * Math.sign(S.cmd.v), 0, Math.cos(S.yaw) * Math.sign(S.cmd.v)) : null, carriedMass: carried, tilt, props: phys.props, falling: S.fall && S.fall.kind !== "rescue" && (S.fall.kind === "edge" || S.fall.t < 0.6) });
    // ---------- garage
    if (S.mode === "garage") updateGarage(dt);
    if (S.pendingAsk && S.simTime >= S.pendingAsk.at) { const l = S.pendingAsk.label; S.pendingAsk = null; S.garageBusy = false; refreshParts(); voice.play("happy", { force: true }); toast("New part fitted", l, "info", 1800); }
    workshop.update(dt); orb.update(dt);
    // occasional idle chirp
    if (!S.fall && speed < 0.01 && S.simTime - S.lastInputAt > 14 && S.simTime - (S.lastIdleChirp || 0) > 16) { S.lastIdleChirp = S.simTime; voice.play("curious"); }
  }

  // ---------------------------------------------------------------- camera
  const camPos = new THREE.Vector3();
  function updateCamera(dt) {
    let tgt;
    if (S.mode === "garage") {
      const wb = world.anchors.workbench.position;
      tgt = new THREE.Vector3(wb[0], wb[1] + 0.105, wb[2]);
      if (S.transfer && companion) { tgt.lerp(new THREE.Vector3(companion.pos.x, 0.1, companion.pos.z), 0.5); tgt.y = 0.09; }
      if (!reduced && S.simTime - S.camDragAt > 3 && !S.transfer) cam.tYaw += dt * 0.12;
    } else {
      tgt = D.duck.root.position.clone(); tgt.y = (S.fall ? D.duck.root.position.y : D.duck.baseY) + 0.125;
      // drift behind the duck while walking unless the player is orbiting
      const moving = Math.abs(S.v) > 0.02;
      if (moving && S.simTime - S.camDragAt > 2.5 && !reduced) {
        const behind = S.yaw + Math.PI - 0.45 * Math.sign(wrap(cam.tYaw - S.yaw - Math.PI) || 1);
        cam.tYaw += wrap(behind - cam.tYaw) * (1 - Math.exp(-0.6 * dt));
      }
    }
    const k = 1 - Math.exp(-(reduced ? 12 : 7) * dt);
    if (innerWidth / innerHeight < 0.8) tgt.y -= S.mode === "garage" ? 0.09 : 0.03; // portrait: keep the duck clear of the bottom sheet / controls
    if (!cam.init) { cam.target.copy(tgt); cam.init = true; }
    cam.target.lerp(tgt, 1 - Math.exp(-6 * dt));
    cam.yaw += wrap(cam.tYaw - cam.yaw) * k; cam.pitch += (cam.tPitch - cam.pitch) * k; cam.dist += (cam.tDist - cam.dist) * k;
    const portrait = innerWidth / innerHeight < 0.8;
    const off = new THREE.Vector3(Math.sin(cam.yaw) * Math.cos(cam.pitch), Math.sin(cam.pitch), Math.cos(cam.yaw) * Math.cos(cam.pitch)).multiplyScalar(cam.dist * (portrait ? (S.mode === "garage" ? 1.9 : 1.35) : 1));
    camPos.copy(cam.target).add(off);
    // keep the camera above the tabletop when it is over the table
    if (!world.isOverDrop(camPos.x, camPos.z)) camPos.y = Math.max(camPos.y, world.groundHeightAt(camPos.x, camPos.z) + 0.03);
    camera.position.copy(camPos); camera.lookAt(cam.target);
  }

  // ---------------------------------------------------------------- layers easing + render
  const eyeBox = $("eyeBox"), tofCv = $("tof");
  const EYE_W = 160, EYE_H = 160;
  const eyeRT = new THREE.WebGLRenderTarget(EYE_W, EYE_H, { samples: 0 }); eyeRT.texture.colorSpace = THREE.SRGBColorSpace;
  const eyePx = new Uint8Array(EYE_W * EYE_H * 4); const eyeCtx = eyeBox.getContext("2d"); const eyeImg = eyeCtx.createImageData(EYE_W, EYE_H);
  function renderEye() {
    const duck = D.duck; const f = duck.headDir(new THREE.Vector3());
    duck.markers.cam.getWorldPosition(eyeCam.position).addScaledVector(f, 0.012);
    eyeCam.lookAt(eyeCam.position.clone().add(f)); eyeCam.aspect = 1; eyeCam.updateProjectionMatrix();
    const hidden = []; scene.traverse(o => { if ((o.userData.lookFX || o.name === "mind_fx") && o.visible) { hidden.push(o); o.visible = false; } });
    D.rig.meshes.forEach(m => { if (m.visible && /^(shell_head|eye_|electronics_camera|shell_beak)/.test(m.name)) { hidden.push(m); m.visible = false; } });
    const exp = renderer.toneMappingExposure; renderer.toneMappingExposure = 0.8;
    renderer.setRenderTarget(eyeRT); renderer.clear(); renderer.render(scene, eyeCam); renderer.setRenderTarget(null);
    renderer.toneMappingExposure = exp;
    hidden.forEach(o => o.visible = true);
    renderer.readRenderTargetPixels(eyeRT, 0, 0, EYE_W, EYE_H, eyePx);
    const d = eyeImg.data;
    for (let y = 0; y < EYE_H; y++) { const src = (EYE_H - 1 - y) * EYE_W * 4; d.set(eyePx.subarray(src, src + EYE_W * 4), y * EYE_W * 4); }
    // slight camera-sensor feel: cool tint + vignette done by CSS
    eyeCtx.putImageData(eyeImg, 0, 0);
  }
  let frame = 0;
  function render(dt) {
    frame++;
    const t = { surface: S.layer === "surface" ? 1 : 0, xray: S.layer === "xray" ? 1 : 0, mind: S.layer === "mind" ? 1 : 0 };
    const k = reduced || TEST || dt === 0 ? 1 : 1 - Math.exp(-5 * dt);
    for (const key in t) S.W[key] = lerp(S.W[key], t[key], k);
    D.rig.setWeights(S.W); if (companion) companion.rig.setWeights(S.W); world.setWeights(S.W);
    updateCamera(dt || DT);
    stage.follow(D.duck.root.position, Math.max(-world.table.height, Math.min(D.duck.baseY, world.groundHeightAt(D.duck.pos.x, D.duck.pos.z))));
    world.update(dt); scene.updateMatrixWorld(true);
    D.rig.follow(); D.rig.update(dt); if (companion) { companion.rig.follow(); companion.rig.update(dt); }
    mind.updateVisuals(dt, { pos: S.pos, yaw: S.yaw, vChosen: S.mode === "garage" ? 0 : S.v, wChosen: S.mode === "garage" ? 0 : S.w, vCmd: S.cmd.v, wCmd: S.cmd.w, override: S.filtered.kind }, S.mode === "garage" ? 0 : S.W.mind);
    markMat.opacity *= 1; marker.scale.setScalar(1 + 0.15 * Math.sin(S.simTime * 6));
    stage.update(dt);
    post.render(dt);
    // head-camera inset (Mind panel): small render target, read back into a 2D canvas inside the glass panel
    const mindVisible = !$("mindPanel").classList.contains("hidden") && getComputedStyle(eyeBox.parentElement).display !== "none";
    if (mindVisible && (TEST || frame % 3 === 0)) renderEye();
    if (mindVisible || !$("mindPanel").classList.contains("hidden")) mind.drawDepth(tofCv);
    updateHUD();
  }

  // ---------------------------------------------------------------- HUD (mind panel)
  const gArc = $("gArc"), gNum = $("gNum");
  function updateHUD() {
    if ($("mindPanel").classList.contains("hidden")) return;
    const r = Math.round(mind.risk * 100);
    gArc.setAttribute("stroke-dasharray", `${r} 100`); gNum.textContent = r;
    $("uNum").textContent = Math.round(mind.uncertainty * 100) + "%";
    $("eNum").textContent = mind.dAheadEst >= 0.49 ? "far" : Math.round(mind.dAheadEst * 100) + " cm";
    const pill = $("statePill");
    let st = "Calm", warn = false;
    if (S.fall) { st = "Falling!"; warn = true; }
    else if (S.filtered.kind === "refuse") { st = "Refusing"; warn = true; }
    else if (S.filtered.kind === "backoff") { st = "Backing away"; warn = true; }
    else if (S.filtered.kind === "slow") { st = "Slowing down"; warn = true; }
    else if (S.held) st = "Carrying " + (PROP_NAMES[S.held.prop.id] || "a toy");
    else if (mind.uncertainty > 0.45) st = "Unsure";
    else if (mind.risk > 0.4) { st = "Careful"; warn = true; }
    pill.textContent = st; pill.classList.toggle("warn", warn);
  }

  function drawLines(cv, series, o = {}) {
    const g = cv.getContext("2d"), W = cv.width, H = cv.height; g.clearRect(0, 0, W, H);
    const L = 44, R = 12, T = 12, B = 34; const xMax = o.xMax || 1, yMax = o.yMax || 1;
    const X = (x) => L + (W - L - R) * x / xMax, Y = (y) => T + (H - T - B) * (1 - y / yMax);
    g.font = "500 20px Inter, sans-serif"; g.fillStyle = "#6E6E73"; g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 2;
    for (const y of o.yTicks || [0, 0.5, 1]) { g.beginPath(); g.moveTo(L, Y(y)); g.lineTo(W - R, Y(y)); g.stroke(); g.textAlign = "right"; g.fillText(o.yFmt ? o.yFmt(y) : Math.round(y * 100), L - 8, Y(y) + 7); }
    g.textAlign = "center"; for (const x of o.xTicks || [0, xMax / 2, xMax]) g.fillText(o.xFmt ? o.xFmt(x) : Math.round(x), X(x), H - 8);
    if (o.xLabel) { g.textAlign = "right"; g.fillText(o.xLabel, W - R, H - 8 - 0); }
    for (const s of series) {
      if (!s.data.length) continue;
      g.strokeStyle = s.color; g.lineWidth = (s.width || 2) * 2; g.lineJoin = "round"; g.lineCap = "round";
      if (s.line !== false) { g.beginPath(); s.data.forEach(([x, y], i) => i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))); g.stroke(); }
      if (s.dots) for (const [x, y, kind] of s.data) { g.fillStyle = kind === "T" ? "#BF5AF2" : s.color; g.beginPath(); if (kind === "T") { g.moveTo(X(x), Y(y) - 9); g.lineTo(X(x) + 9, Y(y)); g.lineTo(X(x), Y(y) + 9); g.lineTo(X(x) - 9, Y(y)); } else g.arc(X(x), Y(y), 6, 0, Math.PI * 2); g.fill(); }
    }
  }

  // ---------------------------------------------------------------- Garage
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
      const st = p.btn.querySelector(".st"); st.textContent = p.replaced ? (p.swaps > 1 ? `new ×${p.swaps}` : "new") : "original"; st.classList.toggle("new", p.replaced);
      p.btn.setAttribute("aria-pressed", String(p === selected));
    }
    const o = workshop.originals, n = workshop.total;
    $("origNum").textContent = `${o} / ${n}`; $("origBar").style.width = (o / n * 100) + "%";
    $("servoCount").textContent = workshop.parts.filter(p => p.servo && !p.replaced).length + " original";
    $("replaceBtn").disabled = !selected || workshop.busy;
    $("selName").textContent = selected ? selected.label : "";
    $("voiceSerial").textContent = D.voiceSerial; $("bodySerial").textContent = D.serial;
    renderMemories();
  }
  function selectPart(p) {
    selected = p; workshop.highlight(p); refreshParts();
    if (p && p.servo) $("servoList").parentElement.open = true;
    if (p && innerWidth > 720) p.btn.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }
  $("replaceBtn").onclick = () => replaceSelected();
  function replaceSelected() {
    if (!selected || workshop.busy || S.transfer) return;
    const p = selected; const dur = workshop.replace(p); voice.play("startled", { force: true });
    S.garageBusy = true; selected = null; refreshParts();
    S.pendingAsk = { at: S.simTime + dur + 0.15, label: p.label };
    return dur;
  }
  document.querySelectorAll("#swatches button").forEach(b => b.onclick = () => {
    const target = $("skinTarget").value; workshop.skin(b.dataset.skin, target);
    if (target === "all") document.querySelectorAll("#swatches button").forEach(x => x.setAttribute("aria-pressed", String(x === b)));
    voice.play("happy");
  });
  let prevVoice = null;
  $("voiceSwap").onclick = () => { prevVoice = D.voiceSerial; D.voiceSerial = makeSerial(); voice.setSerial(D.voiceSerial); refreshParts(); voice.play("hello", { force: true }); };
  $("voiceBefore").onclick = () => { const s = prevVoice || D.voiceSerial; const old = voice.serial; voice.setSerial(s); voice.play("hello", { force: true }); voice.setSerial(old); };
  $("voiceAfter").onclick = () => { voice.setSerial(D.voiceSerial); voice.play("hello", { force: true }); };

  function memoryItems(m) {
    const out = [];
    if (m.name) out.push(`Knows you as ${m.name}`);
    const fav = Object.entries(m.fetched).sort((a, b) => b[1] - a[1])[0];
    if (fav) out.push(`Favourite toy: the ${PROP_NAMES[fav[0]] || fav[0]} (${fav[1]}×)`);
    for (const f of m.falls.slice(-2)) out.push(`Fell off the ${f.edge} edge`);
    if (m.knocks) out.push(`Was knocked over ${m.knocks === 1 ? "once" : m.knocks + " times"}`);
    if (m.refusals) out.push(`Refused to step off the edge ${m.refusals === 1 ? "once" : m.refusals + " times"}`);
    if (m.climbed) out.push("Learned the ramp to the platform");
    for (const n of m.notes) out.push(n);
    return out;
  }
  function renderMemories() {
    const items = memoryItems(D.memory); const ul = $("memList"); ul.innerHTML = "";
    if (!items.length) { const li = document.createElement("li"); li.className = "empty"; li.textContent = "Nothing yet. Go play with it."; ul.appendChild(li); }
    for (const t of items) { const li = document.createElement("li"); li.textContent = t; ul.appendChild(li); }
  }

  function enterGarage() {
    releaseHeld(); S.task = null; D.duck.reach.weight = 0; markMat.opacity = 0;
    if (S.fall) { S.fall = null; }
    S.playPose = { pos: S.pos.clone(), yaw: S.yaw };
    const wb = world.anchors.workbench.position;
    S.pos.set(wb[0], wb[1], wb[2]); S.yaw = 0.35; S.v = S.w = 0;
    D.duck.teleport(S.pos, S.yaw); phys.setCharPosition(S.pos); phys.syncDuckParts(D.duck); phys.snapDuckParts();
    if (!workshop.worn) { workshop.wear(); workshop.worn = true; }
    world.turntable.state.angularVelocity = reduced ? 0 : 0.22;
    cam.tYaw = S.yaw + 0.5; cam.tPitch = 0.32; cam.tDist = 0.55; cam.init = false;
    if (S.layer === "mind") setLayer("surface");
    buildPartsUI();
  }
  function leaveGarage() {
    world.turntable.state.angularVelocity = 0; selectPart(null);
    const p = S.playPose || { pos: new THREE.Vector3(...start.position), yaw: 0 };
    S.pos.copy(p.pos); S.yaw = p.yaw; D.duck.teleport(S.pos, S.yaw); phys.setCharPosition(S.pos); phys.syncDuckParts(D.duck); phys.snapDuckParts();
    cam.tYaw = S.yaw + Math.PI - 0.7; cam.tPitch = 0.44; cam.tDist = 0.85; cam.init = false;
  }
  function updateGarage(dt) {
    // duck rides the turntable
    if (!S.transfer) S.yaw = wrap(S.yaw + world.turntable.state.angularVelocity * dt);
  }

  // ---------------------------------------------------------------- welcome
  const welcome = $("welcome");
  function dismissWelcome(name) {
    const n = (name ?? $("nameIn").value).trim().slice(0, 24);
    D.memory.name = n || null; welcome.classList.add("away"); setTimeout(() => welcome.classList.add("hidden"), 500);
    voice.ensure(); voice.play("hello", { force: true });
    toast(n ? `Hi ${n}!` : "Hi!", n ? "It will remember your name." : "Walk with WASD or the joystick.", "info");
  }
  $("startBtn").onclick = () => dismissWelcome();
  $("nameIn").addEventListener("keydown", (e) => { if (e.key === "Enter") dismissWelcome(); e.stopPropagation(); });

  // ---------------------------------------------------------------- loop
  progress(1);
  updatePanels();
  let acc = 0, last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    let dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (TEST) return;
    if (document.hidden) return;
    acc += dt; let n = 0;
    while (acc >= DT && n < 4) { simStep(DT); acc -= DT; n++; }
    if (n === 4) acc = 0;
    render(dt);
    aq && aq.tick(dt);
  }
  // warm-up frames so the first visible frame is posed
  for (let i = 0; i < 3; i++) simStep(DT);
  render(0);
  loadingEl.classList.add("done");
  if (!TEST || Q.has("welcome")) { welcome.classList.remove("hidden"); setTimeout(() => $("nameIn").focus({ preventScroll: true }), 50); }
  requestAnimationFrame(loop);

  // ---------------------------------------------------------------- test hook (deterministic stepping)
  window.__lab = {
    ready: true, S, D, mind, phys, world, workshop, camera, cam,
    get companion() { return companion; },
    advance(sec, input) { if (input) S.testInput = input; const n = Math.round(sec / DT); for (let i = 0; i < n; i++) simStep(DT); return this.state(); },
    render(n = 1) { for (let i = 0; i < n; i++) render(DT); },
    input(fwd = 0, turn = 0) { S.testInput = { fwd, turn }; },
    state() { return { pos: S.pos.toArray().map(v => +v.toFixed(3)), yaw: +S.yaw.toFixed(3), v: +S.v.toFixed(3), risk: +mind.risk.toFixed(3), unc: +mind.uncertainty.toFixed(3), override: S.filtered.kind, held: S.held && S.held.prop.id, task: S.task && (S.task.kind + ":" + (S.task.phase || "")), fall: S.fall && S.fall.kind, jaw: +D.duck.jaw.toFixed(3), legErr: [D.duck.legs.left.err, D.duck.legs.right.err].map(e => +(e || 0).toFixed(4)), reachErr: D.duck.reach.err }; },
    teleport(x, z, yaw) { S.pos.set(x, world.groundHeightAt(x, z), z); S.yaw = yaw; D.duck.teleport(S.pos, yaw); phys.setCharPosition(S.pos); phys.syncDuckParts(D.duck); phys.snapDuckParts(); cam.tYaw = yaw + Math.PI - 0.7; cam.yaw = cam.tYaw; cam.init = false; },
    camera(yawOff, pitch, dist) { cam.tYaw = cam.yaw = S.yaw + Math.PI + yawOff; cam.tPitch = cam.pitch = pitch; cam.tDist = cam.dist = dist; cam.init = false; },
    snap() { cam.yaw = cam.tYaw; cam.pitch = cam.tPitch; cam.dist = cam.tDist; cam.init = false; },
    camAbs(yaw, pitch, dist) { cam.tYaw = cam.yaw = yaw; cam.tPitch = cam.pitch = pitch; cam.tDist = cam.dist = dist; cam.init = false; },
    setMode, setLayer: (l) => { setLayer(l); for (const k in S.W) S.W[k] = k === l ? 1 : 0; }, setIntentMode, grabKey, beakDown, beakUp, poke: (x, z) => poke(new THREE.Vector3(x, 0, z)), startFetch: (id) => startFetch(phys.props.find(p => p.id === id)), startGo: (x, z) => startGo(new THREE.Vector3(x, 0, z)),
    selectPart: (id) => selectPart(workshop.parts.find(p => p.id === id)), replaceSelected,
    dismissWelcome, toast, skin: (n, t) => workshop.skin(n, t),
    clickAt: (x, y) => click(x, y), safety: (on) => { mind.safety = on; $("safetyBtn").setAttribute("aria-pressed", String(on)); },
    propPos: (id) => phys.props.find(p => p.id === id).object.position.toArray(),
  };
}
