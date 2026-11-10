# Pulse — collective heartbeat visualizer

Phones join by tapping, dancing or measuring their heartbeat with the camera. The computer plays music from any app, and a full-screen WebGL display turns the room's combined pulse and the music's spectrum into seven real-time shader worlds, with stackable FX layers on top.

```
 phones (input.html)                     server (Node/Express/Socket.io)           display (output.html)
 tap / dance / camera → BPM ──pulse 10Hz──▶ latest-sample-per-phone aggregator ──15Hz──▶ pulse uniforms ─┐
                                                                     system audio → Web Audio FFT ──┴─▶ WebGL
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

1. Open `/output.html` on the computer that drives the projector or speakers. Click **Start display**. When Chrome asks what to share, choose **Entire screen** and tick **Also share system audio**, then click **Hide** on the sharing bar. If you skip it, click the spectrum in the top-right later. Play the music from any app on that computer (Spotify, YouTube in another tab, anything); the visuals hear it through the shared system audio.
2. Phones scan the QR code on the main page (`/`) or the display's start screen, or open `/input.html` directly. They pick how to join: the experimental **Heart camera** (the default), **Tap** along to the music, or **Dance** with the phone.

To try it without phones, run `npm run simulate -- http://localhost:3000 25`. This starts 25 fake heartbeats. `npm test` runs the unit tests and a socket test with 30 clients.

## Display controls

| Key | Action |
| --- | --- |
| `1`–`7` / click | Switch visual mode (organic noise dissolve between modes). Shared with every display and phone. |
| `K` `E` `B` `R` / click | Toggle the FX layers: Kaleidoscope, Echo, Bloom, Heart Ripple. They stack and are shared too. |
| `M` / **Live beat** button | Switch between the live beat and **Manual tempo**. In manual, phones and the music are ignored and the **Tempo** slider sets the rhythm at full strength. The HUD shows where the beat comes from: phones, music, or manual. |
| **Phones** button | Host lock: cycles what phones may change between *all*, *sliders* only, and *none*. Hover over it to see the host PIN. |
| `←` `→` | Cycle modes |
| `H` | Hide the UI (it also hides itself after 3.5 s without mouse movement) |
| `F` | Fullscreen |
| `Q` / **Show QR** | Show/hide a QR code in the corner that phones can scan to join |

## Joining from a phone

The top card asks **How are you joining?** Every choice drives the same rhythm, so the coloured rings, combos and modes work with any of them.

| Choice | What it does |
| --- | --- |
| Tap (default) | Tap the big button along to the music. Each tap is a beat; the BPM is the median gap between your last few taps. |
| Dance | Uses the phone's motion sensor. How hard you move heats up the visuals (dancers' average energy is added to `uEnergy`), and sharp jolts well above your recent movement count as beats. iPhones ask for motion permission once. |
| Heart camera | The fingertip-over-camera pulse sensor. Experimental: it works on some phones only. |

A tap or dance phone that goes quiet for 3 s leaves the room until it beats again. Tap and dance phones send the same `pulse` messages as the heart sensor (BPM, confidence, beat), plus `energy` from dancers, which the server averages into `pulse:agg.motion`.

**Where the beat comes from.** The display picks, in order: phones that are sending a BPM; otherwise **the music's own beat**; otherwise the **Tempo** slider. For the music beat, the display collects the last 8 s of bass hits and tests every tempo from 70 to 180 BPM for how well the hits line up (it also checks the half-beat, so off-beat bass still counts). It only follows the song when one tempo clearly stands out and stays steady, so random noise never takes over. It then pulls the beat clock onto the song's beats. This needs an audio source on the display.

## Animation controls (phones)

Under **Animation controls**, the phone page offers the visual mode, the FX layers and these sliders. Chaos and Glow are "macro" sliders that each move several things at once (`updateControls` in `output.js`); the Chaos picture effects run in `fx-pre.frag`, Glow in `fx-final.frag`.

| Slider | Effect |
| --- | --- |
| Chaos | One big "how wild" control. Below its default it calms everything: softer beats, less breathing, less reaction to the music. Above it, beats hit harder and the whole picture starts to swirl and wobble and punch in on every beat. Past 60% the colour channels split apart on beats and bass hits. |
| Glow | Dim and grey at 0, normal at its default (20%), then brighter, more vivid and blooming up to 100%. |
| Speed | Time scale of every animation and simulation. The beat itself is not affected. |
| Colour | Turns every colour around the colour wheel. |
| Tempo (40–180 BPM) | The rhythm in Manual tempo mode, or when nobody joins and no beat is heard in the music. |

The server holds one shared set of controls (`AnimationControls` in `server.js`). Anyone can change them, from a phone or a display, and the latest change wins. Updates are clamped and rate-limited per socket, then rebroadcast as `controls:state` at up to 20 Hz. Phones send at about 15 Hz while you drag. A control you're dragging, or changed in the last 0.7 s, ignores remote updates, so two people adjusting at once don't fight under each other's fingers. **Reset** restores the defaults for everyone. Displays smooth the values, so changes glide rather than step. The first display to connect after a server start seeds the mode and FX from its saved choice, until someone changes a control.

### Host lock

