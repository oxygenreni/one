'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: ioc } = require('socket.io-client');

const tmpUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'pulse-uploads-'));
process.env.UPLOAD_DIR = tmpUploads;
const {
  createApp, parseYouTubeId, parseSpotify, PlaybackState, PulseAggregator, AnimationControls, TapCombos, CrowdHold, TapRace, PassColour,
  ANIM_DEFS, canChange,
} = require('../server.js');

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

test('PulseAggregator reports beats per phone', () => {
  const a = new PulseAggregator();
  const me = { n: 1, hue: 0.618 };
  a.update('a', { bpm: 60, confidence: 0.9, beat: true }, 0, me);
  a.update('a', { bpm: 60, confidence: 0.9, beat: false }, 50, me);
  a.update('b', { bpm: 70, confidence: 0.1, beat: true }, 50, { n: 2, hue: 0.2 }); // too weak to show
  let r = a.aggregate(100);
  assert.deepEqual(r.hearts, [[1, 0.618, 1, 0.9]]);
  r = a.aggregate(150);
  assert.deepEqual(r.hearts, [[1, 0.618, 0, 0.9]], 'beats reset each tick');
});

test('canChange follows the lock level', () => {
  assert.equal(canChange('mode', false, 'open'), true);
  assert.equal(canChange('mode', false, 'limited'), false);
  assert.equal(canChange('hue', false, 'limited'), true);
  assert.equal(canChange('hue', false, 'locked'), false);
  assert.equal(canChange('mode', true, 'locked'), true);
});

test('socket flow: host lock, PIN, build info and per-phone colours', async (t) => {
  const { server, io, hostPin, build } = createApp({ hostPin: '424242' });
  assert.equal(hostPin, '424242');
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const clients = [];
  t.after(() => {
    clients.forEach((c) => c.close());
    io.close();
    server.close();
  });
  // `remote` = arrives through the tunnel like a real phone (Cloudflare adds cf-connecting-ip).
  const connect = (role, remote) =>
    new Promise((resolve) => {
      const c = ioc(url, { transports: ['websocket'], forceNew: true, extraHeaders: remote ? { 'cf-connecting-ip': '203.0.113.9' } : {} });
      clients.push(c);
      const got = {};
      c.on('server:info', (i) => (got.info = i));
      c.on('you', (y) => (got.you = y));
      c.once('host:status', (h) => resolve({ c, got, host: h }));
      c.on('connect', () => c.emit('hello', { role }));
    });
  const nextState = (c, pred) => new Promise((resolve) => c.on('controls:state', (s) => pred(s) && resolve(s)));

  const display = await connect('output', false);
  assert.equal(display.host.host, true, 'the display machine is host');
  assert.equal(display.host.pin, '424242');
  assert.equal(display.got.info.build, build);
  const phone = await connect('input', true);
  const phone2 = await connect('input', true);
  assert.equal(phone.host.host, false);
  assert.equal(phone.host.pin, undefined, 'PIN never sent to non-hosts');
  assert.ok(phone.got.you.hue >= 0 && phone.got.you.hue < 1);
  assert.notEqual(phone.got.you.hue, phone2.got.you.hue);

  // Phones can't lock; the host can.
  phone.c.emit('host:lock', 'locked');
  const limited = nextState(phone.c, (s) => s.lock === 'limited');
  display.c.emit('host:lock', 'limited');
  await limited;

  // Limited: sliders pass, mode is rejected and the sender gets the real state back.
  const rejected = nextState(phone.c, (s) => s.force === true);
  phone.c.emit('controls:set', { mode: 5, hue: 0.4 });
  assert.equal((await rejected).mode, 0);
  await nextState(phone2.c, (s) => s.hue === 0.4);

  const sub = await phone.c.timeout(2000).emitWithAck('yt:submit', 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(sub.ok, false, 'music is host-only while locked');
  const up = await fetch(`${url}/api/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/mpeg', 'X-Filename': 'a.mp3', 'cf-connecting-ip': '203.0.113.9' },
    body: Buffer.alloc(16),
  });
  assert.equal(up.status, 403);

  // The PIN makes a phone host.
  const wrong = await phone.c.timeout(2000).emitWithAck('host:pin', '000000');
  assert.equal(wrong.ok, false);
  await new Promise((r) => setTimeout(r, 2100)); // per-socket PIN attempt spacing
  const right = await phone.c.timeout(2000).emitWithAck('host:pin', '424242');
  assert.equal(right.ok, true);
  const modeSet = nextState(phone2.c, (s) => s.mode === 5);
  phone.c.emit('controls:set', { mode: 5 });
  await modeSet;
});

test('parseSpotify accepts single songs and explains everything else', () => {
  const id = '4cOdK2wGLETKBW3PvgPWqT';
  for (const s of [
    `https://open.spotify.com/track/${id}`,
    `https://open.spotify.com/track/${id}?si=abc123`,
    `open.spotify.com/intl-de/track/${id}`,
    `https://open.spotify.com/embed/track/${id}`,
    `spotify:track:${id}`,
  ]) {
    assert.deepEqual(parseSpotify(s), { type: 'track', id, uri: `spotify:track:${id}` }, s);
  }
  assert.equal(parseSpotify(`https://open.spotify.com/episode/${id}`).uri, `spotify:episode:${id}`);
  assert.match(parseSpotify(`https://open.spotify.com/playlist/${id}`).error, /single song, not a playlist/);
  assert.match(parseSpotify(`https://open.spotify.com/album/${id}`).error, /not an album/);
  assert.equal(parseSpotify('https://youtu.be/dQw4w9WgXcQ'), null);
  assert.equal(parseSpotify('https://evil.example/track/' + id), null);
  assert.equal(parseSpotify('spotify:track:short'), null);
});

