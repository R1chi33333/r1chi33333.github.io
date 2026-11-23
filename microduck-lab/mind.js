// mind.js — the duck's own estimates: simulated 8×8 ToF depth, risk, uncertainty, and the safety policy
// that can overrule the player's command. Plus the Mind-layer visuals (halo, decision path, ToF fan).
import * as THREE from "three";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const TOF = { n: 8, fov: THREE.MathUtils.degToRad(45), maxRange: 2.0, tilt: 0.42 }; // sensor mounted tilted down under the bill

export class Mind {
  constructor(world, scene) {
    this.world = world; this.scene = scene;
    this.rand = mulberry(20261122);
    this.depth = new Float32Array(64); this.valid = new Uint8Array(64); this.drop = new Uint8Array(64);
    this.hits = Array.from({ length: 64 }, () => new THREE.Vector3());
    this.risk = 0; this.uncertainty = 0.1; this.riskParts = {};
    this.dAheadTrue = 1; this.dAheadEst = 1; this.edgeNoise = 0;
    this.override = null; this.overrideT = 0; this.backoffT = 0;
    this.safety = true;
    this.tofTimer = 0;
    this.lastCmdPath = []; this.lastPath = [];
    this._buildVisuals(scene);
  }

  // ------------------------------------------------------------------ sensing
  dropDistance(x, z, dx, dz, max = 0.5) {
    const W = this.world;
    for (let t = 0; t <= max; t += 0.005) if (W.isOverDrop(x + dx * t, z + dz * t)) return t;
    return max;
  }
  senseToF(duck, props) {
    const o = duck.markers.tof.getWorldPosition(new THREE.Vector3());
    const f = duck.headDir(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
    f.applyAxisAngle(right, -TOF.tilt);
    const up = new THREE.Vector3().crossVectors(right, f).normalize();
    const n = TOF.n, half = TOF.fov / 2, W = this.world, r = this.rand;
    const d = new THREE.Vector3(), p = new THREE.Vector3();
    let dropCount = 0, noiseSum = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const ax = ((i + 0.5) / n * 2 - 1) * half, ay = (1 - (j + 0.5) / n * 2) * half;
      d.copy(f).addScaledVector(right, Math.tan(ax)).addScaledVector(up, Math.tan(ay)).normalize();
      let t = 0.015, hit = TOF.maxRange + 1, step = 0.008;
      while (t < TOF.maxRange) {
        p.copy(o).addScaledVector(d, t);
        if (p.y <= W.groundHeightAt(p.x, p.z)) {
          // bisect back
          let a = t - step, b = t;
          for (let s = 0; s < 6; s++) { const m = (a + b) / 2; p.copy(o).addScaledVector(d, m); if (p.y <= W.groundHeightAt(p.x, p.z)) b = m; else a = m; }
          hit = b; break;
        }
        t += step; step = t < 0.5 ? 0.008 : 0.025;
      }
      // props as spheres
      for (const pr of props) {
        if (pr.held) continue;
        const c = pr.object.position, rad = (pr.spec.footprint || 0.05) * 0.28;
        const oc = p.copy(o).sub(c); const b = oc.dot(d), cc = oc.lengthSq() - rad * rad, disc = b * b - cc;
        if (disc > 0) { const th = -b - Math.sqrt(disc); if (th > 0.01 && th < hit) hit = th; }
      }
      const hp = this.hits[k].copy(o).addScaledVector(d, Math.min(hit, TOF.maxRange));
      const isDrop = hp.y < -0.05;
      this.drop[k] = isDrop ? 1 : 0;
      // a drop only worries it when the edge it looks over is close (ray crosses the table plane nearby)
      if (isDrop && d.y < -0.01) { const t0 = o.y / -d.y; const hd = Math.hypot(d.x * t0, d.z * t0); dropCount += Math.max(0, 1 - hd / 0.4); }
      // noise model: grows with range²; near a drop the returns get unreliable (spill + dropouts)
      const sigma = 0.003 + 0.012 * hit * hit + (isDrop ? 0.04 : 0);
      noiseSum += Math.min(sigma, 0.1);
      const dropout = hit > TOF.maxRange || r() < (isDrop ? 0.35 : 0.02);
      this.valid[k] = dropout ? 0 : 1;
      this.depth[k] = dropout ? 0 : Math.max(0.01, hit + gauss(r) * sigma);
    }
    this.tofOrigin = o;
    this.dropFrac = dropCount / 64; this.noiseMean = noiseSum / 64;
  }

