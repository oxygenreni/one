// FX: Chaos (zoom punch, warp, RGB split) + kaleidoscope + heartbeat shockwave ripples + touch pad
// bursts and smudges + room tilt and hold-together charge (a UV remap of the rendered scene).
uniform sampler2D uSrc;
uniform float uKaleido;
uniform float uSegments;
uniform float uKRot;
uniform float uKZoom;
uniform float uRipple;
uniform vec4 uRipples; // ages (s) of up to 4 live rings; -1 = unused
uniform vec4 uBursts[32]; // touch bursts: xy = spot (aspectUv space), z = age (s), w = power
uniform int uBurstCount;
uniform float uWarp;  // Chaos: 0..1 swirl and wobble
uniform float uPunch; // Chaos: zoom-in amount right now (pulses on beats)
uniform float uSplit; // Chaos: RGB split distance (flashes on beats and bass hits)
uniform vec4 uSmudges[16]; // stir drags: xy = spot (aspectUv space), zw = finger velocity (per s)
uniform float uSmudgeAge[16];
uniform int uSmudgeCount;
uniform vec2 uPan;    // room tilt: the picture slides this far
uniform float uCharge; // hold together: 0..1, the picture tightens and trembles

void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = (vUv - 0.5) * 2.0 * asp;
  float ring = 0.0;
  vec2 screen = p; // where on the screen this pixel is (touch bursts are placed in screen space)

  // Stir: each drag pulls the picture along with the finger, fading over about a second.
  for (int i = 0; i < 16; i++) {
    if (i >= uSmudgeCount) break;
    vec4 s = uSmudges[i];
    vec2 dv = screen - s.xy;
    float w = exp(-dot(dv, dv) / 0.06) * exp(-uSmudgeAge[i] * 2.5);
    p -= clamp(s.zw * 0.05, vec2(-0.25), vec2(0.25)) * w;
  }
  p -= uPan;
  if (uCharge > 0.0) {
    p *= 1.0 - 0.08 * uCharge;
    p += uCharge * uCharge * 0.012 * vec2(sin(uTime * 61.0), cos(uTime * 53.0));
  }

  // Chaos: punch in on the beat, then swirl (stronger toward the middle) and wobble the image.
  p *= 1.0 - uPunch;
  if (uWarp > 0.0) {
    float r = length(p);
    float swirl = uWarp * (1.6 * sin(r * 2.5 - uTime * 1.3) + 0.8 * uBreath) * exp(-r * 0.6);
    p = rot(swirl) * p;
    p += uWarp * 0.07 * vec2(sin(p.y * 4.0 + uTime * 1.9), sin(p.x * 4.0 - uTime * 1.6)) * (1.0 + uBeat);
  }

  if (uRipple > 0.5) {
    float r = length(p);
    vec2 dir = r > 1e-4 ? p / r : vec2(0.0);
    for (int i = 0; i < 4; i++) {
      float age = uRipples[i];
      if (age < 0.0) continue;
      float d = r - age * 1.5;                 // expanding wavefront
      float env = exp(-d * d * 14.0) * exp(-age * 1.6);
      p += dir * sin(d * 26.0) * env * 0.045 * (0.5 + 0.5 * uStrength);
      ring += env;
    }
  }

  // Each burst bends the image around an expanding wavefront; stronger ones travel further.
  // Keep the wavefront in step with the coloured ring in fx-final.frag.
  vec2 q = screen;
  for (int i = 0; i < 32; i++) {
    if (i >= uBurstCount) break;
    vec4 b = uBursts[i];
    vec2 dv = q - b.xy;
    float r = length(dv);
    float d = r - b.z * (0.55 + 0.3 * b.w);
    float env = exp(-d * d * 40.0 / (0.4 + b.w)) * exp(-b.z * 2.0 / (0.6 + 0.4 * b.w));
    p += (r > 1e-4 ? dv / r : vec2(0.0)) * sin(d * 30.0) * env * 0.025 * b.w;
    ring += env * min(b.w, 1.5) * 0.4;
  }

  if (uKaleido > 0.5) {
    float a = atan(p.y, p.x) + uKRot;
    float r = length(p) * uKZoom;
    float seg = TAU / uSegments;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);                     // mirror inside each slice -> seamless symmetry
    p = vec2(cos(a), sin(a)) * r;
  }

  vec2 uv = p / asp * 0.5 + 0.5;
  vec3 col = texture(uSrc, uv).rgb;             // scene target mirrors at its edges
  if (uSplit > 0.0) {
    vec2 dir = (uv - 0.5) * uSplit * 2.0;     // channels pulled apart outward from the middle
    col.r = texture(uSrc, uv + dir).r;
    col.b = texture(uSrc, uv - dir).b;
  }
  col *= 1.0 + 0.35 * ring;
  fragColor = vec4(col, 1.0);
}
