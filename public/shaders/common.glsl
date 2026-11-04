// Shared header prepended to every fragment shader (after #version).
precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUv;
out vec4 fragColor;

// Frame
uniform vec2 uRes;
uniform float uTime;

// Aggregated collective pulse (see output.js -> PulseState)
uniform float uBpm;       // smoothed room BPM
uniform float uPulse;     // 0..1 heartbeat waveform (spikes on each beat)
uniform float uBeat;      // decaying impulse triggered by real beats from phones
uniform float uBreath;    // -1..1 slow inhale/exhale oscillator locked to BPM (4 beats / breath)
uniform float uEnergy;    // 0..1 "heat" derived from BPM + beat density
uniform float uStrength;  // 0..1 how much real sensor data is present (idle fallback otherwise)
uniform float uUsers;     // number of active sensors

// Audio (Web Audio FFT)
uniform float uBass;
uniform float uMid;
uniform float uTreble;
uniform float uLevel;
uniform float uOnset;     // decaying impulse on bass onsets
uniform sampler2D uFFT;   // 64 log-spaced bins in .r, 0..1

const float PI = 3.14159265359;
const float TAU = 6.28318530718;

float fft(float x) { return texture(uFFT, vec2(clamp(x, 0.0, 1.0), 0.5)).r; }

vec2 aspectUv() {
  vec2 p = vUv * 2.0 - 1.0;
  p.x *= uRes.x / uRes.y;
  return p;
}

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// 2D simplex noise (after Stefan Gustavson / Ashima Arts, MIT). Range ~[-1, 1].
vec3 permute289(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute289(permute289(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float a = 0.5;
  float s = 0.0;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    s += a * snoise(p);
    p = r * p * 2.02 + 17.1;
    a *= 0.5;
  }
  return s;
}

// Cosine gradient palette.
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(TAU * (c * t + d));
}

vec3 tonemap(vec3 c) {
  c = max(c, 0.0);
  return c / (1.0 + c * 0.35) * 1.1;
}
