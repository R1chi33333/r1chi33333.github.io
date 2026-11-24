// sfx.js — procedural sound effects (WebAudio only, no files): footsteps on different surfaces, a soft servo
// whirr while legs move, skate wheels / push / skid / clack, and sit, crouch, fall and get-up sounds.
// Everything runs through the voice's master gain, so the mute button covers it.
//
//   const sfx = createSfx(voice, world, clock);   clock() = sim time in seconds (rate limits use it)
//   sfx.event(kind, agent, data)      one-shot: plant | sit | crouch | fallHit | getup | push | clack
//   sfx.update(dt, agents, camera)    continuous layers + listener (call once per frame)
//   sfx.counts                        events actually emitted per kind (test hook)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// timbre per surface: noise band, body pitch and decay
const SURF = {
  wood:  { nf: 2600, nq: 1.3, nType: "bandpass", body: 520, bodyType: "triangle", dec: 0.045, nGain: 0.55, bGain: 0.32 },
  table: { nf: 3400, nq: 1.6, nType: "bandpass", body: 780, bodyType: "triangle", dec: 0.035, nGain: 0.5, bGain: 0.3 },
  rug:   { nf: 900,  nq: 0.7, nType: "lowpass",  body: 260, bodyType: "sine",     dec: 0.03,  nGain: 0.35, bGain: 0.16 },
  card:  { nf: 700,  nq: 1.0, nType: "bandpass", body: 150, bodyType: "sine",     dec: 0.09,  nGain: 0.4, bGain: 0.5 },
};

