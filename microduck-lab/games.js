// games.js — the two little games the flock can play: sock-ball football (goals + score) and a
// checkpoint race (countdown, laps, lap timer, AI ducks racing you).
import * as THREE from "three";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const TEAM_COL = ["#FF9F0A", "#64D2FF"];

function glowMat(col, op = 1) {
  return new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(1.6), transparent: true, opacity: op, depthWrite: false, blending: THREE.AdditiveBlending });
}

// ================================================================ football
export class Football {
  constructor(G) { this.G = G; this.active = false; this.score = [0, 0]; this.group = null; this.statics = []; this.ball = null; this.cool = 0; }
  get layout() { return this.G.world.football; }
  goalCenter(i) {
    const L = this.layout;
    if (L.builtIn) return V(...L.goals[i].position);
    const c = V(...L.center);
    const s = i === 0 ? -1 : 1;
    return L.axis === "x" ? c.add(V(s * L.half, 0, 0)) : c.add(V(0, 0, s * L.half));
  }
  start(ball) {
    if (this.active) return;
    const G = this.G, L = this.layout; this.active = true; this.score = [0, 0]; this.cool = 0;
    this.group = new THREE.Group(); this.group.name = "football"; G.scene.add(this.group);
    if (L.builtIn) { this._finishStart(ball); return; }
    const postMat = new THREE.MeshPhysicalMaterial({ color: "#F4F4F2", roughness: 0.35, clearcoat: 0.5 });
    const netMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
    const r = 0.0035, W = L.goalWidth, H = L.goalHeight, D = L.goalDepth;
    for (let i = 0; i < 2; i++) {
      const c = this.goalCenter(i), g = new THREE.Group(); g.position.copy(c);
      const out = i === 0 ? -1 : 1; // the goal mouth faces the pitch centre
      if (L.axis === "x") g.rotation.y = Math.PI / 2 * out; else g.rotation.y = out > 0 ? 0 : Math.PI;
      const post = new THREE.CylinderGeometry(r, r, H, 12);
      for (const sx of [-1, 1]) { const m = new THREE.Mesh(post, postMat); m.position.set(sx * W / 2, H / 2, 0); m.castShadow = true; g.add(m); }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(r, r, W, 12).rotateZ(Math.PI / 2), postMat); bar.position.set(0, H, 0); bar.castShadow = true; g.add(bar);
      const back = new THREE.Mesh(new THREE.PlaneGeometry(W, H), netMat); back.position.set(0, H / 2, D); g.add(back);
      for (const sx of [-1, 1]) { const sd = new THREE.Mesh(new THREE.PlaneGeometry(D, H), netMat); sd.rotation.y = Math.PI / 2; sd.position.set(sx * W / 2, H / 2, D / 2); g.add(sd); }
      const top = new THREE.Mesh(new THREE.PlaneGeometry(W, D), netMat); top.rotation.x = Math.PI / 2; top.position.set(0, H, D / 2); g.add(top);
      // coloured goal line
      const line = new THREE.Mesh(new THREE.PlaneGeometry(W, 0.004), glowMat(TEAM_COL[i], 0.8)); line.rotation.x = -Math.PI / 2; line.position.set(0, 0.0012, 0); g.add(line);
      g.traverse(o => { o.userData.lookNoContact = true; });
      this.group.add(g);
      // physics: posts, crossbar and the back net stop the ball
      g.updateMatrixWorld(true);
      const q = g.quaternion.toArray();
      const add = (local, he) => { const p = local.clone().applyMatrix4(g.matrixWorld); this.statics.push(G.phys.addStatic({ type: "cuboid", halfExtents: he, position: p.toArray(), rotation: q })); };
      add(V(-W / 2, H / 2, 0), [r, H / 2, r]); add(V(W / 2, H / 2, 0), [r, H / 2, r]);
      add(V(0, H, D / 2), [W / 2, 0.002, D / 2]); add(V(0, H / 2, D), [W / 2, H / 2, 0.002]);
      add(V(-W / 2, H / 2, D / 2), [0.002, H / 2, D / 2]); add(V(W / 2, H / 2, D / 2), [0.002, H / 2, D / 2]);
    }
    this._finishStart(ball);
  }
  _finishStart(ball) {
    const G = this.G, L = this.layout;
    // centre spot
    const spot = new THREE.Mesh(new THREE.RingGeometry(0.03, 0.034, 48), glowMat("#ffffff", 0.35)); spot.rotation.x = -Math.PI / 2; spot.position.set(L.center[0], L.center[1] + 0.001, L.center[2]); spot.userData.lookNoContact = true; this.group.add(spot);
    this.ball = ball; this.resetBall();
    // teams: the player's duck is orange
    const ctl = G.controlled();
    G.agents.forEach((a, i) => { a.team = a === ctl ? 0 : (i % 2); });
    if (ctl) { let k = 0; G.agents.forEach(a => { if (a !== ctl) a.team = (k++ % 2) ? 0 : 1; }); }
    G.hud.football(this.score);
  }
  stop() {
    if (!this.active) return;
    this.active = false; const G = this.G;
    G.scene.remove(this.group); this.group = null;
    for (const b of this.statics) G.phys.removeStatic(b); this.statics = [];
    G.hud.hide();
  }
  resetBall() {
    if (!this.ball) return;
    const c = V(...(this.layout.ballSpawn || this.layout.center)); c.y += 0.002;
    this.G.phys.place(this.ball, c, new THREE.Quaternion());
  }
  isChaser(agent) {
    if (!this.ball) return false;
    const b = this.ball.object.position;
    const mates = this.G.agents.filter(a => a.team === agent.team && !a.controlled && !a.fall).sort((x, y) => x.pos.distanceTo(b) - y.pos.distanceTo(b));
    return mates.indexOf(agent) < 2;
  }
  homeSpot(agent) {
    const own = this.goalCenter(agent.team), mid = V(...this.layout.center);
    const p = own.clone().lerp(mid, 0.45);
    const lat = ((agent.index % 3) - 1) * 0.12;
    if (this.layout.axis === "x") p.z += lat; else p.x += lat;
    return p;
  }
  _goal(team) {
    const G = this.G;
    this.score[team]++; this.cool = 2.0;
    G.hud.football(this.score, team);
    G.events?.goal?.(team, this.score);
    for (const a of G.agents) if (a.team === team) a.emote("dance");
  }
  update(dt) {
    if (!this.active || !this.ball) return;
    const G = this.G, L = this.layout, b = this.ball.object.position;
    if (!G.phys.props.includes(this.ball)) { this.stop(); return; }
    if (this.cool > 0) { this.cool -= dt; if (this.cool <= 0) this.resetBall(); return; }
    if (L.builtIn) {
      for (let i = 0; i < 2; i++) {
        const sb = L.goals[i].scoreBox;
        if (b.x > sb.min[0] && b.x < sb.max[0] && b.z > sb.min[2] && b.z < sb.max[2] && b.y < sb.max[1]) { this._goal(1 - i); return; }
      }
      const c = V(...L.center);
      if (b.y < c.y - 0.1 || Math.abs(b.x - c.x) > 1.6 || Math.abs(b.z - c.z) > L.half + 0.5) this.cool = 0.8;
      return;
    }
    const c = V(...L.center);
    const along = L.axis === "x" ? b.x - c.x : b.z - c.z, across = L.axis === "x" ? b.z - c.z : b.x - c.x;
    if (Math.abs(along) > L.half + 0.005 && Math.abs(across) < L.goalWidth / 2 && b.y < c.y + L.goalHeight) {
      this._goal(along < 0 ? 1 : 0); return;
    }
    // out of play: off the pitch area, fell, or carried away
    if (b.y < c.y - 0.1 || Math.abs(across) > 0.6 || Math.abs(along) > L.half + 0.25) { this.cool = 0.8; }
  }
}

