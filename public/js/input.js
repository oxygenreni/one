(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const ui = {
    conn: $('conn'),
    bpm: $('bpm'),
    heart: $('heart'),
    confidence: $('confidence'),
    wave: $('wave'),
    sensorStatus: $('sensorStatus'),
    sensorBtn: $('sensorBtn'),
    flashBtn: $('flashBtn'),
    roomBpm: $('roomBpm'),
    roomSensors: $('roomSensors'),
    cam: $('cam'),
    sample: $('sample'),
  };

  const PULSE_SEND_MS = 100; // 10 Hz upstream

  // ---------------------------------------------------------------- socket + sync
  const socket = io({ transports: ['websocket', 'polling'] });
  const timeSync = new TimeSync(socket);
  // Host PIN entered on this phone (kept for the tab session so a reload stays host).
  let hostPin = null;
  try { hostPin = sessionStorage.getItem('pulse.pin'); } catch (_) { /* ignore */ }
  let isHost = false;
  socket.on('connect', () => {
    socket.emit('hello', { role: 'input', pin: hostPin || undefined });
    ui.conn.textContent = 'live';
    ui.conn.className = 'conn on';
  });
  socket.on('disconnect', () => {
    ui.conn.textContent = 'reconnecting…';
    ui.conn.className = 'conn off';
  });
  socket.on('pulse:summary', (s) => {
    ui.roomBpm.textContent = s.bpm > 0 ? s.bpm : '--';
    ui.roomSensors.textContent = s.sensors;
    roomSensing = s.bpm > 0;
    renderAnim();
  });
  let roomSensing = false;
  timeSync.start();

  // A server restarted with new code reloads this page, unless that would interrupt the sensor or dancing.
  watchServerBuild(socket, (kind) => {
    if (kind === 'updated' && !running && !dancing) return location.reload();
    showBanner(STALE_TEXT[kind], kind === 'updated' ? { label: 'Reload', run: () => location.reload() } : null);
  });

  // Each phone gets its own colour; its beats show as rings of that colour on the display.
  socket.on('you', (me) => {
    myN = me.n;
    const color = `hsl(${Math.round(me.hue * 360)}, 90%, 62%)`;
    ui.heart.style.color = color;
    $('youColor').hidden = false;
    $('youColor').style.color = color;
    $('touchPad').style.setProperty('--me', color);
    $('tapBtn').style.setProperty('--me', color);
  });

  // ---------------------------------------------------------------- shared animation controls
  // Everyone shares one set of controls (latest change wins). Ranges mirror ANIM_DEFS in server.js,
  // which clamps them anyway.
  const MODES = ['Domain Warp', 'Reaction-Diffusion', 'Fluid Tracers', 'Julia Set', 'Mandelbrot', 'Julia Fluid', 'Fractal Flight', 'Star Iris', 'Nebula Portals'];
  const FX = [['kaleido', 'Kaleidoscope'], ['echo', 'Echo'], ['bloom', 'Bloom'], ['ripple', 'Heart Ripple'], ['invert', 'Invert'], ['swap', 'Music → Motion']];
  const pct = (v) => `${Math.round(v * 100)}%`;
  const SLIDERS = [
    { key: 'chaos', label: 'Chaos', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Calm ← → harder beats, bending, zoom punches and glitches' },
    { key: 'glow', label: 'Glow', min: 0, max: 1, step: 0.01, fmt: pct, hint: 'Dim and soft ← → bright, vivid and blooming' },
    { key: 'speed', label: 'Speed', min: 0.1, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
    { key: 'hue', label: 'Colour', min: 0, max: 1, step: 0.005, fmt: (v) => `${Math.round(v * 360)}°`, hint: 'Turns every colour around the colour wheel' },
    { key: 'tempo', label: 'Tempo', min: 40, max: 180, step: 1, fmt: (v) => `${Math.round(v)} BPM` },
  ];
  const CONTROL_SEND_MS = 66; // ~15 Hz while dragging
  const HOLD_MS = 700;        // ignore remote values for a control this long after you last changed it

  const anim = {};            // last known shared state (plus local, not-yet-confirmed changes)
  const pendingCtl = {};
  const holdUntil = {};
  const dragging = {};
  const sliderEls = {};
  let ctlTimer = null;
  let lastCtlSend = 0;
  let animReady = false;

  function sendControl(patch) {
    const hold = performance.now() + HOLD_MS;
    for (const k in patch) holdUntil[k] = hold;
    Object.assign(pendingCtl, patch);
    Object.assign(anim, patch);
    renderAnim();
    if (!ctlTimer) ctlTimer = setTimeout(flushControls, Math.max(0, CONTROL_SEND_MS - (performance.now() - lastCtlSend)));
  }

  function flushControls() {
    ctlTimer = null;
    lastCtlSend = performance.now();
    socket.emit('controls:set', { ...pendingCtl });
    for (const k in pendingCtl) delete pendingCtl[k];
  }

  function chip(label, cls, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = label;
    b.disabled = true;
    b.addEventListener('click', () => {
      onClick();
    });
    return b;
  }

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

  const modeChips = MODES.map((label, i) => chip(label, 'chip', () => sendControl({ mode: i })));
  modeChips.forEach((b) => $('modeGrid').appendChild(b));
  const fxChips = FX.map(([id, label]) => chip(label, 'chip fx', () => sendControl({ [id]: !anim[id] })));
  fxChips.forEach((b) => $('fxGrid').appendChild(b));
  ['sourceGrid', 'modeGrid', 'fxGrid', 'hostRow', 'toolGrid', 'gameGrid'].forEach((id) => spanGradient($(id)));

  for (const d of SLIDERS) {
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const id = `ctl-${d.key}`;
    const label = document.createElement('label');
    label.htmlFor = id;
    const name = document.createElement('span');
    name.textContent = d.label;
    const out = document.createElement('output');
    out.htmlFor = id;
    label.append(name, out);
    const input = document.createElement('input');
    Object.assign(input, { type: 'range', id, min: d.min, max: d.max, step: d.step, disabled: true });
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = d.hint || '';
    wrap.append(label, input, hint);
    $('sliders').appendChild(wrap);

    input.addEventListener('input', () => {
      out.textContent = d.fmt(Number(input.value));
      sendControl({ [d.key]: Number(input.value) });
    });
    input.addEventListener('pointerdown', () => (dragging[d.key] = true));
    const release = () => {
      dragging[d.key] = false;
      holdUntil[d.key] = performance.now() + HOLD_MS;
    };
    input.addEventListener('pointerup', release);
    input.addEventListener('pointercancel', release);
    input.addEventListener('blur', release);
    sliderEls[d.key] = { wrap, input, out, hint, def: d };
  }

  $('animReset').addEventListener('click', () => {
    for (const k in holdUntil) holdUntil[k] = 0;
    socket.emit('controls:reset');
  });

  socket.on('controls:state', (s) => {
    const now = performance.now();
    for (const k in s) {
      // Don't yank a control out from under your finger or undo a change that is still in flight.
      // `force` = the server rejected a change from this phone, so show the real value right away.
      if (!s.force && (k in pendingCtl || dragging[k] || holdUntil[k] > now)) continue;
      anim[k] = s[k];
    }
    if (s.force) for (const k in holdUntil) holdUntil[k] = 0;
    animReady = true;
    renderAnim();
  });

  // ---- Host lock. Mirrors canChange() in server.js, which enforces it.
  const SLIDER_KEYS = new Set(SLIDERS.map((d) => d.key));
  const LOCKS = [['open', 'Open'], ['limited', 'Sliders only'], ['locked', 'Locked']];
  const lockLevel = () => anim.lock || 'open';
  const lockAllows = (key) => lockLevel() === 'open' || (lockLevel() === 'limited' && SLIDER_KEYS.has(key));
  const fullControl = () => isHost || lockLevel() === 'open';
  // ---- Host sharing (server.js -> SHARE_MODULES): a ticked module shows up on every phone at once.
  const MODULE_OF = { mode: 'visual' };
  for (const [id] of FX) MODULE_OF[id] = 'fx';
  for (const k of SLIDER_KEYS) MODULE_OF[k] = 'sliders';
  const shared = (m) => (anim.share ? !!anim.share[m] : m === 'touch'); // touch is shared until the host says otherwise
  const can = (key) => isHost || (shared(MODULE_OF[key]) && lockAllows(key));
  const gamesAllowed = () => isHost || (shared('games') && lockLevel() === 'open');
  document.querySelectorAll('[data-share]').forEach((box) => box.addEventListener('change', () => {
    socket.emit('host:share', { [box.dataset.share]: box.checked });
  }));

  function renderShare() {
    const anyAnim = ['visual', 'fx', 'sliders'].some(shared);
    $('animCard').hidden = !isHost && !anyAnim;
    document.querySelectorAll('#animCard .module').forEach((el) => (el.hidden = !isHost && !shared(el.dataset.module)));
    document.querySelectorAll('[data-share]').forEach((box) => {
      box.checked = shared(box.dataset.share);
      box.closest('.share').hidden = !isHost;
    });
    $('animReset').hidden = !isHost;
    $('touchCard').hidden = !isHost && !shared('touch');
    if (!touchAllowed() && tilting) stopTilt();
    $('hostCard').hidden = isHost;
  }

  socket.on('host:status', (st) => {
    isHost = !!st.host;
    renderHostRow();
    renderAnim();
  });

  function renderHostRow() {
    const row = $('hostRow');
    row.textContent = '';
    // Guests get the join options, the touch pad and whatever the host shares; the PIN unlocks the rest.
    renderShare();
    if (!isHost) return;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Host · phones can change:';
    row.appendChild(label);
    for (const [level, text] of LOCKS) {
      const c = chip(text, 'chip', () => socket.emit('host:lock', level));
      c.disabled = false;
      c.classList.toggle('active', lockLevel() === level);
      c.dataset.lock = level;
      row.appendChild(c);
    }
  }

  $('hostBtn').addEventListener('click', askForPin);

  function askForPin() {
    const attempt = (window.prompt('Host PIN (shown in the server window):') || '').trim();
    if (!attempt) return;
    socket.timeout(5000).emit('host:pin', attempt, (err, res) => {
      if (err || !res.ok) return window.alert(err ? 'Server did not respond.' : res.error);
      hostPin = attempt;
      try { sessionStorage.setItem('pulse.pin', attempt); } catch (_) { /* ignore */ }
    });
  }

  function renderAnim() {
    if (!animReady) return;
    modeChips.forEach((b, i) => {
      b.classList.toggle('active', anim.mode === i);
      b.disabled = !can('mode');
    });
    fxChips.forEach((b, i) => {
      b.classList.toggle('active', !!anim[FX[i][0]]);
      b.disabled = !can(FX[i][0]);
    });
    $('animReset').disabled = !fullControl();
    renderShare();
    const now = performance.now();
    for (const k in sliderEls) {
      const e = sliderEls[k];
      e.input.disabled = !can(k);
      if (typeof anim[k] !== 'number') continue;
      if (!dragging[k] && !(holdUntil[k] > now)) e.input.value = anim[k];
      e.out.textContent = e.def.fmt(Number(e.input.value));
    }
    $('hostRow').querySelectorAll('[data-lock]').forEach((c) => c.classList.toggle('active', c.dataset.lock === lockLevel()));
    const lock = $('lockState');
    lock.hidden = isHost || lockLevel() === 'open';
    lock.textContent = lockLevel() === 'limited'
      ? 'The host has locked mode and effects. You can still use the sliders.'
      : 'The host has locked the controls.';
    pad.classList.toggle('disabled', !touchAllowed());
    renderTouchHint();
    renderTilt();
    renderGame();
    const manual = anim.heartbeat === false;
    const hb = $('hbState');
    hb.hidden = !manual;
    hb.textContent = 'Live beat is off: Tempo sets the rhythm.';
    sliderEls.tempo.hint.textContent = manual ? 'Driving the visuals now' : '';
    sliderEls.tempo.wrap.classList.toggle('dim', !manual && roomSensing);
  }

  // ---------------------------------------------------------------- touch pad
  // Tap: a burst on the display at the same spot, in this phone's colour; taps from several phones
  // within half a second merge into a shockwave (server.js -> TapCombos). Drag: stir the picture
  // with the finger's speed, or paint on it. Hold with others: charge a blast (server.js -> CrowdHold).
  const pad = $('touchPad');
  const TOOL_KEY = 'pulse.tool';
  const TOOL_HINTS = {
    stir: 'Drag to stir the picture, tap for a burst. Hold with others to charge a blast.',
    paint: 'Draw on the display. Strokes melt away after a few seconds.',
  };
  const DRAG_SEND_MS = 70;
  const HOLD_AFTER_MS = 350; // a finger down this long counts as holding
  let tool = 'stir';
  try { tool = localStorage.getItem(TOOL_KEY) === 'paint' ? 'paint' : 'stir'; } catch (_) { /* ignore */ }
  let lastDragSend = 0;
  let lastPoint = null; // last drag sample sent: { x, y, t }
  let holdTimer = null;
  let holding = false;
  let crowdText = '';
  const touchAllowed = () => isHost || (shared('touch') && lockLevel() !== 'locked');

  function renderTouchHint() {
    $('touchHint').textContent = !touchAllowed() ? 'The host has locked the touch pad.' : crowdText || TOOL_HINTS[tool];
  }

  function setTool(t) {
    tool = t === 'paint' ? 'paint' : 'stir';
    try { localStorage.setItem(TOOL_KEY, tool); } catch (_) { /* ignore */ }
    $('toolGrid').querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    renderTouchHint();
  }
  $('toolGrid').querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
  setTool(tool);

  const padPoint = (e) => {
    const r = pad.getBoundingClientRect();
    const px = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    const py = Math.min(Math.max(e.clientY - r.top, 0), r.height);
    return { px, py, x: px / r.width, y: py / r.height };
  };

  function padRipple(p, big) {
    const s = document.createElement('span');
    s.className = big ? 'pad-ripple big' : 'pad-ripple';
    s.style.left = `${p.px}px`;
    s.style.top = `${p.py}px`;
    s.addEventListener('animationend', () => s.remove());
    pad.appendChild(s);
  }

  function endHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    lastPoint = null;
    if (!holding) return;
    holding = false;
    socket.emit('touch:hold', false);
  }

  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!touchAllowed()) return;
    pad.setPointerCapture(e.pointerId);
    const p = padPoint(e);
    socket.volatile.emit('touch', { x: p.x, y: p.y });
    padRipple(p, true);
    lastPoint = { x: p.x, y: p.y, t: performance.now() };
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      holding = true;
      socket.emit('touch:hold', true);
    }, HOLD_AFTER_MS);
    if (navigator.vibrate) navigator.vibrate(8);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!pad.hasPointerCapture(e.pointerId) || !touchAllowed()) return;
    const t = performance.now();
    if (t - lastDragSend < DRAG_SEND_MS) return;
    lastDragSend = t;
    const p = padPoint(e);
    // Finger velocity in pad widths/heights per second: how hard the stir pushes.
    const dt = lastPoint ? Math.max(0.016, (t - lastPoint.t) / 1000) : 1;
    const vx = lastPoint ? (p.x - lastPoint.x) / dt : 0;
    const vy = lastPoint ? (p.y - lastPoint.y) / dt : 0;
    lastPoint = { x: p.x, y: p.y, t };
    socket.volatile.emit('touch', { x: p.x, y: p.y, drag: true, vx, vy, tool });
    padRipple(p, false);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => pad.addEventListener(ev, endHold));

  function padFlash(text) {
    const msg = $('comboMsg');
    msg.textContent = text;
    // Restart the CSS animations even when these come back to back.
    for (const el of [msg, pad]) {
      el.classList.remove('combo');
      void el.offsetWidth;
      el.classList.add('combo');
    }
  }

  socket.on('touch:combo', (c) => {
    padFlash(`Combo ×${c.size}!`);
    if (navigator.vibrate) navigator.vibrate([20, 40, 30]);
  });

  // ---- Hold together: the room's progress shows under the pad while anyone holds.
  socket.on('crowd:hold', (h) => {
    const on = h.holders > 0 || h.charge > 0;
    crowdText = !on ? '' : h.holders >= h.need
      ? `Charging: ${Math.round(h.charge * 100)}%. Let go together to blast!`
      : `Holding together: ${h.holders} of ${h.need} needed.`;
    $('holdMeter').hidden = !on;
    $('holdFill').style.width = `${Math.round(h.charge * 100)}%`;
    renderTouchHint();
  });
  socket.on('crowd:release', (r) => {
    padFlash(`Blast ${Math.round(r.power * 100)}%!`);
    if (navigator.vibrate) navigator.vibrate([40, 30, 80]);
  });

  // ---- Tilt to steer: tipping the phone (from however it was held when switched on) tips the
  // picture like a tray of liquid. The display uses the room's average tilt.
  const TILT_RANGE_DEG = 35; // this much tilt = full strength
  const TILT_SEND_MS = 100;
  let tilting = false;
  let tiltZero = null;
  let tiltNow = { x: 0, y: 0 };
  let tiltTimer = null;
  const unit = (v) => Math.max(-1, Math.min(1, v));

  function onOrient(e) {
    if (e.beta == null || e.gamma == null) return;
    if (!tiltZero) tiltZero = { b: e.beta, g: e.gamma };
    tiltNow = { x: unit((e.gamma - tiltZero.g) / TILT_RANGE_DEG), y: unit((e.beta - tiltZero.b) / TILT_RANGE_DEG) };
  }

  function renderTilt() {
    const b = $('tiltBtn');
    b.classList.toggle('active', tilting);
    b.setAttribute('aria-pressed', String(tilting));
    b.disabled = !touchAllowed();
  }

  async function startTilt() {
    if (typeof DeviceOrientationEvent === 'undefined') return padFlash('No tilt sensor');
    // iPhones ask for permission, and only from a tap.
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return padFlash('Tilt access denied');
      } catch (_) {
        return padFlash('Tilt access failed');
      }
    }
    window.addEventListener('deviceorientation', onOrient);
    tilting = true;
    tiltZero = null;
    tiltTimer = setInterval(() => {
      if (tiltZero && touchAllowed()) socket.volatile.emit('tilt', tiltNow);
    }, TILT_SEND_MS);
    requestWakeLock();
    renderTilt();
  }

  function stopTilt() {
    window.removeEventListener('deviceorientation', onOrient);
    clearInterval(tiltTimer);
    tilting = false;
    socket.emit('tilt', { off: true });
    renderTilt();
  }
  $('tiltBtn').addEventListener('click', () => (tilting ? stopTilt() : startTilt()));

  // ---------------------------------------------------------------- games
  // One game at a time for the whole room, run by the server (server.js -> TapRace, PassColour).
  const TEAM_NAMES = ['Red', 'Blue'];
  let myN = 0;
  let game = { kind: null };
  let wasHolder = false;
  const hueColor = (h) => `hsl(${Math.round(h * 360)}, 90%, 62%)`;

  function renderGame() {
    const s = game;
    const running = !!s.kind;
    $('gamesCard').hidden = !isHost && !running && !shared('games');
    $('gameGrid').hidden = !isHost && !shared('games');
    $('gameGrid').querySelectorAll('[data-game]').forEach((b) => {
      b.classList.toggle('active', s.kind === b.dataset.game);
      b.disabled = running || !gamesAllowed();
    });
    $('gameStop').hidden = !running || !gamesAllowed();
    const st = $('gameStatus');
    const card = st.closest('.card');
    st.style.color = '';
    card.classList.remove('has-colour');
    let text;
    if (!running) {
      text = gamesAllowed() ? 'Start a game for the whole room.' : 'The host has locked the games.';
    } else if (s.kind === 'race') {
      const team = s.teams[myN];
      const name = TEAM_NAMES[team];
      if (name) st.style.color = hueColor(s.hues[team]);
      const score = `Red ${s.score[0]} · Blue ${s.score[1]}`;
      if (s.phase === 'countdown') text = `Tap race starts in ${s.left}… ${name ? `You're on ${name}.` : 'Tap the pad to join a team.'}`;
      else if (s.phase === 'live') text = `${name ? `${name}: t` : 'T'}ap the pad as fast as you can! ${score} · ${s.left}s`;
      else text = s.winner < 0 ? `It's a tie! ${score}` : `${TEAM_NAMES[s.winner]} wins! ${score}${s.winner === team ? '. That\'s you!' : ''}`;
    } else {
      const mine = s.holder === myN;
      if (mine) {
        card.classList.add('has-colour');
        card.style.setProperty('--hold', hueColor(s.hue));
        st.style.color = hueColor(s.hue);
        if (!wasHolder && navigator.vibrate) navigator.vibrate([30, 50, 30]);
      }
      wasHolder = mine;
      text = mine
        ? `You have the colour! Your touches hit three times harder, so use the pad before it moves on. ${s.left}s left`
        : `Someone else has the colour. It moves to another phone every few seconds. ${s.left}s left`;
    }
    st.textContent = text;
  }

  $('gameGrid').querySelectorAll('[data-game]').forEach((b) => b.addEventListener('click', () => {
    socket.timeout(4000).emit('game:start', b.dataset.game, (err, res) => {
      if (err || !res.ok) $('gameStatus').textContent = err ? 'The server did not respond.' : res.error;
    });
  }));
  $('gameStop').addEventListener('click', () => socket.emit('game:stop'));
  socket.on('game:state', (s) => {
    game = s && s.kind ? s : { kind: null };
    if (!game.kind) wasHolder = false;
    renderGame();
  });

  // ---------------------------------------------------------------- joining: tap, dance or heart
  // Tap and dance send the same `pulse` messages as the heart sensor (BPM, confidence, beat), so the
  // display treats every phone alike. Dancers also send how hard they move (`energy`).

  /** Turns beat times (taps or dance jolts) into a BPM and a confidence, like the heart sensor's. */
  class Rhythm {
    constructor() {
      this.times = [];
    }

    beat(t) {
      this.times.push(t);
      if (this.times.length > 8) this.times.shift();
    }

    reset() {
      this.times = [];
    }

    idle(t) {
      const last = this.times[this.times.length - 1];
      return !last || t - last > RHYTHM_IDLE_MS;
    }

    /** Beat-to-beat gaps in the 40..210 BPM range; pauses and double taps are left out. */
    gaps() {
      const g = [];
      for (let i = 1; i < this.times.length; i++) {
        const d = this.times[i] - this.times[i - 1];
        if (d >= 285 && d <= 1500) g.push(d);
      }
      return g.slice(-6);
    }

    bpm(t) {
      const g = this.gaps();
      if (this.idle(t) || g.length < 2) return 0;
      const sorted = [...g].sort((a, b) => a - b);
      return 60000 / sorted[sorted.length >> 1];
    }

    /** 0 when idle; otherwise higher the more even the beats are. */
    confidence(t) {
      if (this.idle(t)) return 0;
      const g = this.gaps();
      if (g.length < 2) return 0.4;
      const mean = g.reduce((s, v) => s + v, 0) / g.length;
      const spread = g.reduce((s, v) => s + Math.abs(v - mean), 0) / g.length / mean;
      return Math.min(1, Math.max(0.3, 1 - spread * 3));
    }
  }

  const RHYTHM_IDLE_MS = 3000;  // no beats for this long = stop counting as joined
  const RHYTHM_MIN_GAP_MS = 55; // the server drops pulse messages closer together than 50 ms
  const JOIN_KEY = 'pulse.join';
  const rhythm = new Rhythm();
  let join = 'heart'; // the heartbeat reader is the default way in
  try { join = localStorage.getItem(JOIN_KEY) || 'heart'; } catch (_) { /* ignore */ }
  let dancing = false;
  let danceEnergy = 0;
  let rhythmSending = false;
  let lastRhythmSend = 0;
  let beatPending = false;
  let flushTimer = null;

  function sendRhythm() {
    clearTimeout(flushTimer);
    const t = performance.now();
    if (t - lastRhythmSend < RHYTHM_MIN_GAP_MS) {
      flushTimer = setTimeout(sendRhythm, RHYTHM_MIN_GAP_MS - (t - lastRhythmSend));
      return;
    }
    lastRhythmSend = t;
    const bpm = rhythm.bpm(t);
    socket.volatile.emit('pulse', {
      bpm: Math.round(bpm * 10) / 10,
      signal: 0,
      confidence: Math.round(Math.max(rhythm.confidence(t), dancing ? 0.3 : 0) * 100) / 100,
      beat: beatPending,
      energy: dancing ? Math.round(danceEnergy * 100) / 100 : undefined,
      source: join, // only heart-camera phones get a heartbeat ring on the display
    });
    beatPending = false;
    rhythmSending = true;
  }

  function onRhythmBeat() {
    rhythm.beat(performance.now());
    beatPending = true;
    flashHeart();
    sendRhythm();
  }

  // Keeps the server up to date between beats, and leaves the room after a few quiet seconds.
  setInterval(() => {
    if (join === 'heart' || !socket.connected) return;
    const t = performance.now();
    const active = dancing || !rhythm.idle(t);
    if (active && t - lastRhythmSend >= PULSE_SEND_MS) sendRhythm();
    if (!active && rhythmSending) {
      socket.emit('pulse:stop');
      rhythmSending = false;
    }
    const bpm = rhythm.bpm(t);
    ui.bpm.textContent = bpm > 0 ? Math.round(bpm) : '--';
    ui.heart.classList.toggle('live', active);
    if (join === 'tap') {
      ui.confidence.textContent = !active ? 'Tap along to join the beat' : bpm > 0 ? 'You\'re in the beat' : 'Keep tapping…';
    } else if (join === 'dance') {
      ui.confidence.textContent = !dancing ? 'Start dancing to join' : `Moving: ${danceEnergy > 0.6 ? 'wild' : danceEnergy > 0.3 ? 'grooving' : danceEnergy > 0.08 ? 'warming up' : 'still'}`;
    }
  }, PULSE_SEND_MS);

  function setJoin(j) {
    if (!['tap', 'dance', 'heart'].includes(j)) j = 'heart';
    if (j !== 'heart' && running) stopSensor();
    if (j !== 'dance' && dancing) stopDance();
    join = j;
    try { localStorage.setItem(JOIN_KEY, j); } catch (_) { /* ignore */ }
    rhythm.reset();
    if (rhythmSending) {
      socket.emit('pulse:stop');
      rhythmSending = false;
    }
    document.querySelectorAll('#sourceGrid [data-join]').forEach((b) => b.classList.toggle('active', b.dataset.join === j));
    $('panelTap').hidden = j !== 'tap';
    $('panelDance').hidden = j !== 'dance';
    $('panelHeart').hidden = j !== 'heart';
    ui.bpm.textContent = '--';
    ui.heart.classList.remove('live');
    if (j === 'heart') ui.confidence.textContent = 'signal quality: –';
  }
  document.querySelectorAll('#sourceGrid [data-join]').forEach((b) => b.addEventListener('click', () => setJoin(b.dataset.join)));

  // ---- Tap: one beat per tap.
  $('tapBtn').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    onRhythmBeat();
    const b = $('tapBtn');
    b.classList.remove('hit');
    void b.offsetWidth; // restart the animation
    b.classList.add('hit');
    if (navigator.vibrate) navigator.vibrate(10);
  });

  // ---- Dance: the motion sensor. Energy = how hard you move; sharp jolts well above your recent
  // movement are beats.
  const JOLT_MIN = 4;          // m/s² above gravity
  const JOLT_RATIO = 2.2;      // ... and this many times the recent average
  const JOLT_REFRACTORY_MS = 280;
  let motionAvg = 1;
  let lastMag = 0;
  let lastJolt = 0;
  let lastMotionT = 0;
  let motionSeen = false;

  function onMotion(e) {
    let mag;
    const a = e.acceleration;
    if (a && a.x != null) mag = Math.hypot(a.x, a.y, a.z);
    else {
      const g = e.accelerationIncludingGravity;
      if (!g || g.x == null) return;
      mag = Math.abs(Math.hypot(g.x, g.y, g.z) - 9.81);
    }
    motionSeen = true;
    const t = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (t - (lastMotionT || t)) / 1000));
    lastMotionT = t;
    // Quick to rise (the display already smooths it), slower to fall so it doesn't flicker between moves.
    const moveNow = Math.min(1, mag / 12);
    danceEnergy += (moveNow - danceEnergy) * (1 - Math.exp(-dt / (moveNow > danceEnergy ? 0.12 : 0.4)));
    motionAvg += (mag - motionAvg) * (1 - Math.exp(-dt / 1.5));
    const threshold = Math.max(JOLT_MIN, motionAvg * JOLT_RATIO);
    if (mag > threshold && lastMag <= threshold && t - lastJolt > JOLT_REFRACTORY_MS) {
      lastJolt = t;
      onRhythmBeat();
    }
    lastMag = mag;
  }

  function setDanceStatus(text, isError) {
    $('danceStatus').textContent = text;
    $('danceStatus').className = `status ${isError ? 'error' : ''}`;
  }

  async function startDance() {
    if (typeof DeviceMotionEvent === 'undefined') return setDanceStatus('This browser has no motion sensor access. Try Tap instead.', true);
    // iPhones ask for permission, and only from a tap.
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return setDanceStatus('Motion access was denied. Allow it in Safari settings, or use Tap.', true);
      } catch (err) {
        return setDanceStatus(`Motion access failed: ${err.message}`, true);
      }
    }
    window.addEventListener('devicemotion', onMotion);
    dancing = true;
    motionSeen = false;
    $('danceBtn').textContent = 'Stop dancing';
    setDanceStatus('Dancing. Move to the music.');
    requestWakeLock();
    setTimeout(() => {
      if (dancing && !motionSeen) setDanceStatus('No motion data from this phone (some laptops and browsers have none). Try Tap instead.', true);
    }, 2500);
    requestAnimationFrame(drawDanceMeter);
  }

  function stopDance() {
    window.removeEventListener('devicemotion', onMotion);
    dancing = false;
    danceEnergy = 0;
    $('danceBtn').textContent = 'Start dancing';
    $('danceMeter').style.width = '0%';
    setDanceStatus('Stopped. Tap Start dancing to join again.');
    if (wakeLock && !running) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  function drawDanceMeter() {
    if (!dancing) return;
    $('danceMeter').style.width = `${Math.round(danceEnergy * 100)}%`;
    requestAnimationFrame(drawDanceMeter);
  }

  $('danceBtn').addEventListener('click', () => (dancing ? stopDance() : startDance()));

  // ---------------------------------------------------------------- camera PPG
  const detector = new PulseDetector();
  const sctx = ui.sample.getContext('2d', { willReadFrequently: true });
  const wctx = ui.wave.getContext('2d');
  const waveBuf = new Float32Array(180);
  let waveHead = 0;
  let stream = null;
  let running = false;
  let beatsSinceSend = 0;
  let sendTimer = null;
  let wakeLock = null;
  let torchOn = false;

  ui.sensorBtn.addEventListener('click', () => {
    if (running) stopSensor();
    else startSensor();
  });

  async function startSensor() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setSensorStatus(
        window.isSecureContext
          ? 'Camera API not available in this browser.'
          : `Camera needs a secure page. In Chrome open chrome://flags/#unsafely-treat-insecure-origin-as-secure, add ${location.origin}, enable it and relaunch Chrome.`,
        true
      );
      return;
    }
    ui.sensorBtn.disabled = true;
    setSensorStatus('Requesting camera…');
    try {
      await openCameraWithTorch();
    } catch (err) {
      dlog(`getUserMedia failed ${errStr(err)}`);
      ui.sensorBtn.disabled = false;
      setSensorStatus(`Camera unavailable: ${err.name === 'NotAllowedError' ? 'permission denied' : err.message}`, true);
      return;
    }

    running = true;
    detector.reset();
    ui.sensorBtn.disabled = false;
    ui.sensorBtn.textContent = 'Stop sensor';
    ui.heart.classList.add('live');
    updateTorchUi();
    setSensorStatus(torchOn ? 'Flash on — cover camera + flash with a fingertip.' : noFlashMessage());
    requestWakeLock();
    scheduleFrame();
    sendTimer = setInterval(sendPulse, PULSE_SEND_MS);
  }

  function stopSensor() {
    running = false;
    clearInterval(sendTimer);
    socket.emit('pulse:stop');
    releaseStream();
    torchOn = false;
    updateTorchUi();
    detector.reset();
    ui.sensorBtn.textContent = 'Start pulse sensor';
    ui.heart.classList.remove('live');
    ui.bpm.textContent = '--';
    ui.confidence.textContent = 'signal quality: –';
    setSensorStatus('Sensor stopped.');
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  const NO_FLASH_MSG =
    'Flash unavailable on this camera — tap "Flash" to retry, or hold your fingertip over the camera in front of a bright lamp.';
  const isFirefox = /Firefox|FxiOS/i.test(navigator.userAgent);
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  // Firefox (all platforms) doesn't expose the torch to websites at all.
  const BROWSER_NO_TORCH_MSG = isIOS
    ? 'This iPhone browser can\'t turn on the flash — update to iOS 17.4+ and use Safari, or hold your fingertip over the camera in front of a bright lamp.'
    : 'Firefox can\'t turn on the camera flash — open this page in Chrome for the flash, or hold your fingertip over the camera in front of a bright lamp.';
  let browserLacksTorch = false;
  const noFlashMessage = () => (isFirefox || (isIOS && browserLacksTorch) ? BROWSER_NO_TORCH_MSG : NO_FLASH_MSG);
  const VIDEO_BASE = { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 30 } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // The camera that had the flash last time, so the next start skips the lens search.
  const TORCH_CAM_KEY = 'pulse.torchCam';
  const savedTorchCam = () => { try { return localStorage.getItem(TORCH_CAM_KEY); } catch (_) { return null; } };
  const saveTorchCam = (id) => { try { localStorage.setItem(TORCH_CAM_KEY, id); } catch (_) { /* ignore */ } };

  // Camera/flash diagnostics, mirrored to the server console.
  const diagLines = [];
  let diagTimer = null;
  function dlog(msg) {
    const line = `${(performance.now() / 1000).toFixed(1)}s ${msg}`;
    diagLines.push(line);
    if (diagLines.length > 120) diagLines.shift();
    clearTimeout(diagTimer);
    diagTimer = setTimeout(() => socket.emit('diag', { ua: navigator.userAgent, lines: diagLines.slice(-60) }), 400);
  }
  const errStr = (e) => (e ? `${e.name || 'Error'}: ${e.message || e}` : 'unknown');
  function describeTrack(track) {
    let caps = {};
    let settings = {};
    try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { dlog(`getCapabilities threw ${errStr(e)}`); }
    try { settings = track.getSettings(); } catch (_) { /* ignore */ }
    return `label="${track.label}" state=${track.readyState} caps=[${Object.keys(caps).join(',')}] torchCap=${JSON.stringify(caps.torch)} ` +
      `facing=${settings.facingMode} ${settings.width}x${settings.height} torchSetting=${settings.torch}`;
  }
  dlog(`page loaded v2 secure=${window.isSecureContext} imageCapture=${typeof window.ImageCapture}`);

  async function attachStream(s) {
    stream = s;
    ui.cam.srcObject = s;
    try {
      // play() can stay pending (e.g. background tab, low-power mode); never block on it.
      await Promise.race([ui.cam.play(), sleep(1500)]);
    } catch (_) {
      /* autoplay of a muted inline video is allowed; ignore spurious rejections */
    }
  }

  function releaseStream() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    ui.cam.srcObject = null;
  }

  /**
   * Opens the rear camera and makes sure the flash is lit. Many phones expose several rear
   * cameras and only the main one has a flash, so if the default pick has no torch we try
   * the other back-facing cameras one at a time (phones can't open two at once).
   */
  async function openCameraWithTorch() {
    releaseStream();
    const saved = savedTorchCam();
    if (saved) {
      try {
        await attachStream(
          await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_BASE, deviceId: { exact: saved } } })
        );
        dlog(`opened saved: ${describeTrack(stream.getVideoTracks()[0])}`);
        torchOn = await setTorch(true);
        if (torchOn) return;
      } catch (e) {
        dlog(`open saved camera failed ${errStr(e)}`);
      }
      releaseStream();
    }
    await attachStream(
      await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_BASE, facingMode: { ideal: 'environment' } } })
    );
    dlog(`opened default: ${describeTrack(stream.getVideoTracks()[0])}`);
    torchOn = await setTorch(true);
    if (torchOn) return;

    const firstId = stream.getVideoTracks()[0].getSettings().deviceId;
    let candidates = [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      dlog(`devices: ${all.filter((d) => d.kind === 'videoinput').map((d) => `"${d.label}"`).join(' | ')}`);
      candidates = all.filter(
        (d) => d.kind === 'videoinput' && d.deviceId && d.deviceId !== firstId && !/front|user|facetime|selfie/i.test(d.label)
      );
    } catch (e) {
      dlog(`enumerateDevices failed ${errStr(e)}`);
    }
    // Prefer cameras labelled as rear/back; front cameras never have a torch.
    candidates.sort((a, b) => /back|rear|environment/i.test(b.label) - /back|rear|environment/i.test(a.label));

    for (const d of candidates) {
      setSensorStatus('Looking for the camera with the flash…');
      releaseStream();
      try {
        await attachStream(
          await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_BASE, deviceId: { exact: d.deviceId } } })
        );
      } catch (e) {
        dlog(`open "${d.label}" failed ${errStr(e)}`);
        continue;
      }
      dlog(`opened: ${describeTrack(stream.getVideoTracks()[0])}`);
      torchOn = await setTorch(true);
      if (torchOn) return;
    }

    // No torch anywhere: fall back to the default rear camera.
    dlog('no camera accepted torch; falling back to default rear camera');
    releaseStream();
    await attachStream(
      await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...VIDEO_BASE, facingMode: { ideal: 'environment' } } })
    );
    torchOn = await setTorch(true);
  }

  /** Torch capability often only appears once frames are flowing, so poll briefly. */
  async function setTorch(on) {
    const track = stream && stream.getVideoTracks()[0];
    if (!track) return false;
    if (!track.getCapabilities) {
      dlog('track.getCapabilities not supported');
      return false;
    }
    let caps = track.getCapabilities();
    for (let i = 0; i < 10 && !caps.torch; i++) {
      await sleep(150);
      if (track.readyState !== 'live') return false;
      caps = track.getCapabilities();
    }
    if (!caps.torch) {
      // A browser that supports torch lists the key (even as [false]); absence means no API support.
      if (!('torch' in caps)) browserLacksTorch = true;
      dlog(`no torch capability on "${track.label}" (caps: ${Object.keys(caps).join(',')})`);
      return false;
    }
    for (const c of [{ advanced: [{ torch: on }] }, { torch: on }]) {
      try {
        await track.applyConstraints(c);
        const s = track.getSettings();
        dlog(`applyConstraints(${JSON.stringify(c)}) ok -> settings.torch=${s.torch}`);
        if (s.torch === undefined || s.torch === on) {
          if (on && s.deviceId) saveTorchCam(s.deviceId);
          return on;
        }
      } catch (e) {
        dlog(`applyConstraints(${JSON.stringify(c)}) failed ${errStr(e)}`);
      }
    }
    return false;
  }

  function updateTorchUi() {
    ui.flashBtn.hidden = !running;
    ui.flashBtn.textContent = torchOn ? 'Flash on' : 'Flash off';
    ui.flashBtn.classList.toggle('on', torchOn);
  }

  ui.flashBtn.addEventListener('click', async () => {
    if (!running || !stream) return;
    ui.flashBtn.disabled = true;
    if (torchOn) {
      await setTorch(false);
      torchOn = false;
    } else {
      torchOn = await setTorch(true);
      if (!torchOn) {
        // Retry the full search (another lens may have the flash).
        try {
          await openCameraWithTorch();
          detector.reset();
          restartFrameLoop();
        } catch (_) {
          /* keep current state */
        }
      }
    }
    ui.flashBtn.disabled = false;
    updateTorchUi();
    setSensorStatus(torchOn ? 'Flash on — cover camera + flash with a fingertip.' : noFlashMessage());
  });

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (_) {
      /* not critical */
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (running || dancing) requestWakeLock();
    if (running && torchOn) setTorch(true);
  });

  // A camera switch replaces the video source; bump the generation so stale callbacks exit.
  let loopGen = 0;
  function restartFrameLoop() {
    loopGen++;
    scheduleFrame();
  }

  function scheduleFrame() {
    if (!running) return;
    const gen = loopGen;
    const cb = (now) => {
      if (gen === loopGen) onFrame(now);
    };
    if (ui.cam.requestVideoFrameCallback) ui.cam.requestVideoFrameCallback(cb);
    else requestAnimationFrame(cb);
  }

  function onFrame(now) {
    if (!running) return;
    if (ui.cam.readyState >= 2) {
      const w = ui.sample.width;
      const h = ui.sample.height;
      // Downscaling to 32x24 averages the frame cheaply on the GPU before readback.
      sctx.drawImage(ui.cam, 0, 0, w, h);
      const px = sctx.getImageData(0, 0, w, h).data;
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < px.length; i += 4) {
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
      }
      const n = px.length / 4;
      r /= n; g /= n; b /= n;
      const contact = PulseDetector.detectContact(r, g, b);
      const sig = detector.addSample(r, now, contact);
      if (detector.takeBeat()) {
        beatsSinceSend++;
        flashHeart();
      }
      pushWave(contact ? sig : 0);
      updateReadout(contact);
    }
    scheduleFrame();
  }

  function sendPulse() {
    if (!running || !socket.connected) return;
    const contact = detector.hasContact;
    socket.volatile.emit('pulse', {
      bpm: contact && detector.confidence > 0.2 ? Math.round(detector.bpm * 10) / 10 : 0,
      signal: contact ? Math.round(detector.signal * 1000) / 1000 : 0,
      confidence: contact ? Math.round(detector.confidence * 100) / 100 : 0,
      beat: beatsSinceSend > 0,
      source: 'heart',
    });
    beatsSinceSend = 0;
  }

  let lastReadout = 0;
  function updateReadout(contact) {
    const t = performance.now();
    if (t - lastReadout < 250) return;
    lastReadout = t;
    if (!contact) {
      ui.bpm.textContent = '--';
      ui.confidence.textContent = 'signal quality: –';
      setSensorStatus(torchOn ? 'No fingertip detected. Cover the camera and flash completely.' : noFlashMessage());
      return;
    }
    const c = detector.confidence;
    ui.bpm.textContent = detector.bpm > 0 && c > 0.2 ? Math.round(detector.bpm) : '--';
    ui.confidence.textContent = `signal quality: ${c > 0.7 ? 'great' : c > 0.4 ? 'good' : c > 0.2 ? 'fair' : 'searching…'}`;
    setSensorStatus(c > 0.2 ? 'Streaming your pulse to the room' : 'Reading… hold still.');
  }

  function setSensorStatus(text, isError) {
    ui.sensorStatus.textContent = text;
    ui.sensorStatus.className = `status ${isError ? 'error' : ''}`;
  }

  let heartTimer = null;
  function flashHeart() {
    ui.heart.classList.add('beat');
    clearTimeout(heartTimer);
    heartTimer = setTimeout(() => ui.heart.classList.remove('beat'), 120);
  }

  function pushWave(v) {
    waveBuf[waveHead] = v;
    waveHead = (waveHead + 1) % waveBuf.length;
    drawWave();
  }

  function drawWave() {
    const { width: w, height: h } = ui.wave;
    wctx.clearRect(0, 0, w, h);
    wctx.lineWidth = 2;
    wctx.strokeStyle = '#ffffe3';
    wctx.beginPath();
    const n = waveBuf.length;
    for (let i = 0; i < n; i++) {
      const v = waveBuf[(waveHead + i) % n];
      const x = (i / (n - 1)) * w;
      const y = h / 2 - v * (h * 0.42);
      if (i === 0) wctx.moveTo(x, y);
      else wctx.lineTo(x, y);
    }
    wctx.stroke();
  }
  drawWave();
  setJoin(join);
})();
