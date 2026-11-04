(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerpK = (dt, tau) => 1 - Math.exp(-dt / tau);
  const TAU = Math.PI * 2;

  // ======================================================================== networking
  const socket = io({ transports: ['websocket', 'polling'] });
  const timeSync = new TimeSync(socket);
  // The display machine is host automatically; a display elsewhere on the network can enter the PIN.
  let hostPin = null;
  try { hostPin = sessionStorage.getItem('pulse.pin'); } catch (_) { /* ignore */ }
  const host = { is: false, pin: null };
  socket.on('connect', () => {
    socket.emit('hello', { role: 'output', controls: savedLook(), pin: hostPin || undefined });
    $('conn').classList.add('on');
  });
  socket.on('disconnect', () => $('conn').classList.remove('on'));
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
      for (const k of ['kaleido', 'echo', 'bloom', 'ripple', 'hearts']) if (typeof f[k] === 'boolean') out[k] = f[k];
    } catch (_) { /* ignore */ }
    return out;
  }

  // ======================================================================== shared animation controls
  /**
   * Mirrors the server's shared controls, which any phone or display can change (latest wins).
   * `ctl` is a per-frame smoothed copy so 15 Hz slider updates glide instead of stepping.
   */
  const controls = {
    heartbeat: true, mode: 0, kaleido: false, echo: false, bloom: false, ripple: false, hearts: true,
    lock: 'open', tempo: 62, intensity: 1, heat: 0, breath: 1, speed: 1, audio: 1, hue: 0,
  };
  const SMOOTHED = ['tempo', 'intensity', 'heat', 'breath', 'speed', 'audio', 'hue'];
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
  }

  fetch('/api/info')
    .then((r) => r.json())
    .then((info) => {
      const url = info.inputUrls[0] || `${location.origin}/input.html`;
      $('joinUrl').textContent = url + (url.startsWith('https://') ? '' : '  (HTTPS needed for phone cameras)');
    })
    .catch(() => ($('joinUrl').textContent = `${location.origin}/input.html`));

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
  };

  socket.on('pulse:agg', (a) => {
    pulse.active = a.active | 0;
    pulse.sensors = a.sensors | 0;
    if (a.bpm > 0) pulse.targetBpm = a.bpm;
    pulse.targetStrength = a.active > 0 ? clamp(0.35 + a.confidence, 0.35, 1) : 0;
    if (!controls.heartbeat) {
      // Heartbeat disabled: sensors are shown in the HUD but don't drive anything.
      hearts.clear();
      return;
    }
    trackHearts(a.hearts);
    if (a.beats > 0 && a.active > 0) {
      const n = Math.max(1, a.active);
      pulse.kick = Math.min(1.5, pulse.kick + (0.8 * a.beats) / n);
      pulse.lastRealBeat = performance.now();
      // Pull the oscillator toward observed beats; with many hearts the nudges average out.
      const frac = pulse.phase - Math.round(pulse.phase);
      pulse.phase -= (frac * 0.35) / n;
    }
  });

  // ---- Per-phone hearts: each phone has its own colour and spot, and every one of its beats
  // sends out a ring there, so people can find themselves in the visuals.
  const MAX_HEART_RINGS = 32; // size of the uHearts array in fx-final.frag
  const hearts = new Map();   // phone number -> { angle, radius, hue, age, conf, seen }
  const heartData = new Float32Array(MAX_HEART_RINGS * 4);

  function trackHearts(list) {
    const t = performance.now();
    for (const [n, hue, beats, conf] of list || []) {
      let h = hearts.get(n);
      if (!h) {
        // Spot on a loose ring around the centre, placed by the phone's hue so colours spread out.
        h = { angle: hue * TAU, radius: 0.55 + 0.25 * ((n * 0.381966) % 1), hue, age: 9 };
        hearts.set(n, h);
      }
      h.conf = conf;
      h.seen = t;
      if (beats > 0) h.age = 0;
    }
    for (const [n, h] of hearts) if (t - h.seen > 2000) hearts.delete(n);
  }

  /** Ages the rings (real time, so they stay on the beat) and packs them for the shader. */
  function heartUniforms(dt) {
    const aspect = canvas.width / Math.max(1, canvas.height);
    let i = 0;
    for (const h of hearts.values()) {
      h.age += dt;
      if (i >= MAX_HEART_RINGS) continue;
      heartData[i * 4] = Math.cos(h.angle) * h.radius * Math.min(1.3, aspect * 0.85);
      heartData[i * 4 + 1] = Math.sin(h.angle) * h.radius;
      heartData[i * 4 + 2] = h.age;
      heartData[i * 4 + 3] = h.hue;
      i++;
    }
    return i;
  }

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

  socket.on('touch:fx', (e) => {
    const drag = e.d === 1;
    addBurst({ x: e.x, y: e.y, hue: e.h, power: drag ? 0.5 : 1, age: 0, life: drag ? 0.9 : 1.8 });
  });
  socket.on('touch:combo', (c) => {
    addBurst({ x: c.x, y: c.y, hue: -1, power: Math.min(4, 1.2 + 0.6 * c.size), age: 0, life: 2.6 });
    pulse.kick = Math.min(1.5, pulse.kick + 0.2 * Math.min(c.size, 5)); // the whole scene surges too
    showCombo(c.size);
  });

  function showCombo(size) {
    const el = $('comboText');
    el.textContent = `COMBO ×${size}`;
    el.classList.remove('show');
    void el.offsetWidth; // restart the animation
    el.classList.add('show');
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

  function updatePulse(dt, nowMs) {
    // Heartbeat off = manual mode: the tempo control drives a full-strength synthetic heartbeat.
    const manual = !ctl.heartbeat;
    const real = !manual && pulse.targetStrength > 0;
    const goal = real && pulse.targetBpm > 0 ? pulse.targetBpm : ctl.tempo;
    pulse.bpm += (goal - pulse.bpm) * lerpK(dt, manual ? 0.4 : 1.5);
    pulse.strength += ((manual ? 1 : pulse.targetStrength) - pulse.strength) * lerpK(dt, 1.0);

    const prev = pulse.phase;
    pulse.phase += (dt * pulse.bpm) / 60;
    if (Math.floor(pulse.phase) > Math.floor(prev)) {
      pulse.beatEvents++;
      const sinceReal = nowMs - pulse.lastRealBeat;
      pulse.kick = Math.max(pulse.kick, manual || (real && sinceReal < 2500) ? 0.75 : real ? 0.6 : 0.35);
    }
    pulse.kick *= Math.exp(-dt * 3.5);
    pulse.beat = pulse.kick * ctl.intensity;

    // "Lub-dub" heartbeat shape.
    const f = pulse.phase - Math.floor(pulse.phase);
    const lub = Math.exp(-f * 9);
    const dub = 0.6 * Math.exp(-Math.abs(f - 0.22) * 28);
    pulse.wave = clamp((Math.max(lub, dub) * (0.45 + 0.55 * pulse.strength) + 0.4 * pulse.kick) * ctl.intensity, 0, 1);
    pulse.breath = Math.sin((pulse.phase / 4) * TAU) * ctl.breath;

    const heat = clamp((pulse.bpm - 55) / 60, 0, 1) * (0.4 + 0.6 * pulse.strength);
    pulse.energy += (clamp(heat + 0.25 * pulse.beat + ctl.heat, 0, 1) - pulse.energy) * lerpK(dt, 0.6);
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
    onset: 0,
    onsetEvents: 0,
    peak: 0.25,
    prevBass: 0,
    bandRanges: null,
    mode: 'off',
  };

  // Virtual audio cables expose what the PC plays as a recording device.
  const CABLE_RE = /cable output|vb-audio|virtual cable|voicemeeter out|blackhole|loopback audio/i;

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
    analyser.smoothingTimeConstant = 0.6;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -15;
    return analyser;
  }

  /**
   * Uploaded files are served from our own origin, so their audio can be analysed directly —
   * no capture needed. The element is routed through Web Audio once (it must then also feed
   * the speakers via the destination node).
   */
  function connectFileAudio() {
    if (audio.fileAnalyser) return;
    const el = $('filePlayer');
    ensureAudioContext();
    const src = audio.ctx.createMediaElementSource(el);
    audio.fileAnalyser = makeAnalyser();
    src.connect(audio.fileAnalyser);
    src.connect(audio.ctx.destination);
  }

  async function findCableDevice() {
    const list = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    let inputs = await list();
    if (!inputs.some((d) => d.label)) {
      // Device labels are hidden until a microphone permission has been granted once.
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      tmp.getTracks().forEach((t) => t.stop());
      inputs = await list();
    }
    return inputs.find((d) => CABLE_RE.test(d.label) && d.deviceId !== 'default' && d.deviceId !== 'communications') ||
      inputs.find((d) => CABLE_RE.test(d.label));
  }

  async function connectAudio(kind) {
    disconnectAudio();
    if (kind === 'off') {
      setAudioStatus('audio off');
      return;
    }
    ensureAudioContext();
    await audio.ctx.resume();
    const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    let stream;
    if (kind === 'tab' || kind === 'screen') {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        throw new Error('Screen/tab capture not supported in this browser — use an input device.');
      }
      // The YouTube iframe is cross-origin, so its audio can't be tapped directly;
      // capturing this tab's (or the whole system's) audio output gives Web Audio the synced soundtrack.
      // Only audio is used, so request the cheapest possible video.
      const video = { frameRate: { ideal: 1 }, width: { ideal: 320 }, height: { ideal: 180 } };
      stream = await navigator.mediaDevices.getDisplayMedia(
        kind === 'tab'
          ? { video, audio: raw, preferCurrentTab: true, selfBrowserSurface: 'include', systemAudio: 'include' }
          : // Whole-screen capture with system audio avoids Chrome's coloured "shared tab" outline.
            { video: { ...video, displaySurface: 'monitor' }, audio: raw, systemAudio: 'include', selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include', surfaceSwitching: 'exclude' }
      );
      if (stream.getAudioTracks().length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error(kind === 'tab' ? 'No audio shared — tick “Share tab audio”.' : 'No audio shared — pick “Entire screen” and tick “Also share system audio”.');
      }
      stream.getVideoTracks().forEach((t) => (t.enabled = false));
    } else if (kind === 'cable') {
      const cable = await findCableDevice();
      if (!cable) {
        throw new Error('No virtual cable found — install VB-Audio Cable (vb-audio.com/Cable), then reload.');
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...raw, deviceId: { exact: cable.deviceId } }, video: false });
    } else {
      const deviceId = $('audioDevice').value;
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { ...raw, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
        video: false,
      });
      refreshAudioDevices();
    }
    const analyser = makeAnalyser();
    const source = audio.ctx.createMediaStreamSource(stream);
    // Analyse only; never route to the speakers (the YouTube player already plays it).
    source.connect(analyser);

    audio.stream = stream;
    audio.source = source;
    audio.analyser = analyser;
    audio.mode = kind;
    stream.getAudioTracks()[0].addEventListener('ended', () => {
      disconnectAudio();
      setAudioStatus('audio capture ended');
    });
    const label = stream.getAudioTracks()[0].label;
    setAudioStatus(
      kind === 'tab'
        ? 'tab audio ✓'
        : kind === 'screen'
          ? 'system audio ✓'
          : kind === 'cable'
            ? `virtual cable ✓${label ? ` (${label.slice(0, 24)})` : ''}`
            : `input ✓${label ? ` (${label.slice(0, 28)})` : ''}`
    );
    try { localStorage.setItem('pulse.audioSrc', kind); } catch (_) { /* ignore */ }
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

  function updateAudio(dt) {
    let bass = 0, mid = 0, treble = 0, nb = 0, nm = 0, nt = 0;
    // An uploaded file playing on this display is analysed directly; otherwise use the capture source.
    const fileDirect = audio.fileAnalyser && yt.kind === 'file';
    if (fileDirect !== audio.fileDirect) {
      audio.fileDirect = fileDirect;
      $('fileAudioBadge').hidden = !fileDirect;
    }
    const analyser = fileDirect ? audio.fileAnalyser : audio.analyser;
    if (analyser) {
      analyser.getByteFrequencyData(audio.freq);
      for (let i = 0; i < FFT_BINS; i++) {
        const [b0, b1, f0] = audio.bandRanges[i];
        let m = 0;
        for (let k = b0; k < b1; k++) if (audio.freq[k] > m) m = audio.freq[k];
        audio.bins[i] = m;
        const v = m / 255;
        if (f0 < 160) { bass += v; nb++; }
        else if (f0 < 2000) { mid += v; nm++; }
        else if (f0 < 11000) { treble += v; nt++; }
      }
      bass /= nb || 1;
      mid /= nm || 1;
      treble /= nt || 1;
    } else {
      audio.bins.fill(0);
    }

    // Spotify can't be analysed directly: hint at a capture source if nothing is being heard.
    const rawLevel = Math.max(bass, mid, treble);
    audio.silentFor = analyser && rawLevel > 0.03 ? 0 : (audio.silentFor || 0) + dt;
    const exp = yt.expected();
    const spotifyDeaf = yt.kind === 'spotify' && !!exp && exp.playing && audio.silentFor > 4;
    if (spotifyDeaf !== audio.spotifyDeaf) {
      audio.spotifyDeaf = spotifyDeaf;
      $('spotifyHint').hidden = !spotifyDeaf;
    }

    // Slow automatic gain so quiet and loud tracks both drive the visuals fully.
    const raw = rawLevel;
    audio.peak = Math.max(raw, audio.peak * Math.exp(-dt / 6), 0.08);
    const g = ctl.audio / audio.peak; // the audio-reactivity control scales everything, including onsets
    const k = lerpK(dt, 0.08);
    audio.bass += (clamp(bass * g, 0, 1) - audio.bass) * k;
    audio.mid += (clamp(mid * g, 0, 1) - audio.mid) * k;
    audio.treble += (clamp(treble * g, 0, 1) - audio.treble) * k;
    audio.level = (audio.bass + audio.mid + audio.treble) / 3;

    const rawBass = clamp(bass * g, 0, 1);
    const flux = rawBass - audio.prevBass;
    audio.prevBass = rawBass;
    if (flux > 0.18 && audio.onset < 0.5) {
      audio.onset = 1;
      audio.onsetEvents++;
    }
    audio.onset *= Math.exp(-dt * 6);
  }

  function setAudioStatus(t) {
    $('audioStatus').textContent = t;
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
        this.t += dt * (0.25 + 0.6 * pulse.energy + 0.9 * pulse.beat);
        this.shift[0] += dt * (0.01 + 0.18 * audio.bass);
        this.shift[1] += dt * (0.008 + 0.14 * audio.mid);
        this.shift[2] += dt * (0.006 + 0.14 * audio.treble);
      },
      render(target, U) {
        const s = pulse.strength;
        draw(P['domain-warp'], {
          ...U,
          uWarpTime: this.t,
          uWarpAmp: 1.4 + 0.8 * pulse.breath * (0.35 + 0.65 * s) + 0.6 * pulse.beat,
          uPaletteShift: [
            this.shift[0] + 0.25 * audio.bass,
            this.shift[1] + 0.2 * audio.mid,
            this.shift[2] + 0.2 * audio.treble,
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
        this.heat += (clamp(pulse.energy * 0.9 + pulse.beat * 0.3, 0, 1) - this.heat) * lerpK(dt, 2.5);
        // Calm = branching "coral" mycelium, hot = "mitosis" regime with dividing cells.
        const feed = 0.0545 + (0.0367 - 0.0545) * this.heat;
        const kill = 0.062 + (0.0649 - 0.062) * this.heat;
        // dt already includes the speed control, so slow motion also slows the simulation.
        const steps = Math.round(clamp(6 + 16 * this.heat + 10 * pulse.beat, 4, 30) * clamp(dt * 60, 0, 2));

        let seeds = pulse.beatEvents - this.lastBeat;
        this.lastBeat = pulse.beatEvents;
        for (let i = 0; i < steps; i++) {
          let seed = [0, 0, 0];
          if (seeds > 0 && i === 0) {
            seed = [Math.random(), Math.random(), 0.012 + 0.02 * pulse.strength];
            seeds--;
          }
          draw(P['rd-sim'], { ...base, uState: st.read.tex, uInit: 0, uFeed: feed, uKill: kill, uSeed: seed }, st.write);
          st.swap();
        }
        this.hue += dt * (0.02 + 0.12 * audio.mid);
      },
      render(target, U) {
        draw(P['rd-display'], { ...U, uState: this.state.read.tex, uTexel: this.state.texel, uHue: this.hue }, target);
      },
    };

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
          uCurlStrength: 18 + 30 * pulse.energy,
        }, v.write);
        v.swap();

        // Pulse = physical force: each beat shoves the fluid from rotating emitters.
        this.spin += dt * (0.15 + 0.4 * pulse.energy);
        const beats = pulse.beatEvents - this.lastBeat;
        this.lastBeat = pulse.beatEvents;
        if (beats > 0) {
          const k = 3 + Math.min(pulse.active, 4);
          const force = 260 + 520 * pulse.energy + 260 * pulse.strength;
          for (let i = 0; i < k; i++) {
            const a = this.spin + (i / k) * TAU;
            const r = 0.22 + 0.06 * Math.sin(this.spin * 3 + i);
            const x = 0.5 + (Math.cos(a) * r) / this.aspect;
            const y = 0.5 + Math.sin(a) * r;
            const dir = a + Math.PI / 2 + 0.6;
            this.splat(v, x, y, [Math.cos(dir) * force, Math.sin(dir) * force, 0], 0.0035);
            // A faint dye trail marks every heartbeat even in silence.
            const c = hsv((this.hue + i / k) % 1, 0.8, 0.12 + 0.1 * pulse.strength);
            this.splat(this.dye, x, y, c, 0.0025);
          }
        }
        // Breathing lung at the centre: radial in/out push.
        const lung = pulse.breath * 70 * (0.4 + 0.6 * pulse.strength);
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * TAU + 0.785;
          this.splat(v, 0.5 + (Math.cos(a) * 0.08) / this.aspect, 0.5 + Math.sin(a) * 0.08,
            [Math.cos(a) * lung, Math.sin(a) * lung, 0], 0.004);
        }

        // Audio = dye: onsets drop vivid ink; strongest band picks the colour.
        this.hue = (this.hue + dt * (0.03 + 0.1 * audio.mid)) % 1;
        const onsets = audio.onsetEvents - this.lastOnset;
        this.lastOnset = audio.onsetEvents;
        if (onsets > 0 || (audio.level > 0.35 && Math.random() < audio.level * 0.25)) {
          let best = 0;
          for (let i = 1; i < FFT_BINS; i++) if (audio.bins[i] > audio.bins[best]) best = i;
          const h = (this.hue + best / FFT_BINS) % 1;
          const amt = onsets > 0 ? 0.9 + 0.8 * audio.bass : 0.35 * audio.level;
          const x = 0.15 + Math.random() * 0.7;
          const y = 0.15 + Math.random() * 0.7;
          this.splat(this.dye, x, y, hsv(h, 0.9, amt), 0.002 + 0.004 * audio.bass);
          const a = Math.random() * TAU;
          const f = 150 + 350 * audio.bass;
          this.splat(v, x, y, [Math.cos(a) * f, Math.sin(a) * f, 0], 0.003);
        }
        if (this.inject) this.inject(dt);

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
          uDissipation: 0.18 + 0.25 * (1 - audio.level),
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
      j.angle += dt * (0.03 + 0.12 * pulse.energy + 0.25 * pulse.beat);
      j.rot += dt * 0.03;
      j.hue += dt * (0.02 + 0.15 * audio.mid);
    };
    const juliaUniforms = (j) => {
      const s = 0.35 + 0.65 * pulse.strength;
      const a = j.angle + 0.16 * pulse.breath * s + 0.05 * pulse.wave;
      const r = 0.7885 - 0.025 * pulse.beat + 0.008 * pulse.breath * s;
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
            uInject: d * (0.6 + 1.2 * audio.level + 1.0 * pulse.beat),
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
        const vel = 0.07 + 0.32 * pulse.energy * (0.4 + 0.6 * pulse.strength) + 0.7 * pulse.beat;
        this.logZoom += dt * vel;
        if (this.logZoom >= LOOP_AT + misOrbit.lnRho) {
          this.logZoom -= misOrbit.lnRho;
          this.wraps++;
        }
        this.rot += dt * 0.04;
        this.bands += dt * (0.02 + 0.3 * audio.bass);
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
        const sGoal = 1.12 + 0.04 * pulse.breath * (0.4 + 0.6 * pulse.strength);
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
        const rate = 1.2 + 3 * pulse.energy * (0.4 + 0.6 * pulse.strength) + 1.5 * pulse.beat; // ~gaps per second
        this.speed += (this.room * rate - this.speed) * lerpK(dt, 0.8);
        const step = Math.min(this.speed * dt, Math.max(d * 0.6, 0.0002));
        for (let i = 0; i < 3; i++) p[i] = fract((p[i] + this.fwd[i] * step + 1) / 2) * 2 - 1;
        this.roll += dt * (0.04 + 0.1 * audio.mid) * Math.sin(this.t * 0.05);
        this.hue += dt * (0.015 + 0.08 * audio.mid);
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

    return [warp, rd, fluid, julia, mandel, juliaFluid, flight];
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
    { id: 'hearts', label: 'Hearts', key: 't' },
  ];
  const fx = { kaleido: false, echo: false, bloom: false, ripple: false, hearts: true };
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
  }

  function clearTarget(t) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Runs the enabled post-processing chain: scene -> kaleido/ripples/bursts -> echo -> bloom -> screen. */
  function runFx(dt, U, heartCount, burstCount) {
    const P = programs;
    let src = view.rtScene;

    // Each heartbeat launches a shockwave ring (up to 4 alive at once).
    const beats = pulse.beatEvents - fxState.lastBeat;
    fxState.lastBeat = pulse.beatEvents;
    if (beats > 0) fxState.ripples.unshift(0);
    fxState.ripples = fxState.ripples.map((a) => a + dt).filter((a) => a < 2.2).slice(0, 4);
    fxState.kRot += dt * (0.05 + 0.25 * pulse.energy);
    const hueRotate = ctl.hue * TAU;

    if (fx.kaleido || fx.ripple || burstCount > 0) {
      const r = fxState.ripples;
      draw(P['fx-pre'], {
        ...U,
        uSrc: src.tex,
        uKaleido: fx.kaleido ? 1 : 0,
        uSegments: 6 + 2 * Math.floor(pulse.energy * 2.99), // 6, 8 or 10 slices as the room heats up
        uKRot: fxState.kRot + 0.25 * pulse.breath,
        uKZoom: 1.0 - 0.12 * pulse.breath * (0.4 + 0.6 * pulse.strength),
        uRipple: fx.ripple ? 1 : 0,
        uRipples: [0, 1, 2, 3].map((i) => (i < r.length ? r[i] : -1)),
        uBurstCount: burstCount,
        uBursts: burstData,
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
        uDecay: clamp(0.93 - 0.05 * pulse.energy, 0.85, 0.94),
        uZoom: 1.004 + 0.02 * pulse.beat + 0.004 * audio.bass,
        uRot: 0.0025 * pulse.breath + 0.002 * audio.mid,
        uHueShift: 0.015 + 0.04 * audio.treble,
      }, view.fb.write);
      view.fb.swap();
      src = view.fb.read;
    }

    let bloomAmt = 0;
    if (fx.bloom) {
      const tx = 1 / view.bloomA.w;
      const ty = 1 / view.bloomA.h;
      draw(P['fx-bright'], { uSrc: src.tex, uThreshold: 0.68 - 0.12 * audio.level }, view.bloomA);
      for (const spread of [1.0, 2.2]) {
        draw(P['fx-blur'], { uSrc: view.bloomA.tex, uDir: [tx * spread, 0] }, view.bloomB);
        draw(P['fx-blur'], { uSrc: view.bloomB.tex, uDir: [0, ty * spread] }, view.bloomA);
      }
      bloomAmt = 0.3 + 0.8 * audio.level + 0.3 * pulse.beat;
    }

    draw(P['fx-final'], {
      ...U,
      uSrc: src.tex,
      uBloom: view.bloomA.tex,
      uBloomAmt: bloomAmt,
      uHueRotate: hueRotate,
      uHeartCount: heartCount,
      uHearts: heartData,
      uBurstCount: burstCount,
      uBursts: burstData,
      uBurstHue: burstHue,
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
    updateAudio(dt);
    // Animation time runs at the speed control's rate; the heartbeat itself keeps real time.
    const sdt = dt * ctl.speed;
    animTime += sdt;

    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FFT_BINS, 1, gl.RED, gl.UNSIGNED_BYTE, audio.bins);

    const U = {
      uRes: [canvas.width, canvas.height],
      uTime: animTime,
      uBpm: pulse.bpm,
      uPulse: pulse.wave,
      uBeat: pulse.beat,
      uBreath: pulse.breath,
      uEnergy: pulse.energy,
      uStrength: pulse.strength,
      uUsers: pulse.active,
      uBass: audio.bass,
      uMid: audio.mid,
      uTreble: audio.treble,
      uLevel: audio.level,
      uOnset: audio.onset,
      uFFT: fftTex,
    };

    const cur = modes[current];
    // A colour shift only needs the final pass, so it also routes the scene through the FX chain.
    const heartCount = heartUniforms(dt);
    const showHearts = fx.hearts && heartCount > 0;
    const burstCount = burstUniforms(dt);
    const fxOn = fx.kaleido || fx.echo || fx.bloom || fx.ripple || showHearts || burstCount > 0 || ctl.hue > 0.002;
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
    if (fxOn) runFx(sdt, U, showHearts ? heartCount : 0, burstCount);

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
      spec.fillStyle = `hsl(${300 - i * 3}, 90%, ${45 + v * 25}%)`;
      spec.fillRect(i * bw, h - v * h, bw - 0.5, v * h);
    }
  }

  function updateHud() {
    $('hudBpm').textContent = !controls.heartbeat || pulse.targetStrength > 0 ? Math.round(pulse.bpm) : '--';
    $('hudUsers').textContent = pulse.active;
    $('hudFps').textContent = `${Math.round(1000 / view.frameMs)} fps · ${Math.round(view.scale * 100)}%`;
  }

  // ---- Heartbeat on/off (shared): off = sensors are ignored and the tempo control sets the rhythm.
  function updateHeartbeatUi() {
    const on = controls.heartbeat;
    const b = $('hbBtn');
    b.textContent = on ? '♥ Heartbeat on' : '♡ Heartbeat off';
    b.classList.toggle('off', !on);
    b.title = on ? 'Phones\' heartbeats drive the visuals. Click (M) to switch to manual tempo.' : 'Manual mode: the tempo slider drives the visuals. Click (M) to use heartbeats again.';
    $('hudMode').textContent = on ? 'BPM' : 'BPM · manual';
  }
  const toggleHeartbeat = () => setControl({ heartbeat: !controls.heartbeat });
  $('hbBtn').addEventListener('click', toggleHeartbeat);

  // ---- Host lock: what phones may change. Click cycles open -> sliders only -> locked.
  const LOCK_UI = {
    open: { text: '🔓 Phones: all', next: 'limited' },
    limited: { text: '🔒 Phones: sliders', next: 'locked' },
    locked: { text: '🔒 Phones: none', next: 'open' },
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

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    const n = parseInt(e.key, 10);
    if (modes && n >= 1 && n <= modes.length) setMode(n - 1);
    else if (e.key === 'ArrowRight') setMode(current + 1);
    else if (e.key === 'ArrowLeft') setMode(current - 1);
    else if (e.key === 'h' || e.key === 'H') ui.classList.toggle('hidden');
    else if (e.key === 'v' || e.key === 'V') toggleDock();
    else if (e.key === 'q' || e.key === 'Q') $('qrCorner').hidden = !$('qrCorner').hidden;
    else if (e.key === 'p' || e.key === 'P') togglePlay();
    else if (e.key === 'm' || e.key === 'M') toggleHeartbeat();
    else if (e.key === 'f' || e.key === 'F') {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    } else {
      const d = FX_DEFS.find((x) => x.key === e.key.toLowerCase());
      if (d) toggleFx(d.id);
    }
  });

  // ---- Shared media (YouTube or uploaded file), locked to the server clock
  let ytState = null;
  const yt = new MediaSync('player', socket, timeSync, {
    muted: false,
    mediaElement: $('filePlayer'),
    spotifyElement: $('spotifyWrap'),
    shield: $('shield'),
    reportSpotifyDuration: true,
    onStatus: (s) => {
      if (s.error) $('nowPlaying').textContent = s.error;
      else if (!s.kind) $('nowPlaying').textContent = 'nothing playing';
      else if (s.note) $('nowPlaying').textContent = s.note;
      // Spotify sometimes refuses to start on its own; its play button is clickable then.
      else if (s.kind === 'spotify' && yt.blocked) $('nowPlaying').textContent = 'Click ▶ in the Spotify player to start';
      else {
        const sec = Math.floor(s.position || 0);
        $('nowPlaying').textContent = `${s.playing ? '▶' : '❚❚'} ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} · ${s.title}`;
      }
      $('playPause').textContent = s.playing ? '❚❚' : '▶';
    },
  });
  socket.on('yt:state', (s) => (ytState = s));
  const linkSource = sourcePicker([...document.querySelectorAll('.src-toggle button')], $('ytUrl'));

  $('mediaFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    yt.unlock();
    try {
      await uploadMedia(file, (p) => ($('nowPlaying').textContent = `uploading ${Math.round(p * 100)}%…`));
    } catch (err) {
      $('nowPlaying').textContent = err.message;
    }
  });

  function togglePlay() {
    const exp = yt.expected();
    socket.emit('yt:control', exp && exp.playing ? 'pause' : 'play');
  }
  function toggleDock() {
    const c = $('dock').classList.toggle('collapsed');
    $('dockToggle').textContent = c ? '▴' : '▾';
  }
  $('playPause').addEventListener('click', () => { yt.unlock(); togglePlay(); });
  $('restart').addEventListener('click', () => socket.emit('yt:control', 'restart'));
  $('dockToggle').addEventListener('click', toggleDock);
  $('ytForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('ytUrl').value.trim();
    if (!url) return;
    yt.unlock();
    socket.timeout(5000).emit('media:submit', { source: linkSource(), url }, (err, res) => {
      if (err || !res.ok) $('nowPlaying').textContent = err ? 'server timeout' : res.error;
      else $('ytUrl').value = '';
    });
  });

  // ---- audio source controls
  // Static, trusted strings only (rendered as HTML for emphasis).
  const SOURCE_HINTS = {
    tab: 'Choose <b>this tab</b> and enable “Share tab audio”. Chrome outlines the shared tab.',
    screen: 'Choose <b>Entire screen</b>, tick “Also share system audio”, then click <b>Hide</b> on Chrome\'s sharing bar.',
    cable: 'Install <b>VB-Audio Cable</b> (vb-audio.com/Cable). In Windows Sound settings set <b>CABLE Input</b> as the output for Chrome (or the default), then on <b>CABLE Output → Properties → Listen</b> tick “Listen to this device” and pick your speakers.',
    mic: 'Pick <b>Stereo Mix</b> (if enabled) to hear exactly what the PC plays, or a microphone to hear the room.',
    off: 'Visuals follow the heartbeats only (uploaded files are still analysed).',
  };
  // Loopback inputs hear exactly what the PC plays — no share prompt and no capture outline.
  const LOOPBACK_RE = /stereo mix|cable output|loopback|what u hear|wave out|monitor of/i;

  async function refreshAudioDevices() {
    const sel = $('audioDevice');
    let saved = null;
    try { saved = localStorage.getItem('pulse.audioDevice'); } catch (_) { /* ignore */ }
    let inputs = [];
    try {
      inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch (_) {
      return;
    }
    const current = saved !== null ? saved : null;
    const fill = (s) => {
      s.textContent = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'Default input';
      s.appendChild(def);
      for (const d of inputs) {
        if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
        const o = document.createElement('option');
        o.value = d.deviceId;
        const name = d.label || `Input ${s.length}`;
        o.textContent = LOOPBACK_RE.test(name) ? `${name} — PC audio, no prompt` : name;
        s.appendChild(o);
      }
    };
    fill(sel);
    fill($('startAudioDevice'));
    const values = [...sel.options].map((o) => o.value);
    if (current !== null && values.includes(current)) sel.value = current;
    else {
      const loop = inputs.find((d) => LOOPBACK_RE.test(d.label));
      sel.value = loop && values.includes(loop.deviceId) ? loop.deviceId : '';
    }
    $('startAudioDevice').value = sel.value;
  }

  function syncAudioUi() {
    $('audioDevice').hidden = $('audioSrc').value !== 'mic';
    $('startAudioDeviceField').hidden = $('startAudioSrc').value !== 'mic';
    $('sourceHint').innerHTML = SOURCE_HINTS[$('startAudioSrc').value] || '';
  }

  async function tryConnectAudio(kind) {
    $('audioSrc').value = kind;
    syncAudioUi();
    setAudioStatus('connecting…');
    try {
      await connectAudio(kind);
    } catch (err) {
      disconnectAudio();
      setAudioStatus(err && err.name === 'NotAllowedError' ? 'audio permission denied' : (err.message || 'audio failed'));
    }
  }
  $('audioBtn').addEventListener('click', () => tryConnectAudio($('audioSrc').value));
  $('audioSrc').addEventListener('change', syncAudioUi);
  $('startAudioSrc').addEventListener('change', syncAudioUi);
  const onDeviceChange = (src) => () => {
    $('audioDevice').value = src.value;
    $('startAudioDevice').value = src.value;
    try { localStorage.setItem('pulse.audioDevice', src.value); } catch (_) { /* ignore */ }
  };
  $('startAudioDevice').addEventListener('change', onDeviceChange($('startAudioDevice')));
  $('audioDevice').addEventListener('change', () => {
    onDeviceChange($('audioDevice'))();
    if ($('audioSrc').value === 'mic') tryConnectAudio('mic');
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', refreshAudioDevices);
  }
  refreshAudioDevices();

  try {
    const savedSrc = localStorage.getItem('pulse.audioSrc');
    if (savedSrc && [...$('startAudioSrc').options].some((o) => o.value === savedSrc)) {
      $('startAudioSrc').value = savedSrc;
      $('audioSrc').value = savedSrc;
    }
  } catch (_) { /* ignore */ }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    $('startAudioSrc').value = 'mic';
  }
  syncAudioUi();

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
    // Inside the click gesture: create/resume the AudioContext and route uploaded media through it.
    ensureAudioContext();
    try {
      connectFileAudio();
    } catch (err) {
      console.warn('File audio analysis unavailable', err);
    }
    audio.ctx.resume();
    yt.unlock();
    await tryConnectAudio($('startAudioSrc').value);
  });

  // Expose for debugging in DevTools.
  window.__pulse = { pulse, audio, view, fx, toggleFx, controls, ctl, setControl, media: yt, renderFrame: (t) => renderFrame(t), setMode, get modes() { return modes; }, get programs() { return programs; }, gl, get ytState() { return ytState; } };
})();
