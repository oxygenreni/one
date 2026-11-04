// MODE 4 — Julia set: a living, mutating fractal.
// Pulse  -> the c constant (uJuliaC orbits/folds with breath + beats; computed in output.js).
// Audio  -> high-contrast lighting (bass = light intensity/contrast, treble = specular) and colour.

uniform vec2 uJuliaC;
uniform float uJuliaRot;
uniform float uHue;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

void main() {
  vec2 p = aspectUv();
  float breath = uBreath * (0.35 + 0.65 * uStrength);
  p = rot(uJuliaRot) * p * (1.45 - 0.12 * breath);

  vec2 z = p;
  vec2 dz = vec2(1.0, 0.0);
  float m2 = dot(z, z);
  float n = 0.0;
  const int MAX_IT = 180;
  for (int i = 0; i < MAX_IT; i++) {
    dz = 2.0 * cmul(z, dz);
    z = cmul(z, z) + uJuliaC;
    m2 = dot(z, z);
    if (m2 > 1024.0) break;
    n += 1.0;
  }

  vec3 col;
  if (n >= float(MAX_IT)) {
    // Interior: flat dark fill that throbs gently with the heartbeat.
    col = vec3(0.03, 0.01, 0.05) * (1.0 + 2.0 * uPulse * uStrength + uLevel);
  } else {
    float sn = n - log2(log2(m2)) + 4.0;
    float de = 0.5 * sqrt(m2 / max(dot(dz, dz), 1e-12)) * log(m2);
    float px = 2.9 / uRes.y;

    vec3 base = palette(sn * 0.035 + uHue + 0.25 * uMid,
                        vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.1, 0.2));

    // Fake relief lighting from the smooth iteration field.
    vec3 nrm = normalize(vec3(dFdx(sn), dFdy(sn), 0.12));
    float la = uTime * 0.4;
    vec3 L = normalize(vec3(cos(la), sin(la), 0.8));
    float diff = max(dot(nrm, L), 0.0);
    float spec = pow(max(dot(reflect(-L, nrm), vec3(0.0, 0.0, 1.0)), 0.0), 24.0);

    float contrast = 1.0 + 2.2 * uBass + 0.8 * uOnset;
    col = base * (0.25 + diff * (0.6 + 1.6 * uBass));
    col += spec * (0.3 + 2.5 * uTreble) * vec3(1.0, 0.95, 0.9);
    col = pow(col, vec3(contrast * 0.8));
    // Fade the far exterior to black so the set's structure carries the contrast.
    col *= 0.12 + 0.88 * smoothstep(2.0, 14.0, sn);

    // Bright filament along the set's boundary.
    float rim = smoothstep(px * 6.0, 0.0, de);
    col += rim * palette(uHue + 0.5, vec3(0.6), vec3(0.4), vec3(1.0), vec3(0.3, 0.2, 0.2)) * (0.5 + 1.5 * uLevel);
  }

  col *= smoothstep(2.4, 0.5, length(aspectUv()));
  fragColor = vec4(tonemap(col * (1.0 + 0.3 * uBeat)), 1.0);
}
