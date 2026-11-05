// MODE 9 — Nebula Portals: a molten, oil-on-water nebula swirling around dark portals, above a
// glittering liquid horizon.
// Pulse  -> flow speed (uFlow, integrated in output.js), portals breathing open with the breath and beats.
// Audio  -> bass brightens the portal rims, mids turn the colours, treble hits make the glitter flare.

uniform float uFlow;
uniform float uHue;
uniform float uPortal; // portal size multiplier
uniform float uSwirl;  // how hard matter spirals into the portals

vec3 irid(float t) { return 0.5 + 0.5 * cos(TAU * (t + vec3(0.0, 0.33, 0.67))); }

// Portals: xy centre, z radius.
vec3 portal(int i) {
  if (i == 0) return vec3(0.0, 0.1, 0.34 * uPortal);
  if (i == 1) return vec3(-1.0, 0.38, 0.17 * uPortal);
  return vec3(1.05, 0.02, 0.16 * uPortal);
}

// Nebula colour at p, with the portals cut out of it.
vec3 nebula(vec2 p) {
  float hole = 0.0;
  float rim = 0.0;
  vec2 q = p;
  for (int i = 0; i < 3; i++) {
    vec3 c = portal(i);
    float l = length(p - c.xy);
    // Matter spirals into each portal, hardest at its rim.
    float a = uSwirl * exp(-max(l - c.z, 0.0) / (c.z * 1.2));
    q = c.xy + rot(a) * (q - c.xy);
    rim += exp(-abs(l - c.z) / (0.012 + 0.05 * c.z));
    hole = max(hole, smoothstep(c.z, c.z * 0.88, l));
  }

  float t = uFlow;
  vec2 w = vec2(fbm(q * 1.2 + vec2(0.0, t * 0.08)), fbm(q * 1.2 + vec2(5.2, 1.3) - t * 0.06));
  float f = fbm(q * 1.5 + 1.8 * w + vec2(t * 0.05, 0.0));
  vec3 col = pow(irid(uHue + f * 1.1 + length(w) * 0.6 + 0.2 * uMid), vec3(1.6));
  col *= 0.3 + 1.0 * smoothstep(-0.4, 0.6, f);
  // Marbled filaments, like oil on water.
  float vein = pow(0.5 + 0.5 * sin(f * 26.0 + w.x * 6.0), 14.0);
  col += vein * mix(vec3(1.0), irid(uHue + f + 0.5), 0.5) * (0.3 + 0.8 * uTreble);
  // Icy rims.
  col += vec3(0.3, 0.75, 1.0) * rim * (0.35 + 0.9 * uBass + 0.6 * uBeat);

  // Inside: deep blue space with twinkling stars and light pooling at the bottom.
  vec3 inside = mix(vec3(0.0, 0.01, 0.06), vec3(0.05, 0.25, 0.75), 0.4 * smoothstep(0.3, -0.5, p.y));
  vec2 sp = p * 60.0;
  vec2 sc = floor(sp);
  float star = step(0.97, hash12(sc)) * smoothstep(0.2, 0.0, length(fract(sp) - hash22(sc)));
  inside += star * vec3(0.8, 0.9, 1.0) * (0.5 + 0.5 * sin(uTime * 3.0 + hash12(sc) * 20.0));
  return mix(col, inside, hole);
}

void main() {
  vec2 uv = aspectUv();
  float breath = uBreath * (0.35 + 0.65 * uStrength);
  vec2 p = uv * (1.0 - 0.04 * breath);
  float horizon = -0.58 + 0.16 * uv.x - 0.05 * uv.x * uv.x;
  vec3 col;

  if (uv.y > horizon) {
    col = nebula(p);
    // Glitter scattered through the nebula; more of it on treble hits.
    vec2 gp = uv * 110.0;
    vec2 gc = floor(gp);
    float gh = hash12(gc);
    float g = step(0.985 - 0.025 * uSpark - 0.008 * uTreble, gh) * smoothstep(0.3, 0.0, length(fract(gp) - 0.5));
    col += irid(gh * 7.0 + uHue) * g * (0.6 + 0.4 * sin(uTime * 4.0 + gh * 30.0) + uSpark);
    // Bright line where the nebula meets the liquid.
    col += vec3(0.4, 0.8, 1.0) * exp(-(uv.y - horizon) * 25.0) * (0.4 + 0.5 * uBass);
  } else {
    // The liquid surface: rippling reflection of the nebula, with coloured glints.
    float dy = horizon - uv.y;
    float z = 0.25 / (dy + 0.03); // distance along the surface
    vec2 wp = vec2(uv.x * z, z - uFlow * 0.6);
    float wave = fbm(wp * vec2(1.5, 3.0));
    vec2 rp = vec2(uv.x + 0.05 * wave, horizon + dy * 0.8 + 0.04 * wave);
    col = nebula(rp) * (0.25 + 0.2 * wave) * exp(-dy * 1.5);
    vec2 gq = wp * vec2(8.0, 14.0);
    float h = hash12(floor(gq));
    float glint = step(0.93 - 0.05 * uSpark, h) * smoothstep(0.35, 0.0, length(fract(gq) - 0.5)) * smoothstep(8.0, 3.0, z);
    col += irid(h * 3.0 + uHue) * glint * (0.6 + 1.5 * uSpark + uOnset) * exp(-dy * 0.8);
    col += vec3(0.05, 0.08, 0.2) * pow(max(wave, 0.0), 2.0);
  }

  col *= 1.0 + 0.25 * uPulse * uStrength;
  col *= smoothstep(2.6, 0.6, length(uv));
  fragColor = vec4(tonemap(col), 1.0);
}
