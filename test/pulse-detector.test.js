'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PulseDetector = require('../public/js/pulse-detector.js');

function synth(bpm, seconds, { fps = 30, noise = 0.15, seed = 1 } = {}) {
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [];
  for (let i = 0; i < seconds * fps; i++) {
    const t = i / fps;
    const phase = ((t * bpm) / 60) % 1;
    // Sharp systolic dip + slow baseline drift (finger pressure / auto-exposure).
    const pulse = -2.0 * Math.exp(-Math.pow((phase - 0.15) / 0.07, 2));
    const drift = 6 * Math.sin(t * 0.3);
    out.push({ t: t * 1000, v: 180 + drift + pulse + rand() * noise * 2 });
  }
  return out;
}

for (const bpm of [55, 72, 98, 130]) {
  test(`detects ${bpm} BPM from a synthetic PPG signal`, () => {
    const d = new PulseDetector();
    let beats = 0;
    for (const { t, v } of synth(bpm, 20)) {
      d.addSample(v, t, true);
      if (d.takeBeat()) beats++;
    }
    assert.ok(Math.abs(d.bpm - bpm) < 3, `estimated ${d.bpm.toFixed(1)}`);
    assert.ok(d.confidence > 0.6, `confidence ${d.confidence}`);
    const expected = (bpm / 60) * (20 - 1.6);
    assert.ok(Math.abs(beats - expected) <= 3, `beats ${beats} vs ~${expected.toFixed(1)}`);
  });
}

test('resets when the finger is removed', () => {
  const d = new PulseDetector();
  for (const { t, v } of synth(70, 10)) d.addSample(v, t, true);
  assert.ok(d.bpm > 0);
  d.addSample(20, 10100, false);
  assert.equal(d.bpm, 0);
  assert.equal(d.confidence, 0);
  assert.equal(d.hasContact, false);
});

test('contact heuristic', () => {
  assert.equal(PulseDetector.detectContact(200, 40, 30), true);
  assert.equal(PulseDetector.detectContact(120, 110, 100), false);
  assert.equal(PulseDetector.detectContact(20, 5, 5), false);
});
