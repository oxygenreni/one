// FX: video feedback ("echo"). Each frame keeps a decayed, slightly zoomed/rotated copy of the
// previous output, producing tracer trails like a camera filming its own screen.
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform float uDecay;
uniform float uZoom;
uniform float uRot;
uniform float uHueShift;

void main() {
  vec2 asp = vec2(uRes.x / uRes.y, 1.0);
  vec2 q = (vUv - 0.5) * asp;
  q = rot(uRot) * q / uZoom;
  vec3 prev = texture(uPrev, q / asp + 0.5).rgb * uDecay;
  prev = mix(prev, prev.brg, uHueShift);        // trails slowly cycle hue as they fade
  vec3 cur = texture(uSrc, vUv).rgb;
  fragColor = vec4(max(cur, prev), 1.0);
}