test('socket flow: media:submit plays the chosen source', async (t) => {
  const { server, io } = createApp();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const c = ioc(url, { transports: ['websocket'], forceNew: true });
  t.after(() => {
    c.close();
    io.close();
    server.close();
  });
  await new Promise((r) => c.on('connect', r));
  c.emit('hello', { role: 'output' });
  const id = '4cOdK2wGLETKBW3PvgPWqT';

  const wrong = await c.timeout(2000).emitWithAck('media:submit', { source: 'youtube', url: `https://open.spotify.com/track/${id}` });
  assert.match(wrong.error, /Switch to Spotify/);
  const wrong2 = await c.timeout(2000).emitWithAck('media:submit', { source: 'spotify', url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.match(wrong2.error, /Switch to YouTube/);

  const state = new Promise((resolve) => c.on('yt:state', (s) => s.media && s.media.kind === 'spotify' && resolve(s)));
  const ok = await c.timeout(2000).emitWithAck('media:submit', { source: 'spotify', url: `https://open.spotify.com/track/${id}?si=x` });
  assert.equal(ok.ok, true);
  const s = await state;
  assert.equal(s.media.uri, `spotify:track:${id}`);
  assert.equal(s.videoId, null);
});

test('TapCombos merges taps from different phones within one window', () => {
  const c = new TapCombos(450);
  c.tap('a', 0.2, 0.2, 0.1, 1000);
  c.tap('a', 0.4, 0.4, 0.1, 1100); // same phone again: counts once, latest spot kept
  assert.equal(c.flush(1300), null, 'window still open');
  assert.equal(c.flush(1500), null, 'one phone is not a combo');
  c.tap('a', 0.2, 0.5, 0.1, 2000);
  c.tap('b', 0.6, 0.5, 0.7, 2200);
  c.tap('c', 0.4, 0.8, 0.3, 2400);
  const combo = c.flush(2450);
  assert.equal(combo.size, 3);
  assert.deepEqual(combo.ids, ['a', 'b', 'c']);
  assert.ok(Math.abs(combo.x - 0.4) < 1e-9 && Math.abs(combo.y - 0.6) < 1e-9);
  assert.equal(c.flush(5000), null, 'taps are used up');
  c.tap('a', 0.5, 0.5, 0.1, 6000);
  c.remove('a');
  assert.equal(c.flush(7000), null);
});

test('socket flow: touch pad bursts, combos and the lock', async (t) => {
  const { server, io } = createApp({ hostPin: '424242' });
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
      const c = ioc(url, { transports: ['websocket'], forceNew: true, extraHeaders: role === 'input' ? { 'cf-connecting-ip': '203.0.113.9' } : {} });
      clients.push(c);
      c.once('host:status', () => resolve(c));
      c.on('connect', () => c.emit('hello', { role }));
    });
  const next = (c, ev, pred = () => true) => new Promise((resolve) => c.on(ev, (m) => pred(m) && resolve(m)));

  const display = await connect('output');
  const a = await connect('input');
  const b = await connect('input');

  const burst = next(display, 'touch:fx');
  a.emit('touch', { x: 0.25, y: 0.75 });
  const fx = await burst;
  assert.equal(fx.x, 0.25);
  assert.equal(fx.y, 0.75);
  assert.equal(fx.d, 0);
  assert.ok(fx.h >= 0 && fx.h < 1);

  // Two phones tapping together make a combo, announced to the display and to both phones.
  const comboDisplay = next(display, 'touch:combo');
  const comboA = next(a, 'touch:combo');
  b.emit('touch', { x: 0.75, y: 0.25 });
  const combo = await comboDisplay;
  assert.equal(combo.size, 2);
  assert.equal(combo.x, 0.5);
  assert.equal((await comboA).size, 2);

  // Out-of-range input is ignored; locked turns the pad off for phones.
  let count = 0;
  display.on('touch:fx', () => count++);
  a.emit('touch', { x: 2, y: 0.5 });
  const locked = next(a, 'controls:state', (s) => s.lock === 'locked');
  display.emit('host:lock', 'locked');
  await locked;
  b.emit('touch', { x: 0.5, y: 0.5 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(count, 0);
});

test('PulseAggregator averages dancers\' movement energy and counts taps as beats', () => {
  const p = new PulseAggregator();
  p.update('tapper', { bpm: 0, confidence: 0.4, beat: true, source: 'tap' }, 1000, { n: 1, hue: 0.1 });
  p.update('dancer1', { bpm: 120, confidence: 0.6, energy: 0.8, source: 'dance' }, 1000, { n: 2, hue: 0.2 });
  p.update('heart', { bpm: 70, confidence: 0.8, source: 'heart' }, 1000, { n: 5, hue: 0.5 });
  p.update('dancer2', { bpm: 0, confidence: 0.3, energy: 0.4, source: 'dance' }, 1000, { n: 3, hue: 0.3 });
  p.update('bad', { bpm: 0, confidence: 0.3, energy: 'lots', source: 'dance' }, 1000, { n: 4, hue: 0.4 });
  const a = p.aggregate(1050);
  assert.equal(a.beats, 1, 'a first tap counts as a beat before any BPM is known');
  assert.equal(a.dancers, 2);
  assert.equal(a.motion, 0.6);
  assert.equal(a.sensors, 5);
  assert.deepEqual(a.hearts.map((h) => h[0]), [5], 'only heart-camera phones get a ring');
  assert.equal(a.active, 2, 'only phones with a BPM set the tempo');
});

test('CrowdHold charges while enough phones hold, and blasts when they let go', () => {
  const h = new CrowdHold();
  assert.equal(CrowdHold.need(2), 2);
  assert.equal(CrowdHold.need(9), 5);
  assert.equal(CrowdHold.need(40), 8);
  h.set('a', true);
  let s = h.tick(1, 4);
  assert.equal(s.holders, 1);
  assert.equal(s.charge, 0, 'one of two needed does not charge');
  h.set('b', true);
  s = h.tick(2, 4);
  assert.equal(s.charge, 0.5);
  assert.equal(s.release, 0);
  h.set('a', false);
  s = h.tick(0.1, 4);
  assert.equal(s.release, 0.5, 'letting go releases the charge');
  assert.equal(s.charge, 0);
  // A short hold fizzles out instead of blasting.
  h.set('a', true);
  h.tick(0.2, 4);
  h.remove('b');
  s = h.tick(0.1, 4);
  assert.equal(s.release, 0);
});

test('TapRace splits teams, counts taps only while live, and names the winner', () => {
  const players = [{ id: 'a', n: 1 }, { id: 'b', n: 2 }, { id: 'c', n: 3 }];
  const r = new TapRace(players, 0);
  assert.equal(r.snapshot(0).phase, 'countdown');
  assert.deepEqual(r.snapshot(0).teams, { 1: 0, 2: 1, 3: 0 });
  r.tap(players[1], 1000);
  assert.deepEqual(r.score, [0, 0], 'countdown taps do not count');
  r.tap(players[1], 3500);
  r.tap(players[1], 3600);
  r.tap(players[0], 3700);
  r.tap({ id: 'd', n: 4 }, 3800); // late joiner goes to the smaller team (blue)
  assert.deepEqual(r.score, [1, 3]);
  r.tap(players[0], 18500);
  const done = r.snapshot(18500);
  assert.equal(done.phase, 'done');
  assert.equal(done.winner, 1);
  assert.ok(!r.finished(20000));
  assert.ok(r.finished(23000));
});

test('PassColour moves the colour on a timer and when its holder leaves', () => {
  let players = [{ id: 'a', n: 1, hue: 0.1 }, { id: 'b', n: 2, hue: 0.7 }];
  const p = new PassColour(players, 0, () => 0);
  assert.equal(p.snapshot(0).holder, 1);
  assert.equal(p.tick(players, 1000), false);
  assert.equal(p.tick(players, 6000), true);
  assert.equal(p.snapshot(6000).holder, 2, 'passes to someone else');
  players = players.slice(0, 1);
  assert.equal(p.tick(players, 7000), true);
  assert.equal(p.snapshot(7000).holder, 1);
  assert.ok(p.finished(60000));
});

test('socket flow: stir drags, hold together, tilt and games', async (t) => {
  const { server, io } = createApp({ hostPin: '424242' });
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
      const c = ioc(url, { transports: ['websocket'], forceNew: true, extraHeaders: role === 'input' ? { 'cf-connecting-ip': '203.0.113.9' } : {} });
      clients.push(c);
      c.once('host:status', () => resolve(c));
      c.on('connect', () => c.emit('hello', { role }));
    });
  const next = (c, ev, pred = () => true) => new Promise((resolve) => c.on(ev, (m) => pred(m) && resolve(m)));

  const display = await connect('output');
  const a = await connect('input');
  const b = await connect('input');

  const drag = next(display, 'touch:fx', (m) => m.d === 1);
  a.emit('touch', { x: 0.5, y: 0.5, drag: true, vx: 99, vy: -2, tool: 'paint' });
  const d = await drag;
  assert.equal(d.vx, 30, 'finger speed is clamped');
  assert.equal(d.vy, -2);
  assert.equal(d.p, 1);

  const tilt = next(display, 'tilt:agg', (m) => m.n === 2);
  a.emit('tilt', { x: 0.5, y: -1 });
  b.emit('tilt', { x: -0.1, y: 5 });
  const agg = await tilt;
  assert.ok(Math.abs(agg.x - 0.2) < 1e-9);
  assert.equal(agg.y, 0);

  const charging = next(display, 'crowd:hold', (m) => m.charge > 0);
  a.emit('touch:hold', true);
  b.emit('touch:hold', true);
  assert.equal((await charging).need, 2);
  await new Promise((r) => setTimeout(r, 700));
  const blast = next(b, 'crowd:release');
  a.emit('touch:hold', false);
  assert.ok((await blast).power >= 0.15);

  const unknown = await new Promise((r) => display.emit('game:start', 'nope', r));
  assert.equal(unknown.ok, false);
  const started = next(b, 'game:state', (s) => s.kind === 'race');
  const res = await new Promise((r) => a.emit('game:start', 'race', r));
  assert.equal(res.ok, true);
  const race = await started;
  assert.equal(race.phase, 'countdown');
  assert.equal(Object.keys(race.teams).length, 2);
  const again = await new Promise((r) => b.emit('game:start', 'pass', r));
  assert.equal(again.ok, false, 'one game at a time');
  const stopped = next(display, 'game:state', (s) => s.kind === null);
  b.emit('game:stop');
  await stopped;
});
