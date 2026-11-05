// MODE 8 — Star Iris: a vast eye made of stardust, staring out of the night sky above a pine forest.
// Pulse  -> the pupil dilates on each beat, the iris breathes with the breath and turns with the
//           energy (uSpin, integrated in output.js), the iris glows with the heartbeat.
// Audio  -> the iris's rings follow the spectrum, bass warms the golden ring, treble hits make the
//           stars flare.

uniform float uSpin;

const vec2 IRIS = vec2(0.42, 0.07);
const float GROUND = -0.86;

// One layer of stars: at most one per grid cell, each with its own size, tint and twinkle.
vec3 starLayer(vec2 p, float scale, float density, float seed, float size) {
  vec2 g = p * scale;
  vec2 c = floor(g);
  float h = hash12(c + seed);
  if (h > density) return vec3(0.0);
  vec2 o = 0.15 + 0.7 * hash22(c + seed * 1.3);
  float r = size * (0.5 + hash12(c + seed + 5.0));
  float d = length(fract(g) - o);
  float tw = 0.65 + 0.35 * sin(uTime * (0.8 + 3.0 * hash12(c + 9.0)) + h * 60.0);
  float b = smoothstep(r, 0.0, d) * tw * (0.3 + 0.7 * hash12(c + 2.0));
  vec3 tint = mix(vec3(0.75, 0.8, 1.0), vec3(1.0, 0.85, 0.6), hash12(c + 4.0));
  return tint * b * (1.0 + 2.5 * uSpark); // treble hits make them flare
}

vec3 stars(vec2 p, float dense) {
  vec3 s = starLayer(p, 150.0, 0.3 + 0.4 * dense, 1.0, 0.12);
  s += starLayer(p, 70.0, 0.1 + 0.15 * dense, 7.0, 0.1) * 1.3;
  s += starLayer(p, 28.0, 0.05, 13.0, 0.07) * 2.0;
  return s;
}

// The iris: stardust fibres radiating from a black pupil. `shade` = how much it hides the stars.
vec3 iris(vec2 p, float breath, out float shade) {
  vec2 d = p - IRIS;
  float a = atan(d.y, d.x) + uSpin;
  vec2 ring = vec2(cos(a), sin(a));
  float r = length(d) / (1.0 + 0.03 * breath);
  float rw = r * (1.0 + 0.08 * snoise(ring * 2.5 + 11.0)); // uneven outer edge
  float lr = log(max(r, 1e-3));
  float pr = 0.2 * (1.0 + 0.3 * uBeat + 0.12 * uBass) * (1.0 + 0.02 * snoise(ring * 3.0)); // pupil, dilating with each beat

  // Fibrous crypts: broad, leafy streaks that run outward and branch (ridged noise, periodic
  // around the circle), with finer filaments inside them.
  float n1 = fbm(ring * 5.0 + vec2(lr * 1.4, -lr * 0.8));
  float n2 = fbm(ring * 12.0 + vec2(lr * 2.4, 4.0));
  float fib = pow(1.0 - abs(n1), 3.0) * 0.75 + pow(1.0 - abs(n2), 6.0) * 0.45;
  float veins = smoothstep(0.0, 0.15, abs(n2)); // dark channels between the fibres

  // Bright and golden near the pupil, dusty violet and fading far out, ragged at the rim.
  float inner = smoothstep(pr - 0.01, pr + 0.06, r) * exp(-max(r - pr, 0.0) * 3.2);
  float outer = exp(-max(rw - 0.3, 0.0) * 2.4) * smoothstep(1.25 + 0.15 * n1, 0.5, rw);
  vec3 gold = vec3(0.36, 0.33, 0.2) * (1.0 + 1.2 * uBass); // muted olive-gold
  vec3 dusk = vec3(0.2, 0.18, 0.27);
  vec3 tint = mix(gold, dusk, smoothstep(0.25, 0.75, r));
  float spectrum = 0.6 + 0.9 * fft(clamp((r - pr) / 0.9, 0.0, 1.0));
  float glow = 0.3 + 0.3 * uPulse * uStrength + 0.15 * uLevel;
  float dust = 0.5 + hash12(floor(p * 420.0)); // grainy, made of specks
  vec3 col = tint * fib * dust * spectrum * glow * (0.9 * inner + 0.35 * outer);

  float pupil = smoothstep(pr + 0.015, pr - 0.015, r);
  col += gold * exp(-abs(r - pr) * 60.0) * (0.15 + 0.6 * uOnset); // faint glowing pupil edge
  col *= 1.0 - pupil;
  shade = max(pupil, (1.0 - veins) * 0.6 * max(inner, outer));
  return col;
}

