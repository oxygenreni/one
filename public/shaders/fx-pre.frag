// FX: kaleidoscope + heartbeat shockwave ripples + touch pad bursts (a UV remap of the rendered scene).
uniform sampler2D uSrc;
uniform float uKaleido;
uniform float uSegments;
uniform float uKRot;
uniform float uKZoom;
uniform float uRipple;
uniform vec4 uRipples; // ages (s) of up to 4 live rings; -1 = unused
uniform vec4 uBursts[32]; // touch bursts: xy = spot (aspectUv space), z = age (s), w = power
uniform int uBurstCount;

void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = (vUv - 0.5) * 2.0 * asp;
  float ring = 0.0;

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
  vec2 q = p;
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
  col *= 1.0 + 0.35 * ring;
  fragColor = vec4(col, 1.0);
}