// ================================================================ race
export class Race {
  constructor(G) { this.G = G; this.active = false; this.frozen = false; this.group = null; this.prog = new Map(); }
  get cps() {
    if (this._cps) return this._cps;
    const R = this.G.world.race, raw = R.checkpoints.map(p => V(...p));
    if (!R.builtIn) return (this._cps = raw);
    // the room's checkpoints are cones: aim beside them, on the outside of the loop
    const c = raw.reduce((a, p) => a.add(p), V()).multiplyScalar(1 / raw.length);
    return (this._cps = raw.map((p, i) => i === 0 ? p : p.clone().add(V(p.x - c.x, 0, p.z - c.z).normalize().multiplyScalar(0.16))));
  }
  start() {
    const G = this.G; if (this.active) this.stop();
    this.active = true; this.frozen = true; this.countdown = 3.6; this.t = 0; this.finishOrder = [];
    this.laps = this.G.world.race.laps || 2;
    this.group = new THREE.Group(); this.group.name = "race"; G.scene.add(this.group);
    const cps = this.cps; this.gates = [];
    cps.forEach((p, i) => {
      const g = new THREE.Group(); g.position.copy(p);
      const nxt = cps[(i + 1) % cps.length], prv = cps[(i - 1 + cps.length) % cps.length];
      g.rotation.y = Math.atan2(nxt.x - prv.x, nxt.z - prv.z);
      const mat = glowMat(i === 0 ? "#30D158" : "#BF5AF2", 0.5);
      const R = this.G.world.race, rr = R.radius ? R.radius[i] * 0.55 : 0.075;
      if (!R.builtIn) { const ring = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.003, 8, 64, Math.PI), mat); g.add(ring); }  // arch over the track
      const pad = new THREE.Mesh(new THREE.RingGeometry(rr * 0.82, rr, 64), mat.clone()); pad.material.opacity = 0.25; pad.rotation.x = -Math.PI / 2; pad.position.y = 0.0012; g.add(pad);
      g.traverse(o => { o.userData.lookNoContact = true; o.raycast = () => {}; });
      this.group.add(g); this.gates.push({ g, mat, pad });
    });
    // grid: line the ducks up behind the first gate
    const c0 = cps[0], c1 = cps[1]; const sd = this.G.world.race.startDir; const dir = sd ? V(sd[0], 0, sd[2]).normalize() : V(c1.x - c0.x, 0, c1.z - c0.z).normalize(); const side = V(dir.z, 0, -dir.x);
    const yaw = Math.atan2(dir.x, dir.z);
    G.agents.forEach((a, i) => {
      a.cancelTask(); a.releaseHeld(); a.duck.sitTarget = false;
      const row = Math.floor(i / 2), col = i % 2 ? 1 : -1;
      const p = c0.clone().addScaledVector(dir, -0.12 - row * 0.24).addScaledVector(side, col * 0.12 + (row % 2 ? 0.05 : 0));
      p.y = G.world.groundHeightAt(p.x, p.z, c0.y + 0.05);
      a.teleport(p, yaw);
      this.prog.set(a, { next: 1, lap: 1, done: false, time: 0, best: null, lapStart: 0, dist: 0 });
    });
    G.hud.race(this);
  }
  stop() {
    if (!this.active) return;
    this.active = false; this.frozen = false; this.G.scene.remove(this.group); this.group = null; this.prog.clear(); this.G.hud.hide();
  }
  targetFor(a) { const P = this.prog.get(a); if (!P || P.done) return a.pos; return this.cps[P.next]; }
  standings() {
    const N = this.cps.length;
    return [...this.prog.entries()].map(([a, P]) => {
      const t = this.cps[P.next]; const d = Math.hypot(t.x - a.pos.x, t.z - a.pos.z);
      const score = P.done ? 1e6 - P.time : (P.lap - 1) * N * 10 + ((P.next - 1 + N) % N) * 10 - d;
      return { a, P, score };
    }).sort((x, y) => y.score - x.score);
  }
  update(dt) {
    if (!this.active) return;
    const G = this.G;
    if (this.frozen) {
      const before = Math.ceil(this.countdown); this.countdown -= dt; const after = Math.ceil(this.countdown);
      if (after !== before) G.events?.countdown?.(after);
      if (this.countdown <= 0.6) { this.frozen = false; this.t = 0; G.events?.countdown?.(0); }
      G.hud.race(this); return;
    }
    this.t += dt;
    const cps = this.cps, N = cps.length;
    for (const [a, P] of this.prog) {
      if (P.done) continue;
      P.time = this.t;
      const t = cps[P.next];
      const rad = this.G.world.race.radius ? this.G.world.race.radius[P.next] * 0.8 : 0.08;
      if (Math.hypot(t.x - a.pos.x, t.z - a.pos.z) < rad) {
        if (P.next === 0) {
          const lapT = this.t - P.lapStart; P.best = P.best == null ? lapT : Math.min(P.best, lapT); P.lapStart = this.t;
          if (P.lap >= this.laps) { P.done = true; this.finishOrder.push(a); G.events?.finish?.(a, this.finishOrder.length, this.t); continue; }
          P.lap++;
        }
        P.next = (P.next + 1) % N;
        if (a.controlled) a.chirp("happy", true);
      }
    }
    // highlight the controlled duck's next gate
    const ctl = G.controlled(), Pc = this.prog.get(ctl);
    this.gates.forEach((gt, i) => { const on = Pc && !Pc.done && i === Pc.next; gt.mat.opacity = on ? 0.95 : 0.28; gt.pad.material.opacity = on ? 0.5 : 0.12; gt.g.scale.setScalar(on ? 1 + 0.06 * Math.sin(this.t * 8) : 1); });
    G.hud.race(this);
    if (this.finishOrder.length >= Math.min(this.prog.size, 3) || (Pc && Pc.done && this.t - Pc.time > 3)) { if (!this.endAt) this.endAt = this.t + 3; }
    if (this.endAt && this.t > this.endAt) { this.endAt = null; this.stop(); G.events?.raceOver?.(); }
  }
}