export function createSfx(voice, world, clock = () => performance.now() / 1000) {
  const counts = {};
  const bump = (k) => { counts[k] = (counts[k] || 0) + 1; };
  let bus = null, ctxRef = null;
  const listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0 };
  let stepBudget = 10, lastT = 0;

  function ctx() {
    const c = voice.ctx; if (!c || !voice.master) return null;
    if (c !== ctxRef) { ctxRef = c; bus = c.createGain(); bus.gain.value = 0.9; bus.connect(voice.master); loops.length = 0; }
    return c;
  }
  const live = () => { const c = ctx(); return c && c.state === "running" && !voice.muted ? c : null; };

  // ------------------------------------------------------------ surface under a point
  const F = world.floorY, T = world.table, A = world.anchors;
  const pitch = A.pitch, acc = A.tableAccess;
  function surfaceAt(p) {
    const y = world.groundHeightAt(p.x, p.z, p.y + 0.02);
    if (y > -0.03 && Math.abs(p.x) <= T.width / 2 + 0.02 && Math.abs(p.z) <= T.depth / 2 + 0.02) return "table";
    if (acc) {
      const xs = acc.path.map(q => q[0]), zs = acc.path.map(q => q[2]);
      if (y > F + 0.01 && p.x > Math.min(...xs) - 0.1 && p.x < Math.max(...xs) + 0.4 && p.z > Math.min(...zs) - 0.2 && p.z < Math.max(...zs) + 0.2) return "card";
    }
    if (pitch && y < F + 0.015 && Math.abs(p.x - pitch.center[0]) < 0.95 && Math.abs(p.z - pitch.center[2]) < 1.57) return "rug";
    if (y > F + 0.012) return "table";  // other raised hard surfaces (turntable, landing, shelf)
    return "wood";
  }

  // ------------------------------------------------------------ spatial mix
  function place(agent) {
    const p = agent.pos;
    const dx = p.x - listener.x, dy = p.y - listener.y, dz = p.z - listener.z, d = Math.hypot(dx, dy, dz) || 1e-3;
    const att = 0.45 / (0.45 + Math.max(0, d - 0.35));
    const pan = clamp((dx * listener.rx + dz * listener.rz) / d * 1.1, -1, 1);
    return agent.controlled ? { g: 0.65 + 0.35 * att, pan: pan * 0.45 } : { g: 0.38 * att, pan: pan * 0.9 };
  }
  function out(c, g, pan) {
    const gain = c.createGain(); gain.gain.value = g;
    if (c.createStereoPanner) { const sp = c.createStereoPanner(); sp.pan.value = pan; gain.connect(sp); sp.connect(bus); gain._pan = sp; }
    else gain.connect(bus);
    return gain;
  }
  function noiseSrc(c, t, len) { const s = c.createBufferSource(); s.buffer = voice.noise; s.start(t, Math.random() * 0.3); s.stop(t + len); return s; }
  function env(c, t, peak, attack, decay, len) {
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + attack); g.gain.setTargetAtTime(0.0001, t + attack, decay);
    return g;
  }
  function tone(c, dest, t, type, f0, f1, peak, dur, attack = 0.003) {
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = env(c, t, peak, attack, dur / 3, dur);
    o.connect(g); g.connect(dest); o.start(t); o.stop(t + dur * 2 + 0.05);
  }
  function burst(c, dest, t, type, f, q, peak, dur, attack = 0.002, f1) {
    const s = noiseSrc(c, t, dur * 2 + 0.05);
    const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (f1) fl.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = env(c, t, peak, attack, dur / 3, dur);
    s.connect(fl); fl.connect(g); g.connect(dest);
  }

  // ------------------------------------------------------------ one-shots
  const SYN = {
    plant(c, dst, t, d) {
      const s = SURF[d.surface] || SURF.wood, j = 0.93 + Math.random() * 0.14, v = d.vol;
      burst(c, dst, t, s.nType, s.nf * j, s.nq, s.nGain * v, s.dec);
      tone(c, dst, t, s.bodyType, s.body * j, s.body * j * 0.82, s.bGain * v, s.dec * 1.4);
      if (d.surface === "card") burst(c, dst, t + 0.004, "lowpass", 320, 0.8, 0.35 * v, 0.12); // hollow thump
    },
    sit(c, dst, t) { tone(c, dst, t, "sine", 120, 62, 0.5, 0.16); burst(c, dst, t, "lowpass", 600, 0.7, 0.25, 0.08); },
    crouch(c, dst, t) { tone(c, dst, t, "sine", 150, 90, 0.28, 0.1); burst(c, dst, t, "lowpass", 900, 0.7, 0.14, 0.05); },
    fallHit(c, dst, t, d) {
      const k = clamp(d.strength ?? 1, 0.3, 1.2);
      for (let i = 0; i < 6; i++) { const dt = i * (0.025 + Math.random() * 0.03); burst(c, dst, t + dt, "bandpass", 1800 + Math.random() * 2600, 2.5, (0.45 - i * 0.05) * k, 0.02); }
      tone(c, dst, t, "triangle", 440, 170, 0.5 * k, 0.22); tone(c, dst, t, "sine", 220, 90, 0.45 * k, 0.18);
    },
    getup(c, dst, t) {
      const o = c.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(190, t); o.frequency.exponentialRampToValueAtTime(520, t + 0.5);
      const bp = c.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 900; bp.Q.value = 3;
      const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.09, t + 0.08); g.gain.setTargetAtTime(0.0001, t + 0.45, 0.06);
      o.connect(bp); bp.connect(g); g.connect(dst); o.start(t); o.stop(t + 0.8);
    },
    push(c, dst, t, d) { burst(c, dst, t, "bandpass", 380, 1.4, 0.28 * (d.vol ?? 1), 0.22, 0.04, 1500); },
    clack(c, dst, t) { burst(c, dst, t, "highpass", 3800, 0.8, 0.45, 0.012); burst(c, dst, t + 0.035, "highpass", 3200, 0.8, 0.35, 0.012); tone(c, dst, t, "square", 900, 700, 0.06, 0.04); },
  };

  const lastStep = new WeakMap();
  function event(kind, agent, data = {}) {
    if (voice.muted) return;
    if (kind === "plant") {
      bump("plants"); if (agent.controlled) bump("plantsCtl");
      // rate limit: the controlled duck always steps (min 40 ms apart); others share a small global budget
      const now = clock(), prev = lastStep.get(agent) || 0;
      if (now - prev < (agent.controlled ? 0.04 : 0.09)) return;
      if (!agent.controlled) { if (stepBudget < 1) return; stepBudget -= 1; }
      lastStep.set(agent, now);
      data.surface = data.surface || surfaceAt(data.pos || agent.pos);
      data.vol = (0.75 + Math.random() * 0.25) * (data.vol ?? 1);
      bump("step"); bump("step_" + data.surface); if (agent.controlled) { bump("stepCtl"); bump("stepCtl_" + data.surface); }
    } else bump(kind);
    const c = live(); if (!c) return;
    const { g, pan } = place(agent); if (g < 0.02) return;
    SYN[kind] && SYN[kind](c, out(c, g, pan), c.currentTime + 0.005, data);
  }

  // ------------------------------------------------------------ continuous layers (servo whirr, wheels, skid)
  // a small pool: the controlled duck plus the two nearest moving ducks get layers; the rest are silent
  const loops = [];
  function makeLoop(c) {
    const o = out(c, 1, 0);   // gain -> stereo panner -> bus
    const servoSrc = c.createBufferSource(); servoSrc.buffer = voice.noise; servoSrc.loop = true;
    const sBp = c.createBiquadFilter(); sBp.type = "bandpass"; sBp.frequency.value = 1100; sBp.Q.value = 6;
    const saw = c.createOscillator(); saw.type = "sawtooth"; saw.frequency.value = 170;
    const sawBp = c.createBiquadFilter(); sawBp.type = "bandpass"; sawBp.frequency.value = 1400; sawBp.Q.value = 4;
    const servoG = c.createGain(); servoG.gain.value = 0;
    servoSrc.connect(sBp); sBp.connect(servoG); saw.connect(sawBp); sawBp.connect(servoG); servoG.connect(o);
    const hum = c.createOscillator(); hum.type = "triangle"; hum.frequency.value = 60;
    const rumbleSrc = c.createBufferSource(); rumbleSrc.buffer = voice.noise; rumbleSrc.loop = true;
    const rLp = c.createBiquadFilter(); rLp.type = "lowpass"; rLp.frequency.value = 400;
    const wheelG = c.createGain(); wheelG.gain.value = 0;
    hum.connect(wheelG); rumbleSrc.connect(rLp); rLp.connect(wheelG); wheelG.connect(o);
    const skidSrc = c.createBufferSource(); skidSrc.buffer = voice.noise; skidSrc.loop = true;
    const kBp = c.createBiquadFilter(); kBp.type = "bandpass"; kBp.frequency.value = 2200; kBp.Q.value = 2.2;
    const skidG = c.createGain(); skidG.gain.value = 0;
    skidSrc.connect(kBp); kBp.connect(skidG); skidG.connect(o);
    for (const s of [servoSrc, saw, hum, rumbleSrc, skidSrc]) s.start();
    return { o, servoG, sBp, saw, sawBp, wheelG, hum, rLp, skidG, kBp };
  }
  const setT = (param, v, c, tc = 0.05) => param.setTargetAtTime(v, c.currentTime, tc);

  function update(dt, agents, camera) {
    stepBudget = Math.min(10, stepBudget + dt * 9);   // ~9 flock steps per second at most
    if (camera) {
      listener.x = camera.position.x; listener.y = camera.position.y; listener.z = camera.position.z;
      const e = camera.matrixWorld.elements; listener.rx = e[0]; listener.rz = e[2];
    }
    // per-agent motion features (also used for skid detection)
    for (const a of agents) {
      const m = a._sfx || (a._sfx = { sp: 0, prevSp: 0, skid: 0, w: 0 });
      const sp = a.skates ? a.sv.length() : Math.hypot(a.vel.x, a.vel.z);
      const decel = Math.max(0, (m.sp - sp) / Math.max(dt, 1e-3));
      let slip = 0;
      if (a.skates && sp > 0.02) { const fx = Math.sin(a.yaw), fz = Math.cos(a.yaw); slip = Math.abs(a.sv.x * fz - a.sv.z * fx); }
      const skidNow = a.skates && !a.fall ? clamp((slip - 0.05) * 6 + (decel - 0.25) * 0.8, 0, 1) * clamp(sp * 6, 0, 1) : 0;
      if (skidNow > 0.25 && m.skid <= 0.25 && !voice.muted) bump("skid");
      m.skid = skidNow; m.prevSp = m.sp; m.sp = sp; m.w = Math.abs(a.w || 0);
      m.legs = !a.skates && !a.fall && (a.duck.stepping || a.duck.sitW > 0.05 && a.duck.sitW < 0.95) ? clamp(sp * 8 + m.w * 0.3, 0.15, 1) : 0;
    }
    const c = live(); if (!c) return;
    if (!loops.length) for (let i = 0; i < 3; i++) loops.push(makeLoop(c));
    // choose who gets layers: controlled first, then the nearest moving ducks
    const moving = agents.filter(a => a._sfx && (a._sfx.legs > 0 || (a.skates && a._sfx.sp > 0.01)));
    moving.sort((a, b) => (b.controlled - a.controlled) || (dist2(a) - dist2(b)));
    for (let i = 0; i < loops.length; i++) {
      const L = loops[i], a = moving[i];
      if (!a) { setT(L.servoG.gain, 0, c); setT(L.wheelG.gain, 0, c); setT(L.skidG.gain, 0, c); continue; }
      const { g, pan } = place(a), m = a._sfx;
      setT(L.o.gain, g, c, 0.03); if (L.o._pan) setT(L.o._pan.pan, pan, c, 0.03);
      setT(L.servoG.gain, 0.022 * m.legs, c, 0.06);
      setT(L.sBp.frequency, 900 + 700 * m.legs, c, 0.08); setT(L.saw.frequency, 150 + 90 * m.legs + 40 * Math.min(1, m.w), c, 0.08);
      const sk = a.skates ? clamp(m.sp / 0.6, 0, 1) : 0;
      setT(L.wheelG.gain, 0.11 * Math.sqrt(sk), c, 0.05);
      setT(L.hum.frequency, 45 + 260 * sk, c, 0.05); setT(L.rLp.frequency, 250 + 1400 * sk, c, 0.05);
      setT(L.skidG.gain, 0.16 * m.skid, c, 0.03); setT(L.kBp.frequency, 1600 + 1400 * m.skid, c, 0.05);
    }
  }
  const dist2 = (a) => (a.pos.x - listener.x) ** 2 + (a.pos.z - listener.z) ** 2;

  return { event, update, counts, surfaceAt, reset() { for (const k in counts) delete counts[k]; } };
}
