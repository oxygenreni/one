# Pulse — collective heartbeat visualizer

Phones measure their users' heartbeats with the camera. A YouTube track plays in sync on every screen. A full-screen WebGL display turns the room's combined pulse and the music's spectrum into seven real-time shader worlds, with stackable FX layers on top.

```
 phones (input.html)                server (Node/Express/Socket.io)            display (output.html)
 camera → PPG → BPM ──pulse 10Hz──▶ latest-sample-per-phone aggregator ──15Hz──▶ pulse uniforms ─┐
 YouTube URL ────────yt:submit────▶ authoritative playback clock ──yt:state──▶ YouTube player   │
 YouTube player ◀───yt:state 2s────┘   (+ time:ping clock sync)                  │ tab audio    ▼
                                                                                 └─▶ Web Audio FFT → WebGL
```

## Run

```bash
npm install
npm run tunnel         # recommended: public HTTPS address for phones, valid certificate, no warnings
npm start              # http://localhost:3000  (camera only works on localhost)
npm run start:https    # https://<LAN-IP>:8443 with a self-signed certificate
```

`npm run tunnel` starts a free [Cloudflare quick tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) (no account needed). It prints an `https://<random>.trycloudflare.com/input.html` address, and the QR codes switch to it automatically. Phones can join from any network, including mobile data. The address changes every time the tunnel starts, and anyone with the link can join. Put `cloudflared.exe` in `.tools/`, or install it on your `PATH`, or set the `CLOUDFLARED` environment variable to its location.

Chrome on Android often fails on self-signed certificates with `ERR_TOO_MANY_RETRIES` (Chromium issue 40418163). Use the tunnel for parties rather than `start:https`. With `start:https`, the server generates a self-signed certificate in `.cert/` the first time it runs, and each phone has to accept the browser warning once. You can supply your own certificate with `SSL_KEY=… SSL_CERT=…`. Set `PORT` to change the port.

