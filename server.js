'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const PULSE_TICK_MS = 66;            // ~15 Hz aggregated pulse broadcast to displays
const INPUT_SUMMARY_MS = 1000;       // 1 Hz collective summary back to phones
const SYNC_HEARTBEAT_MS = 2000;      // periodic playback-state rebroadcast
const END_CHECK_MS = 500;
const PULSE_MIN_INTERVAL_MS = 50;    // per-socket inbound pulse throttle (max 20 Hz)
const PULSE_STALE_MS = 4000;
const VIDEO_SUBMIT_COOLDOWN_MS = 3000;
const CONTROL_COOLDOWN_MS = 400;
const ANIM_MIN_INTERVAL_MS = 25;     // per-socket inbound animation-control throttle (clients send ~15 Hz)
const ANIM_BROADCAST_MS = 50;        // coalesced animation-control rebroadcast (max 20 Hz)
const MODE_COUNT = 7;

/**
 * Shared animation controls, set by anyone (phones or displays). Numbers are clamped to their
 * range; the display maps them onto the pulse/audio uniforms (see output.js -> updateControls).
 */
const ANIM_DEFS = {
  heartbeat: { type: 'bool', def: true },   // false = sensors ignored, `tempo` drives the rhythm
  mode: { type: 'int', min: 0, max: MODE_COUNT - 1, def: 0 },
  kaleido: { type: 'bool', def: false },
  echo: { type: 'bool', def: false },
  bloom: { type: 'bool', def: false },
  ripple: { type: 'bool', def: false },
  tempo: { min: 40, max: 180, def: 62 },    // BPM when the heartbeat is off or no one is sensing
  intensity: { min: 0, max: 2, def: 1 },    // beat punch
  heat: { min: -1, max: 1, def: 0 },        // offset on the energy ("heat") value
  breath: { min: 0, max: 2, def: 1 },       // breathing depth
  speed: { min: 0.1, max: 3, def: 1 },      // animation time scale
  audio: { min: 0, max: 2, def: 1 },        // audio reactivity
  hue: { min: 0, max: 1, def: 0 },          // global colour rotation (turns)
};

const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Media uploads. 100 MB matches Cloudflare's request-size limit for tunnelled uploads.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 2;
const UPLOAD_COOLDOWN_MS = 3000;
const MAX_KEPT_UPLOADS = 20;
const EXT_TO_MIME = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ogv: 'video/ogg',
};
const MIME_TO_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/webm': 'weba',
  'video/mp4': 'mp4',
  'video/x-m4v': 'm4v',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
};

function parseYouTubeId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 500) return null;
  if (YT_ID_RE.test(s)) return s;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '');
  let id = null;
  if (host === 'youtu.be') {
    id = url.pathname.split('/')[1];
  } else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(embed|shorts|live|v)\/([^/?#]+)/);
      if (m) id = m[2];
    }
  }
  return id && YT_ID_RE.test(id) ? id : null;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Authoritative playback clock. Positions are seconds; times are server ms.
 * `media` is either { kind: 'youtube', id } or { kind: 'file', id, url, title, mime }.
 */
class PlaybackState {
  constructor(now = Date.now) {
    this.now = now;
    this.media = null;
    this.playing = false;
    this.basePosition = 0;
    this.baseTime = now();
    this.duration = 0;
    this.version = 0;
  }

  get videoId() {
    return this.media && this.media.kind === 'youtube' ? this.media.id : null;
  }

  position(t = this.now()) {
    let p = this.basePosition;
    if (this.playing) p += (t - this.baseTime) / 1000;
    if (this.duration > 0) p = Math.min(p, this.duration);
    return Math.max(0, p);
  }

  _rebase(position, playing) {
    this.basePosition = position;
    this.baseTime = this.now();
    this.playing = playing;
    this.version++;
  }

  /** Accepts a YouTube video id (string) or a media descriptor object. */
  load(media) {
    this.media = typeof media === 'string' ? { kind: 'youtube', id: media } : media;
    this.duration = 0;
    // Short lead-in so every client has time to buffer before the shared clock starts.
    this.basePosition = 0;
    this.baseTime = this.now() + 1500;
    this.playing = true;
    this.version++;
  }

  play() {
    if (!this.media || this.playing) return false;
    let pos = this.position();
    if (this.duration > 0 && pos >= this.duration - 0.25) pos = 0;
    this._rebase(pos, true);
    return true;
  }

