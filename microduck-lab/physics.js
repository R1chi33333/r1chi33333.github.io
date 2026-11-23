// physics.js — Rapier world: static arena colliders, dynamic graspable props, kinematic duck body parts
// (push props), and a KinematicCharacterController capsule that moves the duck around the arena.
import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

const G = { STATIC: 1, PROPS: 2, DUCK: 4, CHAR: 8 };
const groups = (member, filter) => ((member & 0xffff) << 16) | (filter & 0xffff);

export async function createPhysics(world) {
  await RAPIER.init();
  const pw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  pw.timestep = 1 / 60;

  // ---- statics
  for (const c of world.colliders) {
    const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...c.position).setRotation({ x: c.rotation[0], y: c.rotation[1], z: c.rotation[2], w: c.rotation[3] }));
    let cd;
    if (c.type === "cuboid") cd = RAPIER.ColliderDesc.cuboid(...c.halfExtents);
    else if (c.type === "cylinder") cd = RAPIER.ColliderDesc.cylinder(c.halfHeight, c.radius);
    else if (c.type === "convex") cd = RAPIER.ColliderDesc.convexHull(new Float32Array(c.points.flat()));
    if (!cd) continue;
    cd.setFriction(c.friction ?? 0.8).setCollisionGroups(groups(G.STATIC, 0xffff));
    pw.createCollider(cd, rb);
  }

  // ---- props
  const props = [];
  for (const p of world.props) {
    const o = p.object;
    const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(o.position.x, o.position.y + 0.0005, o.position.z)
      .setRotation({ x: o.quaternion.x, y: o.quaternion.y, z: o.quaternion.z, w: o.quaternion.w })
      .setCcdEnabled(true).setLinearDamping(0.4).setAngularDamping(0.8).setCanSleep(true));
    const shapes = [];
    const s = p.shapeExact && p.shapeExact.type === "torus" ? null : p.shape;
    if (p.shapeExact && p.shapeExact.type === "torus") {
      // ring of balls in the torus plane (torus axis = local z)
      const R = p.shapeExact.majorRadius, r = p.shapeExact.minorRadius;
      for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2; shapes.push(RAPIER.ColliderDesc.ball(r).setTranslation(Math.cos(a) * R, Math.sin(a) * R, 0)); }
    } else if (s.type === "cuboid") shapes.push(RAPIER.ColliderDesc.cuboid(...s.halfExtents));
    else if (s.type === "cylinder") shapes.push(RAPIER.ColliderDesc.cylinder(s.halfHeight, s.radius));
    else if (s.type === "compound") for (const part of s.parts) shapes.push(RAPIER.ColliderDesc.ball(part.radius).setTranslation(...part.offset));
    else if (s.type === "ball") shapes.push(RAPIER.ColliderDesc.ball(s.radius));
    const each = p.mass / shapes.length;
    for (const cd of shapes) {
      cd.setMass(each).setFriction(0.9).setRestitution(0.15).setCollisionGroups(groups(G.PROPS, G.STATIC | G.PROPS | G.DUCK));
      pw.createCollider(cd, rb);
    }
    props.push({ spec: p, body: rb, object: o, held: false, id: p.id, mass: p.mass });
  }

  // ---- duck kinematic parts (push props around)
  const mkKin = (cd) => {
    const rb = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    cd.setCollisionGroups(groups(G.DUCK, G.PROPS)).setFriction(0.6);
    pw.createCollider(cd, rb); return rb;
  };
  const duckParts = {
    trunk: mkKin(RAPIER.ColliderDesc.cuboid(0.05, 0.035, 0.04)),
    head: mkKin(RAPIER.ColliderDesc.cuboid(0.035, 0.028, 0.045)),
    footL: mkKin(RAPIER.ColliderDesc.cuboid(0.02, 0.008, 0.035)),
    footR: mkKin(RAPIER.ColliderDesc.cuboid(0.02, 0.008, 0.035)),
  };

  // ---- character controller
  const CAP = { r: 0.045, hh: 0.05 };
  const charBody = pw.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, CAP.r + CAP.hh + 0.003, 0));
  const charCol = pw.createCollider(RAPIER.ColliderDesc.capsule(CAP.hh, CAP.r).setCollisionGroups(groups(G.CHAR, G.STATIC)), charBody);
  const kcc = pw.createCharacterController(0.002);
  kcc.setUp({ x: 0, y: 1, z: 0 });
  kcc.enableAutostep(0.021, 0.01, false);
  kcc.enableSnapToGround(0.02);
  kcc.setMaxSlopeClimbAngle(THREE.MathUtils.degToRad(28));
  kcc.setMinSlopeSlideAngle(THREE.MathUtils.degToRad(40));
  kcc.setSlideEnabled(true);
  const charOff = CAP.r + CAP.hh + 0.003;

  function setGroups(p, g) { for (let i = 0; i < p.body.numColliders(); i++) p.body.collider(i).setCollisionGroups(g); }
  const _m = new THREE.Matrix4(), _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3();
  const api = {
    RAPIER, pw, props, duckParts, charBody, charCol, kcc, G,
    /** place the capsule so its bottom sits at ground point p */
    setCharPosition(p) { charBody.setTranslation({ x: p.x, y: p.y + charOff, z: p.z }, true); charBody.setNextKinematicTranslation({ x: p.x, y: p.y + charOff, z: p.z }); },
    charPosition(out = new THREE.Vector3()) { const t = charBody.translation(); return out.set(t.x, t.y - charOff, t.z); },
    /** move the character by a desired displacement; returns grounded flag */
    moveChar(d) {
      kcc.computeColliderMovement(charCol, { x: d.x, y: d.y, z: d.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(G.CHAR, G.STATIC));
      const m = kcc.computedMovement(); const t = charBody.translation();
      charBody.setNextKinematicTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z });
      // the kinematic body takes the next translation on step; mirror it immediately for queries
      charBody.setTranslation({ x: t.x + m.x, y: t.y + m.y, z: t.z + m.z }, true);
      return { grounded: kcc.computedGrounded(), moved: m };
    },
    /** drive kinematic duck parts from the visual rig */
    syncDuckParts(duck) {
      const set = (rb, obj, off) => {
        obj.updateWorldMatrix(true, false);
        obj.matrixWorld.decompose(_p, _q, _s);
        if (off) _p.add(off.clone().applyQuaternion(_q));
        rb.setNextKinematicTranslation({ x: _p.x, y: _p.y, z: _p.z });
        rb.setNextKinematicRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w });
      };
      const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), duck.yaw);
      const tr = duck.trunk; tr.updateWorldMatrix(true, false); tr.matrixWorld.decompose(_p, _q, _s);
      duckParts.trunk.setNextKinematicTranslation({ x: _p.x, y: _p.y + 0.01, z: _p.z });
      duckParts.trunk.setNextKinematicRotation(duck.fallen ? { x: _q.x, y: _q.y, z: _q.z, w: _q.w } : { x: yawQ.x, y: yawQ.y, z: yawQ.z, w: yawQ.w });
      // head box centred ahead of the head pivot
      const h = duck.headNode; h.updateWorldMatrix(true, false);
      const c = duck.markers.cam.getWorldPosition(new THREE.Vector3());
      const hp = h.getWorldPosition(new THREE.Vector3());
      const mid = hp.clone().lerp(c, 0.5); const hq = h.getWorldQuaternion(new THREE.Quaternion());
      // align box with head forward
      const f = duck.headDir(new THREE.Vector3());
      const q2 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), f);
      duckParts.head.setNextKinematicTranslation({ x: mid.x, y: mid.y, z: mid.z });
      duckParts.head.setNextKinematicRotation({ x: q2.x, y: q2.y, z: q2.z, w: q2.w });
      for (const [side, rb] of [["left", duckParts.footL], ["right", duckParts.footR]]) {
        const leg = duck.legs[side]; const sp = leg.soleNode.getWorldPosition(new THREE.Vector3());
        const fy = leg.foot.yaw; const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), fy);
        rb.setNextKinematicTranslation({ x: sp.x, y: sp.y + 0.009, z: sp.z + 0 });
        rb.setNextKinematicRotation({ x: q.x, y: q.y, z: q.z, w: q.w });
      }
    },
    /** teleport duck parts (no sweeping impulse) */
    snapDuckParts() { for (const k in duckParts) { const rb = duckParts[k]; const t = rb.nextTranslation ? rb.nextTranslation() : rb.translation(); rb.setTranslation(t, true); } },
    step() { pw.step(); },
    syncProps() {
      for (const p of props) {
        if (p.noDuck > 0 && --p.noDuck === 0) setGroups(p, groups(G.PROPS, G.STATIC | G.PROPS | G.DUCK));
        if (p.held) continue;
        const t = p.body.translation(), r = p.body.rotation();
        p.object.position.set(t.x, t.y, t.z); p.object.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },
    hold(p) {
      p.held = true; p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    },
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
      // let it fall clear of the beak before the duck's body can shove it
      setGroups(p, groups(G.PROPS, G.STATIC | G.PROPS)); p.noDuck = 40;
    },
    resetProp(p) {
      const s = p.spec;
      p.body.setTranslation({ x: s.initialPosition.x, y: s.initialPosition.y + 0.002, z: s.initialPosition.z }, true);
      const q = s.initialQuaternion; p.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true); p.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
  };
  return api;
}
