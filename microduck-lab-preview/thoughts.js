// thoughts.js — comic speech bubbles over the AI ducks, saying what each one is actually doing or about to do.
// Reads real brain / task / game state every frame, pops a short first-person line when the intent changes
// (or on an event), keeps at most a few on screen (nearest, visible, not behind walls), reuses a small DOM pool.
//
//   const th = createThoughts({ G, camera, world, occluders: () => meshes, container, phone, isFree: (x, y) => bool });
//   th.update(dt)          once per rendered frame
//   th.event(agent, kind, data)   goal | gotUp | fetched ... (optional pushes from game events)
//   th.poke(agent)         show this duck's current intent now (hover / click)
//   th.enabled = bool
import * as THREE from "three";

const LINES = {
  wander:   ["Just exploring…", "What's over here?", "La la, wandering."],
  roam:     ["Off to the {room}!", "Heading to the {room}!", "Visiting the {room}."],
  follow:   ["Wait for me!", "Right behind you!", "Coming too!"],
  fetch:    ["Ooh, a {prop}!", "That {prop} is mine!", "Mmm, {prop}!"],
  got:      ["Got it!", "Gotcha!", "Mine now!"],
  drop:     ["Here you go!", "For you!", "Ta-da!"],
  ball:     ["My ball!", "Pass it!", "Kick kick!"],
  kick:     ["My ball!", "Pass it!", "Take that!"],
  goal:     ["GOAL!", "Yesss!", "Score!"],
  race:     ["Can't catch me!", "Zoom zoom!", "Race you!"],
  laser:    ["The red dot!!", "Got to get it!", "Dot! Dot! Dot!"],
  sit:      ["Taking a break.", "Comfy.", "Sitting pretty."],
  idle:     ["♪ la la ♪", "Hmm…", "Nice day."],
  toy:      ["Toy time!", "Ooh, shiny!", "Let me see…"],
  edge:     ["Whoa, too high!", "Nope, not jumping!", "Careful…"],
  fall:     ["Oof!", "Ouch!", "Whoops!"],
  up:       ["I'm okay!", "All good!", "Up again!"],
  bed:      ["Boing boing!", "Bouncy!", "Wheee, bed!"],
  water:    ["Splashy!", "Puddle!", "Splish splash!"],
  slippery: ["Wheee, slippery!", "Sliiide!", "Whoa, tiles!"],
  skate:    ["Wheee!", "Skate time!", "Zoom!"],
};
const ICON = { wander: "👀", roam: "🗺️", follow: "💨", fetch: "✨", got: "😋", drop: "🎁", ball: "⚽", kick: "⚽", goal: "🎉", race: "🏁",
  laser: "🔴", sit: "💤", idle: "🎵", toy: "🧸", edge: "⚠️", fall: "💥", up: "👍", bed: "🛏️", water: "💦", slippery: "🧊", skate: "🛼" };
const ROOM_NAME = { living: "living room", kitchen: "kitchen", bedroom: "bedroom", hallway: "hallway", garden: "garden" };

const SHOW = 3.0, FADE = 0.35, REPEAT = 8, MAX_ON = 4, POOL = 6, RANGE = 4.0;

