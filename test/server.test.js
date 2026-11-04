'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioc } = require('socket.io-client');

const tmpUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-uploads-'));
process.env.UPLOAD_DIR = tmpUploads;
const { createApp, parseYouTubeId, PlaybackState, PulseAggregator, AnimationControls, ANIM_DEFS } = require('../server.js');

test.after(() => fs.rmSync(tmpUploads, { recursive: true, force: true }));

test('media upload: plays synced, served same-origin with range support, rejects non-media', async (t) => {
  const { server, io } = createApp();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const out = ioc(url, { transports: ['websocket'], forceNew: true });
  t.after(() => {
    out.close();
    io.close();
    server.close();
  });
  await new Promise((r) => out.on('connect', r));
  out.emit('hello', { role: 'output' });

  const bad = await fetch(`${url}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/html', 'X-Filename': 'evil.html' },
    body: '<script>alert(1)</script>',
  });
  assert.equal(bad.status, 415);

  const bytes = Buffer.alloc(64 * 1024, 7);
  const statePromise = new Promise((resolve) => out.on('yt:state', (s) => s.media && s.media.kind === 'file' && resolve(s)));
  const res = await fetch(`${url}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/mpeg', 'X-Filename': encodeURIComponent('My Song ♥.mp3') },
    body: bytes,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.media.title, 'My Song ♥');
  assert.match(body.media.url, /^\/media\/[0-9a-f]{16}\.mp3$/);

  const st = await statePromise;
  assert.equal(st.media.url, body.media.url);
  assert.equal(st.videoId, null);

  const ranged = await fetch(url + body.media.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-type'), 'audio/mpeg');
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);
  assert.deepEqual(fs.readdirSync(tmpUploads).filter((f) => f.endsWith('.part')), []);
});

test('parseYouTubeId', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [
    id,
    `https://www.youtube.com/watch?v=${id}&t=10s`,
    `youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}?si=abc`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://music.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
  ]) {
    assert.equal(parseYouTubeId(u), id, u);
  }
  for (const bad of ['', 'hello', 'https://evil.com/watch?v=dQw4w9WgXcQ', 'https://youtube.com/watch?v=short', null, 42]) {
    assert.equal(parseYouTubeId(bad), null, String(bad));
  }
});

test('PlaybackState clock', () => {
  let now = 1_000_000;
  const s = new PlaybackState(() => now);
  s.load('dQw4w9WgXcQ');
  let snap = s.snapshot();
  assert.equal(snap.playing, false);
  assert.ok(snap.startsAt > now);
  now += 1500 + 10_000;
  assert.ok(Math.abs(s.position() - 10) < 1e-9);
  assert.equal(s.snapshot().playing, true);
  s.pause();
  now += 5000;
  assert.ok(Math.abs(s.position() - 10) < 1e-9);
  s.play();
  now += 2000;
  assert.ok(Math.abs(s.position() - 12) < 1e-9);
  assert.equal(s.setDuration('other', 100), false);
  assert.equal(s.setDuration('dQw4w9WgXcQ', 13), true);
  now += 2000;
  assert.equal(s.checkEnded(), true);
  snap = s.snapshot();
  assert.equal(snap.playing, false);
  assert.equal(snap.position, 13);
  s.play(); // replay from start after the end
  assert.equal(s.position(), 0);
});

test('PulseAggregator weights by confidence and prunes stale sensors', () => {
  const a = new PulseAggregator();
  a.update('a', { bpm: 60, signal: 0.5, confidence: 1, beat: true }, 0);
  a.update('b', { bpm: 90, signal: -0.5, confidence: 0.5, beat: false }, 0);
  a.update('c', { bpm: 300, signal: 9, confidence: 7 }, 0); // clamped: bpm invalid -> 0
  let r = a.aggregate(100);
  assert.equal(r.sensors, 3);
  assert.equal(r.active, 2);
  assert.equal(r.bpm, 70);
  assert.equal(r.beats, 1);
  assert.equal(a.aggregate(100).beats, 0);
  r = a.aggregate(10_000);
  assert.equal(r.sensors, 0);
});

