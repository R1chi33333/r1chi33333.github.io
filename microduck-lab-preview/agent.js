// agent.js — one Microduck in the flock: locomotion (walk / skates), beak grab-and-carry tasks, falls,
// sit / crouch / emotes, laser chasing, ball kicks, and the autonomous brain used when the player
// is not driving it (wander, follow-the-leader flocking, fetch toys, chase the laser, football, racing).
import * as THREE from "three";
import { GAIT } from "./duck.js";
import { voiceParams } from "./voice.js";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (cur, target, rate) => cur + clamp(target - cur, -rate, rate);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const SKATE = { accel: 0.42, maxSpeed: 0.42, friction: 0.32, brake: 0.9, grip: 2.4, turn: 2.0, strokeHz: 1.25 };

export class Agent {
  /**
   * @param G shared game context { world, phys, voice, scene, agents, laser, ball, football, race, toast, pulse, rng, now() }
   */
  constructor(G, { duck, rig, serial, skin, index }) {
    this.G = G; this.duck = duck; this.rig = rig; this.index = index;
    this.serial = serial; this.voice = voiceParams(serial); this.skin = skin || "cream";
    this.body = G.phys.addDuck();
    this.pos = V(); this.yaw = 0; this.v = 0; this.w = 0; this.vel = V(); this.sv = V();
    this.cmd = { v: 0, w: 0 }; this.filtered = { v: 0, w: 0, kind: null };
    this.task = null; this.held = null; this.beakOpen = false; this.fall = null;
    this.skates = null; this.pounce = null; this.lastKick = -9; this.stuckT = 0;
    this.controlled = false; this.lod = 0; this.lodTick = 0; this.team = index % 2;
    this.brain = { state: "idle", t: 0, dur: 1 + index * 0.37, target: null };
    this.rand = mulberry(0x9E3779B1 ^ (index * 7919 + 13));
    this.memory = { fetched: {}, falls: 0, knocks: 0, refusals: 0, kicks: 0, goals: 0, notes: [] };
    duck.onGotUp = () => this._gotUp();
  }

