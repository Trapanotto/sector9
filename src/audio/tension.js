// Tension layer (no music): danger / exertion state → low drones built from real room tone pitched down, the
// officer's breathing (recorded breath loops), a heartbeat only when it is really bad, sudden silences, and the
// staged-moment recipes (audio.moment(id, phase), driven by the director's 'moment' event). Owner: E.
//
// Stand-in: the heartbeat is built from two body-fall recordings pitched down and low-passed (no heartbeat
// recording in the library).

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function installTension(K) {
  const { ctx, E, sched } = K;
  const T = { danger: 0, exert: 0, stress: 0, scene: 0, sceneT: 0, health: 100, h: { drone: 0, sub: 0, calm: 0, exert: 0 }, moments: 0 };
  const P = () => ctx.player;

  T.danger = (v) => { T.dangerV = clamp01((T.dangerV ?? 0) + v); };
  T.dangerV = 0;
  T.damage = (amt, health) => { T.danger(0.35 + amt / 100); T.health = health; };
  T.kill = () => { T.danger(0.1); };
  /** scripted tension level for a while (moments) */
  T.swell = (level, dur) => { T.scene = Math.max(T.scene, level); T.sceneT = Math.max(T.sceneT, dur); };

  let hbT = 0, recoverAt = -100, peak = 0, lastX = NaN, lastZ = NaN;
  const loop2D = (name, gain, pitch, lp) => {
    const o = E.opts(); o.twoD = true; o.loop = true; o.gain = gain; o.pitch = pitch; o.pitchVar = 0; o.lp = lp; o.cat = 'tension'; o.fadeIn = 2;
    return E.play(name, o);
  };
  function level(key, name, g, pitch, lp) {
    let h = T.h[key];
    if (g > 0.01 && !h) T.h[key] = h = loop2D(name, g, pitch, lp);
    else if (h) {
      if (g < 0.005) { E.stop(h, 2.5); T.h[key] = 0; return; }
      E.setBase(h, g * K.bankGain(name));
      if (!E.isPlaying(h)) T.h[key] = 0;
    }
  }
  T.update = (dt) => {
    const p = P();
    const playing = ctx.state === 'playing';
    // exertion: sprinting builds it up, standing still lets it fall
    let v = 0;
    if (p && !Number.isNaN(lastX) && dt > 0) v = Math.hypot(p.pos.x - lastX, p.pos.z - lastZ) / dt;
    if (p) { lastX = p.pos.x; lastZ = p.pos.z; }
    if (!playing) v = 0;
    T.exert = clamp01(T.exert + (v > 3.4 ? dt / 9 : -dt / 14));
    T.dangerV = Math.max(0, T.dangerV - dt / 14);
    if (T.sceneT > 0) T.sceneT -= dt; else T.scene = Math.max(0, T.scene - dt / 6);
    const hp = p?.health ?? 100;
    T.stress = clamp01(Math.max(T.dangerV, T.scene * 0.8, (60 - hp) / 60));
    peak = Math.max(peak * Math.exp(-dt / 60), T.stress);
    if (!playing) { level('drone', 'amb.factory', 0, 0.5, 220); level('sub', 'loop.fridge', 0, 0.6, 140); level('calm', 'voice.player.breath.calm', 0, 1, 20000); level('exert', 'voice.player.breath.exert', 0, 1, 20000); return; }
    // drones: real room tone slowed down, swelling with stress
    const s = T.stress;
    level('drone', 'amb.factory', s > 0.12 ? 0.55 * s * s : 0, 0.5, 220);
    level('sub', 'loop.fridge', s > 0.3 ? 0.6 * (s - 0.3) : 0, 0.6, 140);
    // breathing: exertion first, then fear while standing still in danger
    level('exert', 'voice.player.breath.exert', T.exert > 0.3 ? 0.25 + 0.6 * T.exert : 0, 1, 20000);
    level('calm', 'voice.player.breath.calm', T.exert < 0.3 && s > 0.5 && v < 1.5 ? 0.35 * s : 0, 1, 20000);
    // after a firefight: one long recovering breath
    const now = K.now();
    if (peak > 0.75 && s < 0.25 && now - recoverAt > 80) {
      recoverAt = now; peak = 0;
      const o = E.opts(); o.twoD = true; o.gain = 0.7; o.cat = 'player'; o.prio = 5;
      E.play('voice.player.breath.recover', o);
    }
    // heartbeat (stand-in from body-fall thumps) only at high stress / low health
    if (s > 0.6) {
      hbT -= dt;
      if (hbT <= 0) {
        const bpm = 78 + 60 * s;
        hbT = 60 / bpm;
        const g = 0.25 * (s - 0.5) * 2;
        K.D.play2D('foley.bodyfall', g, 0.52, 0, (o) => { o.lp = 130; o.clip = K.shortThump(); o.cat = 'tension'; o.pitchVar = 0; });
        K.D.play2D('foley.bodyfall', g * 0.65, 0.5, 0.26, (o) => { o.lp = 120; o.clip = K.shortThump(); o.cat = 'tension'; o.pitchVar = 0; });
      }
    }
  };
  T.doorSlam = (state, d) => { if ((state === 'closed') && d?.id === 'd_dock2') T.swell(0.5, 6); };
  T.lightsOut = (id) => {
    const zc = ctx.world?.zones?.[K.L.zone]?.circuit ?? K.circuitOfZone?.(K.L.zone);
    if (zc === id || !zc) { K.W.silence(0.25, 3.5); T.swell(0.6, 8); }
  };

  // ---------------------------------------------------------------------------------------------------------
  // staged moments (ids from CONTRACT §11 / moments.js). phase: 'start' (default), 'peak', 'end'
  const D = () => K.D;
  const MOMENTS = {
    m01_ankunft: { start() {
      // far-off city siren drifting over the yard, very faint; dispatcher ack if the director sends no radio
      D().play2D('machine.alarm.siren', 0.12, 1, 6, (o) => { o.lp = 1400; o.cat = 'amb'; o.dur = 14; o.fadeIn = 3; });
      sched.at(K.now() + 3.5, () => K.W.forkOff());
      sched.at(K.now() + 2.5, () => { if (!K.radioSeen) K.radio('Zentrale bestätigt', null); });
    } },
    m02_tor_faellt: { start() { T.swell(0.55, 8); sched.at(K.now() + 1.6, () => K.W.silence(0.35, 2.5)); } },
    m03_packerei: { start() { K.W.killRadio(); K.W.silence(0.3, 3); T.swell(0.7, 10); } },
    m04_keller_licht: { start() {
      T.swell(0.75, 14);
      // heavy breathing and shuffling from the technical room (e20 waking up)
      D().playAt('voice.breath.panic', 8.5, -2.2, 47.5, 0.6, 0.95, 2.2, (o) => { o.cat = 'voice'; });
      D().later(3.4, 'step.concrete', 9, -3.65, 47.6, 0.5);
      D().later(4.1, 'step.concrete', 9.6, -3.65, 47.4, 0.55);
    } },
    m05_halle_dunkel: { start() {
      T.swell(0.65, 12);
      // breakers drop one after another across the hall, then the hall goes quiet
      D().playAt('foley.switch', 30, 3, 2, 0.9, 0.8, 0, (o) => { o.ref = 6; o.clip = K.heavySwitch(); });
      D().later(0.35, 'foley.switch', 50, 3, 2, 0.8, 0.85);
      D().later(0.7, 'foley.switch', 70, 3, 2, 0.7, 0.9);
      K.W.silence(0.3, 6);
    } },
    m06_foerderband: { start() {
      // start-up warning horn at the drive, then the run-up (emitters) masks footsteps
      D().playAt('machine.alarm', 74.5, 1.5, 40, 1.0, 1, 0, (o) => { o.ref = 8; o.max = 90; });
      D().later(1.2, 'machine.pneumatic', 80, 1.2, 24, 0.8);
      T.swell(0.5, 6);
    } },
    m07_agv: { start() {
      const a = ctx.machines?.agv?.('agv2');
      const p = a?.group?.position ?? a?.pos;
      if (p) { const o = E.opts(); o.follow = p; o.fy = 0.4; o.gain = 0.55; o.dur = 9; o.offset = 6; o.cat = 'machine'; o.max = 45; E.play('machine.agv.pass', o); }
      T.swell(0.45, 5);
    } },
    m08_schrei: { start() { K.cue('cue.scream_room', null); T.swell(0.85, 12); } },
    m09_roboter: { start() {
      const r = ctx.layout.robots?.[0];
      if (r) { D().playAt('machine.pneumatic', r.base[0], r.base[1] + 1, r.base[2], 1.0, 0.9, 0, (o) => { o.ref = 5; o.dur = 2.5; }); D().later(0.2, 'machine.servo', r.base[0], r.base[1] + 1.5, r.base[2], 1); }
      T.swell(0.7, 8);
    } },
    m10_kuehl: { start() {
      D().playAt('machine.pneumatic', 86, 2, 56.7, 0.9, 0.85, 0, (o) => { o.dur = 2; });
      D().later(0.6, 'impact.sheetmetal', 93, 1, 60, 0.4, 0.6);
      T.swell(0.75, 12);
    } },
    extract: { start() { if (!K.radioSeen) K.radio('Bereich gesichert', null); T.scene = 0; T.dangerV = 0; } },
  };
  T.moment = (id, phase = 'start') => {
    const m = MOMENTS[id];
    T.moments++;
    if (!m) return false;
    (m[phase] ?? (phase === 'start' ? null : null))?.();
    return true;
  };
  T.momentIds = Object.keys(MOMENTS);
  T.reset = () => {
    T.dangerV = 0; T.exert = 0; T.scene = 0; T.sceneT = 0; peak = 0; recoverAt = -100; lastX = NaN;
    for (const k of Object.keys(T.h)) { if (T.h[k]) E.stop(T.h[k], 0.3); T.h[k] = 0; }
  };
  return T;
}
