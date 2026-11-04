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
    diagLog: $('diagLog'),
    roomBpm: $('roomBpm'),
    roomSensors: $('roomSensors'),
    roomDisplays: $('roomDisplays'),
    ytForm: $('ytForm'),
    ytUrl: $('ytUrl'),
    ytMsg: $('ytMsg'),
    ytStatus: $('ytStatus'),
    ytEmpty: $('ytEmpty'),
    tapSync: $('tapSync'),
    soundBtn: $('soundBtn'),
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
    ui.roomDisplays.textContent = s.displays;
    roomSensing = s.bpm > 0;
    renderAnim();
  });
  let roomSensing = false;
  timeSync.start();

  // A server restarted with new code reloads this page, unless that would interrupt a running sensor.
  watchServerBuild(socket, (kind) => {
    if (kind === 'updated' && !running) return location.reload();
    showBanner(STALE_TEXT[kind], kind === 'updated' ? { label: 'Reload', run: () => location.reload() } : null);
  });

  // Each phone gets its own colour; its beats show as rings of that colour on the display.
  socket.on('you', (me) => {
    const color = `hsl(${Math.round(me.hue * 360)}, 90%, 62%)`;
    ui.heart.style.color = color;
    $('youColor').hidden = false;
    $('youColor').style.color = color;
  });

  // ---------------------------------------------------------------- shared media (locked to server)
  const yt = new MediaSync('player', socket, timeSync, {
    muted: true,
    mediaElement: $('filePlayer'),
    spotifyElement: $('spotifyWrap'),
    shield: $('shield'),
    onBlocked: (b) => (ui.tapSync.hidden = !b),
    onStatus: (s) => {
      // Audio files, and Spotify while this phone is muted (the embed can't be muted), show a title card.
      const card = (s.kind === 'file' && s.mime && s.mime.startsWith('audio/')) || (s.kind === 'spotify' && !!s.note);
      $('audioOnly').hidden = !card;
      if (card) $('audioTitle').textContent = s.title || '';
      if (s.error) {
        ui.ytStatus.textContent = s.error;
        return;
      }
      ui.ytEmpty.hidden = !!s.kind;
      if (!s.kind) {
        ui.ytStatus.textContent = 'nothing playing';
        return;
      }
      if (s.note) {
        ui.ytStatus.textContent = s.note;
        return;
      }
      const t = formatTime(s.position);
      const name = s.kind === 'youtube' ? '' : ` · ${s.title}`;
      ui.ytStatus.textContent = `${s.playing ? '▶' : '❚❚'} ${t}${name} · synced${Math.abs(s.drift) > 0.3 ? ' (correcting)' : ''}`;
    },
  });
  const sourceButtons = [...document.querySelectorAll('.src-toggle button')];
  const linkSource = sourcePicker(sourceButtons, ui.ytUrl);

  $('mediaFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    yt.unlock();
    setMsg(`Uploading “${file.name}”…`);
    try {
      await uploadMedia(file, (p) => ($('uploadProgress').textContent = `${Math.round(p * 100)}%`), hostPin);
      setMsg('Uploaded — starting on every screen.', 'ok');
    } catch (err) {
      setMsg(err.message, 'error');
    } finally {
      $('uploadProgress').textContent = '';
    }
  });

  ui.tapSync.addEventListener('click', () => yt.unlock());
  ui.soundBtn.addEventListener('click', () => {
    yt.setMuted(!yt.muted);
    yt.unlock();
    ui.soundBtn.textContent = yt.muted ? '🔇 Sound off' : '🔊 Sound on';
  });

  ui.ytForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = ui.ytUrl.value.trim();
    if (!url) return;
    yt.unlock();
    setMsg('Sending…');
    const source = linkSource();
    socket.timeout(5000).emit('media:submit', { source, url }, (err, res) => {
      if (err) return setMsg('Server did not respond. Try again.', 'error');
      if (!res.ok) return setMsg(res.error, 'error');
      setMsg(
        source === 'spotify'
          ? 'Starting on the display. Spotify plays full songs only when logged in, otherwise 30-second previews.'
          : 'Queued — starting on every screen.',
        'ok'
      );
      ui.ytUrl.value = '';
    });
  });

  function setMsg(text, kind) {
    ui.ytMsg.textContent = text;
    ui.ytMsg.className = `status small ${kind || ''}`;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  // ---------------------------------------------------------------- shared animation controls
  // Everyone shares one set of controls (latest change wins). Ranges mirror ANIM_DEFS in server.js,
  // which clamps them anyway.
  const MODES = ['Domain Warp', 'Reaction-Diffusion', 'Fluid Tracers', 'Julia Set', 'Mandelbrot', 'Julia Fluid', 'Fractal Flight'];
  const FX = [['kaleido', 'Kaleidoscope'], ['echo', 'Echo'], ['bloom', 'Bloom'], ['ripple', 'Heart Ripple'], ['hearts', 'Hearts']];
  const pct = (v) => `${Math.round(v * 100)}%`;
  const SLIDERS = [
    { key: 'tempo', label: 'Tempo', min: 40, max: 180, step: 1, fmt: (v) => `${Math.round(v)} BPM` },
    { key: 'intensity', label: 'Beat intensity', min: 0, max: 2, step: 0.01, fmt: pct },
    { key: 'heat', label: 'Heat', min: -1, max: 1, step: 0.01, fmt: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`, hint: 'Calmer ← → wilder' },
    { key: 'breath', label: 'Breathing', min: 0, max: 2, step: 0.01, fmt: pct },
    { key: 'speed', label: 'Motion speed', min: 0.1, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
    { key: 'audio', label: 'Audio reactivity', min: 0, max: 2, step: 0.01, fmt: pct },
    { key: 'hue', label: 'Colour shift', min: 0, max: 1, step: 0.005, fmt: (v) => `${Math.round(v * 360)}°` },
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
      yt.unlock();
      onClick();
    });
    return b;
  }

  const modeChips = MODES.map((label, i) => chip(label, 'chip', () => sendControl({ mode: i })));
  modeChips.forEach((b) => $('modeGrid').appendChild(b));
  const fxChips = FX.map(([id, label]) => chip(label, 'chip fx', () => sendControl({ [id]: !anim[id] })));
  fxChips.forEach((b) => $('fxGrid').appendChild(b));

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
  const can = (key) => isHost || lockLevel() === 'open' || (lockLevel() === 'limited' && SLIDER_KEYS.has(key));
  const mediaAllowed = () => isHost || lockLevel() === 'open';

  socket.on('host:status', (st) => {
    isHost = !!st.host;
    renderHostRow();
    renderAnim();
  });

  function renderHostRow() {
    const row = $('hostRow');
    row.textContent = '';
    if (!isHost) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'link-btn';
      b.textContent = 'I\'m the host';
      b.addEventListener('click', askForPin);
      row.appendChild(b);
      return;
    }
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
    $('animReset').disabled = !mediaAllowed();
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
      ? '🔒 The host has locked mode, effects and music. You can still use the sliders.'
      : '🔒 The host has locked the controls and music.';
    [...ui.ytForm.querySelectorAll('input, button'), ...sourceButtons].forEach((el) => (el.disabled = !mediaAllowed()));
    $('mediaFile').disabled = !mediaAllowed();
    $('mediaFile').parentElement.classList.toggle('disabled', !mediaAllowed());
    const manual = anim.heartbeat === false;
    const hb = $('hbState');
    hb.textContent = manual
      ? '♡ Heartbeat is off on the display: the Tempo slider sets the rhythm.'
      : '♥ Heartbeats drive the rhythm. Tempo takes over when nobody is sensing.';
    hb.className = `status small ${manual ? 'manual' : ''}`;
    sliderEls.tempo.hint.textContent = manual ? 'Driving the visuals now' : 'Used when the heartbeat is off or nobody is sensing';
    sliderEls.tempo.wrap.classList.toggle('dim', !manual && roomSensing);
  }

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
    yt.unlock();
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

  // Camera/flash diagnostics: shown on the page and mirrored to the server console.
  const diagLines = [];
  let diagTimer = null;
  function dlog(msg) {
    const line = `${(performance.now() / 1000).toFixed(1)}s ${msg}`;
    diagLines.push(line);
    if (diagLines.length > 120) diagLines.shift();
    ui.diagLog.textContent = diagLines.join('\n');
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
        if (s.torch === undefined || s.torch === on) return on;
      } catch (e) {
        dlog(`applyConstraints(${JSON.stringify(c)}) failed ${errStr(e)}`);
      }
    }
    return false;
  }

  function updateTorchUi() {
    ui.flashBtn.hidden = !running;
    ui.flashBtn.textContent = torchOn ? '🔦 Flash on' : '🔦 Flash off';
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
    if (document.visibilityState === 'visible' && running) {
      requestWakeLock();
      if (torchOn) setTorch(true);
    }
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
    setSensorStatus(c > 0.2 ? 'Streaming your pulse to the room ♥' : 'Reading… hold still.');
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
    wctx.lineWidth = 3;
    wctx.strokeStyle = '#ff3d7f';
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
})();
