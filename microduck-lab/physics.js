// physics.js — Rapier world: static colliders, dynamic props (spawnable at runtime), and per-duck bodies:
// a KinematicCharacterController capsule that moves each duck plus kinematic trunk/head/feet boxes that push props.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

const G = { STATIC: 1, PROPS: 2, DUCK: 4, CHAR: 8 };
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _v = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export async function createPhysics(world) {
  await RAPIER.init();
  const pw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  pw.timestep = 1 / 60;

  // ---- statics
  for (const c of world.colliders) {
    const r = c.rotation || [0, 0, 0, 1];
    const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...c.position).setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] }));
    let cd;
    if (c.type === "cuboid") cd = RAPIER.ColliderDesc.cuboid(...c.halfExtents);
    else if (c.type === "cylinder") cd = RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius);
    else if (c.type === "convex") cd = RAPIER.ColliderDesc.convexHull(new Float32Array(c.points.flat()));
    else if (c.type === "ball") cd = RAPIER.ColliderDesc.ball(c.radius);
    if (!cd) continue;
    cd.setFriction(c.friction ?? 0.8).setCollisionGroups(groups(G.STATIC, 0xffff));
    pw.createCollider(cd, rb);
  }

  // ---- props
  const props = [];
  function shapeDescs(p) {
    const shapes = [];
    const ex = p.shapeExact;
    if (ex && ex.type === "torus") {
      const R = ex.majorRadius, r = ex.minorRadius;
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; shapes.push(RAPIER.ColliderDesc.ball(r).setTranslation(Math.cos(a) * R, Math.sin(a) * R, 0)); }
      return shapes;
    }
    const s = p.shape || { type: "ball", radius: 0.015 };
    const add = (s, off) => {
      let cd;
      if (s.type === "cuboid") cd = RAPIER.ColliderDesc.cuboid(...s.halfExtents);
      else if (s.type === "cylinder") cd = RAPIER.ColliderDesc.cylinder(s.halfHeight, s.radius);
      else if (s.type === "ball") cd = RAPIER.ColliderDesc.ball(s.radius);
      else if (s.type === "capsule") cd = RAPIER.ColliderDesc.capsule(s.halfHeight, s.radius);
      if (!cd) return;
      const o = s.offset || off; if (o) cd.setTranslation(...o);
      if (s.rotation) cd.setRotation({ x: s.rotation[0], y: s.rotation[1], z: s.rotation[2], w: s.rotation[3] });
      shapes.push(cd);
    };
    if (s.type === "compound") for (const part of s.parts) add(part, part.offset); else add(s);
    return shapes;
  }
  /** p: {id, object, mass, shape|shapeExact, grip, footprint, kind} — returns the physics prop record */
  function addProp(p, opts = {}) {
    const o = p.object;
    const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(o.position.x, o.position.y + 0.0005, o.position.z)
      .setRotation({ x: o.quaternion.x, y: o.quaternion.y, z: o.quaternion.z, w: o.quaternion.w })
      .setCcdEnabled(true).setLinearDamping(opts.linearDamping ?? 0.4).setAngularDamping(opts.angularDamping ?? 0.8).setCanSleep(true));
    const shapes = shapeDescs(p);
    const each = (p.mass || 0.006) / Math.max(1, shapes.length);
    for (const cd of shapes) {
      cd.setMass(each).setFriction(opts.friction ?? 0.9).setRestitution(opts.restitution ?? 0.15).setCollisionGroups(groups(G.PROPS, G.STATIC | G.PROPS | G.DUCK));
      pw.createCollider(cd, rb);
    }
    const rec = { spec: p, body: rb, object: o, held: false, id: p.id, kind: p.kind || p.id, mass: p.mass || 0.006, home: o.position.clone(), homeQ: o.quaternion.clone() };
    props.push(rec);
    return rec;
  }
  function removeProp(rec) {
    const i = props.indexOf(rec); if (i >= 0) props.splice(i, 1);
    pw.removeRigidBody(rec.body);
  }
  for (const p of world.props) addProp(p, { restitution: p.restitution });

  const kcc = pw.createCharacterController(0.002);
  kcc.setUp({ x: 0, y: 1, z: 0 });
  kcc.enableAutostep(0.021, 0.01, false);
  kcc.enableSnapToGround(0.02);
  kcc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(28));
  kcc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(40));
  kcc.setSlideEnabled(true);
  const CAP = { r: 0.045, hh: 0.05 }; const charOff = CAP.r + CAP.hh + 0.003;

  function setGroups(p, g) { for (let i = 0; i < p.body.numColliders(); i++) p.body.collider(i).setCollisionGroups(g); }

  /** one physical duck: character capsule + kinematic pusher parts */
  function addDuck() {
    const mkKin = (cd) => {
      const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
      cd.setCollisionGroups(groups(G.DUCK, G.PROPS)).setFriction(0.6);
      pw.createCollider(cd, rb); return rb;
    };
    const parts = {
      trunk: mkKin(RAPIER.ColliderDesc.cuboid(0.05, 0.035, 0.04)),
      head: mkKin(RAPIER.ColliderDesc.cuboid(0.035, 0.028, 0.045)),
      footL: mkKin(RAPIER.ColliderDesc.cuboid(0.02, 0.008, 0.035)),
      footR: mkKin(RAPIER.ColliderDesc.cuboid(0.02, 0.008, 0.035)),
    };
    const charBody = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, charOff, 0));
    const charCol = pw.createCollider(RAPIER.ColliderDesc.capsule(CAP.hh, CAP.r).setCollisionGroups(groups(G.CHAR, G.STATIC)), charBody);
    const h = {
      parts, charBody, charCol,
      setCharPosition(p) { charBody.setTranslation({ x: p.x, y: p.y + charOff, z: p.z }, true); charBody.setNextKinematicTranslation({ x: p.x, y: p.y + charOff, z: p.z }); },
      charPosition(out = new THREE.Vector3()) { const t = charBody.translation(); return out.set(t.x, t.y - charOff, t.z); },
      moveChar(d) {
        kcc.computeColliderMovement(charCol, { x: d.x, y: d.y, z: d.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.CHAR, G.STATIC));
        const m = kcc.computedMovement(); const t = charBody.translation();
        const n = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
        charBody.setNextKinematicTranslation(n); charBody.setTranslation(n, true);
        return { grounded: kcc.computedGrounded(), moved: m };
      },
      sync(duck) {
        const tr = duck.trunk; tr.matrixWorld.decompose(_p, _q, _s);
        parts.trunk.setNextKinematicTranslation({ x: _p.x, y: _p.y + 0.01, z: _p.z });
        if (duck.fallen) parts.trunk.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
        else { _q.setFromAxisAngle(UP, duck.yaw); parts.trunk.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }); }
        const c = duck.markers.cam.getWorldPosition(_v); const hp = duck.headNode.getWorldPosition(_p);
        hp.lerp(c, 0.5); const f = duck.headDir(_s); _q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), f);
        parts.head.setNextKinematicTranslation({ x: hp.x, y: hp.y, z: hp.z });
        parts.head.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
        for (const [side, rb] of [["left", parts.footL], ["right", parts.footR]]) {
          const leg = duck.legs[side]; const sp = leg.soleNode.getWorldPosition(_v);
          _q.setFromAxisAngle(UP, leg.foot.yaw);
          rb.setNextKinematicTranslation({ x: sp.x, y: sp.y + 0.009, z: sp.z });
          rb.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
        }
      },
      snap() { for (const k in parts) { const rb = parts[k]; rb.setTranslation(rb.nextTranslation(), true); } },
      remove() { for (const k in parts) pw.removeRigidBody(parts[k]); pw.removeRigidBody(charBody); },
    };
    return h;
  }

  return {
    RAPIER, pw, props, kcc, G, addProp, removeProp, addDuck,
    /** fixed collider added at runtime (goal posts); returns the body for removeStatic */
    addStatic(c) {
      const r = c.rotation || [0, 0, 0, 1];
      const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...c.position).setRotation({ x: r[0], y: r[1], z: r[2], w: r[3] }));
      const cd = c.type === "cylinder" ? RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius) : RAPIER.ColliderDesc.cuboid(...c.halfExtents);
      cd.setFriction(0.6).setRestitution(0.3).setCollisionGroups(groups(G.PROPS, G.PROPS)); // posts stop balls, not ducks
      pw.createCollider(cd, rb); return rb;
    },
    removeStatic(rb) { pw.removeRigidBody(rb); },
    step() { pw.step(); },
    syncProps() {
      for (const p of props) {
        if (p.noDuck > 0 && --p.noDuck === 0) setGroups(p, groups(G.PROPS, G.STATIC | G.PROPS | G.DUCK));
        if (p.held) continue;
        const t = p.body.translation(), r = p.body.rotation();
        p.object.position.set(t.x, t.y, t.z); p.object.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },
    hold(p) { p.held = true; p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true); },
    setHeldPose(p, pos, quat) {
      p.body.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z });
      p.body.setNextKinematicRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w });
      p.object.position.copy(pos); p.object.quaternion.copy(quat);
    },
    release(p, vel) {
      const t = p.object.position, q = p.object.quaternion;
      p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      p.body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
      p.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      p.body.setLinvel({ x: vel.x, y: vel.y, z: vel.z }, true);
      p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.held = false;
      setGroups(p, groups(G.PROPS, G.STATIC | G.PROPS)); p.noDuck = 40;   // fall clear of the beak first
    },
    impulse(p, v) { p.body.applyImpulse({ x: v.x, y: v.y, z: v.z }, true); },
    place(p, pos, quat) {
      p.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
      if (quat) p.body.setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      p.object.position.copy(pos); if (quat) p.object.quaternion.copy(quat);
    },
    resetProp(p) { this.place(p, p.home.clone().add(new THREE.Vector3(0, 0.002, 0)), p.homeQ); },
  };
}
