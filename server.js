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
const TOUCH_TAP_MS = 80;             // per-socket touch pad taps (max ~12/s)
const TOUCH_DRAG_MS = 70;            // per-socket drag sparks (max ~14/s)
const COMBO_WINDOW_MS = 450;         // taps from different phones this close together merge
const COMBO_TICK_MS = 50;

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
  hearts: { type: 'bool', def: true },      // one coloured ring per phone on each of its beats
  tempo: { min: 40, max: 180, def: 62 },    // BPM when the heartbeat is off or no one is sensing
  intensity: { min: 0, max: 2, def: 1 },    // beat punch
  heat: { min: -1, max: 1, def: 0 },        // offset on the energy ("heat") value
  breath: { min: 0, max: 2, def: 1 },       // breathing depth
  speed: { min: 0.1, max: 3, def: 1 },      // animation time scale
  audio: { min: 0, max: 2, def: 1 },        // audio reactivity
  hue: { min: 0, max: 1, def: 0 },          // global colour rotation (turns)
};

/**
 * Host lock. Hosts (the display machine itself, or anyone who enters the host PIN) can always
 * change everything. Others: 'open' = everything, 'limited' = sliders only, 'locked' = nothing.
 * Media (links, uploads, play/pause) is host-only unless the lock is 'open'.
 */
const LOCK_LEVELS = ['open', 'limited', 'locked'];
const SLIDER_KEYS = new Set(['tempo', 'intensity', 'heat', 'breath', 'speed', 'audio', 'hue']);
const PIN_ATTEMPT_MS = 2000;          // per-socket
const MAX_PIN_FAILURES_PER_MIN = 20;  // server-wide, so a 6-digit PIN can't be brute-forced
const MAX_HEARTS = 64;                // per-phone heartbeats forwarded to displays

function canChange(key, host, lock) {
  if (host || lock === 'open') return true;
  return lock === 'limited' && SLIDER_KEYS.has(key);
}

/** Direct connection from this machine (not through the tunnel or another proxy). */
function isDirectLocal(address, headers) {
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  return loopback && !headers['cf-connecting-ip'] && !headers['x-forwarded-for'];
}

/** Fingerprint of the server + page code, so open pages can tell when the server runs different code. */
function computeBuildId() {
  const h = crypto.createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(e.name).update(fs.readFileSync(p));
    }
  };
  h.update(fs.readFileSync(__filename));
  walk(path.join(__dirname, 'public'));
  return h.digest('hex').slice(0, 12);
}

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

const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_PLAYABLE = new Set(['track', 'episode']);

/**
 * Parses a Spotify track/episode link or URI. Returns { type, id, uri }, { error } for links that
 * aren't a single track (albums and playlists would advance on their own and fall out of sync),
 * or null when it isn't a Spotify link at all.
 */
function parseSpotify(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0 || s.length > 500) return null;
  let type = null;
  let id = null;
  const uri = s.match(/^spotify:([a-z]+):([A-Za-z0-9]+)$/);
  if (uri) {
    [, type, id] = uri;
  } else {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    } catch {
      return null;
    }
    if (url.hostname !== 'open.spotify.com' && url.hostname !== 'play.spotify.com') return null;
    // Paths look like /track/ID, /intl-de/track/ID or /embed/track/ID.
    const m = url.pathname.match(/^(?:\/intl-[a-z-]+)?(?:\/embed)?\/([a-z]+)\/([A-Za-z0-9]+)/i);
    if (!m) return { error: 'That Spotify link isn\'t a track. Open the song and use Share → Copy song link.' };
    [, type, id] = m;
  }
  type = type.toLowerCase();
  if (!SPOTIFY_PLAYABLE.has(type)) {
    return { error: `Paste a single song, not ${/^[aeiou]/.test(type) ? 'an' : 'a'} ${type}. Open the song and use Share → Copy song link.` };
  }
  if (!SPOTIFY_ID_RE.test(id)) return null;
  return { type, id, uri: `spotify:${type}:${id}` };
}