1. Open `/output.html` on the computer that drives the projector or speakers. Click **Start display**. When Chrome asks what to share, choose **this tab** and turn on **Share tab audio**.
2. Phones scan the QR code on the main page (`/`) or the display's start screen, or open `/input.html` directly. They tap **Start pulse sensor** and cover the rear camera and flash with a fingertip.
3. Anyone can paste a YouTube or Spotify link (see [Spotify](#spotify)), or **upload an audio or video file** (up to 100 MB). Every player loads it and follows the server clock. Uploads are kept in `uploads/`; only the 20 newest are kept.

To try it without phones, run `npm run simulate -- http://localhost:3000 25`. This starts 25 fake heartbeats. `npm test` runs the unit tests and a socket test with 30 clients.

## Display controls

| Key | Action |
| --- | --- |
| `1`–`7` / click | Switch visual mode (organic noise dissolve between modes). Shared with every display and phone. |
| `K` `E` `B` `R` `T` / click | Toggle the FX layers: Kaleidoscope, Echo, Bloom, Heart Ripple, Hearts. They stack and are shared too. |
| `M` / **♥ Live beat** button | Switch between the live beat and **Manual tempo**. In manual, phones and the music are ignored and the **Tempo** slider sets the rhythm at full strength. The HUD shows where the beat comes from: phones, ♪ music, or manual. |
| **🔓 Phones** button | Host lock: cycles what phones may change between *all*, *sliders* only, and *none*. Hover over it to see the host PIN. |
| `←` `→` | Cycle modes |
| `H` | Hide the UI (it also hides itself after 3.5 s without mouse movement) |
| `F` | Fullscreen |
| `V` | Collapse the video. Playback keeps going. |
| `P` | Play/pause for everyone |
| `Q` | Show/hide a QR code in the corner that phones can scan to join |

## Joining from a phone

The top card asks **How are you joining?** Every choice drives the same rhythm, so the coloured rings, combos and modes work with any of them.

| Choice | What it does |
| --- | --- |
| 👆 Tap (default) | Tap the big button along to the music. Each tap is a beat; the BPM is the median gap between your last few taps. |
| 💃 Dance | Uses the phone's motion sensor. How hard you move heats up the visuals (dancers' average energy is added to `uEnergy`), and sharp jolts well above your recent movement count as beats. iPhones ask for motion permission once. |
| ♥ Heart camera | The fingertip-over-camera pulse sensor. Experimental: it works on some phones only. |

A tap or dance phone that goes quiet for 3 s leaves the room until it beats again. Tap and dance phones send the same `pulse` messages as the heart sensor (BPM, confidence, beat), plus `energy` from dancers, which the server averages into `pulse:agg.motion`.

**Where the beat comes from.** The display picks, in order: phones that are sending a BPM; otherwise **the music's own beat**; otherwise the **Tempo** slider. For the music beat, the display collects the last 8 s of bass hits and tests every tempo from 70 to 180 BPM for how well the hits line up (it also checks the half-beat, so off-beat bass still counts). It only follows the song when one tempo clearly stands out and stays steady, so random noise never takes over. It then pulls the beat clock onto the song's beats. This needs an audio source on the display.

## Animation controls (phones)

Under **Animation controls**, the phone page offers the visual mode, the FX layers and these sliders:

| Slider | Effect |
| --- | --- |
| Tempo (40–180 BPM) | The rhythm when heartbeat mode is off or nobody is sensing. It replaces the old fixed 62 BPM idle. |
| Beat intensity | How hard each beat hits (`uBeat`, `uPulse`) |
| Heat | Shifts the energy value calmer or wilder |
| Breathing | Depth of the inhale/exhale motion |
| Motion speed | Time scale of every animation and simulation. The heartbeat itself is not affected. |
| Audio reactivity | Gain on the FFT bands and onset detection. 0 ignores the music. |
| Colour shift | Rotates the hue of the final image |

The server holds one shared set of controls (`AnimationControls` in `server.js`). Anyone can change them, from a phone or a display, and the latest change wins. Updates are clamped and rate-limited per socket, then rebroadcast as `controls:state` at up to 20 Hz. Phones send at about 15 Hz while you drag. A control you're dragging, or changed in the last 0.7 s, ignores remote updates, so two people adjusting at once don't fight under each other's fingers. **Reset** restores the defaults for everyone. Displays smooth the values, so changes glide rather than step. The first display to connect after a server start seeds the mode and FX from its saved choice, until someone changes a control.

### Host lock

The display machine is the **host**: any page opened directly on the computer that runs the server, not through the tunnel. Anyone else becomes host by tapping **I'm the host** on the phone page and entering the **host PIN**. The server prints the PIN at startup, and the display shows it when you hover over its lock button. The PIN is random on each start; set `HOST_PIN=123456` to choose your own. Wrong guesses are limited to one every 2 s per connection and 20 a minute across the server.

| Lock | What phones (non-hosts) can do |
| --- | --- |
| Open (default) | Everything: mode, FX, sliders, touch pad, Reset, links, uploads, play/pause |
| Sliders only | Sliders and the touch pad |
| Locked | Nothing; they just add their heartbeat (the touch pad is off too) |

The server enforces the lock (`canChange` in `server.js`); the phone page only greys out what's not allowed. If a change is rejected, the sender gets the real state back so its controls snap back.

### Your own heartbeat

Every phone gets its own colour (golden-ratio hues, so neighbours differ). The heart icon on the phone shows it. On the display, each phone with a good signal has a glowing dot in that colour, and each of its beats sends out a ring from it. This is the **Hearts** FX layer, on by default and limited to 32 at once. The server forwards per-phone beat counts in `pulse:agg` as `hearts: [[n, hue, beats, confidence], …]`. The rings are drawn last in `fx-final.frag`, after the colour shift, so each phone's colour matches what it shows.

### Touch pad

The phone page has a **Touch pad**. A tap sends a burst to the same spot on the display, in your phone's colour: a ring that ripples the image as it spreads. Dragging leaves a trail of smaller sparks. When two or more phones tap within the same 0.45 s, their taps merge into a **combo**: a rainbow shockwave from the middle of the taps, a beat surge through the whole scene, and "COMBO ×N" on the display and the phones. More phones make a bigger shockwave.

The server rate-limits taps (about 12/s) and sparks (about 14/s) per phone and finds combos (`TapCombos` in `server.js`). It sends `touch:fx` and `touch:combo` to the displays, which draw up to 32 bursts at once in `fx-pre.frag` (the ripple) and `fx-final.frag` (the colour). Bursts show in every mode, with or without other FX.

### Spotify

Both link boxes (phone and display) have a **YouTube / Spotify** switch. Pasting an obvious link of the other kind flips it for you. Spotify links must be a single **song** (or podcast episode), from Share → Copy song link. Albums and playlists are refused, because Spotify would move to the next track on its own and break the sync. The server looks up the song title through Spotify's public oEmbed endpoint.

- **Log in to Spotify in the display's browser.** The embedded player plays full songs only for a logged-in browser, otherwise 30-second previews. When a preview runs out, the display says so and stays quiet instead of looping.
- **Phones don't play Spotify while muted.** The embed has no volume control, so a muted phone shows the title and leaves the sound to the display. Turning sound on loads the player on that phone. It needs a Spotify login for full songs too.
- **Sound for the visuals:** Spotify's audio is copy-protected and comes from another site, so the page can't analyse it directly. Use **Virtual cable** or **Input device → Stereo Mix** on the display. Tab audio may work but isn't guaranteed. If a Spotify song is playing and the display hears nothing for 4 s, a yellow hint appears next to the spectrum.
- Sync is looser than YouTube's: Spotify reports its position less often and seeks coarsely, so it corrects only when it drifts more than 0.8 s.
- Only displays report a Spotify song's length to the server, and only if it's longer than a preview, so a logged-out phone can't cut the song short for everyone.

### Out-of-date server warning

At startup the server fingerprints its own code and the pages (`computeBuildId`) and sends the fingerprint to every page when it connects. If the server restarts with different code, open phones reload themselves, unless the pulse sensor is running, in which case they show a **Reload** banner. Displays always show the banner, because a reload would drop the audio capture. A server too old to send a fingerprint gets a "restart it" banner.

## How it works

**PPG (`public/js/pulse-detector.js`).** Each frame is drawn into a hidden 32×24 canvas, which averages the image on the GPU. The detector then takes the mean red channel and checks whether a fingertip covers the lens (the frame is bright and strongly red). The signal is cleaned up in stages:

- two high-pass stages remove drift from auto-exposure and finger pressure
- a low-pass stage smooths it, and the signal is inverted and normalised to its envelope
- beats are picked with hysteresis and a refractory period
- the BPM is the median of the last 8 beat-to-beat intervals, with outlier rejection
- confidence comes from how regular those intervals are

When the hardware allows it, the flash (torch) is turned on and a wake lock keeps the screen on.

**Server (`server.js`).** It keeps only the latest sample from each phone and combines them on a fixed 15 Hz tick, so the work grows with the number of users (O(N)) rather than with the message rate. The combined values are a confidence-weighted BPM, the beat count, and the number of active sensors. Incoming pulses are limited to 20 Hz per socket. Payloads are clamped and validated, outbound pulse messages are `volatile`, and message compression is off. The playback clock is authoritative: `videoId`, `position`, `playing`, `serverTime`, and a 1.5 s lead-in so everyone can buffer. It is broadcast on every change and every 2 s.

**Sync (`public/js/sync.js`).** Clients estimate their offset from the server clock using the lowest-round-trip `time:ping` sample. Every 250 ms, `YouTubeSync` checks the player against the server:

- it re-asserts play or pause, which undoes any local pause, end, or tap
- it hard-seeks if the player drifts more than 0.3 s
- a transparent shield over the iframe blocks local control
- if autoplay is blocked, it shows a "Tap to sync" button

**Display (`public/js/output.js`, `public/shaders/`).** Built on WebGL2. Each pass draws one fullscreen triangle. Uniform types are read from the compiled program. Ping-pong render targets use float or half-float formats. Pulse values reach the shaders through these uniforms:

- `uBpm`
- `uPulse`: a "lub-dub" waveform
- `uBeat`: a decaying impulse
- `uBreath`: inhale and exhale, 4 beats per breath
- `uEnergy`
- `uStrength`: how much real sensor data is present

A local oscillator runs at the room's BPM, and real beats from phones nudge its phase. That keeps a steady rhythm even when 30 hearts are out of phase. With no phones connected, or with heartbeat mode off, it runs at the Tempo control (default 62 BPM). Audio reaches the shaders as `uBass`, `uMid`, `uTreble`, `uLevel` and `uOnset`, plus a 64-bin log-spaced FFT texture `uFFT`. A slow automatic gain control keeps quiet and loud tracks equally lively. Render resolution adapts to keep the frame rate smooth.

| Mode | Pulse → | Audio FFT → |
| --- | --- | --- |
| Domain Warp (simplex fBm) | warp amplitude, warp speed, inhale/exhale zoom | palette phase shift, glowing veins, spores |
| Reaction-Diffusion (Gray-Scott) | heat: simulation steps per frame, moves from coral/mycelium toward mitosis, beats seed new cells | iridescent thin-film colouring of the cells |
| Fluid Tracers (stable fluids + vorticity) | each beat pushes the fluid from rotating emitters, a breathing "lung" at the centre | onsets drop vivid dye coloured by the strongest band |
| Julia Set | the `c` constant orbits, breathes and folds on beats | bass drives contrast and lighting, treble the highlights, mids the hue |
| Mandelbrot | zoom speed (surges on beats). The zoom heads for a self-similar (Misiurewicz) point: once deep enough, it steps back by exactly one repeat of the pattern, so it zooms in forever with no cut. Pixels are computed relative to that point's orbit, so precision never runs out | each colour band is lit by its own FFT bin |
| Julia Fluid (Julia set + stable fluids) | moves the `c` constant, and beats push the fluid, whose currents warp the fractal | the fractal's edge sheds rainbow ink into the fluid (more with louder music), onsets drop dye |
| Fractal Flight (ray-marched 3D Apollonian fractal) | camera speed (relative to the open space around it, so the flow stays smooth), and the geometry slowly "breathes" with the room. The camera looks ahead for open space and turns at a capped rate | surface colour bands come from FFT bins, bass pumps the glow in the gaps, treble adds highlights |

**FX layers** form a post-processing chain: scene, then kaleidoscope and ripple, then echo, then bloom, then the screen. They work on any mode, and when all are off the chain is skipped entirely.

| Layer | Pulse → | Audio → |
| --- | --- | --- |
| Kaleidoscope | 6, 8 or 10 slices as the room heats up, and the slices breathe | — |
| Echo (video feedback) | trail length follows the heart rate, and beats surge the zoom | bass adds zoom, treble adds a hue drift on the trails |
| Bloom | beats flash the glow | louder music lowers the threshold and raises the glow |
| Heart Ripple | every heartbeat sends out a shockwave ring | — |

### Why the display needs an audio source

The YouTube player is a cross-origin iframe, so the Web Audio API cannot read its audio directly. The display offers these sources. Each one feeds only an `AnalyserNode` and is not played a second time:

| Source | How | Trade-off |
| --- | --- | --- |
| **Uploaded file** | Automatic. Uploaded audio or video is served from this server, so the display analyses it directly with `createMediaElementSource`. | None: no prompt, no indicator, exact audio. Overrides the source below while a file is playing. |
| **Tab audio** | `getDisplayMedia` captures this tab. Choose the tab and enable "Share tab audio". | Chrome draws a coloured outline around the shared tab. A page cannot remove it. |
| **System audio** | Choose "Entire screen" and tick "Also share system audio" (Windows and ChromeOS). | No tab outline. Click **Hide** on Chrome's "sharing your screen" bar. |
| **Virtual cable** | The display finds a VB-Audio, VoiceMeeter or BlackHole recording device automatically. | Exact PC audio with no prompt and no indicator. Needs a one-time install (see below). |
| **Input device** | Uses `getUserMedia` with a device you choose. | No prompt after the first time. With **Stereo Mix** it hears exactly what the PC plays. A microphone hears the room's speakers instead. |

To get Stereo Mix on Windows, open **Sound settings → More sound settings → Recording**. Right-click the list and choose **Show Disabled Devices**, then enable **Stereo Mix**. If your sound driver doesn't offer it, install the free [VB-Audio Virtual Cable](https://vb-audio.com/Cable/). Set **CABLE Input** as Chrome's or Windows' audio output, and in **CABLE Output → Properties → Listen**, tick "Listen to this device" so you still hear it. The display automatically selects loopback devices and remembers your source and device.

## Notes

- Phones start **muted** by default, so 30 phones don't echo each other. Each person can turn sound on.
- Mobile browsers require HTTPS before a page can use the camera (localhost is the only exception).
- Websites can turn on the camera flash only in **Chrome on Android** or **Safari on iOS 17.4+**. Firefox doesn't support it. Without a flash, hold your fingertip over the camera in front of a bright lamp. The **Camera diagnostics** section on the phone page shows what the browser reports, and the server console logs the same information.
- Some videos don't allow embedding. Players report this, and you can submit another link.