  /**
   * per-frame estimates. s: { duck, pos, yaw, speed, cmdDir (unit, world xz or null), carriedMass, tilt, props, dt, falling }
   */
  estimate(s) {
    const { duck, dt } = s;
    this.tofTimer -= dt;
    if (this.tofTimer <= 0) { this.senseToF(duck, s.props); this.tofTimer = 1 / 15; }
    const fwd = new THREE.Vector3(Math.sin(s.yaw), 0, Math.cos(s.yaw));
    const dir = s.cmdDir || fwd;
    this.dAheadTrue = this.dropDistance(s.pos.x, s.pos.z, dir.x, dir.z, 0.5);
    const edgeAll = this.world.distanceToEdge(s.pos.x, s.pos.z);
    // uncertainty: drop zones in view, sensor noise, own speed, tilt
    const sp01 = clamp(s.speed / 0.16, 0, 1);
    const u = clamp(0.06 + this.dropFrac * 0.9 + this.noiseMean * 3 + sp01 * 0.18 + clamp(s.tilt / 0.5, 0, 1) * 0.3 + (s.carriedMass > 0 ? 0.06 : 0) + Math.exp(-edgeAll / 0.08) * 0.25, 0, 1);
    this.uncertainty = lerp(this.uncertainty, u, 1 - Math.exp(-4 * dt));
    // noisy belief about the distance to the drop (correlated noise, scaled by uncertainty)
    this.edgeNoise = lerp(this.edgeNoise, gauss(this.rand) * 0.03 * this.uncertainty, 1 - Math.exp(-3 * dt));
    this.dAheadEst = Math.max(0, this.dAheadTrue + this.edgeNoise);
    // slope from local ground samples
    const W = this.world, e = 0.04;
    const gx = (W.groundHeightAt(s.pos.x + e, s.pos.z) - W.groundHeightAt(s.pos.x - e, s.pos.z)) / (2 * e);
    const gz = (W.groundHeightAt(s.pos.x, s.pos.z + e) - W.groundHeightAt(s.pos.x, s.pos.z - e)) / (2 * e);
    const slope = Math.abs(gx) < 0.5 && Math.abs(gz) < 0.5 ? Math.atan(Math.hypot(gx, gz)) : 0;
    const dEdge = Math.min(this.dAheadEst, edgeAll + 0.04);
    const rEdge = Math.pow(clamp(1 - (dEdge - 0.05) / 0.24, 0, 1), 1.5);
    const rSpeed = sp01 * 0.3 * (0.4 + rEdge);
    const rSlope = clamp(slope / 0.3, 0, 1) * 0.35;
    const rCarry = clamp(s.carriedMass / 0.008, 0, 1) * 0.18;
    const rTilt = clamp(s.tilt / 0.7, 0, 1);
    let risk = 1 - (1 - rEdge) * (1 - rSpeed) * (1 - rSlope) * (1 - rCarry) * (1 - rTilt);
    if (s.falling) risk = 1;
    this.riskParts = { edge: rEdge, speed: rSpeed, slope: rSlope, carry: rCarry, tilt: rTilt };
    this.risk = lerp(this.risk, risk, 1 - Math.exp(-6 * dt));
    this.slope = slope; this.dEdge = edgeAll;
    return this.risk;
  }

  /**
   * safety policy: may overrule the commanded forward speed.
   * cmd {v, w}. returns {v, w, kind: null|'slow'|'refuse'|'backoff'}
   */
  filter(cmd, s) {
    if (!this.safety || Math.abs(cmd.v) < 1e-4 && this.backoffT <= 0) { this.override = null; return { v: cmd.v, w: cmd.w, kind: null }; }
    const sgn = Math.sign(cmd.v) || 1;
    const dir = new THREE.Vector3(Math.sin(s.yaw) * sgn, 0, Math.cos(s.yaw) * sgn);
    const dTrue = this.dropDistance(s.pos.x, s.pos.z, dir.x, dir.z, 0.5);
    const est = Math.max(0, dTrue + this.edgeNoise);
    const margin = 0.095 + 0.05 * this.uncertainty + (s.carriedMass > 0 ? 0.01 : 0);
    let v = cmd.v, kind = null;
    if (this.backoffT > 0) { this.backoffT -= s.dt; v = -this.backoffDir * 0.06; kind = "backoff"; }
    else if (est < margin) {
      if (est < margin - 0.03) { this.backoffT = 0.5; this.backoffDir = sgn; v = -sgn * 0.06; kind = "backoff"; }
      else { v = 0; kind = "refuse"; }
    } else if (est < margin + 0.12) {
      const k = clamp((est - margin) / 0.12, 0.2, 1);
      if (Math.abs(v) > 0.16 * k) { v = sgn * 0.16 * k; kind = "slow"; }
    }
    this.override = kind;
    return { v, w: cmd.w, kind };
  }

