// duck.js — articulated Microduck body: joint posing from rig extras, 2-link leg IK with foot planting,
// procedural pigeon-toed gait, head stabilisation / look-at / beak reach (CCD), jaw, tip-over + get-up.
// Units metres, Y up, the duck faces +Z at yaw 0. forward(yaw) = (sin yaw, 0, cos yaw).
import * as THREE from "three";

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const _a = V(), _b = V(), _c = V(), _d = V(), _e = V(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
const smoother = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (cur, target, lambda, dt) => lerp(cur, target, 1 - Math.exp(-lambda * dt));

function projectOnPlane(v, n, out) { return out.copy(v).addScaledVector(n, -v.dot(n)); }
/** signed angle from a to b about axis n (both projected onto the plane ⊥ n) */
function signedAngle(a, b, n) {
  const ap = projectOnPlane(a, n, _d), bp = projectOnPlane(b, n, _e);
  const cx = _c.copy(ap).cross(bp);
  return Math.atan2(n.dot(cx), ap.dot(bp));
}

const LEGS = {
  left: { yaw: "body_yaw2roll", roll: "body_hip_l", pitch: "body_upper_leg_left", knee: "body_leg", ankle: "body_ankle_left", sole: "marker_left_foot", side: 1 },
  right: { yaw: "body_bearing_roll", roll: "body_hip_l_2", pitch: "body_upper_leg_right", knee: "body_leg_2", ankle: "body_ankle_right", sole: "marker_right_foot", side: -1 },
};

export const GAIT = {
  maxSpeed: 0.16,       // m/s
  maxYawRate: 2.2,      // rad/s
  swing: 0.4,           // fraction of the cycle each foot is in the air
  lift: 0.016,          // swing apex height
  footX: 0.045,         // lateral foot offset from centre line (bow-legged, a touch wider than stand)
  toeIn: 0.11,          // pigeon-toed foot yaw (rad)
  crouch: 0.006,        // walking height drop
};

export class DuckBody {
  /** @param model gltf.scene of microduck_rig.glb (already in the scene graph or not) */
  constructor(model, opts = {}) {
    this.ground = opts.ground || (() => 0);
    this.root = new THREE.Group(); this.root.name = "duck_root";
    this.tilt = new THREE.Group(); this.tilt.name = "duck_tilt"; this.root.add(this.tilt);
    this.model = model; this.tilt.add(model);
    this.nodes = {}; model.traverse(o => { if (o.name) this.nodes[o.name] = o; });
    const trunk = this.trunk = this.nodes.body_trunk;
    // centre the trunk origin over the root origin (xz)
    this.trunkBase = trunk.position.clone();
    model.position.set(-this.trunkBase.x, 0, -this.trunkBase.z);
    this.standHeight = this.trunkBase.y;

    // joints from GLB extras
    this.joints = {};
    model.traverse(o => {
      const x = o.userData;
      if (x && x.joint_type === "hinge" && x.zero_quat) {
        const zq = new THREE.Quaternion(x.zero_quat[0], x.zero_quat[1], x.zero_quat[2], x.zero_quat[3]);
        this.joints[x.joint] = { node: o, zq, axis: new THREE.Vector3().fromArray(x.axis).normalize(), stand: x.stand, range: x.range, theta: x.stand, name: x.joint };
      }
    });
    this.q = {}; for (const k in this.joints) this.q[k] = this.joints[k].stand;
    this.applyAll();
    this.root.updateMatrixWorld(true);

    // per-leg constants measured at stand
    this.legs = {};
    for (const side of ["left", "right"]) {
      const L = LEGS[side], prefix = side + "_";
      const leg = { side, s: L.side, names: { yaw: prefix + "hip_yaw", roll: prefix + "hip_roll", pitch: prefix + "hip_pitch", knee: prefix + "knee", ankle: prefix + "ankle" } };
      leg.top = this.nodes[L.yaw]; leg.soleNode = this.nodes[L.sole];
      leg.ankleNode = this.nodes[L.ankle];
      const fw = leg.ankleNode.getWorldQuaternion(new THREE.Quaternion()).invert();
      leg.fLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(fw);           // foot-local "forward"
      leg.rLocal = new THREE.Vector3(1, 0, 0).applyQuaternion(fw);           // foot-local "left" (+X)
      leg.uLocal = new THREE.Vector3(0, 1, 0).applyQuaternion(fw);           // foot-local "up"
      // knee bend sign at stand
      const H = this.jointPivot(leg.names.pitch, V()), K = this.jointPivot(leg.names.knee, V()), A = this.jointPivot(leg.names.ankle, V());
      const wk = this.jointAxis(leg.names.knee, V());
      leg.kneeSign = Math.sign(signedAngle(_a.copy(H).sub(K), _b.copy(A).sub(K), wk)) || 1;
      const sole = leg.soleNode.getWorldPosition(V());
      leg.neutral = new THREE.Vector3(sole.x, 0, sole.z); // in root frame at yaw 0
      leg.neutral.x = L.side * GAIT.footX;
      leg.foot = { pos: sole.clone(), yaw: 0, from: sole.clone(), fromYaw: 0, planted: true, s: 1 };
      this.legs[side] = leg;
    }
    // head constants
    const head = this.nodes.body_jaw_soft; this.headNode = head;
    const hw = head.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.headF = new THREE.Vector3(0, 0, 1).applyQuaternion(hw);
    this.headR = new THREE.Vector3(1, 0, 0).applyQuaternion(hw);
    this.markers = {
      upper: this.nodes.marker_beak_upper_tip, lower: this.nodes.marker_beak_lower_tip,
      tof: this.nodes.marker_tof, cam: this.nodes.marker_head_camera, imu: this.nodes.marker_imu, mouth: this.nodes.marker_mouth_tip,
    };

    // state
    this.pos = new THREE.Vector3(); this.yaw = 0; this.vel = new THREE.Vector3(); this.yawRate = 0;
    this.baseY = 0; this.phase = 0; this.stepping = false; this.cycleHz = 2.2;
    this.trunkOff = new THREE.Vector3(); this.trunkEuler = new THREE.Euler(0, 0, 0, "YXZ");
    this.lean = 0; this.prevVel = new THREE.Vector3();
    this.jaw = 0; this.jawTarget = 0; this.jawStop = 0; // jawStop: min angle when gripping
    this.look = { target: null, weight: 0, pitchDown: 0.26, yawBias: 0 };
    this.reach = { target: null, weight: 0, w: 0, sol: null };
    this.crouchExtra = 0; this.pitchExtra = 0;
    this.fall = null; this.time = 0;
    this.enabledIK = true;
    this.iters = 3;                       // IK iterations (lower for far-away ducks)
    this.sitTarget = false; this.sitW = 0; this.crouchTarget = false; this.crouchW = 0;
    this.skating = false; this.skateLift = 0.022; this.skateW = 0; this.stroke = 0; this.strokeSide = 1; this.wobble = 0;
    this.emote = null; this.hop = 0; this.gazeYawOff = 0; this.gazePitchOff = 0;
    this.happyWiggle = 0;
    this.limp = this._makeLimp();
    { // how far the trunk can sink before its shell touches the ground (for sitting)
      let m = Infinity; const e = new THREE.Vector3();
      for (const o of trunk.children) if (o.isMesh && o.geometry.attributes.position) { const a = o.geometry.attributes.position; for (let i = 0; i < a.count; i += 7) { e.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); m = Math.min(m, e.y); } }
      this.sitDrop = isFinite(m) ? Math.max(0.03, m - 0.009) : 0.05;
    }
    // sparse vertex samples for ground contact while fallen (tighter than bounding boxes)
    this.probes = [];
    model.traverse(o => {
      if (!o.isMesh || !o.geometry.attributes.position) return;
      const a = o.geometry.attributes.position, n = a.count, step = Math.max(1, Math.floor(n / 60));
      const pts = []; for (let i = 0; i < n; i += step) pts.push(a.getX(i), a.getY(i), a.getZ(i));
      this.probes.push({ mesh: o, pts: new Float32Array(pts) });
    });
  }
  _emote(dt) {
    const o = { x: 0, y: 0, pitch: 0, yaw: 0, roll: 0 };
    let gy = 0, gp = 0;
    const E = this.emote;
    if (E) {
      E.t += dt; const t = E.t, u = Math.min(1, t / E.dur), env = Math.sin(Math.PI * u);
      if (E.kind === "nod") gp = Math.sin(t * 11) * 0.38 * env;
      else if (E.kind === "shake") gy = Math.sin(t * 13) * 0.55 * env;
      else if (E.kind === "look") { gy = Math.sin(t * 2.2) * 0.95 * env; gp = -0.18 * env + Math.sin(t * 1.3) * 0.1 * env; }
      else if (E.kind === "dance") {
        o.roll = Math.sin(t * 9) * 0.14 * env; o.x = Math.sin(t * 9) * 0.006 * env; o.y = -Math.abs(Math.sin(t * 9)) * 0.008 * env;
        o.yaw = Math.sin(t * 4.5) * 0.2 * env; gy = Math.sin(t * 4.5 + 1) * 0.4 * env; this.happyWiggle = Math.max(this.happyWiggle, env);
      }
      if (u >= 1) this.emote = null;
    }
    this.gazeYawOff = damp(this.gazeYawOff, gy, 18, dt); this.gazePitchOff = damp(this.gazePitchOff, gp, 18, dt);
    return o;
  }
  playEmote(kind, dur) { this.emote = { kind, t: 0, dur: dur || { nod: 1.1, shake: 1.1, look: 2.6, dance: 2.4 }[kind] || 1.2 }; }
  minY() {
    let m = Infinity; const v = _a;
    for (const { mesh, pts } of this.probes) {
      if (!mesh.visible) continue;
      const e = mesh.matrixWorld.elements;
      for (let i = 0; i < pts.length; i += 3) {
        const y = e[1] * pts[i] + e[5] * pts[i + 1] + e[9] * pts[i + 2] + e[13];
        if (y < m) m = y;
      }
    }
    return m;
  }

  // ------------------------------------------------------------------ joints
  setQ(name, theta) { const j = this.joints[name]; if (!j) return; this.q[name] = clamp(theta, j.range[0], j.range[1]); }
  applyJoint(name) {
    const j = this.joints[name]; if (!j) return;
    j.node.quaternion.copy(j.zq).multiply(_q.setFromAxisAngle(j.axis, this.q[name]));
  }
  applyAll() { for (const k in this.joints) this.applyJoint(k); }
  jointAxis(name, out) {
    const j = this.joints[name];
    j.node.parent.getWorldQuaternion(_q2);
    return out.copy(j.axis).applyQuaternion(_q2.multiply(j.zq)).normalize();
  }
  jointPivot(name, out) { return this.joints[name].node.getWorldPosition(out); }
  rot(name, delta) { this.setQ(name, this.q[name] + delta); this.applyJoint(name); }

  _makeLimp() {
    const q = {};
    for (const k in this.joints) q[k] = this.joints[k].stand;
    Object.assign(q, { left_hip_pitch: -0.05, left_knee: 0.85, left_ankle: 0.55, right_hip_pitch: 0.05, right_knee: -0.85, right_ankle: -0.55,
      left_hip_roll: -0.2, right_hip_roll: 0.2, neck_pitch: 0.1, head_pitch: 0.7, head_roll: 0.15, jaw: 0.25 });
    return q;
  }

  // ------------------------------------------------------------------ leg IK
  solveLeg(leg, target, footYaw, footPitch = 0) {
    const n = leg.names;
    const fd = _b.set(Math.sin(footYaw) * Math.cos(footPitch), -Math.sin(footPitch), Math.cos(footYaw) * Math.cos(footPitch));
    const fdesired = fd.clone();
    const H = V(), K = V(), A = V(), S = V(), w = V(), f = V(), tmp = V(), At = V();
    const upd = () => leg.top.updateMatrixWorld(true);
    for (let it = 0; it < this.iters; it++) {
      // 1. hip yaw: foot heading
      upd();
      f.copy(leg.fLocal).applyQuaternion(leg.ankleNode.getWorldQuaternion(_q));
      this.rot(n.yaw, signedAngle(f, fdesired, this.jointAxis(n.yaw, w)));
      upd();
      // 2. hip roll: bring the sole into the target's plane
      const R = this.jointPivot(n.roll, V()); leg.soleNode.getWorldPosition(S);
      this.jointAxis(n.roll, w);
      this.rot(n.roll, signedAngle(tmp.copy(S).sub(R), _a.copy(target).sub(R), w));
      upd();
      // 3. knee: hip–ankle distance
      this.jointPivot(n.pitch, H); this.jointPivot(n.knee, K); this.jointPivot(n.ankle, A); leg.soleNode.getWorldPosition(S);
      At.copy(target).add(tmp.copy(A).sub(S));
      const wk = this.jointAxis(n.knee, w);
      const l1 = projectOnPlane(tmp.copy(K).sub(H), wk, V()).length();
      const l2 = projectOnPlane(tmp.copy(A).sub(K), wk, V()).length();
      let d = projectOnPlane(tmp.copy(At).sub(H), wk, V()).length();
      d = clamp(d, Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
      const cur = signedAngle(_a.copy(H).sub(K), tmp.copy(A).sub(K), wk);
      const want = leg.kneeSign * Math.acos(clamp((l1 * l1 + l2 * l2 - d * d) / (2 * l1 * l2), -1, 1));
      this.rot(n.knee, want - cur);
      upd();
      // 4. hip pitch: swing the leg onto the target
      this.jointPivot(n.ankle, A); this.jointPivot(n.pitch, H);
      this.rot(n.pitch, signedAngle(tmp.copy(A).sub(H), _a.copy(At).sub(H), this.jointAxis(n.pitch, w)));
      upd();
      // 5. ankle: sole flat
      f.copy(leg.fLocal).applyQuaternion(leg.ankleNode.getWorldQuaternion(_q));
      this.rot(n.ankle, signedAngle(f, fdesired, this.jointAxis(n.ankle, w)));
    }
    upd();
    leg.soleNode.getWorldPosition(S);
    leg.err = S.distanceTo(target);
  }

  // ------------------------------------------------------------------ head
  _head(dt, walkSpeed) {
    // desired gaze
    const fwd = _a.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    let gaze;
    if (this.look.target && this.look.weight > 0.01) {
      const eye = this.markers.cam.getWorldPosition(V());
      gaze = V().copy(this.look.target).sub(eye).normalize();
      const base = V().copy(fwd).multiplyScalar(Math.cos(this.look.pitchDown)).add(V(0, -Math.sin(this.look.pitchDown), 0)).normalize();
      gaze.lerp(base, 1 - this.look.weight).normalize();
    } else {
      const yawB = clamp(this.yawRate * 0.28, -0.6, 0.6) + this.look.yawBias + this.gazeYawOff;
      const y = this.yaw + yawB;
      const p = this.look.pitchDown + walkSpeed * 0.6 + this.gazePitchOff - this.sitW * 0.25;
      gaze = V(Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p));
    }
    // neck posture: a little forward when walking, plus a nod with the gait
    const nod = this.stepping ? Math.sin(this.phase * Math.PI * 4) * 0.03 : 0;
    this.setQ("neck_pitch", this.joints.neck_pitch.stand - walkSpeed * 0.9 + nod); this.applyJoint("neck_pitch");
    const neckTop = this.nodes.body_neck; neckTop.updateMatrixWorld(true);
    const w = V(), f = V(), r = V();
    for (let it = 0; it < Math.min(2, this.iters); it++) {
      f.copy(this.headF).applyQuaternion(this.headNode.getWorldQuaternion(_q));
      const dYaw = signedAngle(f, gaze, this.jointAxis("head_yaw", w));
      const cy = this.q.head_yaw; this.setQ("head_yaw", clamp(cy + dYaw, -1.0, 1.0)); this.applyJoint("head_yaw");
      neckTop.updateMatrixWorld(true);
      f.copy(this.headF).applyQuaternion(this.headNode.getWorldQuaternion(_q));
      this.rot("head_pitch", signedAngle(f, gaze, this.jointAxis("head_pitch", w)));
      neckTop.updateMatrixWorld(true);
      // level the head (roll), with a little cute tilt when idle
      r.copy(this.headR).applyQuaternion(this.headNode.getWorldQuaternion(_q));
      f.copy(this.headF).applyQuaternion(_q);
      const rd = V().copy(UP).cross(f).normalize(); // desired "left"
      const tiltCute = (this.idleTilt || 0);
      rd.applyAxisAngle(f, tiltCute);
      this.rot("head_roll", signedAngle(r, rd, this.jointAxis("head_roll", w)));
      neckTop.updateMatrixWorld(true);
    }
  }

  /** beak gap point (midpoint of the two tips), world */
  beakGap(out = V()) {
    const u = this.markers.upper.getWorldPosition(_a), l = this.markers.lower.getWorldPosition(_b);
    return out.copy(u).add(l).multiplyScalar(0.5);
  }
  beakOpening() { return this.markers.upper.getWorldPosition(_a).distanceTo(this.markers.lower.getWorldPosition(_b)); }
  headDir(out = V()) { return out.copy(this.headF).applyQuaternion(this.headNode.getWorldQuaternion(_q)).normalize(); }

  _reachCCD() {
    const T = this.reach.target; if (!T) return;
    const neckTop = this.nodes.body_neck, w = V(), P = V(), E = V();
    for (let it = 0; it < 8; it++) {
      for (const jn of ["head_pitch", "neck_pitch"]) {
        neckTop.updateMatrixWorld(true);
        this.beakGap(E); this.jointPivot(jn, P);
        const d = signedAngle(_c.copy(E).sub(P), V().copy(T).sub(P), this.jointAxis(jn, w));
        this.rot(jn, d * 0.8);
      }
      // keep the beak pointing down-forward so both tips straddle the prop
      neckTop.updateMatrixWorld(true);
    }
    neckTop.updateMatrixWorld(true);
    this.reach.err = this.beakGap(E).distanceTo(T);
  }

  // ------------------------------------------------------------------ main update
  /**
   * @param s {pos:Vector3 (ground point, y used), yaw, vel:Vector3 world, yawRate}
   */
  update(dt, s) {
    dt = Math.min(dt, 1 / 20);
    this.time += dt;
    this.pos.copy(s.pos); this.yaw = s.yaw;
    this.vel.copy(s.vel); this.yawRate = s.yawRate;
    const speed = Math.hypot(this.vel.x, this.vel.z);
    const sp01 = clamp(speed / GAIT.maxSpeed, 0, 1);

    this.root.position.set(this.pos.x, 0, this.pos.z);
    this.root.rotation.set(0, 0, 0);
    // ground height under the body: average of the planted feet and centre
    const gC = this.ground(this.pos.x, this.pos.z);
    const L = this.legs.left.foot, R = this.legs.right.foot;
    const gFeet = (Math.min(L.pos.y, R.pos.y) + Math.max(L.pos.y, R.pos.y)) * 0.5;
    const gTarget = this.fall ? gC : Math.max(gC - 0.012, Math.min(gC + 0.012, gFeet * 0.6 + gC * 0.4));
    if (s.yOverride !== undefined) this.baseY = s.yOverride;
    else this.baseY = Math.abs(this.baseY - gTarget) > 0.2 ? gTarget : damp(this.baseY, gTarget, 14, dt);
    this.root.position.y = this.baseY + this.hop;
    this.root.rotation.y = this.yaw;

    if (this.fall) { this._updateFall(dt); this._jaw(dt); this.root.updateMatrixWorld(true); return; }

    // ---- gait clock
    const footErr = this._footError();
    // ---- poses: sit / crouch / skates / emotes
    this.sitW = damp(this.sitW, this.sitTarget ? 1 : 0, 3.5, dt);
    this.crouchW = damp(this.crouchW, this.crouchTarget ? 1 : 0, 7, dt);
    this.skateW = damp(this.skateW, this.skating ? 1 : 0, 8, dt);
    const em = this._emote(dt);
    const wantStep = !this.skating && this.sitW < 0.3 && (speed > 0.006 || Math.abs(this.yawRate) > 0.08 || footErr > 0.012);
    if (this.skating) this.stepping = false;
    const hz = lerp(2.0, 2.9, sp01) + Math.max(0, speed - GAIT.maxSpeed) * 9 + Math.min(Math.abs(this.yawRate), 1.5) * 0.25;
    this.cycleHz = damp(this.cycleHz, hz, 6, dt);
    if (wantStep) this.stepping = true;
    if (this.stepping) {
      const prev = this.phase;
      this.phase = (this.phase + this.cycleHz * dt) % 1;
      // allow stopping only when both feet are down
      if (!wantStep) {
        const sw = GAIT.swing;
        const crossed = (a, b, x) => (a <= b ? a < x && b >= x : a < x || b >= x);
        if (crossed(prev, this.phase, sw) || crossed(prev, this.phase, 0.5 + sw)) {
          if (this._footError() < 0.012) { this.stepping = false; }
        }
      }
    }
    // ---- trunk motion (root-local)
    const ph = this.phase * Math.PI * 2;
    const g = this.stepping ? 1 : 0;
    this._gw = damp(this._gw ?? 0, g * (0.35 + 0.65 * sp01) + g * Math.min(Math.abs(this.yawRate), 1) * 0.3, 8, dt);
    const gw = this._gw;
    const accel = _a.copy(this.vel).sub(this.prevVel).divideScalar(Math.max(dt, 1e-3)); this.prevVel.copy(this.vel);
    const fwd = V(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const aF = clamp(accel.dot(fwd), -2, 2);
    this.lean = damp(this.lean, sp01 * 0.07 + aF * 0.02, 6, dt);
    const sway = Math.sin(ph) * 0.0045 * gw;                 // toward the stance foot
    const bob = (Math.cos(ph * 2) * 0.5 + 0.5) * 0.0028 * gw;
    const breathe = Math.sin(this.time * 1.7) * 0.0006;
    const sk = this.skateW, glide = Math.sin(this.stroke * Math.PI * 2);
    const skateRoll = sk * (clamp(this.yawRate * 0.12, -0.25, 0.25) + glide * 0.05 * this.strokeSide + this.wobble * Math.sin(this.time * 15) * 0.2);
    this.trunkOff.set(sway + em.x + sk * glide * 0.004, -GAIT.crouch * gw - bob + breathe - this.crouchExtra - this.sitW * this.sitDrop - this.crouchW * 0.028 + sk * this.skateLift + em.y, 0);
    this.trunkEuler.set(this.lean + this.pitchExtra + Math.sin(ph * 2) * 0.012 * gw - this.sitW * 0.16 + this.crouchW * 0.1 + sk * 0.12 + em.pitch,
      Math.sin(ph) * 0.05 * gw + em.yaw, -Math.sin(ph) * 0.045 * gw + skateRoll + em.roll, "YXZ");
    this.trunk.position.copy(this.trunkBase).add(this.trunkOff);
    this.trunk.quaternion.setFromEuler(this.trunkEuler);
    this.root.updateMatrixWorld(true);

    // ---- feet
    if (this.enabledIK) {
      const sw = GAIT.swing;
      for (const side of ["left", "right"]) {
        const leg = this.legs[side], F = leg.foot;
        const start = side === "left" ? 0 : 0.5;
        let s = ((this.phase - start) % 1 + 1) % 1;
        const inSwing = this.stepping && s < sw;
        const toeYaw = -leg.s * GAIT.toeIn;
        if (this.skateW > 0.01 && !inSwing) {
          // on skates: feet ride under the body; one foot pushes back-and-out on each stroke
          const push = this.strokeSide === leg.s ? Math.max(0, Math.sin(this.stroke * Math.PI * 2)) : 0;
          const tgt = V().copy(leg.neutral).add(V(leg.s * (0.004 + push * 0.016), 0, -push * 0.035)).applyAxisAngle(UP, this.yaw).add(this.pos);
          tgt.y = this.baseY + this.skateLift + push * 0.006;
          F.pos.lerp(tgt, this.skateW > 0.95 ? 1 : 0.25); F.yaw = this.yaw + leg.s * push * 0.35; F.planted = true; F.pitch = 0;
        } else if (this.sitW > 0.01 && !inSwing) {
          // sitting: feet slide forward a little as the body settles onto its bottom
          const tgt = V().copy(leg.neutral).add(V(leg.s * 0.006 * this.sitW, 0, 0.03 * this.sitW)).applyAxisAngle(UP, this.yaw).add(this.pos);
          F.pos.x = damp(F.pos.x, tgt.x, 6, dt); F.pos.z = damp(F.pos.z, tgt.z, 6, dt);
          F.pitch = -0.25 * this.sitW;
        } else if (inSwing) {
          const u = s / sw;
          if (F.planted) { F.planted = false; F.from.copy(F.pos); F.fromYaw = F.yaw; F.fromGroundY = F.pos.y; }
          const T = this._landing(leg, (1 - u) * sw / this.cycleHz, (1 - sw) / this.cycleHz);
          const e = smoother(Math.min(1, u * 1.08));
          F.pos.x = lerp(F.from.x, T.x, e); F.pos.z = lerp(F.from.z, T.z, e);
          let gy = this.ground(T.x, T.z); if (gy < this.baseY - 0.05) gy = this.baseY;
          const gyClamped = clamp(gy, this.baseY - 0.03, this.baseY + 0.03);
          F.toY = gyClamped;
          F.pos.y = lerp(F.fromGroundY, gyClamped, e) + GAIT.lift * Math.pow(Math.sin(Math.PI * u), 0.9) * (0.6 + 0.4 * sp01);
          F.yaw = F.fromYaw + wrap(T.yaw - F.fromYaw) * e;
          F.pitch = Math.sin(Math.PI * u) * 0.12 * sp01 - (u > 0.85 ? (u - 0.85) * 0.4 : 0);
          F.s = u;
        } else {
          if (!F.planted) { F.planted = true; F.pos.y = F.toY ?? F.pos.y; F.pitch = 0; F.justLanded = true; }
          F.pitch = 0;
          if (this.skateW <= 0.01 && F.pos.y > this.baseY + 0.008 && !this.stepping) F.pos.y = damp(F.pos.y, this.baseY, 10, dt);
        }
        this.solveLeg(leg, F.pos, F.yaw, F.pitch || 0);
      }
    }

    // ---- head
    this.idleTilt = damp(this.idleTilt || 0, this.stepping ? 0 : Math.sin(this.time * 0.37) * 0.12 + this.happyWiggle * Math.sin(this.time * 18) * 0.25, 3, dt);
    this.happyWiggle = Math.max(0, this.happyWiggle - dt * 0.8);
    this._head(dt, sp01 * 0.25);
    // reach blend
    const rw = this.reach.weight;
    this.reach.w = damp(this.reach.w, rw, 5, dt);
    this.crouchExtra = this.reach.w * (this.reach.crouch ?? 0.034); this.pitchExtra = this.reach.w * (this.reach.bow ?? 0.62);
    if (this.reach.w > 0.002) {
      // the bow makes the gaze steep: keep the head square to the body while reaching
      const k = smooth(clamp(this.reach.w * 1.3, 0, 1));
      this.setQ("head_yaw", lerp(this.q.head_yaw, 0, k)); this.setQ("head_roll", lerp(this.q.head_roll, 0, k));
      this.applyJoint("head_yaw"); this.applyJoint("head_roll");
    }
    if (this.reach.w > 0.002 && this.reach.target) {
      const base = { neck_pitch: this.q.neck_pitch, head_pitch: this.q.head_pitch };
      if (this.reach.sol) { this.setQ("neck_pitch", this.reach.sol.neck_pitch); this.setQ("head_pitch", this.reach.sol.head_pitch); this.applyJoint("neck_pitch"); this.applyJoint("head_pitch"); }
      this._reachCCD();
      this.reach.sol = { neck_pitch: this.q.neck_pitch, head_pitch: this.q.head_pitch };
      const w = smooth(clamp(this.reach.w, 0, 1));
      this.setQ("neck_pitch", lerp(base.neck_pitch, this.reach.sol.neck_pitch, w)); this.setQ("head_pitch", lerp(base.head_pitch, this.reach.sol.head_pitch, w));
      this.applyJoint("neck_pitch"); this.applyJoint("head_pitch");
    } else this.reach.sol = null;
    this._jaw(dt);
    this.root.updateMatrixWorld(true);
  }

  _jaw(dt) {
    const tgt = Math.max(this.jawTarget, this.jawStop);
    const rate = 3.2; // rad/s
    this.jaw += clamp(tgt - this.jaw, -rate * dt, rate * dt);
    this.setQ("jaw", this.jaw); this.applyJoint("jaw");
  }

  _footError() {
    let e = 0;
    for (const side of ["left", "right"]) {
      const leg = this.legs[side];
      const n = _b.copy(leg.neutral).applyAxisAngle(UP, this.yaw).add(this.pos);
      e = Math.max(e, Math.hypot(n.x - leg.foot.pos.x, n.z - leg.foot.pos.z), Math.abs(wrap(leg.foot.yaw - (this.yaw - leg.s * GAIT.toeIn))) * 0.06);
    }
    return e;
  }

  _landing(leg, tRemain, tStance) {
    const t = tRemain + tStance * 0.5;
    const yawP = this.yaw + this.yawRate * t;
    const p = V().copy(leg.neutral).applyAxisAngle(UP, yawP);
    p.x += this.pos.x + this.vel.x * t; p.z += this.pos.z + this.vel.z * t;
    // never cross under the other foot
    const toeYaw = yawP - leg.s * GAIT.toeIn;
    p.yaw = toeYaw;
    return p;
  }

  /** snap feet to neutral (after teleport / get-up) */
  resetFeet() {
    this.root.position.set(this.pos.x, this.baseY, this.pos.z); this.root.rotation.set(0, this.yaw, 0);
    for (const side of ["left", "right"]) {
      const leg = this.legs[side];
      const n = V().copy(leg.neutral).applyAxisAngle(UP, this.yaw).add(this.pos);
      n.y = this.ground(n.x, n.z); if (n.y < this.baseY - 0.03) n.y = this.baseY;
      leg.foot.pos.copy(n); leg.foot.yaw = this.yaw - leg.s * GAIT.toeIn; leg.foot.planted = true; leg.foot.pitch = 0;
    }
    this.phase = 0; this.stepping = false; this.prevVel.set(0, 0, 0);
  }
  teleport(pos, yaw) {
    this.pos.copy(pos); this.yaw = yaw; this.baseY = pos.y; this.baseY = this.ground(pos.x, pos.z); this.vel.set(0, 0, 0); this.yawRate = 0;
    this.fall = null; this.tilt.position.set(0, 0, 0); this.tilt.quaternion.identity();
    this.model.position.set(-this.trunkBase.x, 0, -this.trunkBase.z);
    this.resetFeet();
  }

  // ------------------------------------------------------------------ falls
  /** dirLocal: push direction in root-local xz (unit). kind: 'tip' (in place) */
  startTip(dirWorld) {
    if (this.fall) return;
    const d = V(dirWorld.x, 0, dirWorld.z).normalize().applyAxisAngle(UP, -this.yaw); // local
    // fall axis: perpendicular to the push in the ground plane; pivot at support edge
    const axis = V().copy(UP).cross(d).normalize();
    const pivot = V().copy(d).multiplyScalar(0.045);
    const sideways = Math.abs(d.x) > Math.abs(d.z);
    this.fall = { phase: "tip", axis, pivot, angle: 0.05, angVel: 1.2, rest: sideways ? 1.32 : (d.z > 0 ? 1.15 : 1.25), t: 0, from: { ...this.q }, trunkFrom: this.trunk.position.clone(), lift: 0 };
    this.stepping = false;
  }
  /** off-edge tumble: externally driven. the controller moves root; we just go limp + spin */
  startTumble(dirWorld) {
    const d = V(dirWorld.x, 0, dirWorld.z).normalize().applyAxisAngle(UP, -this.yaw);
    const axis = V().copy(UP).cross(d).normalize();
    this.fall = { phase: "tumble", axis, pivot: V(0, 0.1, 0), angle: 0, angVel: 4.5, rest: Math.PI * 0.5 + 1.0, t: 0, from: { ...this.q }, trunkFrom: this.trunk.position.clone(), lift: 0 };
    this.stepping = false;
  }
  landTumble() {
    if (!this.fall) return;
    const f = this.fall;
    // settle on the side nearest the current angle
    const a = ((f.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    f.angle = a; f.phase = "tip"; f.pivot.set(0, 0, 0); f.angVel = 0; f.rest = a > Math.PI ? Math.PI * 2 - 1.3 : 1.3;
    if (a > Math.PI) { f.angle = a - Math.PI * 2; f.rest = -1.3; }
    f.landed = true;
  }
  get fallen() { return !!this.fall; }
  _poseFallMatrix() {
    const f = this.fall;
    this.tilt.position.copy(f.pivot);
    this.tilt.quaternion.setFromAxisAngle(f.axis, f.angle);
    this.model.position.set(-this.trunkBase.x - f.pivot.x, -f.pivot.y + f.lift, -this.trunkBase.z - f.pivot.z);
  }
  _updateFall(dt) {
    const f = this.fall; f.t += dt;
    const limpW = f.phase === "getup" ? 1 - smooth(clamp(f.t / 1.4, 0, 1)) : smooth(clamp(f.t / 0.35, 0, 1));
    if (f.phase === "tumble") {
      f.angle += f.angVel * dt;
    } else if (f.phase === "tip") {
      // inverted pendulum until it hits the rest angle, small bounce
      const sgn = Math.sign(f.rest) || 1;
      const ang = Math.abs(f.angle);
      f.angVel += Math.sin(Math.max(ang, 0.05)) * 38 * dt * sgn;
      f.angle += f.angVel * dt;
      if (Math.abs(f.angle) >= Math.abs(f.rest)) {
        f.angle = f.rest; f.angVel = -f.angVel * 0.22;
        if (Math.abs(f.angVel) < 0.3) { f.phase = "lie"; f.t = 0; f.angVel = 0; }
      }
    } else if (f.phase === "lie") {
      if (f.t > (f.lieTime ?? 1.1)) { f.phase = "getup"; f.t = 0; f.getFrom = f.angle; }
    } else if (f.phase === "getup") {
      const u = clamp(f.t / 1.6, 0, 1);
      f.angle = f.getFrom * (1 - smoother(u));
      if (u >= 1) {
        this.fall = null;
        this.tilt.position.set(0, 0, 0); this.tilt.quaternion.identity();
        this.model.position.set(-this.trunkBase.x, 0, -this.trunkBase.z);
        this.trunk.position.copy(this.trunkBase); this.trunk.quaternion.identity();
        this.resetFeet();
        this.onGotUp && this.onGotUp();
        return;
      }
    }
    // joints: blend gait pose -> limp; during get-up push with the legs (crouch then extend)
    if (f.phase === "getup") {
      const u = clamp(f.t / 1.6, 0, 1), e = smoother(u);
      const push = Math.sin(Math.PI * clamp(u * 1.25 - 0.1, 0, 1));   // legs fold then extend
      const P = { left_knee: 0.9, right_knee: -0.9, left_hip_pitch: 0.45, right_hip_pitch: -0.45, left_ankle: 0.45, right_ankle: -0.45 };
      for (const k in this.joints) {
        if (k === "jaw") continue;
        let v = lerp(this.limp[k], this.joints[k].stand, e) + (P[k] || 0) * push;
        if (k === "head_roll") v += Math.sin(f.t * 17) * 0.22 * clamp((u - 0.78) * 5, 0, 1) * (1 - u) * 4;
        this.setQ(k, v); this.applyJoint(k);
      }
      // plant the feet on the ground as the body comes upright
      const wIK = smooth(clamp((u - 0.25) / 0.45, 0, 1));
      if (wIK > 0) {
        f.lift = 0; this._poseFallMatrix(); this.trunk.position.copy(this.trunkBase); this.root.updateMatrixWorld(true);
        for (const side of ["left", "right"]) {
          const leg = this.legs[side], names = Object.values(leg.names);
          const anim = names.map(n => this.q[n]);
          const tgt = V().copy(leg.neutral).applyAxisAngle(UP, this.yaw).add(this.pos); tgt.y = this.baseY;
          this.solveLeg(leg, tgt, this.yaw - leg.s * GAIT.toeIn);
          names.forEach((n, i) => { this.setQ(n, lerp(anim[i], this.q[n], wIK)); this.applyJoint(n); });
        }
      }
    } else {
      for (const k in this.joints) {
        if (k === "jaw") continue;
        this.setQ(k, lerp(f.from[k], this.limp[k], limpW)); this.applyJoint(k);
      }
    }
    // trunk back to base (no gait offsets), small flail in tumble
    this.trunk.position.lerp(this.trunkBase, 1 - Math.exp(-10 * dt));
    this.trunk.quaternion.slerp(_q.identity(), 1 - Math.exp(-10 * dt));
    if (f.phase === "tumble") { this.setQ("left_hip_roll", -0.3 + Math.sin(f.t * 20) * 0.1); this.applyJoint("left_hip_roll"); }
    // pose + keep the body above the ground
    f.lift = 0; this._poseFallMatrix();
    this.root.updateMatrixWorld(true);
    if (f.phase !== "tumble") {
      const my = this.minY();
      const gy = this.baseY;
      if (my < gy) { f.lift = gy - my; this._poseFallMatrix(); this.root.updateMatrixWorld(true); }
    }
  }
}
