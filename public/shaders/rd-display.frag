// MODE 2 — Reaction-Diffusion (Turing patterns): mycelial / cellular growth.
// Pulse  -> heat: drives simulation speed, feed/kill toward the mitosis regime, beats seed new cells
//           (all in output.js -> ReactionDiffusionMode).
// Audio  -> iridescent thin-film colouring of the cells.

uniform sampler2D uState;
uniform vec2 uTexel;
uniform float uHue;

void main() {
  vec2 uv = vUv;
  float b = texture(uState, uv).g;
  float a = texture(uState, uv).r;
  float bx = texture(uState, uv + vec2(uTexel.x, 0.0)).g - texture(uState, uv - vec2(uTexel.x, 0.0)).g;
  float by = texture(uState, uv + vec2(0.0, uTexel.y)).g - texture(uState, uv - vec2(0.0, uTexel.y)).g;

  vec3 n = normalize(vec3(-bx * 6.0, -by * 6.0, 1.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  float ndv = clamp(dot(n, V), 0.0, 1.0);
  float la = uTime * 0.3;
  vec3 L = normalize(vec3(cos(la), sin(la), 1.2));

  float bin = fft(clamp(b * 1.4, 0.0, 1.0));
  // Thin-film interference: hue depends on film thickness (B) and view angle, shifted by audio.
  float film = b * 2.2 + (1.0 - ndv) * 2.5 + uHue + 0.6 * uMid + 0.8 * bin;
  vec3 irid = palette(film, vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 1.0), vec3(0.0, 0.33, 0.67));
  irid *= 0.55 + 1.3 * bin + 0.4 * uBass;

  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), V), 0.0), 32.0);

  vec3 bg = mix(vec3(0.02, 0.01, 0.03), vec3(0.08, 0.04, 0.06), a);
  float cell = smoothstep(0.08, 0.32, b);
  vec3 col = mix(bg, irid * (0.35 + 0.9 * diff), cell);
  col += spec * cell * (0.4 + 1.5 * uTreble + 2.5 * uSpark);

  // Membrane edges glow with the heartbeat.
  float membrane = smoothstep(0.0, 0.25, length(vec2(bx, by))) * (1.0 - cell * 0.5);
  col += membrane * vec3(1.0, 0.45, 0.6) * (0.2 + 0.8 * uPulse * uStrength);

  col *= smoothstep(2.4, 0.5, length(aspectUv()));
  fragColor = vec4(tonemap(col), 1.0);
}
