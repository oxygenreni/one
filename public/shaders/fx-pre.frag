// FX: kaleidoscope + heartbeat shockwave ripples (a UV remap of the rendered scene).
uniform sampler2D uSrc;
uniform float uKaleido;
uniform float uSegments;
uniform float uKRot;
uniform float uKZoom;
uniform float uRipple;
uniform vec4 uRipples; // ages (s) of up to 4 live rings; -1 = unused

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