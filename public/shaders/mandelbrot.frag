// MODE 5 — Mandelbrot set: an endless dive that only ever zooms in.
// Pulse  -> continuous zoom velocity (integrated on the CPU into uScale, see output.js).
//           Near the float32 precision limit a second dive (uCenter2/uScale2) starts underneath
//           and the two crossfade (uMix), so the zoom never reverses.
// Audio  -> each colour band of the escape-time gradient is lit by its own FFT bin.

uniform vec2 uCenter;
uniform float uScale;
uniform float uMaxIter;
uniform vec2 uCenter2;
uniform float uScale2;
uniform float uMaxIter2;
uniform float uMix;
uniform float uRotation;
uniform float uBandShift;

vec3 mandel(vec2 p, vec2 center, float scale, float maxIter) {
  vec2 c = center + p * scale;
  vec2 z = vec2(0.0);
  float m2 = 0.0;
  float n = 0.0;
  const int HARD_MAX = 900;
  for (int i = 0; i < HARD_MAX; i++) {
    if (float(i) >= maxIter) break;
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    m2 = dot(z, z);
    if (m2 > 4096.0) break;
    n += 1.0;
  }

  if (n >= maxIter) {
    return vec3(0.01, 0.0, 0.02) + 0.05 * uPulse * uStrength * vec3(0.8, 0.2, 0.5);
  }
  float mu = n - log2(log2(m2)) + 4.0;
  float band = mu * 0.06 + uBandShift;
  float bin = fft(fract(mu / 40.0));
  vec3 base = palette(band, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.15, 0.3));
  float stripes = 0.5 + 0.5 * sin(mu * 1.3 - uTime * 2.0);
  vec3 col = base * (0.3 + 1.8 * bin) * (0.75 + 0.25 * stripes);
  col += pow(bin, 3.0) * uOnset * vec3(1.0, 0.9, 1.0);
  // Glow near the set boundary.
  col += vec3(0.9, 0.6, 1.0) * exp(-mu * 0.03) * 0.15 * (1.0 + uBass);
  return col;
}

void main() {
  vec2 p = rot(uRotation) * aspectUv();
  vec3 col = mandel(p, uCenter, uScale, uMaxIter);
  if (uMix > 0.001) {
    col = mix(col, mandel(p, uCenter2, uScale2, uMaxIter2), uMix);
  }

  col *= 1.0 + 0.25 * uBeat;
  col *= smoothstep(2.6, 0.6, length(aspectUv()));
  fragColor = vec4(tonemap(col), 1.0);
}
