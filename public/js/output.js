(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerpK = (dt, tau) => 1 - Math.exp(-dt / tau);
  const TAU = Math.PI * 2;
  const smooth01 = (x) => x * x * (3 - 2 * x); // smoothstep on 0..1
  const BEAT_ATTACK_S = 0.035;                  // how fast the beat swells into each kick
  const WAVE_RISE_S = 0.09;                     // how long the beat waveform takes to swell

  // ======================================================================== networking
  const socket = io({ transports: ['websocket', 'polling'] });
  const timeSync = new TimeSync(socket);
  // The display machine is host automatically; a display elsewhere on the network can enter the PIN.
  let hostPin = null;
  try { hostPin = sessionStorage.getItem('pulse.pin'); } catch (_) { /* ignore */ }
  const host = { is: false, pin: null };
  socket.on('connect', () => {
    socket.emit('hello', { role: 'output', controls: savedLook(), pin: hostPin || undefined });
  });
  socket.on('host:status', (st) => {
    host.is = !!st.host;
    host.pin = st.pin || null;
    if (onControls) onControls();
  });
  timeSync.start();
  // Reloading would drop audio capture and need another click on Start, so only offer it.
  watchServerBuild(socket, (kind) =>
    showBanner(STALE_TEXT[kind], kind === 'updated' ? { label: 'Reload', run: () => location.reload() } : null)
  );

  /** This display's last mode/FX; the server adopts it if nobody has changed the shared controls yet. */
  function savedLook() {
    const out = {};
    try {
      const m = parseInt(localStorage.getItem('pulse.mode'), 10);
      if (m >= 0) out.mode = m;
      const f = JSON.parse(localStorage.getItem('pulse.fx') || '{}');
      for (const k of ['kaleido', 'echo', 'bloom', 'ripple', 'invert']) if (typeof f[k] === 'boolean') out[k] = f[k];
    } catch (_) { /* ignore */ }
    return out;
  }

  // ======================================================================== shared animation controls
  /**
   * Mirrors the server's shared controls, which any phone or display can change (latest wins).
   * `ctl` is a per-frame smoothed copy so 15 Hz slider updates glide instead of stepping.
   */
  const controls = {
    heartbeat: true, mode: 0, kaleido: false, echo: false, bloom: false, ripple: false, invert: false, swap: false,
    lock: 'open', tempo: 62, chaos: 0.33, glow: 0.2, speed: 1, hue: 0,
  };
  const SMOOTHED = ['tempo', 'chaos', 'glow', 'speed', 'hue'];
  const ctl = { ...controls };
  let controlsReceived = false;
  let onControls = null; // set once the renderer exists: applies mode/FX and refreshes the UI

  socket.on('controls:state', (s) => {
    for (const k in controls) if (typeof s[k] === typeof controls[k]) controls[k] = s[k];
    if (!controlsReceived) Object.assign(ctl, controls);
    controlsReceived = true;
    if (onControls) onControls();
  });

  function setControl(patch) {
    Object.assign(controls, patch);
    socket.emit('controls:set', patch);
    if (onControls) onControls();
  }

  function updateControls(dt) {
    const k = lerpK(dt, 0.12);
    for (const key of SMOOTHED) ctl[key] += (controls[key] - ctl[key]) * k;
    ctl.heartbeat = controls.heartbeat;
    // Chaos is a macro: up to its default it scales the rhythm (calm below it), and above the
    // default it also bends, punches and glitches the picture (see runFx).
    const c = ctl.chaos;
    ctl.intensity = 0.25 + 2.25 * c;     // beat punch (1 at the default)
    ctl.heat = -0.6 + 1.8 * c;           // energy offset (0 at the default)
    ctl.breath = 0.2 + 2.4 * c;          // breathing depth (1 at the default)
    ctl.audio = 0.5 + 1.5 * c;           // audio gain (1 at the default)
    const wild = clamp((c - CHAOS_DEF) / (1 - CHAOS_DEF), 0, 1);
    ctl.warp = wild * wild;              // swirl and wobble
    ctl.punch = wild;                    // zoom-in on every beat
    ctl.glitch = clamp((c - 0.6) / 0.4, 0, 1); // RGB split on beats and bass hits
    // Glow is a macro too: dim and grey at 0, normal at its default, bright, vivid and blooming at 1.
    const g = ctl.glow;
    const lo = clamp(g / GLOW_DEF, 0, 1);
    const hi = clamp((g - GLOW_DEF) / (1 - GLOW_DEF), 0, 1);
    ctl.exposure = 0.35 + 0.65 * lo + 1.3 * hi;
    ctl.saturation = 0.2 + 0.8 * lo + 1.0 * hi;
    ctl.bloomBoost = 1.4 * hi;
  }
  const CHAOS_DEF = 0.33; // match ANIM_DEFS in server.js
  const GLOW_DEF = 0.2;

  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const url = info.inputUrls[0] || `${location.origin}/input.html`;
      $('joinUrl').textContent = url + (url.startsWith('https://') ? '' : '  (HTTPS needed for phone cameras)');
      $('qrCornerUrl').textContent = url.replace(/^https?:\/\//, '');
    })
    .catch(() => {
      $('joinUrl').textContent = `${location.origin}/input.html`;
      $('qrCornerUrl').textContent = `${location.host}/input.html`;
    });

  // ======================================================================== collective pulse
  /**
   * Converts the 15 Hz aggregated stream into smooth per-frame values. A local oscillator runs at
   * the room BPM so the visuals keep a steady rhythm even when many out-of-phase hearts are summed,
   * and real beats from phones nudge its phase and add shimmer on top.
   */
  const pulse = {
    bpm: 62,
    targetBpm: 0,
    phase: 0,
    kick: 0, // raw decaying beat impulse; `beat` is this scaled by the intensity control
    beat: 0,
    beatEvents: 0,
    strength: 0,
    targetStrength: 0,
    active: 0,
    sensors: 0,
    energy: 0,
    lastRealBeat: 0,
    wave: 0,
    breath: 0,
    phaseNudge: 0,   // beat-clock correction still to apply (spread over frames)
    motion: 0,       // smoothed movement energy of dancing phones
    targetMotion: 0,
    source: 'tempo', // what sets the rhythm: 'phones', 'music' or 'tempo'
    seenOnsets: 0,   // audio hits already turned into kicks
  };

  socket.on('pulse:agg', (a) => {
    pulse.active = a.active | 0;
    pulse.sensors = a.sensors | 0;
    if (a.bpm > 0) pulse.targetBpm = a.bpm;
    pulse.targetStrength = a.active > 0 ? clamp(0.35 + a.confidence, 0.35, 1) : 0;
    if (!controls.heartbeat) {
      // Live beat off: phones are shown in the HUD but don't drive anything.
      pulse.targetMotion = 0;
      return;
    }
    pulse.targetMotion = a.motion || 0;
    // Every beat kicks, even a first tap that has no BPM yet.
    if (a.beats > 0) {
      const n = Math.max(1, a.active);
      // Each tap/jolt/heartbeat lands visibly: sqrt keeps a single phone's beat strong in a full room.
      pulse.kick = Math.min(1.5, pulse.kick + (0.9 * a.beats) / Math.sqrt(n));
      pulse.lastRealBeat = performance.now();
      // Pull the oscillator toward observed beats; with many hearts the nudges average out.
      const at = pulse.phase + pulse.phaseNudge; // where the clock is headed, counting corrections in flight
      const frac = at - Math.round(at);
      pulse.phaseNudge -= (frac * 0.35) / n;
    }
  });

  // ---- Touch pad bursts from phones (see input.js): a tap ripples out from the spot it lands on,
  // drags leave small sparks, and taps from several phones at once merge into a rainbow shockwave.
  const MAX_BURSTS = 32; // size of the uBursts arrays in fx-pre.frag / fx-final.frag
  const bursts = [];     // { x, y (pad 0..1), hue (-1 = rainbow), power, age, life }
  const burstData = new Float32Array(MAX_BURSTS * 4);
  const burstHue = new Float32Array(MAX_BURSTS);

  function addBurst(b) {
    bursts.push(b);
    if (bursts.length <= MAX_BURSTS) return;
    // Full: drop whichever burst has the least left to show.
    let weakest = 0;
    let least = Infinity;
    bursts.forEach((o, i) => {
      const left = o.power * (1 - o.age / o.life);
      if (left < least) {
        least = left;
        weakest = i;
      }
    });
    bursts.splice(weakest, 1);
  }

  // ---- Stir and paint: drags from phones, used up by the next frame. In the fluid modes a stir
  // pushes the fluid and drops ink in the phone's colour; elsewhere it smudges the picture along the
  // finger. Paint strokes go onto their own layer that fades over a few seconds.
  const MAX_SMUDGES = 16;  // size of the uSmudges arrays in fx-pre.frag
  const STROKE_GAP_MS = 250; // drag samples further apart than this start a new stroke
  const strokes = [];      // this frame's segments: { x0, y0, x1, y1, vx, vy, hue, power, paint }
  const lastDrag = new Map(); // phone number -> { x, y, t } of its previous drag sample
  const smudges = [];      // { x, y, vx, vy (pad units), age }
  const smudgeData = new Float32Array(MAX_SMUDGES * 4);
  const smudgeAge = new Float32Array(MAX_SMUDGES);

  // Room-wide play: tilt, hold-together charge and the games (see server.js).
  const room = {
    tiltTarget: [0, 0], tilt: [0, 0], pan: [0, 0],
    chargeTarget: 0, charge: 0, blast: 0,
    game: { kind: null }, raceSplit: 0.5, raceOn: 0, passOn: 0, passHue: 0,
  };
  const HOLDER_POWER = 3; // the phone holding the colour hits this much harder

  const hasFluid = () => !!modes && (modes[current].id === 'fluid' || modes[current].id === 'juliafluid');

  /** Pass the colour boosts its holder; in a tap race everyone's touches turn their team's colour. */
  function touchStyle(e) {
    const g = room.game;
    if (g.kind === 'pass' && g.holder === e.n) return { hue: e.h, power: HOLDER_POWER };
    if (g.kind === 'race' && g.teams && g.teams[e.n] != null) return { hue: g.hues[g.teams[e.n]], power: 1 };
    return { hue: e.h, power: 1 };
  }

  socket.on('touch:fx', (e) => {
    const { hue, power } = touchStyle(e);
    if (e.d !== 1) {
      lastDrag.delete(e.n);
      addBurst({ x: e.x, y: e.y, hue, power: Math.min(2.5, power), age: 0, life: 1.8 });
      return;
    }
    const t = performance.now();
    const prev = lastDrag.get(e.n);
    const from = prev && t - prev.t < STROKE_GAP_MS ? prev : { x: e.x, y: e.y };
    lastDrag.set(e.n, { x: e.x, y: e.y, t });
    const vx = e.vx || 0;
    const vy = e.vy || 0;
    strokes.push({ x0: from.x, y0: from.y, x1: e.x, y1: e.y, vx, vy, hue, power, paint: e.p === 1 });
    if (e.p !== 1 && !hasFluid()) {
      smudges.unshift({ x: e.x, y: e.y, vx: vx * power, vy: vy * power, age: 0 });
      smudges.length = Math.min(smudges.length, MAX_SMUDGES);
    }
  });
  socket.on('touch:combo', (c) => {
    addBurst({ x: c.x, y: c.y, hue: -1, power: Math.min(4, 1.2 + 0.6 * c.size), age: 0, life: 2.6 });
    pulse.kick = Math.min(1.5, pulse.kick + 0.2 * Math.min(c.size, 5)); // the whole scene surges too
    showBig(`COMBO ×${c.size}`);
  });

  socket.on('tilt:agg', (t) => {
    room.tiltTarget = t.n > 0 ? [clamp(t.x, -1, 1), clamp(t.y, -1, 1)] : [0, 0];
  });
  socket.on('crowd:hold', (h) => {
    room.chargeTarget = clamp(h.charge, 0, 1);
  });
  // Letting go together: a rainbow blast from the middle, sized by how long the room held.
  socket.on('crowd:release', (r) => {
    const p = clamp(r.power, 0, 1);
    room.chargeTarget = 0;
    room.charge = 0;
    room.blast = p;
    addBurst({ x: 0.5, y: 0.5, hue: -1, power: 2 + 2 * p, age: 0, life: 3 });
    const hues = r.hues && r.hues.length ? r.hues : [-1];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      addBurst({ x: 0.5 + Math.cos(a) * 0.22, y: 0.5 + Math.sin(a) * 0.3, hue: hues[i % hues.length], power: 1 + p, age: 0, life: 2.2 });
    }
    pulse.kick = 1.5;
    showBig('BLAST!');
  });

  socket.on('game:state', (s) => {
    const was = room.game;
    room.game = s && s.kind ? s : { kind: null };
    const g = room.game;
    if (g.kind === 'race') {
      if (g.phase === 'countdown' && (was.kind !== 'race' || was.left !== g.left)) showBig(String(g.left));
      if (g.phase === 'live' && was.phase === 'countdown') showBig('GO!');
      if (g.phase === 'done' && was.phase !== 'done') showBig(g.winner < 0 ? 'TIE!' : `${g.winner === 0 ? 'RED' : 'BLUE'} WINS`);
    }
    if (g.kind === 'pass' && was.holder !== g.holder) room.passHue = g.hue;
    renderGameBanner();
  });

  function renderGameBanner() {
    const g = room.game;
    const el = $('gameBanner');
    el.hidden = !g.kind;
    if (!g.kind) return;
    el.textContent = '';
    const add = (cls, text, color) => {
      const s = document.createElement('span');
      if (cls) s.className = cls;
      if (color) s.style.color = color;
      s.textContent = text;
      el.appendChild(s);
    };
    const teamColor = (i) => `hsl(${Math.round(g.hues[i] * 360)} 95% 60%)`;
    if (g.kind === 'race') {
      add('team', `Red ${g.score[0]}`, teamColor(0));
      add('muted', g.phase === 'done' ? 'final' : g.phase === 'countdown' ? `starts in ${g.left}` : `${g.left}s`);
      add('team', `${g.score[1]} Blue`, teamColor(1));
    } else {
      add('dot', '', `hsl(${Math.round(g.hue * 360)} 95% 60%)`);
      add('', 'Pass the colour');
      add('muted', `${g.left}s`);
    }
  }

  /** Big centred text for combos, blasts and game moments. */
  function showBig(text) {
    const el = $('comboText');
    el.textContent = text;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
  }

  const TILT_PAN = 0.35;     // full tilt pans the picture this far (non-fluid modes)
  const TILT_FLUID = 1400;   // full tilt's pull on the fluid (texels/s²)
  const STIR_FORCE = 0.9;    // finger speed -> fluid velocity
  const BLAST_FORCE = 2600;

  /** Smooths the room's tilt, charge and game overlays; ages the smudges. */
  function updateRoom(dt) {
    const k = lerpK(dt, 0.25);
    room.tilt = room.tilt.map((v, i) => v + (room.tiltTarget[i] - v) * k);
    const panTo = hasFluid() ? [0, 0] : room.tilt.map((v) => v * TILT_PAN);
    room.pan = room.pan.map((v, i) => v + (panTo[i] - v) * lerpK(dt, 0.4));
    room.charge += (room.chargeTarget - room.charge) * lerpK(dt, 0.15);
    const g = room.game;
    room.raceOn += ((g.kind === 'race' ? (g.phase === 'countdown' ? 0.35 : 1) : 0) - room.raceOn) * lerpK(dt, 0.3);
    if (g.kind === 'race') {
      const total = g.score[0] + g.score[1];
      room.raceSplit += ((total > 0 ? g.score[0] / total : 0.5) - room.raceSplit) * lerpK(dt, 0.3);
    }
    room.passOn += ((g.kind === 'pass' ? 1 : 0) - room.passOn) * lerpK(dt, 0.4);
    if (g.kind === 'pass') room.passHue = g.hue;
    for (let i = smudges.length - 1; i >= 0; i--) {
      smudges[i].age += dt;
      if (smudges[i].age > 1.4) smudges.splice(i, 1);
    }
  }

  /** Packs the smudges for fx-pre.frag: xy spot and zw finger velocity, in its aspectUv space. */
  function smudgeUniforms() {
    if (hasFluid()) return 0;
    const aspect = canvas.width / Math.max(1, canvas.height);
    smudges.forEach((s, i) => {
      smudgeData[i * 4] = (s.x * 2 - 1) * aspect;
      smudgeData[i * 4 + 1] = 1 - s.y * 2;
      smudgeData[i * 4 + 2] = s.vx * 2 * aspect;
      smudgeData[i * 4 + 3] = -s.vy * 2;
      smudgeAge[i] = s.age;
    });
    return smudges.length;
  }

  /** Phones' stirs, the room's tilt and any blast, pushed into a fluid sim (from its update). */
  function touchFluid(f, dt) {
    const [tw, th] = f.vel.texel;
    for (const s of strokes) {
      if (s.paint) continue;
      const len = Math.hypot((s.x1 - s.x0) * f.aspect, s.y1 - s.y0);
      const steps = Math.min(6, 1 + Math.floor(len / 0.025));
      const vx = clamp((s.vx / tw) * STIR_FORCE, -3000, 3000) * s.power;
      const vy = clamp((-s.vy / th) * STIR_FORCE, -3000, 3000) * s.power;
      const ink = hsv(s.hue < 0 ? 0 : s.hue, 0.85, Math.min(1.2, 0.5 * s.power) / Math.sqrt(steps));
      for (let i = 1; i <= steps; i++) {
        const x = s.x0 + ((s.x1 - s.x0) * i) / steps;
        const y = 1 - (s.y0 + ((s.y1 - s.y0) * i) / steps);
        f.splat(f.vel, x, y, [vx, vy, 0], 0.0022);
        f.splat(f.dye, x, y, ink, 0.0016);
      }
    }
    const [gx, gy] = room.tilt;
    if (Math.abs(gx) + Math.abs(gy) > 0.02) f.splat(f.vel, 0.5, 0.5, [gx * TILT_FLUID * dt, -gy * TILT_FLUID * dt, 0], 2);
    if (room.blast > 0) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * TAU;
        const x = 0.5 + (Math.cos(a) * 0.06) / f.aspect;
        const y = 0.5 + Math.sin(a) * 0.06;
        f.splat(f.vel, x, y, [Math.cos(a) * BLAST_FORCE * room.blast, Math.sin(a) * BLAST_FORCE * room.blast, 0], 0.006);
        f.splat(f.dye, x, y, hsv(i / 8, 0.9, 1.2 * room.blast), 0.004);
      }
    }
  }

  // ---- Paint layer: strokes stamped into their own texture that fades every frame. Its size follows
  // the window's shape only, so the display's adaptive resolution never wipes it.
  const PAINT_FADE_S = 2.5; // strokes lose about two thirds of their brightness in this time
  const PAINT_SIZE = 480;   // short side of the paint texture, in texels
  const paint = { layer: null, left: 0 }; // `left`: seconds until the layer is surely blank

  function updatePaint(dt) {
    const fresh = strokes.filter((s) => s.paint);
    if (!fresh.length && paint.left <= 0) return false;
    const [w, h] = simSize(PAINT_SIZE);
    if (!paint.layer || paint.layer.w !== w || paint.layer.h !== h) {
      if (paint.layer) paint.layer.destroy();
      paint.layer = createDouble(w, h, fluidFmt);
    }
    const L = paint.layer;
    draw(programs['fluid-scale'], { uSource: L.read.tex, uValue: Math.exp(-dt / PAINT_FADE_S) }, L.write);
    L.swap();
    const aspect = w / h;
    for (const s of fresh) {
      const len = Math.hypot((s.x1 - s.x0) * aspect, s.y1 - s.y0);
      const steps = Math.min(10, 1 + Math.floor(len / 0.012));
      const col = hsv(s.hue < 0 ? 0 : s.hue, 0.8, 0.55 + 0.15 * Math.min(s.power, 2));
      for (let i = 1; i <= steps; i++) {
        draw(programs['fluid-splat'], {
          uTarget: L.read.tex,
          uPoint: [s.x0 + ((s.x1 - s.x0) * i) / steps, 1 - (s.y0 + ((s.y1 - s.y0) * i) / steps)],
          uColor: col,
          uRadius: 0.00035 * Math.min(s.power, 2),
          uAspect: aspect,
        }, L.write);
        L.swap();
      }
    }
    if (fresh.length) paint.left = PAINT_FADE_S * 5;
    paint.left -= dt;
    return true;
  }

  /** Ages the bursts (real time) and packs them for the shaders: xy in aspectUv space, z age, w power. */
  function burstUniforms(dt) {
    const aspect = canvas.width / Math.max(1, canvas.height);
    for (let i = bursts.length - 1; i >= 0; i--) {
      bursts[i].age += dt;
      if (bursts[i].age >= bursts[i].life) bursts.splice(i, 1);
    }
    bursts.forEach((b, i) => {
      burstData[i * 4] = (b.x * 2 - 1) * aspect;
      burstData[i * 4 + 1] = 1 - b.y * 2;
      burstData[i * 4 + 2] = b.age;
      burstData[i * 4 + 3] = b.power;
      burstHue[i] = b.hue;
    });
    return bursts.length;
  }

  // ---- Music beat: with nobody sending a rhythm, the beat clock follows the song. Bass onsets from
  // the last 8 s are tested against every tempo from 70 to 180 BPM; the tempo they line up with best
  // (and where on it they land) becomes the beat.
  const music = { onsets: [], seen: 0, bpm: 0, phase: 0, conf: 0, candidate: 0, nextEval: 0 };
  const MUSIC_WINDOW_S = 8;
  const MUSIC_MIN_ONSETS = 6;

  function trackMusicBeat(nowMs) {
    const now = nowMs / 1000;
    if (audio.onsetEvents !== music.seen) {
      music.seen = audio.onsetEvents;
      music.onsets.push(now);
    }
    while (music.onsets.length && now - music.onsets[0] > MUSIC_WINDOW_S) music.onsets.shift();
    if (now < music.nextEval) return;
    music.nextEval = now + 0.5;
    const n = music.onsets.length;
    if (n < MUSIC_MIN_ONSETS) {
      music.conf = Math.max(0, music.conf - 0.25);
      return;
    }
    // Phase coherence: onsets on the beat all point the same way on a circle that turns once per beat.
    // The half-beat circle is scored too, so bass on the off-beats doesn't cancel the beat out.
    let best = 0;
    let bestBpm = 0;
    let bestPhase = 0;
    const scores = [];
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const w = (TAU * bpm) / 60;
      let re = 0;
      let im = 0;
      let re2 = 0;
      let im2 = 0;
      for (const t of music.onsets) {
        re += Math.cos(w * t);
        im += Math.sin(w * t);
        re2 += Math.cos(2 * w * t);
        im2 += Math.sin(2 * w * t);
      }
      // A slight pull toward ~115 BPM settles double/half-tempo ties.
      const coherence = (Math.hypot(re, im) + 0.5 * Math.hypot(re2, im2)) / (1.5 * n);
      const score = coherence * (0.9 + 0.1 * Math.exp(-((Math.log2(bpm / 115)) ** 2) / 0.5));
      scores.push(score);
      if (score > best) {
        best = score;
        bestBpm = bpm;
        bestPhase = Math.atan2(im, re) / TAU; // beats fall where bpm/60 * t - bestPhase is a whole number
      }
    }
    // A real beat stands well above the typical tempo (random hits score about 2x the median at
    // best) and stays put between checks (random hits jump to a new tempo every time).
    scores.sort((a, b) => a - b);
    const ratio = best / Math.max(1e-6, scores[scores.length >> 1]);
    const steady = Math.abs(bestBpm - music.candidate) <= music.candidate * 0.03;
    music.candidate = bestBpm;
    const conf = steady ? clamp((ratio - 2.2) / 2, 0, 1) : 0;
    music.conf += (conf - music.conf) * 0.5;
    if (conf > 0.2) {
      music.bpm = bestBpm;
      music.phase = bestPhase;
    }
  }

  function updatePulse(dt, nowMs) {
    trackMusicBeat(nowMs);
    // What sets the rhythm, in order: phones (taps, dancers, hearts), the music's beat, the Tempo
    // control. Live beat off = manual mode: Tempo drives a full-strength synthetic beat.
    const manual = !ctl.heartbeat;
    const real = !manual && pulse.targetStrength > 0;
    const onMusic = !manual && !real && music.conf > 0.3 && music.bpm > 0;
    pulse.source = real ? 'phones' : onMusic ? 'music' : 'tempo';
    const goal = real && pulse.targetBpm > 0 ? pulse.targetBpm : onMusic ? music.bpm : ctl.tempo;
    pulse.bpm += (goal - pulse.bpm) * lerpK(dt, manual ? 0.4 : onMusic ? 0.6 : 1.5);
    pulse.strength += ((manual ? 1 : onMusic ? 0.8 : pulse.targetStrength) - pulse.strength) * lerpK(dt, 1.0);

    const prev = pulse.phase;
    pulse.phase += (dt * pulse.bpm) / 60;
    // Phase corrections from phones' beats are spread over a fraction of a second, not jumped.
    const nudge = pulse.phaseNudge * lerpK(dt, 0.25);
    pulse.phase += nudge;
    pulse.phaseNudge -= nudge;
    if (onMusic) {
      // Pull the beat clock onto the song's beats.
      const want = (nowMs / 1000) * (music.bpm / 60) - music.phase;
      let off = (want - pulse.phase) % 1;
      if (off > 0.5) off -= 1;
      if (off < -0.5) off += 1;
      pulse.phase += off * lerpK(dt, 0.4);
    }
    if (Math.floor(pulse.phase) > Math.floor(prev)) {
      pulse.beatEvents++;
      const sinceReal = nowMs - pulse.lastRealBeat;
      const period = 60000 / Math.max(30, pulse.bpm);
      const sinceHit = nowMs - audio.lastOnsetMs;
      let k;
      if (manual || onMusic) k = 0.75;
      // A phone's beat just kicked: the clock only fills the gaps, so taps aren't doubled up.
      else if (real) k = sinceReal < period * 0.6 ? 0 : sinceReal < 2500 ? 0.75 : 0.6;
      // Music playing without a locked tempo: its own hits kick (below), the metronome stays faint.
      else k = sinceHit < 1500 ? 0.12 : 0.35;
      pulse.kick = Math.max(pulse.kick, k);
    }
    // With no phones setting the rhythm, every bass hit in the music kicks the scene directly.
    if (!manual && !real && audio.onsetEvents !== pulse.seenOnsets) {
      pulse.kick = Math.min(1.5, Math.max(pulse.kick, 0.35 + 0.5 * audio.onsetRaw));
    }
    pulse.seenOnsets = audio.onsetEvents;
    pulse.kick *= Math.exp(-dt * 4);
    // Every effect reads `beat`, so it is the one place beats are smoothed: it swells into each
    // kick over ~60 ms instead of jumping in one frame, then fades with it.
    const target = pulse.kick * ctl.intensity;
    pulse.beat += (target - pulse.beat) * lerpK(dt, target > pulse.beat ? BEAT_ATTACK_S : 0.05);

    // Beat waveform: a smooth swell and fade, then a softer second bump, back to ~0 before the next
    // beat so nothing jumps when the phase wraps.
    const f = pulse.phase - Math.floor(pulse.phase);
    const rise = Math.min(0.3, (WAVE_RISE_S * pulse.bpm) / 60); // the swell takes the same time at any tempo
    const swell = f < rise ? smooth01(f / rise) : Math.exp(-(f - rise) * 6);
    const echo = 0.5 * Math.exp(-(((f - 0.3) / 0.07) ** 2));
    pulse.wave = clamp((Math.max(swell, echo) * (0.45 + 0.55 * pulse.strength) * ctl.intensity + 0.4 * pulse.beat), 0, 1);
    pulse.breath = Math.sin((pulse.phase / 4) * TAU) * ctl.breath;

    // Dancers heat the room up: the harder they move, the wilder every mode gets. Rises quickly
    // (a burst of dancing shows within a beat), cools off more gently.
    pulse.motion += (pulse.targetMotion - pulse.motion) * lerpK(dt, pulse.targetMotion > pulse.motion ? 0.15 : 0.6);
    // 50 BPM is calm, 170 is flat out, so dance tempos (120-130) sit in the middle with room to go.
    const heat = clamp((pulse.bpm - 50) / 120, 0, 1) * (0.4 + 0.6 * pulse.strength);
    // With no phones, the music's loudness heats the room too, so a drop is felt in the motion.
    const sound = real || manual ? 0 : 0.45 * audio.level;
    const heatGoal = clamp(heat + 0.3 * pulse.beat + 0.8 * pulse.motion + sound + ctl.heat, 0, 1);
    pulse.energy += (heatGoal - pulse.energy) * lerpK(dt, heatGoal > pulse.energy ? 0.25 : 0.7);
  }

  // ======================================================================== audio FFT
  const FFT_BINS = 64;
  const audio = {
    ctx: null,
    analyser: null,
    stream: null,
    source: null,
    freq: null,
    bins: new Uint8Array(FFT_BINS),
    bass: 0,
    mid: 0,
    treble: 0,
    level: 0,
    onset: 0,        // smoothed bass-hit envelope (what effects read)
    onsetRaw: 0,     // the detector's own spike
    onsetEvents: 0,
    lastOnsetMs: -1e9,
    // Per-band adaptive range [floor, ceiling]: each band is stretched over the span it actually
    // moves in, so a track's dynamics reach the visuals instead of sitting near a constant.
    range: { bass: [0, 0.1], mid: [0, 0.1], treble: [0, 0.1] },
    prevBins: new Float32Array(FFT_BINS),
    fluxMean: 0,     // running mean / mean deviation of bass flux: the hit threshold adapts to the track
    fluxDev: 0.02,
    // Treble hits (hi-hats, snares, claps), detected like the bass hits but over 2-11 kHz. They
    // come several per beat, so they only drive small, short effects ("sparks"), never the beat.
    spark: 0,        // smoothed flash envelope (what effects read)
    sparkRaw: 0,
    sparkEvents: 0,
    lastSparkMs: -1e9,
    sFluxMean: 0,
    sFluxDev: 0.02,
    bandRanges: null,
    mode: 'off',
  };
  const AUDIO_ATTACK_S = 0.025; // band envelopes jump up this fast...
  const AUDIO_RELEASE_S = 0.14; // ...and let go this fast
  const ONSET_GAP_MS = 110;     // two bass hits can't be closer than this (~16th notes at 136 BPM)
  const SPARK_GAP_MS = 70;      // treble hits can come faster (hi-hat rolls)


  function ensureAudioContext() {
    if (!audio.ctx) {
      audio.ctx = new (window.AudioContext || window.webkitAudioContext)();
      audio.freq = new Uint8Array(1024);
      audio.bandRanges = buildBandRanges(audio.ctx.sampleRate, 2048);
    }
    return audio.ctx;
  }

  function makeAnalyser() {
    const analyser = audio.ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3; // low, so hits aren't smeared before we see them
    analyser.minDecibels = -90;
    analyser.maxDecibels = -15;
    return analyser;
  }

  /**
   * Captures the computer's system audio (whatever it plays: YouTube, Spotify, anything) for
   * analysis. Chrome only offers system audio with a screen share, so the cheapest possible video is requested and
   * switched off; a whole-screen share also avoids Chrome's coloured "shared tab" outline.
   */
  async function connectAudio() {
    disconnectAudio();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      throw new Error('This browser can\'t share system audio. Use Chrome or Edge.');
    }
    ensureAudioContext();
    await audio.ctx.resume();
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    const video = { frameRate: { ideal: 1 }, width: { ideal: 320 }, height: { ideal: 180 }, displaySurface: 'monitor' };
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video, audio: raw, systemAudio: 'include', selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include', surfaceSwitching: 'exclude',
    });
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio shared: pick “Entire screen” and tick “Also share system audio”.');
    }
    stream.getVideoTracks().forEach((t) => (t.enabled = false));
    const analyser = makeAnalyser();
    const source = audio.ctx.createMediaStreamSource(stream);
    // Analyse only; never route to the speakers (the computer is already playing it).
    source.connect(analyser);

    audio.stream = stream;
    audio.source = source;
    audio.analyser = analyser;
    audio.mode = 'system';
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      disconnectAudio();
      setAudioStatus('Audio sharing stopped. Click the spectrum to share again.');
    });
    setAudioStatus('');
  }

  function disconnectAudio() {
    if (audio.stream) audio.stream.getTracks().forEach((t) => t.stop());
    if (audio.source) audio.source.disconnect();
    audio.stream = audio.source = audio.analyser = null;
    audio.mode = 'off';
  }

  function buildBandRanges(sampleRate, fftSize) {
    const hzPerBin = sampleRate / fftSize;
    const maxBin = fftSize / 2 - 1;
    const lo = 30;
    const hi = 16000;
    const ranges = [];
    for (let i = 0; i < FFT_BINS; i++) {
      const f0 = lo * Math.pow(hi / lo, i / FFT_BINS);
      const f1 = lo * Math.pow(hi / lo, (i + 1) / FFT_BINS);
      const b0 = clamp(Math.floor(f0 / hzPerBin), 0, maxBin);
      const b1 = clamp(Math.max(b0 + 1, Math.ceil(f1 / hzPerBin)), 1, maxBin + 1);
      ranges.push([b0, b1, f0]);
    }
    return ranges;
  }

  /**
   * Maps a band's raw level onto 0..1 over the range it has recently moved in. The ceiling jumps to
   * new peaks and sinks over a few seconds; the floor drops to troughs at once and creeps up slowly.
   * A share of the plain (ceiling-relative) level is kept so a loud, steady passage still reads loud.
   */
  function normBand(r, x, dt) {
    r[1] = Math.max(x, r[1] * Math.exp(-dt / 4), 0.1);
    r[0] = x < r[0] ? x : r[0] + (x - r[0]) * lerpK(dt, 2.5);
    const span = Math.max(0.15, r[1] - r[0]); // below this it's noise: don't stretch it into jitter
    const dyn = clamp((x - r[0]) / span, 0, 1);
    return 0.3 * (x / r[1]) + 0.7 * dyn;
  }

  function updateAudio(dt, nowMs) {
    let bass = 0, mid = 0, treble = 0, nb = 0, nm = 0, nt = 0;
    let flux = 0;  // how much the bass bins rose since last frame (spectral flux)
    let sflux = 0; // the same over the treble bins
    const analyser = audio.analyser;
    if (analyser) {
      analyser.getByteFrequencyData(audio.freq);
      for (let i = 0; i < FFT_BINS; i++) {
        const [b0, b1, f0] = audio.bandRanges[i];
        let m = 0;
        for (let k = b0; k < b1; k++) if (audio.freq[k] > m) m = audio.freq[k];
        audio.bins[i] = m;
        const v = m / 255;
        if (f0 < 160) {
          bass += v; nb++;
          flux += Math.max(0, v - audio.prevBins[i]);
        } else if (f0 < 2000) { mid += v; nm++; }
        else if (f0 < 11000) {
          treble += v; nt++;
          sflux += Math.max(0, v - audio.prevBins[i]);
        }
        audio.prevBins[i] = v;
      }
      bass /= nb || 1;
      mid /= nm || 1;
      treble /= nt || 1;
      flux /= nb || 1;
      sflux /= nt || 1;
    } else {
      audio.bins.fill(0);
      audio.prevBins.fill(0);
    }

    // Fast attack, short release, so each hit and each drop shows up right away.
    const g = ctl.audio; // the audio-reactivity control scales everything, including hits
    const env = (cur, target) => cur + (target - cur) * lerpK(dt, target > cur ? AUDIO_ATTACK_S : AUDIO_RELEASE_S);
    audio.bass = env(audio.bass, clamp(normBand(audio.range.bass, bass, dt) * g, 0, 1));
    audio.mid = env(audio.mid, clamp(normBand(audio.range.mid, mid, dt) * g, 0, 1));
    audio.treble = env(audio.treble, clamp(normBand(audio.range.treble, treble, dt) * g, 0, 1));
    audio.level = (audio.bass + audio.mid + audio.treble) / 3;

    // Bass hits: flux well above what this track usually does (adaptive threshold), so quiet and
    // loud songs, sparse and busy ones, all register their kicks. Flux is per 60 Hz frame.
    const f = flux / clamp(dt * 60, 0.25, 4);
    const thresh = audio.fluxMean + 2.2 * audio.fluxDev + 0.015 / Math.max(0.3, g);
    if (analyser && f > thresh && nowMs - audio.lastOnsetMs > ONSET_GAP_MS) {
      audio.lastOnsetMs = nowMs;
      audio.onsetEvents++;
      // Harder hits (further above the threshold) flash harder.
      audio.onsetRaw = Math.max(audio.onsetRaw, clamp((0.6 + (f - thresh) / Math.max(thresh, 0.01)) * g, 0, 1.4));
    }
    const kf = lerpK(dt, 1.2);
    audio.fluxMean += (f - audio.fluxMean) * kf;
    audio.fluxDev += (Math.abs(f - audio.fluxMean) - audio.fluxDev) * kf;
    audio.onsetRaw *= Math.exp(-dt * 7);
    // What effects see: swells into each hit over ~20 ms instead of jumping, then fades with it.
    audio.onset += (audio.onsetRaw - audio.onset) * lerpK(dt, audio.onsetRaw > audio.onset ? 0.02 : 0.05);

    // Treble hits: same adaptive test, own statistics (cymbal hiss sets a higher floor than bass).
    const sf = sflux / clamp(dt * 60, 0.25, 4);
    const sThresh = audio.sFluxMean + 2.5 * audio.sFluxDev + 0.012 / Math.max(0.3, g);
    if (analyser && sf > sThresh && nowMs - audio.lastSparkMs > SPARK_GAP_MS) {
      audio.lastSparkMs = nowMs;
      audio.sparkEvents++;
      audio.sparkRaw = Math.max(audio.sparkRaw, clamp((0.5 + (sf - sThresh) / Math.max(sThresh, 0.01)) * g, 0, 1));
    }
    audio.sFluxMean += (sf - audio.sFluxMean) * kf;
    audio.sFluxDev += (Math.abs(sf - audio.sFluxMean) - audio.sFluxDev) * kf;
    audio.sparkRaw *= Math.exp(-dt * 14); // gone in ~0.15 s, so a hi-hat pattern glitters instead of strobing
    audio.spark += (audio.sparkRaw - audio.spark) * lerpK(dt, audio.sparkRaw > audio.spark ? 0.012 : 0.03);
  }

  /** Only problems are shown; while audio flows, the spectrum says enough. */
  function setAudioStatus(t) {
    $('audioStatus').textContent = t;
    $('audioStatus').hidden = !t;
  }

  // ======================================================================== WebGL core
  const canvas = $('gl');
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    alpha: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) {
    fatal('WebGL2 is not available in this browser/GPU.');
    return;
  }
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    fatal('GPU context lost — reloading…');
    setTimeout(() => location.reload(), 1500);
  });

  const extFloat = gl.getExtension('EXT_color_buffer_float');
  const extHalf = extFloat ? null : gl.getExtension('EXT_color_buffer_half_float');
  const extFloatLinear = gl.getExtension('OES_texture_float_linear');
  const FMT = {
    rgba8: { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, linear: true },
    half: { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, linear: true },
    float: { internal: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, linear: !!extFloatLinear },
  };
  const fluidFmt = extFloat || extHalf ? FMT.half : FMT.rgba8;
  // Gray-Scott needs full float precision: its per-step increments are below half-float epsilon.
  const rdFmt = extFloat ? FMT.float : fluidFmt;

  gl.bindVertexArray(gl.createVertexArray());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  function createTarget(w, h, fmt, { wrap = gl.CLAMP_TO_EDGE, filter } = {}) {
    const tex = gl.createTexture();
    const f = filter || (fmt.linear ? gl.LINEAR : gl.NEAREST);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) console.warn('Framebuffer incomplete', status, fmt);
    return { tex, fbo, w, h, texel: [1 / w, 1 / h] };
  }

  function destroyTarget(t) {
    if (!t) return;
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  }

  function createDouble(w, h, fmt, opts) {
    let a = createTarget(w, h, fmt, opts);
    let b = createTarget(w, h, fmt, opts);
    return {
      w, h, texel: a.texel,
      get read() { return a; },
      get write() { return b; },
      swap() { const t = a; a = b; b = t; },
      destroy() { destroyTarget(a); destroyTarget(b); },
    };
  }

  class Program {
    constructor(vs, fragSrc, name) {
      const fs = compile(gl.FRAGMENT_SHADER, fragSrc, name);
      const p = gl.createProgram();
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`Link failed (${name}): ${gl.getProgramInfoLog(p)}`);
      }
      this.p = p;
      this.u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        // Arrays are reported as "name[0]"; they're set by their bare name from a flat typed array.
        this.u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type, size: info.size };
      }
    }
  }

  function compile(type, src, name) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile failed (${name}):\n${gl.getShaderInfoLog(s)}`);
    }
    return s;
  }

  /** Draw a fullscreen pass. `target` null = screen. Uniform types are inferred from the program. */
  function draw(prog, uniforms, target) {
    gl.useProgram(prog.p);
    let unit = 0;
    for (const name in prog.u) {
      const { loc, type, size } = prog.u[name];
      if (!(name in uniforms)) {
        // Never leave an active sampler pointing at a stale unit (could be the render target).
        if (type === gl.SAMPLER_2D) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, null);
          gl.uniform1i(loc, unit++);
        }
        continue;
      }
      const v = uniforms[name];
      switch (type) {
        case gl.FLOAT:
          if (size > 1) gl.uniform1fv(loc, v);
          else gl.uniform1f(loc, v);
          break;
        case gl.FLOAT_VEC2:
          if (size > 1) gl.uniform2fv(loc, v);
          else gl.uniform2f(loc, v[0], v[1]);
          break;
        case gl.FLOAT_VEC3: gl.uniform3f(loc, v[0], v[1], v[2]); break;
        case gl.FLOAT_VEC4:
          if (size > 1) gl.uniform4fv(loc, v);
          else gl.uniform4f(loc, v[0], v[1], v[2], v[3]);
          break;
        case gl.INT: gl.uniform1i(loc, v); break;
        case gl.SAMPLER_2D:
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, v);
          gl.uniform1i(loc, unit++);
          break;
        default: break;
      }
    }
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // FFT texture: 64x1, single channel.
  const fftTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, fftTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, FFT_BINS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, audio.bins);

  // ======================================================================== shader loading
  const FRAG_FILES = [
    'domain-warp', 'rd-sim', 'rd-display', 'julia', 'mandelbrot', 'julia-fluid', 'composite',
    'fluid-advect', 'fluid-curl', 'fluid-vorticity', 'fluid-divergence', 'fluid-pressure',
    'fluid-gradient', 'fluid-splat', 'fluid-scale', 'fluid-display',
    'fx-pre', 'fx-feedback', 'fx-bright', 'fx-blur', 'fx-final', 'fractal3d',
    'star-iris', 'nebula-portals',
  ];

  async function loadText(path) {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`Failed to load ${path}`);
    return (await r.text()).replace(/^\uFEFF/, '');
  }

  async function loadPrograms() {
    const [vsSrc, common, ...frags] = await Promise.all([
      loadText('shaders/quad.vert'),
      loadText('shaders/common.glsl'),
      ...FRAG_FILES.map((f) => loadText(`shaders/${f}.frag`)),
    ]);
    const vs = compile(gl.VERTEX_SHADER, vsSrc, 'quad.vert');
    const progs = {};
    FRAG_FILES.forEach((name, i) => {
      progs[name] = new Program(vs, `#version 300 es\n${common}\n#line 1\n${frags[i]}`, name);
    });
    return progs;
  }

  // ======================================================================== drive routing
  /**
   * What every mode and FX reads instead of `pulse` / `audio` directly.
   * Normal: the beat (hearts, taps, dancers) moves the picture and the sound turns the colours.
   * Swapped (shared `swap` control): the sound moves the picture and the phones' beat turns the
   * colours. Swapped, only phones colour the picture: the beat clock's music/tempo fallback doesn't.
   */
  const drv = {
    energy: 0, beat: 0, breath: 0, wave: 0, bass: 0, mid: 0, treble: 0, level: 0, onset: 0,
    mix: 0,    // 0 = normal routing, 1 = swapped (glides between the two)
    phones: 0, // smoothed: 1 while phones set the rhythm
    sway: 0,   // the sound's own slow breathing clock while swapped
    hue: 0,    // whole-palette turn driven by the colour source (turns)
    beatEvents: 0, // motion beats: the phones' beats normally, the sound's hits when swapped
    seenBeats: 0,
    seenOnsets: 0,
    thump: 0,  // swapped: how hard the bass is hitting right now (0..1)
  };

  function updateDrive(dt) {
    drv.mix += ((controls.swap ? 1 : 0) - drv.mix) * lerpK(dt, 0.4);
    drv.phones += ((pulse.source === 'phones' ? 1 : 0) - drv.phones) * lerpK(dt, 0.5);
    const m = drv.mix;
    const lerp = (a, b) => a + (b - a) * m;
    // Motion from the sound: bass hits are the beat, loudness the energy, the level sets the sway.
    drv.sway += dt * (0.1 + 0.6 * audio.level);
    const sndEnergy = clamp(0.1 + 1.1 * audio.level + 0.4 * audio.bass + ctl.heat, 0, 1);
    const sndBeat = clamp(1.4 * audio.onset * ctl.intensity, 0, 1.5);
    const sndBreath = Math.sin(drv.sway * TAU) * ctl.breath * (0.3 + 0.9 * audio.level);
    const sndWave = clamp((0.8 * audio.bass + 0.6 * audio.onset) * ctl.intensity, 0, 1);
    // Colour from the phones: their beat throb, how hard they dance or tap.
    const ph = drv.phones;
    const hWave = pulse.wave * ph;
    const hBeat = pulse.beat * ph;
    const hHeat = clamp(0.5 * pulse.energy * ph + 0.6 * hWave + 0.6 * pulse.motion, 0, 1);
    drv.energy = lerp(pulse.energy, sndEnergy);
    drv.beat = lerp(pulse.beat, sndBeat);
    drv.breath = lerp(pulse.breath, sndBreath);
    drv.wave = lerp(pulse.wave, sndWave);
    drv.bass = lerp(audio.bass, hWave);
    drv.mid = lerp(audio.mid, hHeat);
    drv.treble = lerp(audio.treble, hBeat);
    drv.level = lerp(audio.level, clamp(0.4 * pulse.energy * ph + 0.6 * hWave, 0, 1));
    drv.onset = lerp(audio.onset, hBeat);
    // The colour source also turns the whole palette: sound hits normally, phone beats when swapped.
    const sndHue = 0.06 * audio.level + 0.35 * audio.onset + 0.2 * audio.spark; // hi-hats flicker the hue a little
    const beatHue = 0.3 * hWave + 0.15 * pulse.motion;
    drv.hue = (drv.hue + dt * lerp(sndHue, beatHue)) % 1;
    const beats = pulse.beatEvents - drv.seenBeats;
    const hits = audio.onsetEvents - drv.seenOnsets;
    drv.seenBeats = pulse.beatEvents;
    drv.seenOnsets = audio.onsetEvents;
    drv.beatEvents += controls.swap ? hits : beats;
    // Bass thump: low bass reads as nothing, a hit as 1; it snaps up and lets go quickly.
    const hit = Math.max(smooth01(clamp((audio.bass - 0.35) / 0.6, 0, 1)), audio.onset) * m;
    drv.thump += (hit - drv.thump) * lerpK(dt, hit > drv.thump ? 0.02 : 0.12);
  }

  // ======================================================================== modes
  function hsv(h, s, v) {
    const f = (n) => {
      const k = (n + h * 6) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
  }

  function simSize(shortSide) {
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    return aspect >= 1
      ? [Math.round(shortSide * aspect), shortSide]
      : [shortSide, Math.round(shortSide / aspect)];
  }

  function createModes(P) {
    const warp = {
      id: 'warp',
      label: 'Domain Warp',
      t: 0,
      shift: [0, 0, 0],
      update(dt) {
        this.t += dt * (0.25 + 0.6 * drv.energy + 0.5 * drv.beat);
        this.shift[0] += dt * (0.01 + 0.18 * drv.bass);
        this.shift[1] += dt * (0.008 + 0.14 * drv.mid);
        this.shift[2] += dt * (0.006 + 0.14 * drv.treble);
      },
      render(target, U) {
        const s = pulse.strength;
        draw(P['domain-warp'], {
          ...U,
          uWarpTime: this.t,
          uWarpAmp: 1.4 + 0.8 * drv.breath * (0.35 + 0.65 * s) + 0.6 * drv.beat,
          uPaletteShift: [
            this.shift[0] + 0.25 * drv.bass,
            this.shift[1] + 0.2 * drv.mid,
            this.shift[2] + 0.2 * drv.treble,
          ],
        }, target);
      },
    };

    const rd = {
      id: 'rd',
      label: 'Reaction-Diffusion',
      state: null,
      size: null,
      needsInit: true,
      heat: 0,
      lastBeat: 0,
      hue: 0,
      ensure() {
        const [w, h] = simSize(Math.min(540, Math.ceil(canvas.clientHeight * 0.6)));
        if (this.state && Math.abs(this.size[0] / this.size[1] - w / h) < 0.02) return;
        if (this.state) this.state.destroy();
        this.state = createDouble(w, h, rdFmt, { wrap: gl.REPEAT });
        this.size = [w, h];
        this.needsInit = true;
      },
      update(dt, U) {
        this.ensure();
        const st = this.state;
        const base = { ...U, uTexel: st.texel, uSimAspect: st.w / st.h, uDt: 1.0, uSeed: [0, 0, 0] };
        if (this.needsInit) {
          draw(P['rd-sim'], { ...base, uInit: 1, uState: st.read.tex }, st.write);
          st.swap();
          this.needsInit = false;
        }
        this.heat += (clamp(drv.energy * 0.9 + drv.beat * 0.3, 0, 1) - this.heat) * lerpK(dt, 2.5);
        // Calm = branching "coral" mycelium, hot = "mitosis" regime with dividing cells.
        const feed = 0.0545 + (0.0367 - 0.0545) * this.heat;
        const kill = 0.062 + (0.0649 - 0.062) * this.heat;
        // dt already includes the speed control, so slow motion also slows the simulation.
        const steps = Math.round(clamp(6 + 16 * this.heat + 10 * drv.beat, 4, 30) * clamp(dt * 60, 0, 2));

        let seeds = drv.beatEvents - this.lastBeat;
        this.lastBeat = drv.beatEvents;
        for (let i = 0; i < steps; i++) {
          let seed = [0, 0, 0];
          if (seeds > 0 && i === 0) {
            seed = [Math.random(), Math.random(), 0.012 + 0.02 * pulse.strength];
            seeds--;
          }
          draw(P['rd-sim'], { ...base, uState: st.read.tex, uInit: 0, uFeed: feed, uKill: kill, uSeed: seed }, st.write);
          st.swap();
        }
        this.hue += dt * (0.02 + 0.12 * drv.mid);
      },
      render(target, U) {
        draw(P['rd-display'], { ...U, uState: this.state.read.tex, uTexel: this.state.texel, uHue: this.hue }, target);
      },
    };

    const SHOVE_S = 0.1; // how long each beat's push into the fluid lasts
    /** Stable-fluids simulation; `makeFluid` lets several modes own independent fluid states. */
    const makeFluid = (id, label) => ({
      id,
      label,
      inject: null, // optional hook (dt) => void, called before projection to add custom dye
      vel: null,
      dye: null,
      pressure: null,
      div: null,
      curl: null,
      aspect: 0,
      lastBeat: 0,
      lastOnset: 0,
      lastSpark: 0,
      shove: 0, // beat push still to deliver
      spin: 0,
      hue: Math.random(),
      ensure() {
        const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
        if (this.vel && Math.abs(aspect - this.aspect) < 0.02) return;
        ['vel', 'dye', 'pressure'].forEach((k) => this[k] && this[k].destroy());
        ['div', 'curl'].forEach((k) => this[k] && destroyTarget(this[k]));
        const [sw, sh] = simSize(144);
        const [dw, dh] = simSize(Math.min(720, canvas.clientHeight));
        this.vel = createDouble(sw, sh, fluidFmt);
        this.pressure = createDouble(sw, sh, fluidFmt, { filter: gl.NEAREST });
        this.div = createTarget(sw, sh, fluidFmt, { filter: gl.NEAREST });
        this.curl = createTarget(sw, sh, fluidFmt, { filter: gl.NEAREST });
        this.dye = createDouble(dw, dh, fluidFmt);
        this.aspect = aspect;
      },
      splat(target, x, y, color, radius) {
        draw(P['fluid-splat'], {
          uTarget: target.read.tex, uPoint: [x, y], uColor: color, uRadius: radius, uAspect: this.aspect,
        }, target.write);
        target.swap();
      },
      update(dtRaw, U) {
        this.ensure();
        const dt = Math.min(dtRaw, 1 / 30);
        const v = this.vel;
        const tx = v.texel;

        draw(P['fluid-curl'], { uVelocity: v.read.tex, uTexel: tx }, this.curl);
        draw(P['fluid-vorticity'], {
          uVelocity: v.read.tex, uCurl: this.curl.tex, uTexel: tx, uDt: dt,
          uCurlStrength: 18 + 30 * drv.energy,
        }, v.write);
        v.swap();

        // Pulse = physical force: each beat pushes the fluid from rotating emitters. The push is
        // spread over ~0.1 s (`shove` decays) rather than landing in one frame, so it surges, not jolts.
        this.spin += dt * (0.15 + 0.4 * drv.energy);
        const beats = drv.beatEvents - this.lastBeat;
        this.lastBeat = drv.beatEvents;
        const k = 3 + Math.min(pulse.active, 4);
        const emitter = (i) => {
          const a = this.spin + (i / k) * TAU;
          const r = 0.22 + 0.06 * Math.sin(this.spin * 3 + i);
          return { a, x: 0.5 + (Math.cos(a) * r) / this.aspect, y: 0.5 + Math.sin(a) * r };
        };
        if (beats > 0) {
          this.shove = Math.min(1.5, this.shove + 1);
          for (let i = 0; i < k; i++) {
            // A faint dye trail marks every beat even in silence.
            const { x, y } = emitter(i);
            this.splat(this.dye, x, y, hsv((this.hue + i / k) % 1, 0.8, 0.12 + 0.1 * pulse.strength), 0.0025);
          }
        }
        if (this.shove > 0.02) {
          const share = this.shove * lerpK(dt, SHOVE_S); // this frame's part of the push
          this.shove -= share;
          const force = (220 + 440 * drv.energy + 220 * pulse.strength) * share; // the shares add up to one push per beat
          for (let i = 0; i < k; i++) {
            const { a, x, y } = emitter(i);
            const dir = a + Math.PI / 2 + 0.6;
            this.splat(v, x, y, [Math.cos(dir) * force, Math.sin(dir) * force, 0], 0.0035);
          }
        }
        // Breathing lung at the centre: radial in/out push.
        const lung = drv.breath * 70 * (0.4 + 0.6 * pulse.strength);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + 0.785;
          this.splat(v, 0.5 + (Math.cos(a) * 0.08) / this.aspect, 0.5 + Math.sin(a) * 0.08,
            [Math.cos(a) * lung, Math.sin(a) * lung, 0], 0.004);
        }

        // Audio = dye: onsets drop vivid ink; strongest band picks the colour.
        this.hue = (this.hue + dt * (0.03 + 0.1 * drv.mid)) % 1;
        const onsets = audio.onsetEvents - this.lastOnset;
        this.lastOnset = audio.onsetEvents;
        if (onsets > 0 || (drv.level > 0.35 && Math.random() < drv.level * 0.25)) {
          let best = 0;
          for (let i = 1; i < FFT_BINS; i++) if (audio.bins[i] > audio.bins[best]) best = i;
          const h = (this.hue + best / FFT_BINS) % 1;
          const amt = onsets > 0 ? 0.9 + 0.8 * drv.bass : 0.35 * drv.level;
          const x = 0.15 + Math.random() * 0.7;
          const y = 0.15 + Math.random() * 0.7;
          this.splat(this.dye, x, y, hsv(h, 0.9, amt), 0.002 + 0.004 * drv.bass);
          const a = Math.random() * TAU;
          const f = 100 + 230 * drv.bass;
          this.splat(v, x, y, [Math.cos(a) * f, Math.sin(a) * f, 0], 0.003);
        }
        // Treble hits: a few tiny bright droplets, no push, so hi-hats glitter on top of the flow.
        const sparks = audio.sparkEvents - this.lastSpark;
        this.lastSpark = audio.sparkEvents;
        if (sparks > 0) {
          for (let i = 0; i < 3; i++) {
            const x = 0.1 + Math.random() * 0.8;
            const y = 0.1 + Math.random() * 0.8;
            this.splat(this.dye, x, y, hsv((this.hue + 0.5 + Math.random() * 0.2) % 1, 0.6, 0.35 + 0.4 * audio.sparkRaw), 0.0006);
          }
        }
        if (this.inject) this.inject(dt);
        touchFluid(this, dt);

        draw(P['fluid-divergence'], { uVelocity: v.read.tex, uTexel: tx }, this.div);
        draw(P['fluid-scale'], { uSource: this.pressure.read.tex, uValue: 0.8 }, this.pressure.write);
        this.pressure.swap();
        for (let i = 0; i < 20; i++) {
          draw(P['fluid-pressure'], { uPressure: this.pressure.read.tex, uDivergence: this.div.tex, uTexel: tx }, this.pressure.write);
          this.pressure.swap();
        }
        draw(P['fluid-gradient'], { uPressure: this.pressure.read.tex, uVelocity: v.read.tex, uTexel: tx }, v.write);
        v.swap();

        draw(P['fluid-advect'], {
          uVelocity: v.read.tex, uSource: v.read.tex, uTexel: tx, uDt: dt, uDissipation: 0.25,
        }, v.write);
        v.swap();
        draw(P['fluid-advect'], {
          uVelocity: v.read.tex, uSource: this.dye.read.tex, uTexel: tx, uDt: dt,
          uDissipation: 0.18 + 0.25 * (1 - drv.level),
        }, this.dye.write);
        this.dye.swap();
      },
      render(target, U) {
        draw(P['fluid-display'], { ...U, uDye: this.dye.read.tex, uTexel: this.dye.texel }, target);
      },
    });
    const fluid = makeFluid('fluid', 'Fluid Tracers');

    // Shared Julia parameter motion: pulse drives the c constant, audio the hue.
    const stepJulia = (j, dt) => {
      j.angle += dt * (0.03 + 0.12 * drv.energy + 0.15 * drv.beat);
      j.rot += dt * 0.03;
      j.hue += dt * (0.02 + 0.15 * drv.mid);
    };
    const juliaUniforms = (j) => {
      const s = 0.35 + 0.65 * pulse.strength;
      const a = j.angle + 0.16 * drv.breath * s + 0.05 * drv.wave;
      const r = 0.7885 - 0.015 * drv.beat + 0.008 * drv.breath * s;
      return { uJuliaC: [r * Math.cos(a), r * Math.sin(a)], uJuliaRot: j.rot, uHue: j.hue };
    };

    const julia = {
      id: 'julia',
      label: 'Julia Set',
      j: { angle: 0.6, rot: 0, hue: 0 },
      update(dt) {
        stepJulia(this.j, dt);
      },
      render(target, U) {
        draw(P.julia, { ...U, ...juliaUniforms(this.j) }, target);
      },
    };

    /**
     * Julia + fluid: the fluid's velocity field warps the fractal's coordinates, and the
     * fractal's glowing boundary bleeds dye into the fluid so currents drag tracers off it.
     */
    const JF_WARP = 0.00028; // velocity (texels/s) -> fractal-space offset (low enough to keep the shape legible)
    const juliaFluid = {
      id: 'juliafluid',
      label: 'Julia Fluid',
      j: { angle: 2.4, rot: 0, hue: 0.45 },
      fluid: makeFluid('juliafluid-sim', ''),
      update(dt, U) {
        stepJulia(this.j, dt);
        const f = this.fluid;
        f.inject = (d) => {
          draw(P['julia-fluid'], {
            ...U,
            ...juliaUniforms(this.j),
            uPass: 0,
            uDye: f.dye.read.tex,
            uVelocity: f.vel.read.tex,
            uWarp: JF_WARP,
            uInject: d * (0.6 + 1.2 * drv.level + 0.4 * drv.beat),
          }, f.dye.write);
          f.dye.swap();
        };
        f.update(dt, U);
      },
      render(target, U) {
        const f = this.fluid;
        draw(P['julia-fluid'], {
          ...U,
          ...juliaUniforms(this.j),
          uPass: 1,
          uDye: f.dye.read.tex,
          uVelocity: f.vel.read.tex,
          uWarp: JF_WARP,
          uInject: 0,
        }, target);
      },
    };

    // ---- Mandelbrot: an endless zoom into a Misiurewicz point, where the set is self-similar.
    // Zooming in by |rho| and turning by arg(rho) (rho = the multiplier of the point's cycle) shows
    // the same picture again, so once the dive is deep enough the zoom wraps back by exactly one
    // such step and carries on forever without a cut. The shader iterates pixels relative to the
    // point's orbit, so precision never runs out.
    const MIS = { c: [-0.748240929755911, 0.136466389588626], pre: 20, period: 5 }; // match mandelbrot.frag
    const misOrbit = (() => {
      const n = MIS.pre + MIS.period;
      const z = new Float32Array(n * 2);
      let a = 0;
      let b = 0;
      let lnRho = 0;
      let arg = 0;
      for (let i = 0; i < n; i++) {
        z[i * 2] = a;
        z[i * 2 + 1] = b;
        if (i >= MIS.pre) {
          lnRho += Math.log(2 * Math.hypot(a, b));
          arg += Math.atan2(b, a);
        }
        [a, b] = [a * a - b * b + MIS.c[0], 2 * a * b + MIS.c[1]];
      }
      return { z, lnRho, arg };
    })();
    const LOOP_AT = 16; // log-zoom where one step deeper looks the same (checked to ~98% of pixels)
    const ITER_PER_ZOOM = MIS.period / misOrbit.lnRho; // escape times grow this much per log-zoom
    const mandel = {
      id: 'mandel',
      label: 'Mandelbrot',
      logZoom: 0,
      wraps: 0,
      rot: 0,
      bands: 0,
      update(dt) {
        // Pulse = zoom velocity; each heartbeat surges the dive forward.
        const vel = 0.07 + 0.32 * drv.energy * (0.4 + 0.6 * pulse.strength) + 0.35 * drv.beat;
        this.logZoom += dt * vel;
        if (this.logZoom >= LOOP_AT + misOrbit.lnRho) {
          this.logZoom -= misOrbit.lnRho;
          this.wraps++;
        }
        this.rot += dt * 0.04;
        this.bands += dt * (0.02 + 0.3 * drv.bass);
      },
      render(target, U) {
        const L = this.logZoom;
        draw(P.mandelbrot, {
          ...U,
          uOrbit: misOrbit.z,
          uScale: 1.6 * Math.exp(-L),
          // The first term is constant by the time the zoom wraps, so a wrap changes nothing.
          uMaxIter: Math.min(600, 140 + L * 55) + L * ITER_PER_ZOOM,
          // Turning with the zoom by arg(rho) per step lines the wrapped picture up exactly.
          uRotation: this.rot + (misOrbit.arg * L) / misOrbit.lnRho,
          uBandShift: this.bands,
          uMuOffset: this.wraps * MIS.period,
          uMuRef: L * ITER_PER_ZOOM,
        }, target);
      },
    };

    // ---- Fractal Flight: endless 3D flythrough. The Apollonian fractal repeats every 2 units, so
    // the camera position is wrapped into [-1, 1)^3 to keep float precision forever.
    const fract = (x) => x - Math.floor(x);
    const apollonian = (px, py, pz, s) => {
      let scale = 1;
      for (let i = 0; i < 8; i++) {
        px = -1 + 2 * fract(0.5 * px + 0.5);
        py = -1 + 2 * fract(0.5 * py + 0.5);
        pz = -1 + 2 * fract(0.5 * pz + 0.5);
        const k = s / (px * px + py * py + pz * pz);
        px *= k; py *= k; pz *= k;
        scale *= k;
      }
      return (0.25 * Math.abs(py)) / scale;
    };
    const norm3 = (v) => {
      const l = Math.hypot(v[0], v[1], v[2]) || 1;
      return [v[0] / l, v[1] / l, v[2] / l];
    };
    const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    // Never point (nearly) straight up or down, where the camera's up vector would flip.
    const MAX_PITCH = 0.6;
    const levelOut = (v) => norm3([v[0], clamp(v[1], -MAX_PITCH, MAX_PITCH), v[2]]);
    /**
     * Rotates unit vector `v` toward `target` by fraction `k` of the angle between them, at most
     * `maxAngle` radians. Rotating (rather than blending) never flips, even toward the opposite way.
     */
    const MAX_TURN = 1.2; // rad/s
    const turnToward = (v, target, k, maxAngle) => {
      const c = clamp(dot3(v, target), -1, 1);
      const angle = Math.min(Math.acos(c) * k, maxAngle);
      if (angle < 1e-7) return v;
      let perp = target.map((x, i) => x - v[i] * c);
      if (Math.hypot(perp[0], perp[1], perp[2]) < 1e-6) perp = cross3(v, [0, 1, 0]); // exactly behind
      perp = norm3(perp);
      return norm3(v.map((x, i) => x * Math.cos(angle) + perp[i] * Math.sin(angle)));
    };
    /** How far the camera could fly along `dir` before reaching a wall (capped at LOOK_AHEAD). */
    const LOOK_AHEAD = 0.6;
    const AVOID = 0.02;     // walls closer than this steer the camera away (open space is ~0.01 wide)
    const WALL_GAP = 0.003; // closer than this, the camera is also eased back out
    const openDist = (p, dir, s) => {
      // A "hit" is relative to where the camera is, so a camera already close to a wall can still
      // tell the way out (away from it) from the way in.
      const hit = Math.min(0.0015, 0.5 * apollonian(p[0], p[1], p[2], s));
      let t = 0;
      for (let i = 0; i < 48 && t < LOOK_AHEAD; i++) {
        const d = apollonian(p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t, s);
        if (d < hit) break;
        t += Math.max(d * 0.9, 0.0015);
      }
      return Math.min(t, LOOK_AHEAD);
    };
    const flight = {
      id: 'flight',
      label: 'Fractal Flight',
      pos: [0.1, 0.05, 0.0],
      fwd: norm3([0.3, 0.1, 1]),
      aim: norm3([0.3, 0.1, 1]),
      aimTimer: 0,
      away: [0, 0, 0],
      speed: 0,
      room: 0.01, // smoothed distance to the nearest wall
      roll: 0,
      hue: 0.1,
      t: 0,
      fracS: 1.12,
      /**
       * Looks ahead along a cone of directions and returns the most open one, nudged toward a slow
       * wander and toward the current aim (so it doesn't flip-flop between two equal gaps).
       */
      pickAim(wander) {
        const f = this.fwd;
        const right = norm3(cross3(f, [0, 1, 0]));
        const up = cross3(right, f);
        let best = f;
        let bestScore = -Infinity;
        const consider = (dir, open = openDist(this.pos, dir, this.fracS)) => {
          const score = open + 0.08 * dot3(dir, wander) + 0.05 * dot3(dir, this.aim);
          if (score > bestScore) {
            bestScore = score;
            best = dir;
          }
        };
        consider(f);
        for (const tilt of [0.35, 0.7, 1.1]) {
          for (let k = 0; k < 8; k++) {
            const az = (k / 8) * TAU;
            const side = Math.sin(tilt);
            consider(levelOut([0, 1, 2].map((i) =>
              f[i] * Math.cos(tilt) + (right[i] * Math.cos(az) + up[i] * Math.sin(az)) * side)));
          }
        }
        return best;
      },
      update(dt) {
        this.t += dt;
        // Geometry breathes slowly with the room. Any change reshapes the whole fractal around the
        // camera, so it ignores single beats and eases in over seconds.
        const sGoal = 1.12 + 0.04 * drv.breath * (0.4 + 0.6 * pulse.strength);
        this.fracS += (sGoal - this.fracS) * lerpK(dt, 2.5);

        // Steering: aim at the most open direction (re-checked a few times a second) and away from
        // nearby walls. The wall direction is smoothed so the distance field's noise can't jolt the view.
        const wander = norm3([Math.sin(this.t * 0.31) * 0.6, Math.sin(this.t * 0.23 + 1.3) * 0.3, 1]);
        this.aimTimer -= dt;
        if (this.aimTimer <= 0) {
          this.aimTimer = 0.2;
          this.aim = this.pickAim(wander);
        }
        const p = this.pos;
        const s = this.fracS;
        const d = apollonian(p[0], p[1], p[2], s);
        const e = clamp(d * 0.5, 0.0005, 0.002);
        const g = norm3([
          apollonian(p[0] + e, p[1], p[2], s) - apollonian(p[0] - e, p[1], p[2], s),
          apollonian(p[0], p[1] + e, p[2], s) - apollonian(p[0], p[1] - e, p[2], s),
          apollonian(p[0], p[1], p[2] + e, s) - apollonian(p[0], p[1], p[2] - e, s),
        ]);
        this.away = norm3(this.away.map((c, i) => c + (g[i] - c) * lerpK(dt, 0.6)));
        const push = clamp((AVOID - d) / AVOID, 0, 1) * 1.2;
        const target = norm3(this.aim.map((c, i) => c + this.away[i] * push));
        this.fwd = levelOut(turnToward(this.fwd, target, lerpK(dt, 0.9), MAX_TURN * dt));
        if (d < WALL_GAP) {
          // Too close (the walls can shift as the geometry breathes): ease straight out.
          for (let i = 0; i < 3; i++) p[i] += this.away[i] * (WALL_GAP - d) * lerpK(dt, 0.1);
        }
        // Speed scales with the open space around the camera, so the flow looks the same in tight gaps
        // and big chambers and there is always time to steer. Never step further than the wall.
        this.room += (d - this.room) * lerpK(dt, 0.5);
        const rate = 1.2 + 3 * drv.energy * (0.4 + 0.6 * pulse.strength) + 1.5 * drv.beat; // ~gaps per second
        this.speed += (this.room * rate - this.speed) * lerpK(dt, 0.8);
        const step = Math.min(this.speed * dt, Math.max(d * 0.6, 0.0002));
        for (let i = 0; i < 3; i++) p[i] = fract((p[i] + this.fwd[i] * step + 1) / 2) * 2 - 1;
        this.roll += dt * (0.04 + 0.1 * drv.mid) * Math.sin(this.t * 0.05);
        this.hue += dt * (0.015 + 0.08 * drv.mid);
      },
      render(target, U) {
        draw(P.fractal3d, {
          ...U,
          uCamPos: this.pos,
          uCamFwd: this.fwd,
          uCamRoll: this.roll,
          uFracS: this.fracS,
          uHue: this.hue,
        }, target);
      },
    };

    // ---- Star Iris: a vast eye of stardust in the night sky above a pine forest.
    const starIris = {
      id: 'iris',
      label: 'Star Iris',
      spin: 0,
      update(dt) {
        // Pulse = the iris slowly turning; beats nudge it round.
        this.spin += dt * (0.01 + 0.05 * drv.energy + 0.08 * drv.beat);
      },
      render(target, U) {
        draw(P['star-iris'], { ...U, uSpin: this.spin }, target);
      },
    };

    // ---- Nebula Portals: an oil-slick nebula spiralling into dark portals above a liquid horizon.
    const portals = {
      id: 'portals',
      label: 'Nebula Portals',
      flow: 0,
      hue: 0.1,
      swirl: 1.2,
      update(dt) {
        this.flow += dt * (0.3 + 0.9 * drv.energy + 0.8 * drv.beat);
        this.hue += dt * (0.015 + 0.1 * drv.mid);
        // Energy winds the spiral tighter; eased so the shape changes over seconds, not frames.
        this.swirl += (1.0 + 1.2 * drv.energy - this.swirl) * lerpK(dt, 1.5);
      },
      render(target, U) {
        const s = 0.35 + 0.65 * pulse.strength;
        draw(P['nebula-portals'], {
          ...U,
          uFlow: this.flow,
          uHue: this.hue,
          uPortal: 1 + 0.08 * drv.breath * s + 0.08 * drv.beat,
          uSwirl: this.swirl,
        }, target);
      },
    };

    return [warp, rd, fluid, julia, mandel, juliaFluid, flight, starIris, portals];
  }

  // ======================================================================== render loop
  const view = {
    scale: 1,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
    rtA: null,
    rtB: null,
    frameMs: 16.7,
    lastAdjust: performance.now() + 3000, // let shader compilation / warm-up settle first
    badScale: Infinity,
  };

  function resize() {
    const w = Math.max(1, Math.floor(canvas.clientWidth * view.dpr * view.scale));
    const h = Math.max(1, Math.floor(canvas.clientHeight * view.dpr * view.scale));
    if (canvas.width === w && canvas.height === h && view.rtA) return;
    canvas.width = w;
    canvas.height = h;
    [view.rtA, view.rtB, view.rtScene, view.rtPre, view.bloomA, view.bloomB].forEach(destroyTarget);
    if (view.fb) view.fb.destroy();
    view.rtA = createTarget(w, h, FMT.rgba8);
    view.rtB = createTarget(w, h, FMT.rgba8);
    // Post-processing targets (only used while an FX layer is enabled).
    view.rtScene = createTarget(w, h, FMT.rgba8, { wrap: gl.MIRRORED_REPEAT }); // kaleido samples past edges
    view.rtPre = createTarget(w, h, FMT.rgba8);
    view.fb = createDouble(w, h, fluidFmt); // echo feedback; half-float avoids 8-bit trail banding
    const bw = Math.max(1, Math.floor(w / 4));
    const bh = Math.max(1, Math.floor(h / 4));
    view.bloomA = createTarget(bw, bh, fluidFmt);
    view.bloomB = createTarget(bw, bh, fluidFmt);
  }
  window.addEventListener('resize', resize);

  // ---------------------------------------------------------------- FX layers (post-processing)
  const FX_DEFS = [
    { id: 'kaleido', label: 'Kaleidoscope', key: 'k' },
    { id: 'echo', label: 'Echo', key: 'e' },
    { id: 'bloom', label: 'Bloom', key: 'b' },
    { id: 'ripple', label: 'Heart Ripple', key: 'r' },
    { id: 'invert', label: 'Invert', key: 'i' },
    { id: 'swap', label: 'Music → Motion', key: 'x' },
  ];
  const fx = { kaleido: false, echo: false, bloom: false, ripple: false, invert: false, swap: false };
  delete fx.hearts; // dropped FX layer; ignore it in saved settings
  try {
    Object.assign(fx, JSON.parse(localStorage.getItem('pulse.fx') || '{}'));
  } catch (_) { /* ignore */ }
  const fxState = { kRot: 0, ripples: [], lastBeat: 0, echoNeedsClear: true };

  /** `share` = a local change that is also sent to everyone; remote changes arrive with share=false. */
  function setFx(id, on, share = true) {
    if (fx[id] === on) return;
    fx[id] = on;
    if (id === 'echo' && fx.echo) fxState.echoNeedsClear = true;
    document.querySelectorAll('#fxBar button').forEach((b) => b.classList.toggle('active', !!fx[b.dataset.fx]));
    try { localStorage.setItem('pulse.fx', JSON.stringify(fx)); } catch (_) { /* ignore */ }
    if (share) setControl({ [id]: on });
  }
  const toggleFx = (id) => setFx(id, !fx[id]);

  // One gradient across the whole group: each selected button's underline shows its own slice.
  function spanGradient(group) {
    const place = () => {
      group.style.setProperty('--span-w', `${group.clientWidth}px`);
      for (const el of group.children) el.style.setProperty('--span-x', `${-el.offsetLeft}px`);
    };
    new ResizeObserver(place).observe(group);
    new MutationObserver(place).observe(group, { childList: true });
    document.fonts.ready.then(place);
    place();
  }

  function buildFxBar() {
    const nav = $('fxBar');
    const lbl = document.createElement('span');
    lbl.className = 'fx-label';
    lbl.textContent = 'FX';
    nav.appendChild(lbl);
    for (const d of FX_DEFS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.fx = d.id;
      b.innerHTML = `<kbd>${d.key.toUpperCase()}</kbd>`;
      b.appendChild(document.createTextNode(d.label));
      b.classList.toggle('active', !!fx[d.id]);
      b.addEventListener('click', () => toggleFx(d.id));
      nav.appendChild(b);
    }
    spanGradient(nav);
  }

  function clearTarget(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Runs the enabled post-processing chain: scene -> kaleido/ripples/bursts -> echo -> bloom -> screen. */
  function runFx(dt, U, burstCount, paintOn) {
    const P = programs;
    let src = view.rtScene;

    // Each heartbeat launches a shockwave ring (up to 4 alive at once).
    const beats = pulse.beatEvents - fxState.lastBeat;
    fxState.lastBeat = pulse.beatEvents;
    // Rings start only while Heart Ripple is on, so switching it on doesn't release ones queued while it was off.
    if (beats > 0 && fx.ripple) fxState.ripples.unshift(0);
    fxState.ripples = fxState.ripples.map((a) => a + dt).filter((a) => a < 2.2).slice(0, 4);
    fxState.kRot += dt * (0.05 + 0.25 * drv.energy);
    const hueRotate = (ctl.hue + drv.hue) * TAU;

    const chaosFx = ctl.warp > 0.001 || ctl.punch > 0.001 || ctl.glitch > 0.001 || drv.thump > 0.002;
    const smudgeCount = smudgeUniforms();
    const roomPre = smudgeCount > 0 || Math.abs(room.pan[0]) + Math.abs(room.pan[1]) > 0.002 || room.charge > 0.005;
    if (fx.kaleido || fx.ripple || burstCount > 0 || chaosFx || roomPre) {
      const r = fxState.ripples;
      draw(P['fx-pre'], {
        ...U,
        uSrc: src.tex,
        uKaleido: fx.kaleido ? 1 : 0,
        uSegments: 6 + 2 * Math.round(controls.chaos * 2), // 6, 8 or 10 slices; changes only when Chaos is moved
        uKRot: fxState.kRot + 0.25 * drv.breath,
        uKZoom: 1.0 - 0.12 * drv.breath * (0.4 + 0.6 * pulse.strength),
        uRipple: fx.ripple ? 1 : 0,
        uRipples: [0, 1, 2, 3].map((i) => (i < r.length ? r[i] : -1)),
        uBurstCount: burstCount,
        uBursts: burstData,
        uWarp: ctl.warp,
        uPunch: ctl.punch * drv.beat * 0.12 + 0.09 * drv.thump, // bass thump zooms in when swapped
        uSplit: ctl.glitch * (0.012 * drv.beat + 0.02 * drv.onset + 0.008 * audio.spark),
        uSmudgeCount: smudgeCount,
        uSmudges: smudgeData,
        uSmudgeAge: smudgeAge,
        uPan: [room.pan[0] * 2, -room.pan[1] * 2],
        uCharge: room.charge,
      }, view.rtPre);
      src = view.rtPre;
    }

    if (fx.echo) {
      if (fxState.echoNeedsClear) {
        clearTarget(view.fb.read);
        clearTarget(view.fb.write);
        fxState.echoNeedsClear = false;
      }
      draw(P['fx-feedback'], {
        ...U,
        uSrc: src.tex,
        uPrev: view.fb.read.tex,
        // Faster hearts = shorter, snappier trails; beats surge the zoom like a camera push.
        uDecay: clamp(0.93 - 0.05 * drv.energy, 0.85, 0.94),
        uZoom: 1.004 + 0.02 * drv.beat + 0.004 * drv.bass,
        uRot: 0.0025 * drv.breath + 0.002 * drv.mid,
        uHueShift: 0.015 + 0.04 * drv.treble,
      }, view.fb.write);
      view.fb.swap();
      src = view.fb.read;
    }

    let bloomAmt = 0;
    if (fx.bloom || ctl.bloomBoost > 0.01) {
      const tx = 1 / view.bloomA.w;
      const ty = 1 / view.bloomA.h;
      draw(P['fx-bright'], { uSrc: src.tex, uThreshold: 0.68 - 0.12 * drv.level }, view.bloomA);
      for (const spread of [1.0, 2.2]) {
        draw(P['fx-blur'], { uSrc: view.bloomA.tex, uDir: [tx * spread, 0] }, view.bloomB);
        draw(P['fx-blur'], { uSrc: view.bloomB.tex, uDir: [0, ty * spread] }, view.bloomA);
      }
      bloomAmt = (fx.bloom ? 0.3 + 0.8 * drv.level + 0.3 * drv.beat : 0) + ctl.bloomBoost * (0.7 + 0.5 * drv.level);
    }

    draw(P['fx-final'], {
      ...U,
      uSrc: src.tex,
      uBloom: view.bloomA.tex,
      uBloomAmt: bloomAmt,
      uHueRotate: hueRotate,
      uExposure: ctl.exposure,
      uSaturation: ctl.saturation,
      uBurstCount: burstCount,
      uBursts: burstData,
      uBurstHue: burstHue,
      uPaint: paintOn ? paint.layer.read.tex : view.bloomA.tex,
      uPaintOn: paintOn ? 1 : 0,
      uCharge: room.charge,
      uRace: [room.raceOn, room.raceSplit, ...(room.game.hues || [0, 0.62])],
      uPass: [room.passOn, room.passHue],
      uInvert: fx.invert ? 1 : 0,
    }, null);
  }

  /** Adaptive resolution: keep the display smooth regardless of GPU or screen size. */
  function adaptQuality(dt, now) {
    view.frameMs += (dt * 1000 - view.frameMs) * 0.05;
    if (now - view.lastAdjust < 2500) return;
    if (view.frameMs > 22 && view.scale > 0.45) {
      view.badScale = view.scale;
      view.scale = Math.max(0.45, view.scale - 0.1);
      view.lastAdjust = now;
      resize();
    } else if (view.frameMs < 17.5 && view.scale < 1 && view.scale + 0.05 < view.badScale && now - view.lastAdjust > 8000) {
      view.scale = Math.min(1, view.scale + 0.05);
      view.lastAdjust = now;
      resize();
    } else if (now - view.lastAdjust > 60000) {
      view.badScale = Infinity;
    }
  }

  let modes = null;
  let current = 0;
  let previous = -1;
  let fade = 1;
  const FADE_S = 1.4;

  function setMode(i, share = true) {
    if (!modes) return;
    i = ((i % modes.length) + modes.length) % modes.length;
    if (i === current) return;
    previous = fade < 1 ? previous : current; // mid-fade: keep fading from the original mode
    if (previous === i) previous = current;
    current = i;
    fade = 0;
    document.querySelectorAll('#modes button').forEach((b, k) => b.classList.toggle('active', k === i));
    try { localStorage.setItem('pulse.mode', String(i)); } catch (_) { /* ignore */ }
    if (share) setControl({ mode: i });
  }

  function buildModeBar() {
    const nav = $('modes');
    modes.forEach((m, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<kbd>${i + 1}</kbd>`;
      b.appendChild(document.createTextNode(m.label));
      b.addEventListener('click', () => setMode(i));
      nav.appendChild(b);
    });
    nav.children[current].classList.add('active');
    spanGradient(nav);
  }

  let lastT = performance.now();
  let animTime = 0; // shader time, advanced at the speed control's rate
  let hudTimer = 0;

  function frame(now) {
    renderFrame(now);
    requestAnimationFrame(frame);
  }

  function renderFrame(now) {
    const rawDt = (now - lastT) / 1000;
    const dt = clamp(rawDt, 0.001, 0.1);
    lastT = now;
    if (rawDt < 0.25) adaptQuality(dt, now); // ignore stalls (background tab, GC)
    updateControls(dt);
    updatePulse(dt, now);
    updateAudio(dt, now);
    updateDrive(dt);
    // Animation time runs at the speed control's rate; the heartbeat itself keeps real time.
    // Swapped, every bass hit also surges the animation forward (up to ~3x for a moment).
    const sdt = dt * ctl.speed * (1 + 2 * drv.thump);
    animTime += sdt;

    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FFT_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, audio.bins);

    const U = {
      uRes: [canvas.width, canvas.height],
      uTime: animTime,
      uBpm: pulse.bpm,
      uPulse: drv.wave,
      uBeat: drv.beat,
      uBreath: drv.breath,
      uEnergy: drv.energy,
      uStrength: pulse.strength,
      uUsers: pulse.active,
      uBass: drv.bass,
      uMid: drv.mid,
      uTreble: drv.treble,
      uLevel: drv.level,
      uOnset: drv.onset,
      uSpark: audio.spark, // treble hits are detail, so they come from the sound in either routing
      uFFT: fftTex,
    };

    const cur = modes[current];
    // A colour shift only needs the final pass, so it also routes the scene through the FX chain.
    const burstCount = burstUniforms(dt);
    updateRoom(dt);
    const paintOn = updatePaint(dt);
    const looks = ctl.hue > 0.002 || drv.hue > 0.002 || fx.invert || Math.abs(ctl.exposure - 1) > 0.01 || Math.abs(ctl.saturation - 1) > 0.01 || ctl.warp > 0.001 || ctl.punch > 0.001 || ctl.glitch > 0.001;
    const play = paintOn || smudges.length > 0 || Math.abs(room.pan[0]) + Math.abs(room.pan[1]) > 0.002 || room.charge > 0.005 || room.raceOn > 0.01 || room.passOn > 0.01;
    const fxOn = fx.kaleido || fx.echo || fx.bloom || fx.ripple || burstCount > 0 || looks || play;
    // With FX enabled the mode renders off-screen and the FX chain composites to the screen.
    const sceneTarget = fxOn ? view.rtScene : null;
    if (fade < 1 && previous >= 0) {
      fade = Math.min(1, fade + dt / FADE_S);
      const prev = modes[previous];
      prev.update(sdt, U);
      cur.update(sdt, U);
      prev.render(view.rtA, U);
      cur.render(view.rtB, U);
      draw(programs.composite, { ...U, uFrom: view.rtA.tex, uTo: view.rtB.tex, uMix: fade }, sceneTarget);
      if (fade >= 1) previous = -1;
    } else {
      cur.update(sdt, U);
      cur.render(sceneTarget, U);
    }
    if (fxOn) runFx(sdt, U, burstCount, paintOn);
    // Drags and blasts are used up by this frame's fluid and paint passes.
    strokes.length = 0;
    room.blast = 0;

    hudTimer += dt;
    if (hudTimer > 0.25) {
      hudTimer = 0;
      updateHud();
    }
    drawSpectrum();
  }

  // ======================================================================== HUD / UI
  const spec = $('spectrum').getContext('2d');
  function drawSpectrum() {
    const { width: w, height: h } = spec.canvas;
    spec.clearRect(0, 0, w, h);
    const bw = w / FFT_BINS;
    for (let i = 0; i < FFT_BINS; i++) {
      const v = audio.bins[i] / 255;
      // Red (bass) through green to blue (treble) across the spectrum.
      // A 2 px floor keeps a gradient line visible in silence, so the spectrum still reads as a button.
      const bh = Math.max(2, v * h);
      spec.fillStyle = `hsl(${(i / (FFT_BINS - 1)) * 240} 100% 55% / ${0.45 + v * 0.55})`;
      spec.fillRect(i * bw, h - bh, bw - 0.5, bh);
    }
  }

  function updateHud() {
    $('hudBpm').textContent = !controls.heartbeat || pulse.source !== 'tempo' ? Math.round(pulse.bpm) : '--';
    $('hudMode').textContent = !controls.heartbeat ? 'BPM · manual' : pulse.source === 'music' ? 'BPM · music' : pulse.source === 'phones' ? 'BPM · phones' : 'BPM';
    $('hudUsers').textContent = pulse.sensors;
  }

  // ---- Live beat on/off (shared): off = phones and music are ignored and the tempo control sets the rhythm.
  function updateHeartbeatUi() {
    const on = controls.heartbeat;
    const b = $('hbBtn');
    b.textContent = on ? 'Live beat' : 'Manual tempo';
    b.classList.toggle('off', !on);
    b.title = on
      ? 'Phones (taps, dancing, hearts) drive the rhythm, then the music\'s beat. Click (M) for manual tempo.'
      : 'Manual mode: the tempo slider drives the visuals. Click (M) to go back to the live beat.';
  }
  const toggleHeartbeat = () => setControl({ heartbeat: !controls.heartbeat });
  $('hbBtn').addEventListener('click', toggleHeartbeat);

  // ---- Host lock: what phones may change. Click cycles open -> sliders only -> locked.
  const LOCK_UI = {
    open: { text: 'Phones: all', next: 'limited' },
    limited: { text: 'Phones: sliders', next: 'locked' },
    locked: { text: 'Phones: none', next: 'open' },
  };
  function updateLockUi() {
    const b = $('lockBtn');
    const level = LOCK_UI[controls.lock] || LOCK_UI.open;
    b.textContent = level.text;
    b.className = `btn small lock-btn ${controls.lock}`;
    b.title = host.is
      ? `What phones can change (click to cycle). Host PIN ${host.pin}: enter it on a phone for full control there.`
      : 'Only the host can change the lock. Click to enter the host PIN.';
  }
  $('lockBtn').addEventListener('click', () => {
    if (host.is) return socket.emit('host:lock', (LOCK_UI[controls.lock] || LOCK_UI.open).next);
    const attempt = (window.prompt('Host PIN (shown in the server window):') || '').trim();
    if (!attempt) return;
    socket.timeout(5000).emit('host:pin', attempt, (err, res) => {
      if (err || !res.ok) return window.alert(err ? 'Server did not respond.' : res.error);
      hostPin = attempt;
      try { sessionStorage.setItem('pulse.pin', attempt); } catch (_) { /* ignore */ }
    });
  });

  onControls = () => {
    updateHeartbeatUi();
    updateLockUi();
    // Mode/FX may arrive before the shaders have loaded; boot applies `controls.mode` then.
    if (modes) setMode(controls.mode, false);
    for (const d of FX_DEFS) setFx(d.id, controls[d.id], false);
  };
  updateHeartbeatUi();
  updateLockUi();

  const ui = $('ui');
  let idleTimer = null;
  function poke() {
    ui.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ui.classList.add('idle'), 3500);
  }
  ['mousemove', 'pointerdown', 'keydown', 'touchstart'].forEach((e) => window.addEventListener(e, poke, { passive: true }));

  // QR code in the corner, so more phones can join after the show has started (button or Q).
  function toggleQr() {
    const corner = $('qrCorner');
    corner.hidden = !corner.hidden;
    const b = $('qrBtn');
    b.textContent = corner.hidden ? 'Show QR' : 'Hide QR';
    b.setAttribute('aria-pressed', String(!corner.hidden));
  }
  $('qrBtn').addEventListener('click', toggleQr);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const n = parseInt(e.key, 10);
    if (modes && n >= 1 && n <= modes.length) setMode(n - 1);
    else if (e.key === 'ArrowRight') setMode(current + 1);
    else if (e.key === 'ArrowLeft') setMode(current - 1);
    else if (e.key === 'h' || e.key === 'H') ui.classList.toggle('hidden');
    else if (e.key === 'q' || e.key === 'Q') toggleQr();
    else if (e.key === 'm' || e.key === 'M') toggleHeartbeat();
    else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } else {
      const d = FX_DEFS.find((x) => x.key === e.key.toLowerCase());
      if (d) toggleFx(d.id);
    }
  });

  // ---- audio source controls
  async function tryConnectAudio() {
    setAudioStatus('');
    try {
      await connectAudio();
    } catch (err) {
      disconnectAudio();
      setAudioStatus(err && err.name === 'NotAllowedError' ? 'No audio shared. Click the spectrum, choose Entire screen and tick Also share system audio.' : (err.message || 'audio failed'));
    }
  }
  $('audioBtn').addEventListener('click', tryConnectAudio);

  // ======================================================================== boot
  function fatal(msg) {
    const el = $('fatal');
    el.textContent = msg;
    el.hidden = false;
    $('start').hidden = false;
  }

  let programs = null;
  loadPrograms()
    .then((P) => {
      programs = P;
      modes = createModes(P);
      if (controlsReceived) current = clamp(controls.mode, 0, modes.length - 1);
      else {
        try {
          const saved = parseInt(localStorage.getItem('pulse.mode'), 10);
          if (saved >= 0 && saved < modes.length) current = saved;
        } catch (_) { /* ignore */ }
      }
      buildModeBar();
      buildFxBar();
      resize();
      requestAnimationFrame(frame);
    })
    .catch((err) => {
      console.error(err);
      fatal(String(err.message || err));
    });

  $('startBtn').addEventListener('click', async () => {
    $('start').hidden = true;
    poke();
    // Inside the click gesture: create/resume the AudioContext.
    ensureAudioContext();
    audio.ctx.resume();
    await tryConnectAudio();
  });

  // Expose for debugging in DevTools.
  window.__pulse = { pulse, audio, drv, view, fx, toggleFx, controls, ctl, setControl, renderFrame: (t) => renderFrame(t), setMode, get modes() { return modes; }, get programs() { return programs; }, gl };
})();
