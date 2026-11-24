// adapter.js — a thin layer over world.js so the game asks the same questions on the desk or anywhere in the
// living room: height-aware ground/drop queries, where to wander, where the goals and race checkpoints are,
// which meshes items can be placed on, and how to keep the camera inside the room.
import * as THREE from "three";

export function adaptWorld(world) {
  const A = world.anchors || {};
  const T = world.table || { width: 1.6, depth: 1.0, height: 0.75 };
  const room = world.room || { x0: -T.width / 2, x1: T.width / 2, z0: -T.depth / 2, z1: T.depth / 2 };
  const bounds = { minX: room.x0, maxX: room.x1, minZ: room.z0, maxZ: room.z1 };
  const floorY = world.floorY ?? -T.height;
  const yAware = world.groundHeightAt.length >= 3;
  /** highest walkable surface at or just below y (y omitted = highest anywhere) */
  const ground = (x, z, y) => {
    if (yAware) return world.groundHeightAt(x, z, y);
    const g = world.groundHeightAt(x, z);
    return y !== undefined && g > y + 0.04 ? floorY : g;
  };
  /** standing at height y over (x, z) would mean falling */
  const over = (x, z, y = 0) => ground(x, z, y + 0.03) < y - 0.06;
  const edge = (x, z, y = 0) => {
    let best = 0.4;
    for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; for (let t = 0.02; t < best; t += 0.02) if (over(x + Math.cos(a) * t, z + Math.sin(a) * t, y)) { best = t; break; } }
    return best;
  };

  function isOpen(x, z, clear = 0.12, y) {
    const h = ground(x, z, y === undefined ? undefined : y + 0.03);
    if (y !== undefined && Math.abs(h - y) > 0.03) return false;
    if (x < bounds.minX + 0.12 || x > bounds.maxX - 0.12 || z < bounds.minZ + 0.12 || z > bounds.maxZ - 0.12) return false;
    for (const [dx, dz] of [[clear, 0], [-clear, 0], [0, clear], [0, -clear], [clear * 0.7, clear * 0.7], [-clear * 0.7, -clear * 0.7]]) {
      const g = ground(x + dx, z + dz, h + 0.03);
      if (Math.abs(g - h) > 0.018) return false;
    }
    return true;
  }
  function randomSpot(from, radius = 0.4, rand = Math.random) {
    for (let i = 0; i < 24; i++) {
      const a = rand() * Math.PI * 2, r = radius * (0.35 + 0.65 * rand());
      const x = from.x + Math.cos(a) * r, z = from.z + Math.sin(a) * r;
      if (isOpen(x, z, 0.07, from.y)) return new THREE.Vector3(x, ground(x, z, from.y + 0.03), z);
    }
    return from.clone();
  }

  // ---- football: the room's pitch + goals if it has them, otherwise goals we build on the desk
  let football;
  if (A.pitch && A.goals && A.goals.length >= 2) {
    const c = A.pitch.center, gA = A.goals[0], gB = A.goals[1];
    const half = Math.abs(gB.position[2] - gA.position[2]) / 2;
    football = { center: c, axis: "z", half, goalWidth: gA.width, goalHeight: gA.height, goalDepth: gA.depth, builtIn: true,
      goals: [gA, gB].sort((a, b) => a.position[2] - b.position[2]), ballSpawn: A.pitch.ballSpawn || c };
  } else {
    football = { center: [-0.05, 0, 0], axis: "z", half: 0.4, goalWidth: 0.18, goalDepth: 0.06, goalHeight: 0.07, builtIn: false };
  }
  // ---- race: start line + checkpoints from the room, else a loop on the desk
  let race;
  if (A.raceStart && A.checkpoints && A.checkpoints.length) {
    race = { checkpoints: [A.raceStart.position, ...A.checkpoints.map(c => c.position)], radius: [A.raceStart.width / 2, ...A.checkpoints.map(c => c.radius || 0.3)],
      startDir: A.raceStart.direction, laps: 1, speedBoost: 1.9, builtIn: true };
  } else {
    race = { checkpoints: [[0.02, -0.36], [0.58, -0.3], [0.6, 0.38], [-0.08, 0.4], [-0.62, 0.36], [-0.66, 0.02], [-0.3, -0.36]].map(([x, z]) => [x, ground(x, z, 0.03), z]), laps: 2, speedBoost: 1, builtIn: false };
  }

  const startP = (A.start && A.start.position) || [0, 0, 0];
  const spawnPts = A.spawnPoints || [];
  return {
    raw: world, colliders: world.colliders, props: world.props, anchors: A, turntable: world.turntable, table: T, room, bounds, floorY,
    meshes: world.placementMeshes || world.meshes || [], root: world.root,
    groundHeightAt: ground, isOverDrop: over, distanceToEdge: edge,
    randomSpot, isOpen,
    clampCamera: (p) => (world.clampCamera ? world.clampCamera(p) : p),
    start: { position: new THREE.Vector3(...startP), yaw: (A.start && A.start.yaw) || 0 },
    /** spot for the i-th duck of n: around the start on the desk first, then the room's spawn points */
    spawnSpot(i, n) {
      const s = new THREE.Vector3(...startP);
      if (i === 0) return s;
      if (i < 5) for (let k = 0; k < 30; k++) {
        const a = (i / 5) * Math.PI * 2 + k * 0.7, r = 0.15 + 0.05 * (k % 4);
        const x = s.x + Math.sin(a) * r, z = s.z + Math.cos(a) * r;
        if (isOpen(x, z, 0.07, s.y)) return new THREE.Vector3(x, ground(x, z, s.y + 0.03), z);
      }
      const sp = spawnPts[(i - 1) % Math.max(1, spawnPts.length)];
      return sp ? new THREE.Vector3(...sp.position) : s.clone().add(new THREE.Vector3(0.1 * i, 0, 0));
    },
    football, race,
    workbench: A.workbench,
    addProp: (p) => world.addProp && world.addProp(p), removeProp: (p) => world.removeProp && world.removeProp(p),
    update: (dt) => world.update(dt), setWeights: (w) => world.setWeights(w),
    // multi-room house (world.js / house.js): surfaces, focus for the wall cutaway, rooms
    surfaceAt: world.surfaceAt ? (x, z, y) => world.surfaceAt(x, z, y) : () => ({ type: "wood", friction: 0.7, bounce: 0 }),
    setFocus: (p) => world.setFocus && world.setFocus(p),
    setCameraFree: (b) => world.setCameraFree && world.setCameraFree(b),
    roomAt: (x, z) => (world.roomAt ? world.roomAt(x, z) : "living"),
    drawCallsByRoom: () => (world.drawCallsByRoom ? world.drawCallsByRoom() : {}),
    rooms: world.rooms, house: world.house, cull: world.cull || { enabled: false },
  };
}
