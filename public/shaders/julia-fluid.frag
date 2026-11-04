// MODE 6 — Julia Fluid: the Julia set suspended in the fluid simulation.
// Pulse  -> the c constant (as in the Julia mode) and physical force splats in the fluid,
//           whose velocity field warps the fractal's coordinates.
// Audio  -> dye dropped into the fluid, boundary glow injected into the dye, lighting contrast.
// uPass 0: inject the fractal's glowing boundary into the dye texture (rendered at dye resolution).
// uPass 1: final display — warped fractal plus the dye it has shed.

uniform sampler2D uDye;
uniform sampler2D uVelocity;
uniform vec2 uJuliaC;
uniform float uJuliaRot;
uniform float uHue;
uniform float uPass;
uniform float uWarp;
uniform float uInject;

vec2 cmul(vec2 a, vec2 b) { return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }

// Returns the fractal colour. `edge`: soft 0..1 glow along the boundary (used to shed ink).
// `mask`: how much the fractal body should cover the fluid. `line`: crisp boundary outline.
vec3 juliaColor(vec2 p, out float edge, out float mask, out float line) {
  vec2 z = p;
  vec2 dz = vec2(1.0, 0.0);
  float m2 = dot(z, z);
  float n = 0.0;
  const int MAX_IT = 160;
  for (int i = 0; i < MAX_IT; i++) {
    dz = 2.0 * cmul(z, dz);
    z = cmul(z, z) + uJuliaC;
    m2 = dot(z, z);
    if (m2 > 1024.0) break;
    n += 1.0;
  }
  if (n >= float(MAX_IT)) {
    // Interior: a dark silhouette that stands out against the bright ink.
    edge = 0.0;
    mask = 1.0;
    line = 0.0;
    return vec3(0.05, 0.02, 0.08) * (1.0 + 2.0 * uPulse * uStrength);
  }
  float sn = n - log2(log2(m2)) + 4.0;
  float de = 0.5 * sqrt(m2 / max(dot(dz, dz), 1e-12)) * log(m2);
  float px = 2.9 / uRes.y;
  edge = smoothstep(px * 10.0, 0.0, de) + 0.35 * exp(-de / (px * 40.0));
  line = smoothstep(px * 2.5, 0.0, de);
  mask = smoothstep(3.0, 10.0, sn);

  vec3 base = palette(sn * 0.035 + uHue + 0.25 * uMid, vec3(0.5), vec3(0.5), vec3(1.0), vec3(0.0, 0.1, 0.2));
  vec3 col = base * (0.5 + 1.2 * uBass) * smoothstep(2.0, 12.0, sn);
  col += edge * palette(uHue + 0.5 + 0.3 * uTreble, vec3(0.6), vec3(0.4), vec3(1.0), vec3(0.3, 0.2, 0.2)) * (0.45 + 1.0 * uLevel);
  return col;
}

void main() {
  vec2 uv = vUv;
  vec2 vel = texture(uVelocity, uv).xy;
  float breath = uBreath * (0.35 + 0.65 * uStrength);

  // Fluid currents bend the fractal: offset its sample point along the local flow.
  vec2 p = aspectUv() + vel * uWarp;
  p = rot(uJuliaRot) * p * (1.45 - 0.12 * breath);

  float edge, mask, line;
  vec3 jc = juliaColor(p, edge, mask, line);
  vec3 dye = texture(uDye, uv).rgb;

  if (uPass < 0.5) {
    // Shed vivid boundary ink into the fluid; the currents carry it away as tracers.
    // Hue varies around the fractal (and over time) so trails stay saturated instead of greying out.
    float ang = atan(p.y, p.x) / TAU;
    vec3 ink = 0.5 + 0.5 * cos(TAU * (uHue + ang + 0.2 * uMid + vec3(0.0, 0.33, 0.67)));
    ink = pow(ink, vec3(1.8));
    fragColor = vec4(dye + ink * edge * uInject, 1.0);
    return;
  }

  // The fractal body sits on top of the fluid (mostly hiding the ink behind it), with a crisp
  // bright outline, so its shape stays readable while the trails swirl around it.
  vec3 col = mix(dye * 0.7, jc * 1.1, mask * 0.85);
  col += line * vec3(1.0, 0.97, 0.92) * (0.6 + 0.8 * uTreble);
  // Chromatic shimmer where the flow is fast.
  col += 0.0006 * length(vel) * vec3(0.4, 0.2, 0.8) * (0.5 + uTreble);
  col *= 1.0 + 0.25 * uBeat;
  col *= smoothstep(2.6, 0.6, length(aspectUv()));
  fragColor = vec4(tonemap(col), 1.0);
}
