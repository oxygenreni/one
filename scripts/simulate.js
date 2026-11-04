'use strict';
// Simulates N phones streaming heartbeats, for demos and load testing.
// Usage: node scripts/simulate.js [url=http://localhost:3000] [count=25]
const { io } = require('socket.io-client');

const url = process.argv[2] || 'http://localhost:3000';
const count = Number(process.argv[3]) || 25;
const SEND_MS = 100;

for (let i = 0; i < count; i++) {
  const socket = io(url, { transports: ['websocket'], forceNew: true, rejectUnauthorized: false });
  const baseBpm = 58 + Math.random() * 40;
  let phase = Math.random();
  let last = Date.now();
  let lastBeatPhase = Math.floor(phase);
  socket.on('connect', () => socket.emit('hello', { role: 'input' }));
  setInterval(() => {
    if (!socket.connected) return;
    const now = Date.now();
    // Slow excitement wave so the room's tempo drifts over a few minutes.
    const bpm = baseBpm + 18 * Math.sin(now / 40000 + i);
    phase += ((now - last) / 1000) * (bpm / 60);
    last = now;
    const beat = Math.floor(phase) > lastBeatPhase;
    lastBeatPhase = Math.floor(phase);
    const f = phase % 1;
    socket.volatile.emit('pulse', {
      bpm: Math.round(bpm * 10) / 10,
      signal: Math.round((Math.exp(-f * 8) * 2 - 1) * 1000) / 1000,
      confidence: 0.6 + 0.4 * Math.random(),
      beat,
    });
  }, SEND_MS);
}
console.log(`Simulating ${count} phones -> ${url}`);
