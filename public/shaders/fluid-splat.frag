// Gaussian splat used for both pulse forces (velocity) and audio dye drops.
uniform sampler2D uTarget;
uniform vec2 uPoint;
uniform vec3 uColor;
uniform float uRadius;
uniform float uAspect;

void main() {
  vec2 p = vUv - uPoint;
  p.x *= uAspect;
  vec3 splat = exp(-dot(p, p) / uRadius) * uColor;
  fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}
