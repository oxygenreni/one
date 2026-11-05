// MODE 5 — Mandelbrot set: an endless zoom into a self-similar (Misiurewicz) point.
// The view wraps back by exactly one self-similar step when it gets deep enough (see output.js ->
// mandel), so the zoom never cuts or reverses. Pixels are iterated relative to the point's own
// orbit (perturbation), so float32 precision never runs out.
// Pulse  -> zoom velocity (integrated on the CPU into uScale), heartbeat surges.
// Audio  -> each colour band of the escape-time gradient is lit by its own FFT bin.

const int PRE = 20;    // the point's orbit: PRE steps, then a cycle of PERIOD (match MIS in output.js)
const int PERIOD = 5;
uniform vec2 uOrbit[25]; // PRE + PERIOD orbit points, starting at 0
uniform float uScale;
uniform float uMaxIter;
uniform float uRotation;
uniform float uBandShift;
uniform float uMuOffset; // iterations skipped by the wraps, keeps the colours continuous
uniform float uMuRef;    // typical escape time at this depth, for the glow

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  vec2 dc = rot(uRotation) * aspectUv() * uScale;
  // z = orbit[m] + dz. When dz outgrows z, restart from the orbit's start (orbit[0] = 0) so the
  // small-difference maths stays accurate.
  vec2 dz = vec2(0.0);
  int m = 0;
  float m2 = 0.0;
  float n = 0.0;
  const int HARD_MAX = 900;
  for (int i = 0; i < HARD_MAX; i++) {
    if (float(i) >= uMaxIter) break;
    dz = cmul(2.0 * uOrbit[m] + dz, dz) + dc;
    m = m + 1 == PRE + PERIOD ? PRE : m + 1;
    vec2 z = uOrbit[m] + dz;
    m2 = dot(z, z);
    if (m2 > 4096.0) break;
    n += 1.0;
    if (m2 < dot(dz, dz)) {
      dz = z;
      m = 0;
    }
  }

  vec3 col;
  if (n >= uMaxIter) {
    col = vec3(0.01, 0.0, 0.02) + 0.05 * uPulse * uStrength * vec3(0.8, 0.2, 0.5);
  } else {
    float mu = n - log2(log2(m2)) + 4.0;
    float muc = mu + uMuOffset;
    float bin = fft(fract(muc / 40.0));
    vec3 base = palette(muc * 0.06 + uBandShift, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.15, 0.3));
    float stripes = 0.5 + 0.5 * sin(muc * 1.3 - uTime * 2.0);
    col = base * (0.3 + 1.8 * bin) * (0.75 + 0.25 * stripes);
    col += pow(bin, 3.0) * uOnset * vec3(1.0, 0.9, 1.0);
    // Treble hits flash the stripes.
    col += base * 0.4 * uSpark * stripes * stripes;
    // Glow on the fast-escaping side of the boundary.
    col += vec3(0.9, 0.6, 1.0) * min(exp(-(mu - uMuRef) * 0.03), 1.0) * 0.15 * (1.0 + uBass);
  }

  col *= 1.0 + 0.25 * uBeat;
  col *= smoothstep(2.6, 0.6, length(aspectUv()));
  fragColor = vec4(tonemap(col), 1.0);
}