// A pine: stacked, ragged tiers narrowing to a point. Signed distance, < 0 inside.
float pine(vec2 p, float x0, float h, float w) {
  float y = p.y - GROUND;
  float t = clamp(1.0 - y / h, 0.0, 1.0); // 0 at the tip, 1 at the base
  float tier = fract(t * (5.0 + h * 8.0));
  float width = w * t * (0.6 + 0.5 * tier) + 0.004;
  width += 0.012 * snoise(p * 70.0) * t;
  return max(abs(p.x - x0) - width, max(-y, y - h));
}

float forest(vec2 p) {
  float d = p.y - (GROUND + 0.04 + 0.03 * snoise(vec2(p.x * 2.0, 0.5)));
  d = min(d, pine(p, -0.95, 0.56, 0.17)); // the tall one on the left
  d = min(d, pine(p, -1.15, 0.3, 0.1));
  for (int i = 0; i < 22; i++) {
    float fi = float(i);
    float x = -2.0 + fi * 0.19 + 0.08 * hash12(vec2(fi, 1.0));
    float h = 0.08 + 0.2 * pow(hash12(vec2(fi, 2.0)), 2.0);
    d = min(d, pine(p, x, h, 0.05 + 0.03 * hash12(vec2(fi, 3.0))));
  }
  return d;
}

void main() {
  vec2 uv = aspectUv();
  float breath = uBreath * (0.35 + 0.65 * uStrength);
  float px = 2.0 / uRes.y;

  // Night sky: near-black blue, a little lighter low down so the trees read against it.
  vec3 col = mix(vec3(0.012, 0.014, 0.03), vec3(0.03, 0.03, 0.055), smoothstep(0.3, -0.9, uv.y));

  // Milky Way: a faint, mottled band rising from the lower left toward the iris.
  vec2 mwA = vec2(-0.7, -0.8);
  vec2 mwDir = normalize(vec2(0.75, 0.62));
  vec2 rel = uv - mwA;
  float along = dot(rel, mwDir);
  float across = dot(rel, vec2(-mwDir.y, mwDir.x));
  float band = exp(-across * across / 0.05) * smoothstep(-0.2, 0.3, along) * smoothstep(2.2, 0.8, along);
  float mott = 0.5 + 0.5 * fbm(vec2(along * 2.5, across * 6.0) + 3.0);
  col += vec3(0.16, 0.14, 0.18) * band * mott * 0.6;
  // A dim blue nebula in the top right.
  float neb = exp(-length((uv - vec2(1.3, 0.68)) * vec2(1.0, 1.4)) * 2.2) * (0.6 + 0.4 * fbm(uv * 3.0));
  col += vec3(0.08, 0.1, 0.2) * neb;

  // Stars, denser in the Milky Way, slowly wheeling around the iris.
  vec2 sp = IRIS + rot(uSpin * 0.15) * (uv - IRIS);
  vec3 st = stars(sp, band + 0.5 * neb);

  float shade;
  vec3 eye = iris(uv, breath, shade);
  col += eye;
  col += st * (1.0 - 0.85 * shade);

  // Film grain, like the illustration.
  col += (hash12(gl_FragCoord.xy + fract(uTime) * 100.0) - 0.5) * 0.02;

  // Forest silhouette in front of everything.
  col = mix(col, vec3(0.008, 0.009, 0.018), smoothstep(px, -px, forest(uv)));

  col *= 1.0 + 0.15 * uBeat;
  col *= smoothstep(2.4, 0.6, length(uv * vec2(0.8, 1.0)));
  fragColor = vec4(max(col, 0.0), 1.0);
}