  get fwd() { return V(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }
  chirp(kind, force = false) {
    const G = this.G;
    if (!force && !this.controlled) {
      const cam = G.camera.position; if (cam.distanceTo(this.pos) > 1.6 || this.rand() > 0.6) return;
    }
    G.voice.play(kind, { params: this.voice, force: force || this.controlled });
  }

  teleport(p, yaw) {
    this.pos.copy(p); this.yaw = yaw; this.v = this.w = 0; this.vel.set(0, 0, 0); this.sv.set(0, 0, 0);
    this.fall = null; this.pounce = null; this.duck.hop = 0;
    this.duck.teleport(this.pos, yaw); this.body.setCharPosition(this.pos);
    this.duck.root.updateMatrixWorld(true); this.body.sync(this.duck); this.body.snap();
  }
  remove() {
    this.releaseHeld(); this.unequipSkates();
    this.G.scene.remove(this.duck.root); if (this.rig.fxGroup.parent) this.rig.fxGroup.parent.remove(this.rig.fxGroup);
    this.body.remove();
  }

  // ------------------------------------------------------------------ skates
  equipSkates(skates) {
    if (this.skates) return false;
    this.skates = skates;
    for (const [side, g] of [["left", skates.left], ["right", skates.right]]) {
      const leg = this.duck.legs[side];
      // deck forward (+X) along the foot, deck up along the foot's up
      const x = leg.fLocal.clone().normalize(), y = leg.uLocal.clone().normalize(), z = V().crossVectors(x, y).normalize();
      y.crossVectors(z, x).normalize();
      g.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
      g.position.copy(leg.soleNode.position);
      g.scale.setScalar(1);
      leg.ankleNode.add(g); g.visible = true;
    }
    this.duck.skating = true; this.duck.skateLift = skates.height;
    this.sv.copy(this.fwd).multiplyScalar(this.v);
    this.chirp("happy", this.controlled);
    return true;
  }
  unequipSkates() {
    const s = this.skates; if (!s) return null;
    s.left.parent && s.left.parent.remove(s.left); s.right.parent && s.right.parent.remove(s.right);
    this.skates = null; this.duck.skating = false; this.v = clamp(this.sv.dot(this.fwd), -0.1, 0.16);
    return s;
  }

  // ------------------------------------------------------------------ beak
  gripPoint(p, from) {
    const o = p.object; o.updateWorldMatrix(true, false);
    const ex = p.spec.shapeExact;
    if (ex && ex.type === "torus") {
      const R = ex.majorRadius; let best = null, bd = 1e9;
      for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; const w = V(Math.cos(a) * R, Math.sin(a) * R, 0).applyMatrix4(o.matrixWorld); const d = w.distanceToSquared(from); if (d < bd) { bd = d; best = w; } }
      return best;
    }
    if (p.id === "toy_duck" && !p.spec.shape?.offset && p.spec.shape?.type === "compound") return V(0.009, 0.026, 0).applyMatrix4(o.matrixWorld);
    const s = p.spec.shape || {};
    if (s.type === "compound" && s.parts && s.parts.length > 1) return V(...(s.parts[1].offset || [0, 0, 0])).applyMatrix4(o.matrixWorld);
    return V(...(s.offset || [0, 0, 0])).applyMatrix4(o.matrixWorld);
  }
  gripWidth(p) { return (p.spec.grip && p.spec.grip.width) || 0.015; }
  graspable(p) { return p.spec.graspable !== false && !!p.spec.grip && !p.held; }
  propBetweenTips() {
    const d = this.duck; const U = d.markers.upper.getWorldPosition(V()), L = d.markers.lower.getWorldPosition(V());
    const seg = L.clone().sub(U); const len2 = Math.max(seg.lengthSq(), 1e-8);
    let best = null, bd = 1e9;
    for (const p of this.G.phys.props) {
      if (!this.graspable(p)) continue;
      if (p.object.position.distanceToSquared(U) > 0.02) continue;
      const g = this.gripPoint(p, U.clone().lerp(L, 0.5));
      const t = clamp(g.clone().sub(U).dot(seg) / len2, 0, 1);
      const dd = U.clone().addScaledVector(seg, t).distanceTo(g);
      if (dd < this.gripWidth(p) * 0.5 + 0.014 && dd < bd) { bd = dd; best = p; }
    }
    return best;
  }
  attach(p) {
    const G = this.G; G.phys.hold(p);
    const head = this.duck.headNode; head.updateWorldMatrix(true, false);
    const inv = head.matrixWorld.clone().invert();
    const local = inv.clone().multiply(p.object.matrixWorld);
    const gap = this.duck.beakGap(V()).applyMatrix4(inv);
    const g = this.gripPoint(p, this.duck.beakGap(V())).applyMatrix4(inv);
    this.held = { prop: p, local, settle: gap.sub(g), settleT: 0, prevPos: p.object.position.clone() };
    p.holder = this;
    this.duck.jawStop = 0;
    this.memory.fetched[p.kind] = (this.memory.fetched[p.kind] || 0) + 1;
    this.chirp("happy"); this.duck.happyWiggle = 1;
  }
  releaseHeld() {
    if (!this.held) return;
    const p = this.held.prop; const vel = p.object.position.clone().sub(this.held.prevPos).multiplyScalar(60).clampLength(0, 0.25);
    this.G.phys.release(p, vel); p.holder = null; this.held = null; this.duck.jawStop = 0;
  }
  _updateHeld(dt) {
    const h = this.held; if (!h) return;
    if (!this.G.phys.props.includes(h.prop)) { this.held = null; return; }
    const head = this.duck.headNode; head.updateWorldMatrix(true, false);
    h.settleT = Math.min(1, h.settleT + dt / 0.25);
    const local = h.local.clone(); const off = h.settle.clone().multiplyScalar(h.settleT);
    local.premultiply(new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
    const wm = head.matrixWorld.clone().multiply(local);
    const pos = V(), quat = new THREE.Quaternion(), sc = V(); wm.decompose(pos, quat, sc);
    h.prevPos.copy(h.prop.object.position);
    this.G.phys.setHeldPose(h.prop, pos, quat);
    const d = this.duck;
    if (d.jaw > 0.02 && d.beakOpening() <= this.gripWidth(h.prop) + 0.0015 && d.jawStop === 0) d.jawStop = d.jaw;
  }

  // ------------------------------------------------------------------ tasks
  steer(target, face = null, tol = 0.015, speed = GAIT.maxSpeed) {
    const dx = target.x - this.pos.x, dz = target.z - this.pos.z, dist = Math.hypot(dx, dz);
    const lookAt = face || target;
    const desired = dist > tol ? Math.atan2(dx, dz) : Math.atan2(lookAt.x - this.pos.x, lookAt.z - this.pos.z);
    const err = wrap(desired - this.yaw);
    const w = clamp(err * 4.5, -GAIT.maxYawRate, GAIT.maxYawRate);
    const v = dist > tol ? speed * clamp(1 - Math.abs(err) / 0.9, 0, 1) * clamp(dist / 0.12, 0.25, 1) : 0;
    return { v, w, dist, err };
  }
  startGo(point) { this.task = { kind: "go", target: point.clone(), t: 0 }; }
  startGrab(p, then = null) { this.task = { kind: "grab", prop: p, phase: "approach", t: 0, then }; this.duck.look.target = null; }
  startFetch(p, home) { if (this.held) { this.startDrop(); return; } this.startGrab(p, { kind: "return", home: (home || this.pos).clone() }); this.task.fetch = true; }
  startDrop(then = null) { if (!this.held) return; this.task = { kind: "drop", phase: "lower", t: 0, then }; }
  nearestGraspable(maxDist = 0.42, cone = 1.4) {
    const f = this.fwd; let best = null, bs = 1e9;
    for (const p of this.G.phys.props) {
      if (!this.graspable(p) || p.holder || !this._outside(p.object.position, 0.05)) continue;
      const d = p.object.position.clone().sub(this.pos); const dy = d.y; d.y = 0; const L = d.length();
      if (L > maxDist || Math.abs(dy) > 0.05) continue;
      const ang = Math.acos(clamp(d.normalize().dot(f), -1, 1));
      const score = L + ang * 0.12;
      if (ang < cone && score < bs) { bs = score; best = p; }
    }
    return best;
  }
  cancelTask() { this.task = null; this.duck.reach.weight = 0; this.duck.look.target = null; }

  _runTask(dt) {
    const T = this.task; if (!T) return null;
    T.t += dt; const duck = this.duck, W = this.G.world;
    if (T.kind === "go") {
      const s = this.steer(T.target);
      if (s.dist < 0.02 || T.t > 20) { this.task = null; if (s.dist < 0.03) { this.chirp("happy"); this.G.events?.arrived?.(this); } }
      return { v: s.v, w: s.w };
    }
    if (T.kind === "peck") {
      duck.reach.target = this.pos.clone().addScaledVector(this.fwd, 0.1).setY(this.pos.y + 0.03); duck.reach.weight = T.t < 0.55 ? 0.6 : 0;
      if (T.t > 1.2) { this.task = null; duck.reach.weight = 0; }
      return { v: 0, w: 0 };
    }
    if (T.kind === "grab") {
      const p = T.prop, P = p.object.position;
      if (!this.G.phys.props.includes(p) || P.y < this.pos.y - 0.2 || (p.holder && p.holder !== this)) { this.cancelTask(); return { v: 0, w: 0 }; }
      if (T.phase === "approach") {
        const g = this.gripPoint(p, this.pos.clone().setY(this.pos.y + 0.03));
        const dir = V(g.x - this.pos.x, 0, g.z - this.pos.z); const L = dir.length(); dir.normalize();
        const standoff = 0.088;
        const stand = V(g.x - dir.x * standoff, 0, g.z - dir.z * standoff);
        const s = this.steer(L < standoff + 0.03 ? this.pos.clone().addScaledVector(dir, L - standoff) : stand, g, 0.01);
        duck.look.target = g; duck.look.weight = 1;
        if ((Math.abs(L - standoff) < 0.018 && Math.abs(s.err) < 0.12) || T.t > 9) { T.phase = "reach"; T.t = 0; this.beakOpen = true; duck.look.target = null; }
        if (T.t > 9 && Math.abs(L - standoff) > 0.05) { this.cancelTask(); this.G.events?.grabFailed?.(this, "far"); }
        return { v: s.v, w: s.w };
      }
      if (T.phase === "reach") {
        const g = this.gripPoint(p, duck.beakGap(V()));
        duck.reach.target = g.clone().setY(Math.max(g.y, this.pos.y + 0.017)); duck.reach.weight = 1; this.beakOpen = true;
        if ((duck.reach.w > 0.9 && (duck.reach.err ?? 1) < 0.014) || T.t > 1.8) { T.phase = "close"; T.t = 0; this.beakOpen = false; }
        return { v: 0, w: 0 };
      }
      if (T.phase === "close") {
        this.beakOpen = false;
        if (this.held) { T.phase = "lift"; T.t = 0; } else if (T.t > 0.6) { T.phase = "lift"; T.t = 0; T.missed = true; }
        return { v: 0, w: 0 };
      }
      if (T.phase === "lift") {
        duck.reach.weight = 0; duck.look.target = null;
        if (T.t > 0.55) {
          if (T.missed) { this.task = null; this.G.events?.grabFailed?.(this, "missed"); this.chirp("sad"); return { v: 0, w: 0 }; }
          if (T.then && T.then.kind === "return") { this.task = { kind: "return", home: T.then.home, t: 0, prop: p }; return { v: 0, w: 0 }; }
          this.task = null;
        }
        return { v: 0, w: 0 };
      }
    }
    if (T.kind === "return") {
      const s = this.steer(T.home, null, 0.03);
      if (s.dist < 0.035 || T.t > 20) this.startDrop({ kind: "fetched", prop: T.prop });
      return { v: s.v, w: s.w };
    }
    if (T.kind === "drop") {
      const f = this.fwd;
      if (T.phase === "lower") {
        const gy = W.groundHeightAt(this.pos.x + f.x * 0.09, this.pos.z + f.z * 0.09, this.pos.y + 0.03);
        const gyy = Math.abs(gy - this.pos.y) < 0.05 ? gy : this.pos.y;
        duck.reach.target = this.pos.clone().addScaledVector(f, 0.092).setY(gyy + 0.026); duck.reach.weight = 1;
        if (duck.reach.w > 0.85 || T.t > 1.4) { T.phase = "open"; T.t = 0; this.beakOpen = true; this.releaseHeld(); }
      } else if (T.phase === "open") { if (T.t > 0.3) { T.phase = "up"; T.t = 0; duck.reach.weight = 0; } }
      else if (T.phase === "up") {
        if (T.t > 0.3) this.beakOpen = false;
        if (T.t > 0.6) { this.task = null; if (T.then && T.then.kind === "fetched") { this.chirp("happy"); duck.happyWiggle = 1.2; this.G.events?.fetched?.(this, T.then.prop); } }
      }
      return { v: 0, w: 0 };
    }
    return null;
  }

  // ------------------------------------------------------------------ moves
  setSit(on) { if (this.fall) return; this.duck.sitTarget = on; if (on) { this.duck.crouchTarget = false; this.cancelTask(); } this.chirp(on ? "curious" : "hello"); }
  setCrouch(on) { if (this.fall) return; this.duck.crouchTarget = on; if (on) this.duck.sitTarget = false; }
  emote(kind) {
    if (this.fall) return;
    this.duck.playEmote(kind);
    this.chirp({ nod: "hello", shake: "sad", dance: "happy", look: "curious" }[kind] || "curious", this.controlled);
  }
  get sitting() { return this.duck.sitTarget; }

  // ------------------------------------------------------------------ falls
  poke(dir) {
    if (this.fall) return;
    const d = V(dir.x, 0, dir.z).normalize();
    this.releaseHeld(); this.cancelTask(); this.duck.sitTarget = false;
    this.fall = { kind: "tip", t: 0 }; this.duck.startTip(d);
    this.memory.knocks++; this.chirp("startled", this.controlled);
  }
  tipOver(dir, reason) {
    if (this.fall) return;
    this.releaseHeld(); this.cancelTask();
    this.fall = { kind: "tip", t: 0, reason }; this.duck.startTip(dir);
    this.sv.multiplyScalar(0.2); this.v = 0;
    this.chirp("startled", this.controlled);
  }
  _startEdgeFall() {
    const dir = this.vel.clone().setY(0); if (dir.lengthSq() < 1e-6) dir.copy(this.fwd);
    dir.normalize();
    this.releaseHeld(); this.cancelTask();
    this.fall = { kind: "edge", t: 0, vel: dir.clone().multiplyScalar(Math.max(0.14, this.vel.length())), y: this.pos.y };
    this.duck.startTumble(dir);
    this.memory.falls++;
    this.chirp("startled", true);
    this.v = this.w = 0; this.sv.set(0, 0, 0);
    this.G.events?.edgeFall?.(this);
  }
  _gotUp() {
    if (!this.fall) return;
    if (this.fall.kind === "floor") {
      // landed somewhere it can't walk (the void below the arena): put it back
      if (this.G.world.isOverDrop(this.pos.x, this.pos.z, this.pos.y + 0.02)) { this.fall.kind = "rescue"; this.fall.t = 0; return; }
      this.pos.y = this.G.world.groundHeightAt(this.pos.x, this.pos.z, this.pos.y + 0.02); this.body.setCharPosition(this.pos);
    }
    this.fall = null; this.chirp("curious");
  }

  // ------------------------------------------------------------------ safety reflex (cheap version for the flock)
  safe(cmd, dt) {
    const W = this.G.world;
    if (Math.abs(cmd.v) < 1e-4) return { v: cmd.v, w: cmd.w, kind: null };
    const sgn = Math.sign(cmd.v);
    const f = this.fwd.multiplyScalar(sgn);
    let d = 0.5; for (let t = 0; t <= 0.5; t += 0.01) if (W.groundHeightAt(this.pos.x + f.x * t, this.pos.z + f.z * t, this.pos.y + 0.03) < this.pos.y - 0.03) { d = t; break; }
    const margin = 0.1 + (this.skates ? Math.abs(this.sv.length()) * 0.5 : 0);
    if (d < margin) return { v: d < margin - 0.03 ? -sgn * 0.05 : 0, w: cmd.w + (this.index % 2 ? 1.5 : -1.5), kind: "refuse" };
    if (d < margin + 0.12) return { v: cmd.v * clamp((d - margin) / 0.12, 0.25, 1), w: cmd.w, kind: "slow" };
    return { v: cmd.v, w: cmd.w, kind: null };
  }

  // ------------------------------------------------------------------ per-step simulation
  /**
   * cmdIn: {v, w} walk command (or {thrust, turn} on skates). filter(cmd) applies the safety reflex.
   */
  step(dt, cmdIn, filter) {
    const G = this.G, W = G.world, duck = this.duck;
    let cmd = cmdIn || { v: 0, w: 0 };
    // pounce on the laser dot
    if (this.pounce) {
      const P = this.pounce; P.t += dt; const u = P.t / 0.6;
      duck.crouchTarget = u < 0.35; duck.hop = u > 0.35 && u < 1 ? Math.sin(Math.PI * (u - 0.35) / 0.65) * 0.03 : 0;
      cmd = { v: u > 0.35 && u < 0.9 ? 0.26 : 0, w: 0 };
      if (u >= 1) { this.pounce = null; duck.hop = 0; duck.crouchTarget = false; duck.happyWiggle = 1; }
    }
    // sitting: moving stands it up
    if (duck.sitTarget && (Math.abs(cmd.v) > 0.02 || this.task)) duck.sitTarget = false;
    if (duck.sitW > 0.25 && !this.skates) cmd = { v: 0, w: duck.sitTarget ? 0 : cmd.w * 0.3 };
    this.cmd = cmd;
    const F = this.filtered = filter ? filter(cmd) : this.safe(cmd, dt);

    if (!this.fall) {
      const before = this.pos.clone();
      if (this.skates) this._skate(dt, F);
      else {
        const accel = Math.abs(F.v) > Math.abs(this.v) ? 0.55 : 1.0;
        this.v = approach(this.v, F.v, accel * dt);
        this.w = approach(this.w, F.w, 7 * dt);
        this.yaw = wrap(this.yaw + this.w * dt);
        const f = this.fwd;
        this.body.moveChar(V(f.x * this.v * dt, -0.004, f.z * this.v * dt));
      }
      this.body.charPosition(this.pos);
      this.vel.copy(this.pos).sub(before).divideScalar(dt); this.vel.y = 0;
      if (W.groundHeightAt(this.pos.x, this.pos.z, this.pos.y + 0.03) < this.pos.y - 0.06) this._startEdgeFall();
    }
    // falling / lying
    let yOverride;
    if (this.fall) {
      const f = this.fall; f.t += dt;
      if (f.kind === "edge") {
        f.vel.y -= 9.81 * dt; f.vel.x *= 0.995; f.vel.z *= 0.995;
        this.pos.x += f.vel.x * dt; this.pos.z += f.vel.z * dt; f.y += f.vel.y * dt;
        const floorY = W.groundHeightAt(this.pos.x, this.pos.z, f.y + 0.01);
        if (f.y <= floorY) { f.y = floorY; f.kind = "floor"; duck.landTumble(); duck.fall && (duck.fall.lieTime = 1.0); this.chirp("sad", true); }
        yOverride = f.y; this.pos.y = f.y;
      } else if (f.kind === "floor" || f.kind === "rescue") {
        yOverride = this.pos.y;
        if (f.kind === "rescue" && f.t > (G.rescueDelay ?? 1.4)) { G.events?.rescue?.(this); return; }
      }
      this.vel.set(0, 0, 0); this.v = 0; this.w = 0;
    }
    // jaw + grasp
    duck.jawTarget = this.beakOpen ? 0.6 : 0;
    if (!this.beakOpen && !this.held && duck.jaw > 0.05 && !this.fall) { const p = this.propBetweenTips(); if (p) this.attach(p); }
    if (this.held && this.beakOpen && duck.jaw > (duck.jawStop || 0) + 0.12) this.releaseHeld();
    if (!this.held) duck.jawStop = 0;
    // kick the ball by walking into it
    this._kick();
    // body (cheaper IK for far ducks)
    duck.iters = this.lod === 0 ? 3 : 1;
    this.lodTick++;
    const skip = this.lod >= 2 && !this.fall && (this.lodTick & 1);
    if (!skip) duck.update(this.lod >= 2 ? dt * 2 : dt, { pos: this.pos, yaw: this.yaw, vel: this.skates ? this.sv : this.vel, yawRate: this.fall ? 0 : this.w, yOverride });
    if (this.skates && !this.fall) this.skates.spin(this.sv.dot(this.fwd) * dt);
    this._updateHeld(dt);
    if (!this.fall) { duck.root.updateMatrixWorld(true); this.body.sync(duck); }
  }

  _skate(dt, F) {
    // F carries {v, w}; v>0 pushes, v<0 brakes. Momentum, drift and wobble.
    const S = SKATE, d = this.duck, W = this.G.world;
    const f = this.fwd;
    const pushing = F.v > 0.02;
    if (pushing) {
      d.stroke = (d.stroke + S.strokeHz * dt) % 1; if (d.stroke < S.strokeHz * dt) { d.strokeSide *= -1; }
      const phase = Math.max(0, Math.sin(d.stroke * Math.PI * 2));
      this.sv.addScaledVector(f, S.accel * (F.v / GAIT.maxSpeed) * (0.4 + phase) * dt);
    } else d.stroke = Math.max(0, d.stroke - dt);
    if (F.v < -0.01) this.sv.multiplyScalar(Math.exp(-S.brake * dt));
    this.sv.multiplyScalar(Math.exp(-S.friction * dt));
    // the refuse reflex brakes hard
    if (F.kind === "refuse") this.sv.multiplyScalar(Math.exp(-6 * dt));
    let sp = this.sv.length(); if (sp > S.maxSpeed) { this.sv.multiplyScalar(S.maxSpeed / sp); sp = S.maxSpeed; }
    // steer; the velocity only slowly follows the heading -> drift
    this.w = approach(this.w, F.w * (S.turn / GAIT.maxYawRate), 8 * dt);
    this.yaw = wrap(this.yaw + this.w * dt);
    const along = this.sv.dot(f);
    const target = f.clone().multiplyScalar(along >= 0 ? sp : -sp);
    this.sv.lerp(target, 1 - Math.exp(-S.grip * dt));
    // ramps pull it downhill
    const e = 0.03, yy = this.pos.y + 0.03, gx = (W.groundHeightAt(this.pos.x + e, this.pos.z, yy) - W.groundHeightAt(this.pos.x - e, this.pos.z, yy)) / (2 * e);
    const gz = (W.groundHeightAt(this.pos.x, this.pos.z + e, yy) - W.groundHeightAt(this.pos.x, this.pos.z - e, yy)) / (2 * e);
    const slope = Math.abs(gx) < 0.6 && Math.abs(gz) < 0.6 ? Math.hypot(gx, gz) : 0;
    if (slope > 0) { this.sv.x -= gx * 2.2 * dt; this.sv.z -= gz * 2.2 * dt; }
    this.body.moveChar(V(this.sv.x * dt, -0.004, this.sv.z * dt));
    // wobble: speed, slip and slope; too much and it falls over
    const slip = Math.abs(this.sv.clone().cross(f).y);
    const wob = clamp((sp - 0.28) / 0.14, 0, 1) * 0.7 + slip * 2.2 + slope * 2.5;
    d.wobble = lerp(d.wobble, clamp(wob, 0, 1.2), 1 - Math.exp(-3 * dt));
    if (d.wobble > 0.82 && this.rand() < dt * 2.2) this.tipOver(V().crossVectors(UP, f).multiplyScalar(this.rand() < 0.5 ? 1 : -1), "skates");
  }

  _kick() {
    const G = this.G; if (this.fall || !G.balls || !G.balls.length) return;
    const now = G.now();
    if (now - this.lastKick < 0.35) return;
    const f = this.fwd, speed = this.skates ? this.sv.length() : Math.abs(this.v);
    if (speed < 0.025) return;
    for (const b of G.balls) {
      if (b.held) continue;
      const c = b.object.position; const r = (b.spec.shape && b.spec.shape.radius) || 0.03;
      const front = this.pos.clone().addScaledVector(f, 0.05);
      const dx = c.x - front.x, dz = c.z - front.z;
      if (Math.hypot(dx, dz) < r + 0.035 && c.y < this.pos.y + 0.08) {
        const dir = V(dx, 0, dz).normalize().lerp(f, 0.6).normalize();
        const power = 0.0035 + speed * 0.05 + (this.kickBoost || 0);
        G.phys.impulse(b, dir.multiplyScalar(power).add(V(0, power * 0.25, 0)));
        this.lastKick = now; this.memory.kicks++; this.kickBoost = 0;
        if (this.controlled || this.rand() < 0.3) this.chirp("happy");
        G.events?.kick?.(this, b);
      }
    }
  }

  // ------------------------------------------------------------------ brain (autonomous ducks)
  think(dt) {
    const G = this.G, B = this.brain, W = G.world;
    if (this.fall) return { v: 0, w: 0 };
    if (this.task) return this._runTask(dt) || { v: 0, w: 0 };
    B.t += dt;
    // modes the whole room is playing take over
    if (G.race && G.race.active) return this._steerAvoid(G.race.targetFor(this), GAIT.maxSpeed * (G.world.race.speedBoost || 1) * (0.8 + 0.16 * ((this.index * 37) % 7) / 7), 0.03, G.race.frozen);
    if (G.football && G.football.active) return this._football(dt);
    if (G.laser.visible && G.laser.point.distanceTo(this.pos) < 0.8) return this._laser(dt);
    if (B.t > B.dur) this._pick();
    if (this._stage() && !this.held && !this._outside(this.pos)) return this._steerAvoid(this._keepOut(this.pos), GAIT.maxSpeed * 0.8, 0.02);
    switch (B.state) {
      case "follow": {
        const L = G.leader(); if (!L || L === this || G.customising) { this._pick("wander"); break; }
        // boids-style: stay behind the leader, keep spacing, match heading
        const slot = this.index % 5;
        const back = L.fwd.multiplyScalar(-0.22 - 0.13 * Math.floor(slot / 2));
        const side = V(L.fwd.z, 0, -L.fwd.x).multiplyScalar((slot % 2 ? 1 : -1) * (0.1 + 0.02 * slot));
        const goal = L.pos.clone().add(back).add(side);
        const d = goal.distanceTo(this.pos);
        if (d < 0.04 && Math.abs(L.v) < 0.02) { const e = wrap(L.yaw - this.yaw); return { v: 0, w: clamp(e * 3, -1.2, 1.2) }; }
        return this._steerAvoid(goal, GAIT.maxSpeed * clamp(d / 0.25, 0.4, 1), 0.03);
      }
      case "wander": {
        if (!B.target || B.target.distanceTo(this.pos) < 0.04) { if (B.target) { B.state = "idle"; B.t = 0; B.dur = 1 + this.rand() * 2; if (this.rand() < 0.3) this.emote(["look", "nod", "dance"][Math.floor(this.rand() * 3)]); break; } B.target = W.randomSpot(this.pos, 0.45, this.rand); }
        return this._steerAvoid(B.target, GAIT.maxSpeed * 0.7, 0.03);
      }
      case "toy": {
        if (this.held) { if (B.t > 4) this.startDrop(); return { v: 0, w: 0 }; }
        if (!B.target) {
          let best = null, bd = 0.7;
          for (const p of G.phys.props) { if (!this.graspable(p) || p.holder) continue; const d = p.object.position.distanceTo(this.pos); if (d < bd && Math.abs(p.object.position.y - this.pos.y) < 0.04) { bd = d; best = p; } }
          if (!best) { this._pick("wander"); break; }
          B.target = best; this.startGrab(best);
          return { v: 0, w: 0 };
        }
        if (!this.held && B.t > 12) this._pick("wander");
        break;
      }
      case "ball": {
        // dribble the nearest sock ball around
        let b = null, bd = 1.4; for (const x of G.balls || []) { if (!G.phys.props.includes(x) || x.held || !this._outside(x.object.position, 0.05)) continue; const d = x.object.position.distanceTo(this.pos); if (d < bd) { bd = d; b = x; } }
        if (!b) { this._pick("wander"); break; }
        if (!B.target || B.t > 3.5) { B.target = W.randomSpot(b.object.position, 0.5, this.rand); B.t = 0; }
        const bp = b.object.position, to = V(B.target.x - bp.x, 0, B.target.z - bp.z).normalize();
        const behind = V(bp.x, this.pos.y, bp.z).addScaledVector(to, -0.09);
        const d = Math.hypot(behind.x - this.pos.x, behind.z - this.pos.z);
        if (d < 0.04) return this._steerAvoid(V(bp.x, this.pos.y, bp.z).addScaledVector(to, 0.1), GAIT.maxSpeed, 0.01);
        return this._steerAvoid(behind, GAIT.maxSpeed * 0.85, 0.02);
      }
      case "sit": if (!this.duck.sitTarget && B.t < 0.2) this.setSit(true); if (B.t > B.dur - 0.5) this.duck.sitTarget = false; return { v: 0, w: 0 };
      case "idle": default: return { v: 0, w: 0 };
    }
    return { v: 0, w: 0 };
  }
  /** while the customise stage is up, keep points (targets, balls, toys) out of a circle around the turntable */
  _stage() { const G = this.G; return G.customising && G.stage ? G.stage : null; }
  _outside(p, pad = 0) {
    const S = this._stage(); if (!S) return true;
    return Math.hypot(p.x - S.x, p.z - S.z) >= S.r + pad;
  }
  _keepOut(p) {
    const S = this._stage(); if (!p || !S) return p;
    let dx = p.x - S.x, dz = p.z - S.z; const d = Math.hypot(dx, dz);
    if (d >= S.r) return p;
    if (d < 1e-4) { dx = this.pos.x - S.x; dz = this.pos.z - S.z; }
    const L = Math.hypot(dx, dz) || 1, R = S.r * 1.08;
    return V(S.x + dx / L * R, p.y, S.z + dz / L * R);
  }
  _pick(force) {
    const B = this.brain, r = this.rand();
    B.t = 0; B.target = null; this.duck.sitTarget = false;
    B.state = force || (r < 0.42 ? (this.G.customising ? "ball" : "follow") : r < 0.66 ? "wander" : r < 0.8 ? "toy" : r < 0.9 ? "sit" : "idle");
    B.dur = { ball: 9 + this.rand() * 6, follow: 8 + this.rand() * 8, wander: 7 + this.rand() * 6, toy: 14, sit: 3 + this.rand() * 3, idle: 1.5 + this.rand() * 2 }[B.state];
    if (B.state === "idle" && this.rand() < 0.5) this.emote(["nod", "look", "dance", "shake"][Math.floor(this.rand() * 4)]);
  }
  /** steer to a goal with separation from the other ducks and a whisker probe for obstacles */
  _steerAvoid(goal, speed, tol = 0.02, frozen = false) {
    if (!goal) return { v: 0, w: 0 };
    if (frozen) { const e = wrap(Math.atan2(goal.x - this.pos.x, goal.z - this.pos.z) - this.yaw); return { v: 0, w: clamp(e * 3, -1.5, 1.5) }; }
    const G = this.G, W = G.world;
    goal = this._keepOut(goal);
    const to = V(goal.x - this.pos.x, 0, goal.z - this.pos.z); const dist = to.length();
    if (dist < tol) return { v: 0, w: 0 };
    to.normalize();
    const sep = V();
    for (const o of G.agents) { if (o === this) continue; const d = V(this.pos.x - o.pos.x, 0, this.pos.z - o.pos.z); const L = d.length(); if (L < 0.19 && L > 1e-4) sep.addScaledVector(d.normalize(), (0.19 - L) / 0.19); }
    const S = this._stage();
    if (S) { const d = V(this.pos.x - S.x, 0, this.pos.z - S.z), L = d.length(), edge = S.r + 0.12; if (L < edge && L > 1e-4) sep.addScaledVector(d.normalize(), 1.5 * (edge - L) / 0.12); }
    const dir = to.clone().addScaledVector(sep, 1.6);
    // whiskers: if the way ahead climbs too high or drops away, bend around it
    for (const a of [0, 0.5, -0.5]) {
      const pr = dir.clone().normalize().applyAxisAngle(UP, a);
      const px = this.pos.x + pr.x * 0.12, pz = this.pos.z + pr.z * 0.12, gy = W.groundHeightAt(px, pz, this.pos.y + 0.06);
      if (a === 0 && (gy > this.pos.y + 0.03 || gy < this.pos.y - 0.03)) { dir.applyAxisAngle(UP, this.index % 2 ? 0.9 : -0.9); break; }
    }
    const desired = Math.atan2(dir.x, dir.z), err = wrap(desired - this.yaw);
    const w = clamp(err * 4, -GAIT.maxYawRate, GAIT.maxYawRate);
    let v = speed * clamp(1 - Math.abs(err) / 1.1, 0, 1) * clamp(dist / 0.1, 0.3, 1);
    // unstick
    if (v > 0.05 && Math.hypot(this.vel.x, this.vel.z) < 0.01) { this.stuckT += 1 / 60; if (this.stuckT > 1.2) { this.stuckT = 0; this.brain.target = W.randomSpot(this.pos, 0.3, this.rand); } } else this.stuckT = 0;
    if (this.skates) return { v: v > 0.02 ? GAIT.maxSpeed * 0.6 : -0.05, w };
    return { v, w };
  }
  _laser(dt) {
    const G = this.G, P = G.laser.point;
    const d = Math.hypot(P.x - this.pos.x, P.z - this.pos.z);
    if (!this.pounce && d < 0.13 && G.now() - (this.lastPounce || -9) > 2.2) { this.pounce = { t: 0 }; this.lastPounce = G.now(); this.chirp("happy"); return { v: 0, w: 0 }; }
    // gather in a ring around the dot instead of piling onto it
    const ang = this.index * 2.39996, ring = V(P.x + Math.cos(ang) * 0.11, P.y, P.z + Math.sin(ang) * 0.11);
    const s = d < 0.16 ? this.steer(ring, P, 0.02) : this._steerAvoid(ring, GAIT.maxSpeed, 0.03);
    this.duck.look.target = P; this.duck.look.weight = 0.8;
    return s;
  }
  _football(dt) {
    const G = this.G, FB = G.football, ball = FB.ball; if (!ball) return { v: 0, w: 0 };
    const goal = FB.goalCenter(1 - this.team);   // attack the other team's goal
    const b = ball.object.position;
    const toGoal = V(goal.x - b.x, 0, goal.z - b.z).normalize();
    const behind = V(b.x, 0, b.z).addScaledVector(toGoal, -0.09);
    const d = Math.hypot(behind.x - this.pos.x, behind.z - this.pos.z);
    // only the closest two of each team chase; the rest hang back in position
    if (!FB.isChaser(this)) return this._steerAvoid(FB.homeSpot(this), GAIT.maxSpeed * 0.6, 0.04);
    if (d < 0.04) { this.kickBoost = 0.004; return this._steerAvoid(V(b.x, 0, b.z).addScaledVector(toGoal, 0.1), GAIT.maxSpeed, 0.01); }
    return this._steerAvoid(behind, GAIT.maxSpeed, 0.02);
  }
}
