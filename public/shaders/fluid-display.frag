// MODE 3 — Fluid dynamics (framebuffer feedback): closed-eye visual tracers.
// Pulse  -> physical force splats pushing the fluid (output.js -> FluidMode).
// Audio  -> vibrant dye dropped into the liquid; display adds shimmer from the spectrum.
uniform sampler2D uDye;
uniform vec2 uTexel;

void main() {
  vec3 c = texture(uDye, vUv).rgb;
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  float lx = dot(texture(uDye, vUv + vec2(uTexel.x, 0.0)).rgb - texture(uDye, vUv - vec2(uTexel.x, 0.0)).rgb, vec3(0.333));
  float ly = dot(texture(uDye, vUv + vec2(0.0, uTexel.y)).rgb - texture(uDye, vUv - vec2(0.0, uTexel.y)).rgb, vec3(0.333));
  vec3 n = normalize(vec3(-lx * 3.0, -ly * 3.0, 1.0));
  float shade = 0.75 + 0.35 * dot(n, normalize(vec3(0.4, 0.6, 1.0)));

  vec3 col = c * shade;
  // Chromatic fringe on fast gradients mimics retinal after-images.
  col += 0.25 * vec3(abs(lx), abs(ly), abs(lx + ly)) * (0.5 + uTreble + 1.5 * uSpark);
  col += 0.03 * l * vec3(0.6, 0.3, 1.0) * uPulse * uStrength;
  col *= smoothstep(2.6, 0.6, length(aspectUv()));
  fragColor = vec4(tonemap(col), 1.0);
}
