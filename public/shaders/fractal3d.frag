// MODE 7 — Fractal Flight: an endless flythrough of a 3D Apollonian fractal (sphere-inversion folds).
// Pulse  -> camera speed (integrated in output.js), geometry "breathing" (uFracS), heartbeat flashes.
// Audio  -> surface colour bands from the FFT, bass-driven glow in the gaps, treble sparkle.

uniform vec3 uCamPos;
uniform vec3 uCamFwd;
uniform float uCamRoll;
uniform float uFracS;
uniform float uHue;

// Distance estimator. `orb` = orbit trap (min radius²), used for colouring.
// Must match apollonian() in output.js, which steers the camera away from walls.
float apollonian(vec3 p, out float orb) {
  float scale = 1.0;
  orb = 1e4;
  for (int i = 0; i < 8; i++) {
    p = -1.0 + 2.0 * fract(0.5 * p + 0.5);
    float r2 = dot(p, p);
    orb = min(orb, r2);
    float k = uFracS / r2;
    p *= k;
    scale *= k;
  }
  return 0.25 * abs(p.y) / scale;
}

float mapD(vec3 p) {
  float o;
  return apollonian(p, o);
}

vec3 calcNormal(vec3 p, float eps) {
  const vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * mapD(p + k.xyy * eps) + k.yyx * mapD(p + k.yyx * eps) +
                   k.yxy * mapD(p + k.yxy * eps) + k.xxx * mapD(p + k.xxx * eps));
}

void main() {
  vec2 uv = aspectUv();
  vec3 fwd = normalize(uCamFwd);
  vec3 up0 = vec3(sin(uCamRoll), cos(uCamRoll), 0.0);
  vec3 right = normalize(cross(fwd, up0));
  vec3 up = cross(right, fwd);
  vec3 rd = normalize(fwd * 1.5 + uv.x * right + uv.y * up);

  float t = 0.002;
  float orb = 0.0;
  float glow = 0.0;
  bool hit = false;
  float steps = 0.0;
  const int MAX_STEPS = 110;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = uCamPos + rd * t;
    float d = apollonian(p, orb);
    glow += exp(-d * 60.0);
    if (d < 0.00035 * t) {
      hit = true;
      break;
    }
    t += d * 0.9;
    steps += 1.0;
    if (t > 5.0) break;
  }

  vec3 fogCol = palette(uHue + 0.55, vec3(0.02, 0.01, 0.04), vec3(0.03, 0.02, 0.05), vec3(1.0), vec3(0.2, 0.4, 0.6));
  vec3 col = fogCol;
  if (hit) {
    vec3 p = uCamPos + rd * t;
    vec3 n = calcNormal(p, 0.0002 * t);
    float bandPos = fract(sqrt(orb) * 1.7 + uHue * 0.3);
    float bin = fft(bandPos);
    vec3 base = palette(sqrt(orb) * 3.2 + uHue, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.33, 0.67));
    vec3 L = normalize(-rd + up * 0.6 + right * 0.3);
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(rd, n), L), 0.0), 20.0);
    float ao = clamp(1.0 - steps / float(MAX_STEPS), 0.0, 1.0);
    col = base * (0.15 + 0.85 * diff) * (0.4 + 0.6 * ao) * (0.6 + 1.4 * bin);
    col += spec * (0.25 + 1.5 * uTreble);
    col = mix(col, fogCol, 1.0 - exp(-t * 0.8));
  }

  // Volumetric glow in the gaps between spheres, pumped by bass and heartbeats.
  vec3 glowCol = palette(uHue + 0.3, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.6, 0.3, 0.1));
  col += glowCol * glow * 0.006 * (0.4 + 1.6 * uBass + 1.2 * uBeat);

  col *= 1.0 + 0.3 * uPulse * uStrength;
  col *= smoothstep(2.4, 0.5, length(uv));
  fragColor = vec4(tonemap(col), 1.0);
}