  pause() {
    if (!this.media || !this.playing) return false;
    this._rebase(this.position(), false);
    return true;
  }

  restart() {
    if (!this.media) return false;
    this._rebase(0, true);
    return true;
  }

  setDuration(mediaId, duration) {
    if (!this.media || mediaId !== this.media.id || this.duration > 0) return false;
    if (!(duration > 0 && duration < 86400)) return false;
    this.duration = duration;
    return true;
  }

  checkEnded() {
    if (this.playing && this.duration > 0 && this.position() >= this.duration) {
      this._rebase(this.duration, false);
      return true;
    }
    return false;
  }

  snapshot() {
    const t = this.now();
    return {
      media: this.media,
      videoId: this.videoId,
      playing: this.playing && t >= this.baseTime,
      // A future baseTime means we're in the lead-in window: clients should cue and wait.
      startsAt: this.playing && t < this.baseTime ? this.baseTime : 0,
      position: this.position(t),
      duration: this.duration,
      serverTime: t,
      version: this.version,
    };
  }
}

/** Keeps only the latest sample per sensor; aggregation is O(users) per tick. */
class PulseAggregator {
  constructor() {
    this.sensors = new Map();
    this.beats = 0;
  }

  update(id, data, t) {
    if (!data || typeof data !== 'object') return false;
    let bpm = finite(data.bpm);
    bpm = bpm >= 35 && bpm <= 210 ? bpm : 0;
    const sample = {
      bpm,
      signal: clamp(finite(data.signal), -1, 1),
      confidence: clamp(finite(data.confidence), 0, 1),
      t,
    };
    this.sensors.set(id, sample);
    if (data.beat === true && sample.confidence > 0.15) this.beats++;
    return true;
  }

  remove(id) {
    this.sensors.delete(id);
  }

  aggregate(t) {
    let wBpm = 0;
    let wSum = 0;
    let signal = 0;
    let confSum = 0;
    let active = 0;
    for (const [id, s] of this.sensors) {
      if (t - s.t > PULSE_STALE_MS) {
        this.sensors.delete(id);
        continue;
      }
      confSum += s.confidence;
      signal += s.signal * s.confidence;
      if (s.bpm > 0 && s.confidence > 0.2) {
        wBpm += s.bpm * s.confidence;
        wSum += s.confidence;
        active++;
      }
    }
    const n = this.sensors.size;
    const out = {
      bpm: wSum > 0 ? Math.round((wBpm / wSum) * 10) / 10 : 0,
      signal: n > 0 ? Math.round((signal / n) * 1000) / 1000 : 0,
      confidence: n > 0 ? Math.round((confSum / n) * 100) / 100 : 0,
      beats: this.beats,
      active,
      sensors: n,
      t,
    };
    this.beats = 0;
    return out;
  }
}

/** Last-writer-wins shared controls. Validation is per key, so a bad field never blocks the rest. */
class AnimationControls {
  constructor() {
    this.version = 0;
    this.values = {};
    this.reset();
    // Until someone changes a control, the first display to connect may seed mode/FX from its saved choice.
    this.touched = false;
  }

  reset() {
    for (const [k, d] of Object.entries(ANIM_DEFS)) this.values[k] = d.def;
    this.touched = true;
    this.version++;
  }

  /** Applies a partial update; unknown keys and invalid values are ignored. Returns true if anything changed. */
  set(patch, { seed = false } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return false;
    let changed = false;
    for (const [k, d] of Object.entries(ANIM_DEFS)) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const raw = patch[k];
      let v;
      if (d.type === 'bool') {
        if (typeof raw !== 'boolean') continue;
        v = raw;
      } else {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
        v = clamp(raw, d.min, d.max);
        v = d.type === 'int' ? Math.round(v) : Math.round(v * 1000) / 1000;
      }
      if (this.values[k] !== v) {
        this.values[k] = v;
        changed = true;
      }
    }
    if (!seed) this.touched = true;
    if (changed) this.version++;
    return changed;
  }

  seed(patch) {
    return this.touched ? false : this.set(patch, { seed: true });
  }

  snapshot() {
    return { ...this.values, version: this.version };
  }
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  return out;
}

