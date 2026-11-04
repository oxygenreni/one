// Gray-Scott reaction-diffusion step. State texture: r = chemical A, g = chemical B.
uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uFeed;
uniform float uKill;
uniform float uDt;
uniform float uInit;       // 1.0 on the first pass: lay down random spores
uniform vec3 uSeed;        // xy = uv, z = radius (0 disables); injects B ("new cells")
uniform float uSimAspect;

void main() {
  vec2 uv = vUv;
  if (uInit > 0.5) {
    vec2 g = floor(uv * vec2(uSimAspect, 1.0) * 28.0);
    float spot = step(0.93, hash12(g + uTime));
    vec2 f = fract(uv * vec2(uSimAspect, 1.0) * 28.0) - 0.5;
    fragColor = vec4(1.0, spot * step(length(f), 0.35), 0.0, 1.0);
    return;
  }

  vec2 s = texture(uState, uv).rg;
  vec2 lap = -s
    + 0.2 * (texture(uState, uv + vec2(uTexel.x, 0.0)).rg + texture(uState, uv - vec2(uTexel.x, 0.0)).rg
           + texture(uState, uv + vec2(0.0, uTexel.y)).rg + texture(uState, uv - vec2(0.0, uTexel.y)).rg)
    + 0.05 * (texture(uState, uv + uTexel).rg + texture(uState, uv - uTexel).rg
            + texture(uState, uv + vec2(uTexel.x, -uTexel.y)).rg + texture(uState, uv + vec2(-uTexel.x, uTexel.y)).rg);

  // Gentle spatial variation of the regime so mycelial branches and dividing cells coexist.
  float v = 0.5 + 0.25 * sin(uv.x * 6.0 * uSimAspect + sin(uv.y * 4.3) * 2.0) + 0.25 * sin(uv.y * 5.1 + uv.x * 2.7);
  float feed = uFeed + (v - 0.5) * 0.010;
  float kill = uKill + (v - 0.5) * 0.002;

  float a = s.x;
  float b = s.y;
  float r = a * b * b;
  float na = a + (1.0 * lap.x - r + feed * (1.0 - a)) * uDt;
  float nb = b + (0.5 * lap.y + r - (kill + feed) * b) * uDt;

  if (uSeed.z > 0.0) {
    vec2 d = (uv - uSeed.xy) * vec2(uSimAspect, 1.0);
    float m = smoothstep(uSeed.z, uSeed.z * 0.5, length(d));
    nb = mix(nb, 0.9, m);
    na = mix(na, 0.3, m);
  }
  fragColor = vec4(clamp(na, 0.0, 1.0), clamp(nb, 0.0, 1.0), 0.0, 1.0);
}