/** Looks up a Spotify track's title via the public oEmbed endpoint; resolves null on any failure. */
async function fetchSpotifyTitle(uri) {
  const [, type, id] = uri.split(':');
  try {
    const r = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${type}/${id}`)}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j.title === 'string' ? j.title.slice(0, 120) : null;
  } catch {
    return null;
  }
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(v, fallback = 0) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Authoritative playback clock. Positions are seconds; times are server ms.
 * `media` is { kind: 'youtube', id }, { kind: 'spotify', id, uri, title } or
 * { kind: 'file', id, url, title, mime }.
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

  /** `heart` ({ n, hue }) identifies the phone on the display; beats are also counted per phone. */
  update(id, data, t, heart = null) {
    if (!data || typeof data !== 'object') return false;
    let bpm = finite(data.bpm);
    bpm = bpm >= 35 && bpm <= 210 ? bpm : 0;
    const prev = this.sensors.get(id);
    const sample = {
      bpm,
      signal: clamp(finite(data.signal), -1, 1),
      confidence: clamp(finite(data.confidence), 0, 1),
      energy: typeof data.energy === 'number' && Number.isFinite(data.energy) ? clamp(data.energy, 0, 1) : null, // dancers only
      t,
      heart,
      ring: data.source === undefined || data.source === 'heart', // older pages are heart sensors
      beats: prev ? prev.beats : 0,
    };
    this.sensors.set(id, sample);
    if (data.beat === true && sample.confidence > 0.15) {
      this.beats++;
      sample.beats++;
    }
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
    const hearts = []; // [n, hue, beats since last tick, confidence] per heart-camera phone with a good signal
    let motion = 0; // average movement energy of the dancing phones
    let dancers = 0;
    for (const [id, s] of this.sensors) {
      if (t - s.t > PULSE_STALE_MS) {
        this.sensors.delete(id);
        continue;
      }
      if (s.heart && s.ring && s.confidence > 0.2 && hearts.length < MAX_HEARTS) {
        hearts.push([s.heart.n, s.heart.hue, s.beats, Math.round(s.confidence * 100) / 100]);
      }
      s.beats = 0;
      if (s.energy !== null) {
        motion += s.energy;
        dancers++;
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
      hearts,
      motion: dancers > 0 ? Math.round((motion / dancers) * 100) / 100 : 0,
      dancers,
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
    this.lock = 'open'; // not part of reset: only a host changes it
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

  setLock(level) {
    if (!LOCK_LEVELS.includes(level) || level === this.lock) return false;
    this.lock = level;
    this.version++;
    return true;
  }

  /** Keeps only the keys this client may change. */
  filter(patch, host) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { allowed: null, rejected: false };
    const allowed = {};
    let rejected = false;
    for (const k of Object.keys(patch)) {
      if (canChange(k, host, this.lock)) allowed[k] = patch[k];
      else rejected = true;
    }
    return { allowed, rejected };
  }

  snapshot() {
    return { ...this.values, lock: this.lock, version: this.version };
  }
}

/**
 * Touch pad combos: taps from different phones that land within one window merge into a single
 * combo. The window opens with the first tap; when it closes, two or more phones make a combo.
 * Each phone counts once per window (its latest tap is kept).
 */
class TapCombos {
  constructor(windowMs = COMBO_WINDOW_MS) {
    this.windowMs = windowMs;
    this.taps = new Map(); // socket id -> { x, y, hue }
    this.openedAt = 0;
  }

  tap(id, x, y, hue, t) {
    if (this.taps.size === 0) this.openedAt = t;
    this.taps.set(id, { x, y, hue });
  }

  /** Closes an expired window: returns { ids, size, x, y, hues } for a combo, else null. */
  flush(t) {
    if (this.taps.size === 0 || t - this.openedAt < this.windowMs) return null;
    const list = [...this.taps.entries()];
    this.taps.clear();
    if (list.length < 2) return null;
    const avg = (k) => list.reduce((s, [, v]) => s + v[k], 0) / list.length;
    return {
      ids: list.map(([id]) => id),
      size: list.length,
      x: avg('x'),
      y: avg('y'),
      hues: list.slice(0, 16).map(([, v]) => v.hue),
    };
  }

  remove(id) {
    this.taps.delete(id);
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

function createApp({ useHttps = false, hostPin = process.env.HOST_PIN } = {}) {
  let publicUrl = null;
  const build = computeBuildId();
  const pin = /^\d{4,12}$/.test(String(hostPin || '')) ? String(hostPin) : String(crypto.randomInt(100000, 1000000));
  let pinFailures = [];
  /** Checks a PIN attempt; failures are capped server-wide per minute. */
  const checkPin = (attempt) => {
    const t = Date.now();
    pinFailures = pinFailures.filter((f) => t - f < 60000);
    if (pinFailures.length >= MAX_PIN_FAILURES_PER_MIN) return false;
    const a = Buffer.from(String(attempt || '').slice(0, 12));
    const b = Buffer.from(pin);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) pinFailures.push(t);
    return ok;
  };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/api/info', (req, res) => {
    res.json({ inputUrls: inputUrls(req), https: useHttps, build });
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
  const combos = new TapCombos();
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
    const host = isDirectLocal(req.socket.remoteAddress, req.headers) || (req.headers['x-host-pin'] && checkPin(req.headers['x-host-pin']));
    if (!host && anim.lock !== 'open') {
      return res.status(403).json({ ok: false, error: 'The host has locked the music. Ask them to unlock it.' });
    }
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

  let heartCounter = 0;

  io.on('connection', (socket) => {
    let role = null;
    let lastPulse = 0;
    let lastSubmit = 0;
    let lastControl = 0;
    let lastPinTry = 0;
    let heart = null;
    // The display machine itself is trusted; everyone else becomes host by entering the PIN.
    let host = isDirectLocal(socket.handshake.address, socket.handshake.headers);
    const sendHostStatus = () => socket.emit('host:status', { host, pin: host ? pin : undefined });
    const mediaAllowed = () => host || anim.lock === 'open';

    socket.emit('server:info', { build });

    const tryPin = (attempt) => {
      const t = Date.now();
      if (host || t - lastPinTry < PIN_ATTEMPT_MS) return host;
      lastPinTry = t;
      if (checkPin(attempt)) host = true;
      return host;
    };

    socket.on('hello', (data) => {
      const r = data && data.role;
      if (role || (r !== 'input' && r !== 'output')) return;
      role = r;
      socket.join(r === 'input' ? 'inputs' : 'outputs');
      if (data.pin) tryPin(data.pin);
      if (r === 'output' && host && anim.seed(data.controls)) animDirty = true;
      if (r === 'input') {
        // Golden-ratio hues keep each new phone's colour far from the previous ones.
        heart = { n: ++heartCounter, hue: Math.round(((heartCounter * 0.618034) % 1) * 1000) / 1000 };
        socket.emit('you', heart);
      }
      socket.emit('yt:state', playback.snapshot());
      socket.emit('controls:state', anim.snapshot());
      sendHostStatus();
    });

    socket.on('host:pin', (attempt, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const wasHost = host;
      const ok = tryPin(attempt);
      if (ok && !wasHost) sendHostStatus();
      reply({ ok, error: ok ? undefined : 'Wrong PIN (or too many tries, wait a moment).' });
    });

    socket.on('host:lock', (level) => {
      if (!host) return;
      if (anim.setLock(level)) animDirty = true;
    });

    socket.on('time:ping', (_t0, ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('pulse', (data) => {
      if (role !== 'input') return;
      const t = Date.now();
      if (t - lastPulse < PULSE_MIN_INTERVAL_MS) return;
      lastPulse = t;
      pulses.update(socket.id, data, t, heart);
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

    /** Loads a YouTube or Spotify link (the sender picks which) for everyone. */
    const submit = (source, url, reply) => {
      const t = Date.now();
      if (!mediaAllowed()) return reply({ ok: false, error: 'The host has locked the music. Ask them to unlock it.' });
      if (t - lastSubmit < VIDEO_SUBMIT_COOLDOWN_MS) {
        return reply({ ok: false, error: 'Please wait a moment before submitting again.' });
      }
      if (source === 'spotify') {
        const sp = parseSpotify(url);
        if (!sp) {
          return reply({ ok: false, error: parseYouTubeId(url) ? 'That\'s a YouTube link. Switch to YouTube.' : 'That does not look like a Spotify song link.' });
        }
        if (sp.error) return reply({ ok: false, error: sp.error });
        lastSubmit = t;
        const media = { kind: 'spotify', id: sp.id, uri: sp.uri, title: 'Spotify' };
        playback.load(media);
        broadcastState();
        reply({ ok: true, media });
        fetchSpotifyTitle(sp.uri).then((title) => {
          if (title && playback.media === media) {
            media.title = title;
            broadcastState();
          }
        });
        return;
      }
      const id = parseYouTubeId(url);
      if (!id) {
        const sp = parseSpotify(url);
        return reply({ ok: false, error: sp ? 'That\'s a Spotify link. Switch to Spotify.' : 'That does not look like a YouTube URL.' });
      }
      lastSubmit = t;
      playback.load(id);
      broadcastState();
      reply({ ok: true, videoId: id });
    };
    socket.on('yt:submit', (url, ack) => submit('youtube', url, typeof ack === 'function' ? ack : () => {}));
    socket.on('media:submit', (data, ack) =>
      submit(data && data.source === 'spotify' ? 'spotify' : 'youtube', data && data.url, typeof ack === 'function' ? ack : () => {})
    );

    socket.on('yt:control', (action) => {
      const t = Date.now();
      if (!mediaAllowed() || t - lastControl < CONTROL_COOLDOWN_MS) return;
      lastControl = t;
      let changed = false;
      if (action === 'play') changed = playback.play();
      else if (action === 'pause') changed = playback.pause();
      else if (action === 'restart') changed = playback.restart();
      if (changed) broadcastState();
    });

    // Animation controls: anyone the lock allows may change them; the latest value wins and is
    // rebroadcast to all. A rejected change gets the real state back so the sender's UI reverts.
    let lastAnim = 0;
    socket.on('controls:set', (patch) => {
      const t = Date.now();
      if (!role || t - lastAnim < ANIM_MIN_INTERVAL_MS) return;
      lastAnim = t;
      const { allowed, rejected } = anim.filter(patch, host);
      if (allowed && anim.set(allowed)) animDirty = true;
      if (rejected) socket.emit('controls:state', { ...anim.snapshot(), force: true });
    });

    socket.on('controls:reset', () => {
      const t = Date.now();
      if (!role || !mediaAllowed() || t - lastControl < CONTROL_COOLDOWN_MS) return;
      lastControl = t;
      anim.reset();
      animDirty = true;
    });

    socket.on('yt:duration', (data) => {
      if (data && playback.setDuration(data.id || data.videoId, finite(data.duration))) broadcastState();
    });

    // Touch pad: a tap bursts on the display at the same spot in the phone's colour; dragging leaves
    // small sparks. Only 'locked' turns it off for non-hosts.
    let lastTap = 0;
    let lastDrag = 0;
    socket.on('touch', (data) => {
      if (role !== 'input' || !heart || !data || (!host && anim.lock === 'locked')) return;
      const x = finite(data.x, -1);
      const y = finite(data.y, -1);
      if (x < 0 || x > 1 || y < 0 || y > 1) return;
      const t = Date.now();
      const drag = !!data.drag;
      if (t - (drag ? lastDrag : lastTap) < (drag ? TOUCH_DRAG_MS : TOUCH_TAP_MS)) return;
      if (drag) lastDrag = t;
      else lastTap = t;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      io.to('outputs').volatile.emit('touch:fx', { n: heart.n, h: heart.hue, x: r3(x), y: r3(y), d: drag ? 1 : 0 });
      if (!drag) combos.tap(socket.id, x, y, heart.hue, t);
    });

    socket.on('disconnect', () => {
      pulses.remove(socket.id);
      combos.remove(socket.id);
    });
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
      if (playback.videoId || (playback.media && playback.media.kind === 'spotify')) broadcastState();
    }, SYNC_HEARTBEAT_MS),
    setInterval(() => {
      if (playback.checkEnded()) broadcastState();
    }, END_CHECK_MS),
    setInterval(() => {
      if (!animDirty) return;
      animDirty = false;
      io.emit('controls:state', anim.snapshot());
    }, ANIM_BROADCAST_MS),
    setInterval(() => {
      const c = combos.flush(Date.now());
      if (!c) return;
      const r3 = (v) => Math.round(v * 1000) / 1000;
      io.to('outputs').emit('touch:combo', { size: c.size, x: r3(c.x), y: r3(c.y), hues: c.hues });
      for (const id of c.ids) io.to(id).emit('touch:combo', { size: c.size });
    }, COMBO_TICK_MS),
  ];
  server.on('close', () => timers.forEach(clearInterval));

  return {
    app,
    server,
    io,
    playback,
    pulses,
    anim,
    build,
    hostPin: pin,
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
  const { server, setPublicUrl, hostPin } = createApp({ useHttps });
  server.listen(port, () => {
    const proto = useHttps ? 'https' : 'http';
    console.log(`Pulse visualizer running:`);
    console.log(`  Display  ${proto}://localhost:${port}/output.html`);
    console.log(`  Host PIN ${hostPin}  (enter on a phone for full control; set HOST_PIN to choose your own)`);
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

module.exports = { createApp, parseYouTubeId, parseSpotify, PlaybackState, PulseAggregator, AnimationControls, TapCombos, ANIM_DEFS, canChange };