function loadOrCreateCert() {
  if (process.env.SSL_KEY && process.env.SSL_CERT) {
    return { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) };
  }
  const dir = path.join(__dirname, '.cert');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  const selfsigned = require('selfsigned');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanAddresses().map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'pulse-visualizer.local' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

function createApp({ useHttps = false } = {}) {
  let publicUrl = null;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/info', (req, res) => {
    res.json({ inputUrls: inputUrls(req), https: useHttps });
  });
  // QR code for the phone page, so guests can scan instead of typing the LAN address.
  const qrCache = new Map();
  app.get('/api/qr.svg', async (req, res) => {
    const url = inputUrls(req)[0];
    try {
      if (!qrCache.has(url)) {
        qrCache.set(url, await QRCode.toString(url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }));
      }
      res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(qrCache.get(url));
    } catch (err) {
      res.status(500).send(String(err.message || err));
    }
  });

  function inputUrls(req) {
    const port = req.socket.localPort;
    const proto = useHttps ? 'https' : 'http';
    const hosts = lanAddresses();
    if (hosts.length === 0) hosts.push(req.hostname || 'localhost');
    const urls = hosts.map((ip) => `${proto}://${ip}:${port}/input.html`);
    // A public tunnel URL (valid HTTPS, reachable from any network) takes priority.
    if (publicUrl) urls.unshift(`${publicUrl}/input.html`);
    return urls;
  }

  const server = useHttps ? https.createServer(loadOrCreateCert(), app) : http.createServer(app);
  const io = new Server(server, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10000,
    pingTimeout: 8000,
    perMessageDeflate: false,
  });

  const playback = new PlaybackState();
  const pulses = new PulseAggregator();
  const anim = new AnimationControls();
  let animDirty = false;
  const roomSize = (room) => io.sockets.adapter.rooms.get(room)?.size || 0;
  const broadcastState = () => io.emit('yt:state', playback.snapshot());

  // ---- Media uploads: played in sync like YouTube, but same-origin so displays can analyse
  // the audio directly with Web Audio (no tab/screen capture needed).
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (f.endsWith('.part')) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
  }
  app.use(
    '/media',
    express.static(UPLOAD_DIR, {
      maxAge: '1h',
      setHeaders: (res) => res.set('X-Content-Type-Options', 'nosniff'),
    })
  );

  let activeUploads = 0;
  let lastUploadAt = 0;
  app.post('/api/upload', (req, res) => {
    const t = Date.now();
    if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      return res.status(429).json({ ok: false, error: 'Another upload is in progress — try again shortly.' });
    }
    if (t - lastUploadAt < UPLOAD_COOLDOWN_MS) {
      return res.status(429).json({ ok: false, error: 'Please wait a moment before uploading again.' });
    }
    if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ ok: false, error: `File too large (max ${MAX_UPLOAD_BYTES / 1048576} MB).` });
    }
    let name = '';
    try {
      name = decodeURIComponent(String(req.headers['x-filename'] || ''));
    } catch (_) {
      /* keep empty */
    }
    name = name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
    const fileExt = path.extname(name).slice(1).toLowerCase();
    let mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = MIME_TO_EXT[mime] || (EXT_TO_MIME[fileExt] ? fileExt : null);
    if (!ext) return res.status(415).json({ ok: false, error: 'Unsupported file type — upload an audio or video file (mp3, m4a, wav, ogg, flac, mp4, webm, mov).' });
    if (!MIME_TO_EXT[mime]) mime = EXT_TO_MIME[ext];

    const id = crypto.randomBytes(8).toString('hex');
    const file = `${id}.${ext}`;
    const finalPath = path.join(UPLOAD_DIR, file);
    const tmpPath = `${finalPath}.part`;
    const out = fs.createWriteStream(tmpPath);
    let bytes = 0;
    let done = false;
    activeUploads++;

    const fail = (code, error) => {
      if (done) return;
      done = true;
      activeUploads--;
      out.destroy();
      fs.rm(tmpPath, { force: true }, () => {});
      if (!res.headersSent) res.status(code).json({ ok: false, error });
    };
    req.setTimeout(10 * 60 * 1000, () => {
      fail(408, 'Upload timed out.');
      req.destroy();
    });
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        fail(413, `File too large (max ${MAX_UPLOAD_BYTES / 1048576} MB).`);
        req.destroy();
      }
    });
    req.on('aborted', () => fail(400, 'Upload interrupted.'));
    req.on('error', () => fail(400, 'Upload interrupted.'));
    out.on('error', () => fail(500, 'Could not save the file.'));
    out.on('finish', () => {
      if (done) return;
      if (bytes === 0) return fail(400, 'The file is empty.');
      fs.rename(tmpPath, finalPath, (err) => {
        if (err) return fail(500, 'Could not save the file.');
        done = true;
        activeUploads--;
        lastUploadAt = Date.now();
        const title = (name.replace(/\.[^.]+$/, '') || 'Uploaded media').slice(0, 120);
        const media = { kind: 'file', id, url: `/media/${file}`, title, mime };
        playback.load(media);
        broadcastState();
        pruneUploads(file);
        res.json({ ok: true, media });
      });
    });
    req.pipe(out);
  });

  /** Keeps the upload folder bounded: delete the oldest files, never the one now playing. */
  function pruneUploads(keep) {
    const current = playback.media && playback.media.kind === 'file' ? path.basename(playback.media.url) : null;
    const files = fs
      .readdirSync(UPLOAD_DIR)
      .filter((f) => !f.endsWith('.part'))
      .map((f) => ({ f, m: fs.statSync(path.join(UPLOAD_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const { f } of files.slice(MAX_KEPT_UPLOADS)) {
      if (f !== keep && f !== current) fs.rm(path.join(UPLOAD_DIR, f), { force: true }, () => {});
    }
  }

  io.on('connection', (socket) => {
    let role = null;
    let lastPulse = 0;
    let lastSubmit = 0;
    let lastControl = 0;

    socket.on('hello', (data) => {
      const r = data && data.role;
      if (role || (r !== 'input' && r !== 'output')) return;
      role = r;
      socket.join(r === 'input' ? 'inputs' : 'outputs');
      if (r === 'output' && anim.seed(data.controls)) animDirty = true;
      socket.emit('yt:state', playback.snapshot());
      socket.emit('controls:state', anim.snapshot());
    });

    socket.on('time:ping', (_t0, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('pulse', (data) => {
      if (role !== 'input') return;
      const t = Date.now();
      if (t - lastPulse < PULSE_MIN_INTERVAL_MS) return;
      lastPulse = t;
      pulses.update(socket.id, data, t);
    });

    socket.on('pulse:stop', () => pulses.remove(socket.id));

    // Client camera diagnostics (rate-limited, size-capped) to help debug device quirks.
    let lastDiag = 0;
    socket.on('diag', (d) => {
      const t = Date.now();
      if (t - lastDiag < 1000 || !d || !Array.isArray(d.lines)) return;
      lastDiag = t;
      const ua = String(d.ua || '').slice(0, 200);
      const lines = d.lines.slice(-60).map((l) => String(l).slice(0, 400));
      console.log(`[diag ${socket.id.slice(0, 6)}] ${ua}\n  ${lines.join('\n  ')}`);
    });

    socket.on('yt:submit', (url, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const t = Date.now();
      if (t - lastSubmit < VIDEO_SUBMIT_COOLDOWN_MS) {
        return reply({ ok: false, error: 'Please wait a moment before submitting again.' });
      }
      const id = parseYouTubeId(url);
      if (!id) return reply({ ok: false, error: 'That does not look like a YouTube URL.' });
      lastSubmit = t;
      playback.load(id);
      broadcastState();
      reply({ ok: true, videoId: id });
    });

    socket.on('yt:control', (action) => {
      const t = Date.now();
      if (t - lastControl < CONTROL_COOLDOWN_MS) return;
      lastControl = t;
      let changed = false;
      if (action === 'play') changed = playback.play();
      else if (action === 'pause') changed = playback.pause();
      else if (action === 'restart') changed = playback.restart();
      if (changed) broadcastState();
    });

    // Animation controls: anyone may change them; the latest value wins and is rebroadcast to all.
    let lastAnim = 0;
    socket.on('controls:set', (patch) => {
      const t = Date.now();
      if (!role || t - lastAnim < ANIM_MIN_INTERVAL_MS) return;
      lastAnim = t;
      if (anim.set(patch)) animDirty = true;
    });

    socket.on('controls:reset', () => {
      const t = Date.now();
      if (!role || t - lastControl < CONTROL_COOLDOWN_MS) return;
      lastControl = t;
      anim.reset();
      animDirty = true;
    });

    socket.on('yt:duration', (data) => {
      if (data && playback.setDuration(data.id || data.videoId, finite(data.duration))) broadcastState();
    });

    socket.on('disconnect', () => pulses.remove(socket.id));
  });

  const timers = [
    setInterval(() => {
      const agg = pulses.aggregate(Date.now());
      if (roomSize('outputs') > 0) io.to('outputs').volatile.emit('pulse:agg', agg);
    }, PULSE_TICK_MS),
    setInterval(() => {
      if (roomSize('inputs') === 0) return;
      let bpm = 0;
      let w = 0;
      for (const s of pulses.sensors.values()) {
        if (s.bpm > 0 && s.confidence > 0.2) {
          bpm += s.bpm * s.confidence;
          w += s.confidence;
        }
      }
      io.to('inputs').volatile.emit('pulse:summary', {
        bpm: w > 0 ? Math.round(bpm / w) : 0,
        sensors: pulses.sensors.size,
        displays: roomSize('outputs'),
      });
    }, INPUT_SUMMARY_MS),
    setInterval(() => {
      if (playback.videoId) broadcastState();
    }, SYNC_HEARTBEAT_MS),
    setInterval(() => {
      if (playback.checkEnded()) broadcastState();
    }, END_CHECK_MS),
    setInterval(() => {
      if (!animDirty) return;
      animDirty = false;
      io.emit('controls:state', anim.snapshot());
    }, ANIM_BROADCAST_MS),
  ];
  server.on('close', () => timers.forEach(clearInterval));

  return {
    app,
    server,
    io,
    playback,
    pulses,
    anim,
    setPublicUrl(url) {
      publicUrl = url;
    },
  };
}

/**
 * Starts a Cloudflare quick tunnel (no account needed) so phones get a trusted HTTPS URL
 * from any network. Resolves with the public https://*.trycloudflare.com URL.
 */
function startTunnel(port) {
  const { spawn } = require('child_process');
  const local = path.join(__dirname, '.tools', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  const bin = process.env.CLOUDFLARED || (fs.existsSync(local) ? local : 'cloudflared');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let found = false;
    const onData = (buf) => {
      const m = !found && String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) {
        found = true;
        resolve({ url: m[0], child });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) =>
      reject(new Error(`Could not start cloudflared (${err.message}). Download it from https://github.com/cloudflare/cloudflared/releases into .tools/`))
    );
    child.on('exit', (code) => {
      if (!found) reject(new Error(`cloudflared exited with code ${code}`));
      else console.log(`cloudflared exited (${code}); public URL no longer available.`);
    });
    const kill = () => child.kill();
    process.on('exit', kill);
    process.on('SIGINT', () => process.exit(0));
    process.on('SIGTERM', () => process.exit(0));
  });
}

function main() {
  const useHttps = process.argv.includes('--https') || process.env.HTTPS === '1';
  const useTunnel = process.argv.includes('--tunnel') || process.env.TUNNEL === '1';
  const port = Number(process.env.PORT) || (useHttps ? 8443 : 3000);
  const { server, setPublicUrl } = createApp({ useHttps });
  server.listen(port, () => {
    const proto = useHttps ? 'https' : 'http';
    console.log(`Pulse visualizer running:`);
    console.log(`  Display  ${proto}://localhost:${port}/output.html`);
    for (const ip of lanAddresses()) console.log(`  Phones   ${proto}://${ip}:${port}/input.html  (same network only)`);
    if (useTunnel) {
      if (useHttps) console.log('  Note: --tunnel works best without --https (the tunnel already provides HTTPS).');
      console.log('  Starting Cloudflare tunnel…');
      startTunnel(port)
        .then(({ url }) => {
          setPublicUrl(url);
          console.log(`  Phones   ${url}/input.html  (public HTTPS — the QR code uses this)`);
        })
        .catch((err) => console.error(`  Tunnel failed: ${err.message}`));
    } else if (!useHttps) {
      console.log('  Note: phone cameras require HTTPS on non-localhost origins. Use `npm run tunnel` or `npm run start:https`.');
    }
  });
}

if (require.main === module) main();

module.exports = { createApp, parseYouTubeId, PlaybackState, PulseAggregator, AnimationControls, ANIM_DEFS };