test('socket flow: inputs stream pulse, outputs receive aggregate + sync state', async (t) => {
  const { server, io } = createApp();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.close());
    io.close();
    server.close();
  });
  const connect = (role) =>
    new Promise((resolve) => {
      const c = ioc(url, { transports: ['websocket'], forceNew: true });
      clients.push(c);
      c.on('connect', () => {
        c.emit('hello', { role });
        resolve(c);
      });
    });

  const out = await connect('output');
  const inputs = await Promise.all(Array.from({ length: 30 }, () => connect('input')));

  const qr = await fetch(`${url}/api/qr.svg`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(await qr.text(), /<svg/);

  const serverNow = await out.timeout(2000).emitWithAck('time:ping', Date.now());
  assert.ok(Math.abs(serverNow - Date.now()) < 1000);

  const bad = await inputs[0].timeout(2000).emitWithAck('yt:submit', 'not a url');
  assert.equal(bad.ok, false);

  const statePromise = new Promise((resolve) => out.on('yt:state', (s) => s.videoId && resolve(s)));
  const ok = await inputs[1].timeout(2000).emitWithAck('yt:submit', 'https://youtu.be/dQw4w9WgXcQ');
  assert.deepEqual(ok, { ok: true, videoId: 'dQw4w9WgXcQ' });
  const st = await statePromise;
  assert.equal(st.videoId, 'dQw4w9WgXcQ');

  const again = await inputs[1].timeout(2000).emitWithAck('yt:submit', 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(again.ok, false, 'per-socket cooldown enforced');

  const agg = await new Promise((resolve) => {
    out.on('pulse:agg', (a) => a.active === 30 && resolve(a));
    const send = () => inputs.forEach((c, i) => c.emit('pulse', { bpm: 60 + i, signal: 0.1, confidence: 0.9, beat: true }));
    send();
    const iv = setInterval(send, 120);
    t.after(() => clearInterval(iv));
  });
  assert.equal(agg.sensors, 30);
  assert.ok(Math.abs(agg.bpm - 74.5) < 0.2, `bpm ${agg.bpm}`);
});

test('AnimationControls validates, clamps and seeds only until first change', () => {
  const c = new AnimationControls();
  assert.equal(c.snapshot().heartbeat, true);
  assert.equal(c.seed({ mode: 3, bloom: true }), true);
  assert.equal(c.snapshot().mode, 3);
  assert.equal(c.set({ tempo: 999, speed: -5, mode: 2.6, heartbeat: 'no', hue: NaN, bogus: 1 }), true);
  const s = c.snapshot();
  assert.equal(s.tempo, ANIM_DEFS.tempo.max);
  assert.equal(s.speed, ANIM_DEFS.speed.min);
  assert.equal(s.mode, 3); // 2.6 rounds to 3: unchanged
  assert.equal(s.heartbeat, true);
  assert.equal(s.hue, 0);
  assert.equal('bogus' in s, false);
  assert.equal(c.seed({ mode: 0 }), false, 'seed ignored once someone changed a control');
  assert.equal(c.set(null), false);
  c.reset();
  assert.equal(c.snapshot().tempo, ANIM_DEFS.tempo.def);
  assert.equal(c.snapshot().bloom, false);
});

test('socket flow: animation controls are shared between many participants', async (t) => {
  const { server, io } = createApp();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.close());
    io.close();
    server.close();
  });
  const connect = (hello) =>
    new Promise((resolve) => {
      const c = ioc(url, { transports: ['websocket'], forceNew: true });
      clients.push(c);
      c.once('controls:state', (s) => resolve({ c, s }));
      c.on('connect', () => c.emit('hello', hello));
    });
  const waitFor = (c, pred) => new Promise((resolve) => c.on('controls:state', (s) => pred(s) && resolve(s)));

  // The first display seeds mode/FX from its saved look.
  const { c: out, s: first } = await connect({ role: 'output', controls: { mode: 4, echo: true } });
  assert.equal(first.mode, 4);
  assert.equal(first.echo, true);
  const phones = await Promise.all(Array.from({ length: 10 }, () => connect({ role: 'input' })));
  phones.forEach(({ s }) => assert.equal(s.mode, 4));

  // Phones change different controls at once; everyone converges on the merged state.
  const merged = (s) => s.tempo === 120 && s.hue === 0.5 && s.speed === 2;
  const seen = Promise.all([out, ...phones.map((p) => p.c)].map((c) => waitFor(c, merged)));
  phones[0].c.emit('controls:set', { tempo: 120 });
  phones[1].c.emit('controls:set', { hue: 0.5 });
  phones[2].c.emit('controls:set', { speed: 2 });
  await seen;

  // A display turning the heartbeat off reaches every phone.
  const off = Promise.all(phones.map((p) => waitFor(p.c, (s) => s.heartbeat === false)));
  out.emit('controls:set', { heartbeat: false });
  await off;

  // A second display does not override shared state with its own saved look.
  const { s: late } = await connect({ role: 'output', controls: { mode: 0 } });
  assert.equal(late.mode, 4);
  assert.equal(late.heartbeat, false);
});