The display machine is the **host**: any page opened directly on the computer that runs the server, not through the tunnel. Anyone else becomes host by tapping **For host** on the phone page and entering the **host PIN**. Guest phones only show the join options and the touch pad. On a host phone, each module (Visual, Effects, Sliders, Games, Touch pad) has a **Share** tick (only the touch pad starts shared) that hands it to every phone straight away; the server rejects changes to modules that aren't shared. Displays are not affected. The server prints the PIN at startup, and the display shows it when you hover over its lock button. The PIN is random on each start; set `HOST_PIN=123456` to choose your own. Wrong guesses are limited to one every 2 s per connection and 20 a minute across the server.

| Lock | What phones (non-hosts) can do |
| --- | --- |
| Open (default) | Everything: mode, FX, sliders, touch pad, Reset |
| Sliders only | Sliders and the touch pad |
| Locked | Nothing; they just add their heartbeat (the touch pad is off too) |

The server enforces the lock (`canChange` in `server.js`); the phone page only greys out what's not allowed. If a change is rejected, the sender gets the real state back so its controls snap back.

### Your own heartbeat

Every phone gets its own colour (golden-ratio hues, so neighbours differ). The heart icon on the phone shows it. Touch pad bursts on the display use that colour too, so people can find themselves in the visuals.

### Touch pad

The phone page has a **Touch pad**. A tap sends a burst to the same spot on the display, in your phone's colour: a ring that ripples the image as it spreads. When two or more phones tap within the same 0.45 s, their taps merge into a **combo**: a rainbow shockwave from the middle of the taps, a beat surge through the whole scene, and "COMBO ×N" on the display and the phones. More phones make a bigger shockwave.

Dragging depends on the tool picked above the pad:

- **Stir.** In Fluid Tracers and Julia Fluid, the drag pushes the fluid with the finger's speed and drops ink in your colour, so several phones mix their colours together. In the other modes it smudges the picture along the finger.
- **Paint.** Glowing strokes in your colour drawn over the visuals, fading over a few seconds.

**Hold together.** When at least half the room (2 to 8 phones) keeps a finger on the pad, the display charges up: the picture tightens, trembles and gets a rainbow aura, and the phones show the progress. Letting go releases the charge as a blast. The longer the hold, the bigger the blast. This is `CrowdHold` in `server.js`.

**Tilt to steer.** With the toggle on, tipping the phone tips the picture like a tray of liquid. In the fluid modes it pulls the fluid, and elsewhere it slides the picture. Tilt is measured from however the phone was held when it was switched on, and the display uses the average of every tilting phone.

The server rate-limits taps (about 12/s), drags (about 14/s) and tilt (about 20/s) per phone and finds combos (`TapCombos` in `server.js`). It sends `touch:fx`, `touch:combo`, `crowd:hold`, `crowd:release` and `tilt:agg`. The display draws bursts, smudges, the tilt slide and the charge in `fx-pre.frag`, and the burst colours, paint, aura and game tints in `fx-final.frag`. Stirring goes into the fluid sim itself (`touchFluid` in `output.js`).

### Games

The **Games** card starts a game for the whole room. It needs at least two phones and runs one game at a time. Anyone can start or stop a game unless the host has locked the controls.

- **Tap race.** The room splits into Red and Blue. After a 3-second countdown, each tap on the pad scores for your team for 15 seconds. The display floods with each team's colour from its side, and the border moves with the score. Phones that join mid-race go to the smaller team.
- **Pass the colour.** One phone holds the colour for a few seconds, then it moves to another phone at random. The holder's touches hit three times harder, and the display's edges glow in the holder's colour. A round lasts a minute.

The server runs both games (`TapRace` and `PassColour` in `server.js`) and sends `game:state` to everyone four times a second.

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

**Server (`server.js`).** It keeps only the latest sample from each phone and combines them on a fixed 15 Hz tick, so the work grows with the number of users (O(N)) rather than with the message rate. The combined values are a confidence-weighted BPM, the beat count, and the number of active sensors. Incoming pulses are limited to 20 Hz per socket. Payloads are clamped and validated, outbound pulse messages are `volatile`, and message compression is off.

**Sync (`public/js/sync.js`).** Clients estimate their offset from the server clock using the lowest-round-trip `time:ping` sample.

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
| Invert | — (the whole picture turns negative) | — |

**Music → Motion** (X, off by default) swaps what drives what, for every mode and layer. Off: the beat (hearts, taps, dancers) moves the picture and the sound turns the colours, with each bass hit nudging the whole palette round the wheel. On: the sound moves the picture (bass hits are the beat and also time the fluid pushes and seeds, loudness is the energy, the level sets the sway), and the phones' beat and dancing turn the colours. When swapped, only phones colour the picture, so with nobody joined the colours just drift slowly. Switching glides over about a second.

### Why the display needs system audio

The music plays in other apps, so the Web Audio API cannot read it directly. The display therefore listens to the computer's **system audio**: `getDisplayMedia` with "Entire screen" and "Also share system audio" (Chrome or Edge on Windows and ChromeOS). Only the audio is used; the screen video is requested at the lowest size and switched off. A whole-screen share has no coloured tab outline; click **Hide** on Chrome's "sharing your screen" bar. The captured audio only feeds an `AnalyserNode` and is never played a second time.

## Notes

- Mobile browsers require HTTPS before a page can use the camera (localhost is the only exception).
- Websites can turn on the camera flash only in **Chrome on Android** or **Safari on iOS 17.4+**. Firefox doesn't support it. Without a flash, hold your fingertip over the camera in front of a bright lamp. The server console logs what each phone's browser reports about its camera and flash.