export function createThoughts({ G, camera, world, occluders, isCut = () => false, container, phone = false, isFree = () => true }) {
  const layer = document.createElement("div"); layer.className = "thoughts"; layer.setAttribute("aria-hidden", "true");
  (container || document.body).appendChild(layer);
  const pool = [];
  for (let i = 0; i < POOL; i++) {
    const el = document.createElement("div"); el.className = "thought";
    el.innerHTML = '<i class="ic"></i><b></b>'; layer.appendChild(el);
    pool.push({ el, ic: el.firstChild, tx: el.lastChild, owner: null, text: "", shown: false });
  }
  const st = new Map();           // agent -> per-duck state (allocated once per duck)
  const V = new THREE.Vector3(), P = new THREE.Vector3(), CAM = new THREE.Vector3(), DIR = new THREE.Vector3();
  const ray = new THREE.Raycaster();
  const cand = [];               // reused candidate list
  let clock = 0, frame = 0, W = innerWidth, H = innerHeight;
  addEventListener("resize", () => { W = innerWidth; H = innerHeight; });

  const fill = (tpl, a, data) => tpl.replace("{room}", data.room || "room").replace("{prop}", data.prop || "toy");
  function pick(s, kind, a, data) {
    const L = LINES[kind] || [kind];
    // rotate through the variants, skipping any said in the last REPEAT seconds
    for (let k = 0; k < L.length; k++) {
      const t = fill(L[(s.vi + k) % L.length], a, data);
      if (clock - (s.said.get(t) ?? -99) >= REPEAT) { s.vi = (s.vi + k + 1) % L.length; return t; }
    }
    return null;
  }
  function say(a, kind, data = {}, force = false) {
    const s = state(a);
    const text = pick(s, kind, a, data) || (force ? fill((LINES[kind] || [kind])[0], a, data) : null);
    if (!text) return false;
    s.said.set(text, clock); s.text = text; s.kind = kind; s.t0 = clock; s.until = clock + SHOW;
    return true;
  }
  function state(a) {
    let s = st.get(a);
    if (!s) { s = { key: "", text: "", kind: "", t0: -99, until: -99, vi: (a.index * 7) % 3, said: new Map(), held: null, fall: null, kick: a.lastKick, surf: "", vis: false, visAt: -9, dist: 99 }; st.set(a, s); }
    return s;
  }

  // ---- what is this duck doing right now? -> [key, kind, data]
  const out = { key: "", kind: "", data: { room: "", prop: "" } };
  function intent(a) {
    const B = a.brain, d = out.data; d.room = ""; d.prop = "";
    out.kind = ""; out.key = "";
    if (a.fall) { out.kind = "fall"; out.key = "fall"; return out; }
    if (G.race && G.race.active && G.race.prog && G.race.prog.has(a)) { out.kind = "race"; out.key = "race"; return out; }
    if (G.football && G.football.active) { out.kind = "ball"; out.key = "football"; return out; }
    if (G.laser && G.laser.visible && G.laser.point.distanceTo(a.pos) < 0.8 && !a.skates) { out.kind = "laser"; out.key = "laser"; return out; }
    if (a.filtered && a.filtered.kind === "refuse") { out.kind = "edge"; out.key = "edge"; return out; }
    if (a.surfType === "water") { out.kind = "water"; out.key = "water"; return out; }
    if (a.surfType === "bed") { out.kind = "bed"; out.key = "bed"; return out; }
    if (a.drifting && a.surfType === "tile") { out.kind = "slippery"; out.key = "slip"; return out; }
    if (a.task && a.task.kind === "grab" && a.task.prop) {
      const p = a.task.prop; d.prop = ((p.spec && p.spec.label) || p.kind || "toy").toLowerCase();
      out.kind = "fetch"; out.key = "grab:" + p.kind; return out;
    }
    switch (B && B.state) {
      case "roam": {
        const r = B.route && B.route.length ? B.route[B.route.length - 1] : null;
        const room = r && world.roomAt ? world.roomAt(r.x, r.z) : null;
        const here = world.roomAt ? world.roomAt(a.pos.x, a.pos.z) : null;
        if (room && room === here) { out.kind = "wander"; out.key = "roam:" + room; return out; }   // already there: just pottering about
        d.room = ROOM_NAME[room] || "next room"; out.kind = "roam"; out.key = "roam:" + (room || "?"); return out;
      }
      case "follow": out.kind = "follow"; out.key = "follow"; return out;
      case "ball": out.kind = "ball"; out.key = "ball"; return out;
      case "toy": out.kind = "toy"; out.key = "toy"; return out;
      case "sit": out.kind = "sit"; out.key = "sit"; return out;
      case "idle": out.kind = a.duck.emote ? "idle" : ""; out.key = a.duck.emote ? "idle:emote" : "idle"; return out;
      case "wander": out.kind = "wander"; out.key = "wander"; return out;
    }
    if (a.skates) { out.kind = "skate"; out.key = "skate"; }
    return out;
  }

  function track(a) {
    const s = state(a);
    // edge events derived from state transitions
    if (s.fall && !a.fall) say(a, "up");
    s.fall = a.fall ? a.fall.kind : null;
    const heldNow = a.held ? a.held.prop : null;
    if (heldNow && !s.held) say(a, "got");
    else if (!heldNow && s.held && !a.fall) say(a, "drop");
    s.held = heldNow;
    if (a.lastKick !== s.kick) { s.kick = a.lastKick; if (clock > s.until - SHOW + 1.2) say(a, "kick"); }
    // intent changes
    const I = intent(a);
    if (I.key !== s.key) {
      s.key = I.key;
      if (I.kind) say(a, I.kind, I.data);
    }
  }

  // ---- visibility: in front, in range, room drawn, not behind a wall (raycast, round-robin)
  const head = (a, v) => { a.duck.headNode.getWorldPosition(v); v.y += 0.075; return v; };
  function visible(a, s) {
    head(a, P);
    s.dist = P.distanceTo(CAM);
    if (s.dist > RANGE) return false;
    V.copy(P).project(camera);
    if (V.z > 1 || V.x < -1.05 || V.x > 1.05 || V.y < -1.05 || V.y > 1.05) return false;
    const groups = world.house && world.house.groups;
    if (groups && world.roomAt) { const r = world.roomAt(a.pos.x, a.pos.z); if (r && groups[r] && !groups[r].visible) return false; }
    if (!a.duck.root.visible) return false;
    if (clock - s.visAt > 0.25) {    // occlusion test at most 4x per second per duck
      s.visAt = clock;
      const occ = occluders && occluders();
      if (occ && occ.length) {
        DIR.copy(P).sub(CAM).normalize(); ray.set(CAM, DIR); ray.far = s.dist - 0.12;
        const hit = ray.intersectObjects(occ, false);
        s.occluded = false;
        for (const h of hit) if (!isCut(h.point)) { s.occluded = true; break; }   // walls cut away for the camera don't count
        hit.length = 0;
      } else s.occluded = false;
    }
    return !s.occluded;
  }

  const th = {
    enabled: true, showControlled: false, count: 0,
    event(a, kind, data) { if (!a || (a.controlled && !this.showControlled)) return; state(a); say(a, kind, data || {}, true); },
    /** hover / click: show this duck's current intent right now */
    poke(a) {
      if (!a) return; const s = state(a); const I = intent(a);
      const kind = I.kind || (a.held ? "got" : "idle"); s.key = I.key;
      say(a, kind, I.data, true); s.until = clock + SHOW; s.forced = clock + SHOW;
    },
    lineOf(a) { const s = st.get(a); return s && s.until > clock ? s.text : ""; },
    update(dt) {
      clock += dt; frame++;
      camera.getWorldPosition(CAM);
      cand.length = 0;
      for (const a of G.agents) {
        if (a.controlled && !this.showControlled) { const s = st.get(a); if (s) { s.until = Math.min(s.until, clock); s.key = ""; } continue; }
        track(a);
        const s = state(a);
        if (!this.enabled && !(s.forced > clock)) continue;
        if (s.until <= clock) continue;
        s.vis = visible(a, s);
        if (s.vis) cand.push(a);
      }
      // nearest first; a poked duck always wins
      cand.sort((a, b) => { const sa = st.get(a), sb = st.get(b); return ((sb.forced > clock) - (sa.forced > clock)) || (sa.dist - sb.dist); });
      if (cand.length > MAX_ON) cand.length = MAX_ON;
      // release pool slots whose owner is no longer shown
      for (const b of pool) if (b.owner && !cand.includes(b.owner)) { b.owner = null; if (b.shown) { b.shown = false; b.el.classList.remove("on"); } }
      let n = 0;
      for (const a of cand) {
        const s = st.get(a);
        let b = null; for (const q of pool) if (q.owner === a) { b = q; break; }
        if (!b) for (const q of pool) if (!q.owner) { b = q; b.owner = a; break; }
        if (!b) break;
        if (b.text !== s.text) { b.text = s.text; b.tx.textContent = s.text; b.ic.textContent = ICON[s.kind] || "💭"; b.el.dataset.kind = s.kind; }
        head(a, P); V.copy(P).project(camera);
        const m = phone ? 72 : 96;                               // keep the bubble on screen; the tail still points down
        const x = Math.min(W - m, Math.max(m, (V.x * 0.5 + 0.5) * W)), y = (-V.y * 0.5 + 0.5) * H;
        if (!isFree(x, y)) { if (b.shown) { b.shown = false; b.el.classList.remove("on"); } continue; }
        const age = clock - s.t0, left = s.until - clock;
        const k = phone ? Math.max(0.82, Math.min(1.0, 1.08 - s.dist * 0.1)) : Math.max(0.66, Math.min(1.08, 1.18 - s.dist * 0.16));
        const pop = age < 0.18 ? 0.6 + 0.4 * (age / 0.18) : 1;
        b.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) scale(${(k * pop).toFixed(3)})`;
        b.el.style.opacity = left < FADE ? (left / FADE).toFixed(2) : "1";
        if (!b.shown) { b.shown = true; b.el.classList.add("on"); }
        n++;
      }
      this.count = n;
    },
    debug() { const r = []; for (const a of G.agents) { const s = st.get(a); if (!s) continue; head(a, P); V.copy(P).project(camera); r.push({ i: a.index, d: +s.dist.toFixed(2), vis: s.vis, occ: !!s.occluded, live: s.until > clock, sx: Math.round((V.x * 0.5 + 0.5) * W), sy: Math.round((-V.y * 0.5 + 0.5) * H), free: isFree((V.x * 0.5 + 0.5) * W, (-V.y * 0.5 + 0.5) * H) }); } return r; },
    hideAll() { for (const b of pool) { b.owner = null; b.shown = false; b.el.classList.remove("on"); } },
    get bubbles() { return pool.filter(b => b.shown).map(b => b.text); },
  };
  return th;
}