  // ------------------------------------------------------------------ visuals
  _buildVisuals(scene) {
    const g = this.group = new THREE.Group(); g.name = "mind_fx"; g.userData.lookFX = true; scene.add(g);
    // uncertainty halo
    this.haloMat = new THREE.ShaderMaterial({
      uniforms: { uR: { value: 0.15 }, uOp: { value: 0 }, uT: { value: 0 }, uCol: { value: new THREE.Color("#BF5AF2") }, uRisk: { value: 0 } },
      vertexShader: "varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: `uniform float uR, uOp, uT, uRisk; uniform vec3 uCol; varying vec2 vP;
        float h(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)))*43758.5453); }
        void main(){
          float r = length(vP); float a = atan(vP.y, vP.x);
          float wob = (0.004 + 0.012 * uR) * (sin(a*5.0 + uT*2.3) + 0.6 * sin(a*9.0 - uT*3.1));
          float edge = uR + wob;
          float ring = exp(-pow((r - edge) / 0.006, 2.0));
          float fill = smoothstep(edge, edge*0.25, r) * 0.18;
          float dots = step(0.985, h(floor(vP*220.0) + floor(uT*6.0))) * smoothstep(edge+0.03, edge-0.02, r) * 0.6;
          vec3 c = mix(uCol, vec3(1.0, 0.62, 0.04), smoothstep(0.45, 0.9, uRisk));
          gl_FragColor = vec4(c * 1.6, (ring + fill + dots) * uOp);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.halo = new THREE.Mesh(new THREE.CircleGeometry(0.5, 96), this.haloMat);
    this.halo.rotation.x = -Math.PI / 2; this.halo.renderOrder = 20; this.halo.userData.lookNoContact = true; g.add(this.halo);
    // decision path ribbon (chosen) + ghost (commanded)
    const N = 32;
    const mkRibbon = (op) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
      geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(N * 2 * 4), 4));
      const idx = []; for (let i = 0; i < N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      geo.setIndex(idx);
      const m = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: op, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geo, m); mesh.frustumCulled = false; mesh.renderOrder = 21; mesh.userData.lookNoContact = true; g.add(mesh);
      return mesh;
    };
    this.path = mkRibbon(1); this.ghostPath = mkRibbon(0.5); this.N = N;
    // ToF fan
    const fan = new THREE.BufferGeometry();
    fan.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 2 * 3), 3));
    fan.setAttribute("color", new THREE.BufferAttribute(new Float32Array(64 * 2 * 3), 3));
    this.fanMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.fan = new THREE.LineSegments(fan, this.fanMat); this.fan.frustumCulled = false; this.fan.renderOrder = 22; g.add(this.fan);
    // hit dots
    const pts = new THREE.BufferGeometry(); pts.setAttribute("position", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    pts.setAttribute("color", new THREE.BufferAttribute(new Float32Array(64 * 3), 3));
    this.dotMat = new THREE.PointsMaterial({ size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    this.dots = new THREE.Points(pts, this.dotMat); this.dots.frustumCulled = false; this.dots.renderOrder = 22; g.add(this.dots);
    this.time = 0;
  }
  _fillRibbon(mesh, pts, colorFn, width = 0.012) {
    const N = this.N, pos = mesh.geometry.attributes.position.array, col = mesh.geometry.attributes.color.array;
    for (let i = 0; i < N; i++) {
      const p = pts[Math.min(i, pts.length - 1)], q = pts[Math.min(i + 1, pts.length - 1)], q0 = pts[Math.max(i - 1, 0)];
      let dx = q.x - q0.x, dz = q.z - q0.z; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
      const w = width * (1 - i / N * 0.5);
      pos.set([p.x - dz * w, p.y + 0.0015, p.z + dx * w, p.x + dz * w, p.y + 0.0015, p.z - dx * w], i * 6);
      const c = colorFn(i / (N - 1), p);
      col.set([c[0], c[1], c[2], c[3], c[0], c[1], c[2], c[3]], i * 8);
    }
    mesh.geometry.attributes.position.needsUpdate = true; mesh.geometry.attributes.color.needsUpdate = true;
  }
  /** simulate a unicycle forward for the ribbons */
  _rollout(pos, yaw, v, w, T = 1.3) {
    const pts = []; let x = pos.x, z = pos.z, a = yaw;
    const N = this.N, dt = T / (N - 1);
    for (let i = 0; i < N; i++) { pts.push(new THREE.Vector3(x, Math.max(0, this.world.groundHeightAt(x, z)), z)); x += Math.sin(a) * v * dt; z += Math.cos(a) * v * dt; a += w * dt; }
    return pts;
  }
  updateVisuals(dt, s, mindW) {
    this.time += dt;
    const show = mindW > 0.01;
    this.group.visible = show;
    if (!show) return;
    const gy = Math.max(0, this.world.groundHeightAt(s.pos.x, s.pos.z));
    this.halo.position.set(s.pos.x, gy + 0.001, s.pos.z);
    this.haloMat.uniforms.uR.value = 0.09 + this.uncertainty * 0.28;
    this.haloMat.uniforms.uOp.value = mindW * 0.9; this.haloMat.uniforms.uT.value = this.time;
    this.haloMat.uniforms.uRisk.value = this.risk;
    // decision path
    const chosen = this._rollout(s.pos, s.yaw, s.vChosen, s.wChosen);
    const risky = (p) => clamp(1 - this.world.distanceToEdge(p.x, p.z) / 0.15, 0, 1);
    const pulse = 0.75 + 0.25 * Math.sin(this.time * 6);
    this._fillRibbon(this.path, chosen, (u, p) => {
      const r = Math.max(risky(p), this.risk * 0.6);
      const a = (1 - u) * mindW * pulse * (Math.abs(s.vChosen) > 0.003 || Math.abs(s.wChosen) > 0.05 ? 1 : 0.25);
      return [lerp(0.75, 1.0, r) * a, lerp(0.35, 0.55, r) * a, lerp(0.95, 0.05, r) * a, 1];
    });
    const overriding = s.override && s.override !== "slow" || (s.override === "slow");
    if (overriding && Math.abs(s.vCmd) > 0.003) {
      const cmdPts = this._rollout(s.pos, s.yaw, s.vCmd, s.wCmd);
      this._fillRibbon(this.ghostPath, cmdPts, (u) => { const a = (1 - u) * mindW * 0.55 * (Math.floor(u * 14) % 2); return [a, a, a, 1]; }, 0.008);
      this.ghostPath.visible = true;
    } else this.ghostPath.visible = false;
    // ToF fan
    const o = this.tofOrigin; if (!o) return;
    const pa = this.fan.geometry.attributes.position.array, ca = this.fan.geometry.attributes.color.array;
    const da = this.dots.geometry.attributes.position.array, dc = this.dots.geometry.attributes.color.array;
    for (let k = 0; k < 64; k++) {
      const h = this.hits[k];
      pa.set([o.x, o.y, o.z, h.x, h.y, h.z], k * 6);
      const c = this.valid[k] ? (this.drop[k] ? [1.0, 0.35, 0.1] : [0.55, 0.3, 0.95]) : [0.25, 0.25, 0.3];
      ca.set([c[0] * 0.05, c[1] * 0.05, c[2] * 0.05, c[0] * 0.5, c[1] * 0.5, c[2] * 0.5], k * 6);
      da.set([h.x, h.y + 0.001, h.z], k * 3); dc.set(c, k * 3);
    }
    this.fan.geometry.attributes.position.needsUpdate = true; this.fan.geometry.attributes.color.needsUpdate = true;
    this.dots.geometry.attributes.position.needsUpdate = true; this.dots.geometry.attributes.color.needsUpdate = true;
    this.fanMat.opacity = mindW * 0.7; this.dotMat.opacity = mindW;
  }

  /** draw the 8×8 depth grid into a 2D canvas */
  drawDepth(canvas) {
    const g = canvas.getContext("2d"), W = canvas.width, H = canvas.height, n = TOF.n;
    const cw = W / n, ch = H / n;
    g.clearRect(0, 0, W, H);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, x = i * cw, y = j * ch;
      if (!this.valid[k]) {
        g.fillStyle = "#121214"; g.fillRect(x + 1, y + 1, cw - 2, ch - 2);
        g.strokeStyle = "rgba(255,255,255,.14)"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(x + 4, y + ch - 4); g.lineTo(x + cw - 4, y + 4); g.stroke();
        continue;
      }
      const d = this.depth[k];
      const t = clamp(Math.log(d / 0.05) / Math.log(1.6 / 0.05), 0, 1); // near→far
      // violet (near) → cyan → deep blue (far); drops glow orange
      let c;
      if (this.drop[k]) c = [255, 120 + 60 * (1 - t), 30];
      else c = [Math.round(lerp(220, 40, t)), Math.round(lerp(140, 150, t * (1 - t) * 4) * (1 - t * 0.5)), Math.round(lerp(255, 120, t))];
      g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
      g.globalAlpha = lerp(1, 0.55, t);
      g.beginPath(); g.roundRect ? g.roundRect(x + 1, y + 1, cw - 2, ch - 2, 3) : g.rect(x + 1, y + 1, cw - 2, ch - 2); g.fill();
      g.globalAlpha = 1;
    }
  }
}
