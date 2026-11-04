/*
 * Shared client-side sync: server clock estimation + a YouTube player that is slaved to the
 * server's authoritative playback state. Used by both input.js and output.js.
 */
(function (root) {
  'use strict';

  const DRIFT_SEEK_THRESHOLD = 0.3; // seconds
  const SEEK_COOLDOWN_MS = 1500;
  const ENFORCE_INTERVAL_MS = 250;

  class TimeSync {
    constructor(socket) {
      this.socket = socket;
      this.offset = 0;
      this.rtt = 0;
      this.samples = [];
      this._timer = null;
    }

    start() {
      const burst = (n) => {
        if (n <= 0) return;
        this.ping();
        setTimeout(() => burst(n - 1), 250);
      };
      burst(6);
      clearInterval(this._timer);
      this._timer = setInterval(() => this.ping(), 15000);
      this.socket.on('connect', () => burst(4));
    }

    ping() {
      if (!this.socket.connected) return;
      const t0 = Date.now();
      this.socket.timeout(3000).emit('time:ping', t0, (err, serverNow) => {
        if (err || typeof serverNow !== 'number') return;
        const t1 = Date.now();
        const rtt = t1 - t0;
        this.samples.push({ rtt, offset: serverNow - (t0 + t1) / 2 });
        if (this.samples.length > 10) this.samples.shift();
        // Lowest-RTT sample has the least asymmetric-latency error.
        const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
        this.offset = best.offset;
        this.rtt = best.rtt;
      });
    }

    now() {
      return Date.now() + this.offset;
    }
  }

  let apiPromise = null;
  function loadYouTubeApi() {
    if (root.YT && root.YT.Player) return Promise.resolve(root.YT);
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
      const prev = root.onYouTubeIframeAPIReady;
      root.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        resolve(root.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    });
    return apiPromise;
  }

  let spotifyApiPromise = null;
  function loadSpotifyApi() {
    if (spotifyApiPromise) return spotifyApiPromise;
    spotifyApiPromise = new Promise((resolve) => {
      root.onSpotifyIframeApiReady = (api) => resolve(api);
      const s = document.createElement('script');
      s.src = 'https://open.spotify.com/embed/iframe-api/v1';
      s.async = true;
      document.head.appendChild(s);
    });
    return spotifyApiPromise;
  }

  // Spotify only reports its position a few times a second and seeks coarsely, so allow more drift.
  const SPOTIFY_DRIFT_SEEK = 0.8;
  const SPOTIFY_SEEK_COOLDOWN_MS = 2500;

  /**
   * Keeps the shared media locked to server state. The server's `media` is a YouTube video
   * (embedded YouTube player), a Spotify track (embedded Spotify player) or an uploaded file
   * (native <video> element, which also allows same-origin Web Audio analysis).
   * Options: { muted, mediaElement, spotifyElement, shield, reportSpotifyDuration,
   *            onStatus(statusObj), onBlocked(bool) }
   * The Spotify embed has no volume control, so a muted page never loads it.
   */
  class MediaSync {
    constructor(elementId, socket, timeSync, options = {}) {
      this.elementId = elementId;
      this.socket = socket;
      this.time = timeSync;
      this.opts = options;
      this.el = options.mediaElement || null;
      this.state = null;
      this.player = null;
      this.ready = false;
      this.loadedId = null;
      this.fileUrl = null;
      this.fileError = false;
      this.playPending = false;
      this.reportedDurationFor = null;
      this.lastSeek = 0;
      this.muted = !!options.muted;
      this.blockedSince = 0;
      this.blocked = false;
      this.drift = 0;
      this.errorFor = null;
      this.sp = null; // { ctl, ready, uri, state, lastPlay, lastSeek, error } once a Spotify track is loaded
      this.spWrap = options.spotifyElement || null;
      if (this.spWrap) this.spWrap.hidden = true;

      if (this.el) {
        this.el.playsInline = true;
        this.el.preload = 'auto';
        this.el.muted = this.muted;
        this.el.hidden = true;
        this.el.addEventListener('error', () => {
          if (this.el.getAttribute('src')) this.fileError = true;
          this.enforce();
        });
        // A local pause/end (user, OS media controls) is corrected right away.
        ['pause', 'ended', 'loadedmetadata'].forEach((ev) => this.el.addEventListener(ev, () => this.enforce()));
      }

      socket.on('yt:state', (s) => {
        this.state = s;
        this.enforce();
      });
      setInterval(() => this.enforce(), ENFORCE_INTERVAL_MS);
      this._init();
    }

    async _init() {
      const YT = await loadYouTubeApi();
      this.YT = YT;
      this.player = new YT.Player(this.elementId, {
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          disablekb: 1,
          playsinline: 1,
          rel: 0,
          fs: 0,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: location.origin,
        },
        events: {
          onReady: () => {
            this.ready = true;
            if (this.muted) this.player.mute();
            else this.player.unMute();
            this.enforce();
          },
          // Any local state change (user tap, end, buffering) is immediately corrected.
          onStateChange: () => this.enforce(),
          onError: (e) => {
            this.errorFor = this.loadedId;
            this._status({ kind: 'youtube', error: `YouTube can't play this video (error ${e.data}).` });
          },
        },
      });
    }

    /** Server-expected media, playback position and whether it should be playing right now. */
    expected() {
      const s = this.state;
      const media = s && (s.media || (s.videoId ? { kind: 'youtube', id: s.videoId } : null));
      if (!media) return null;
      const now = this.time.now();
      let playing = s.playing;
      let position = s.position;
      if (s.startsAt) {
        const elapsed = (now - s.startsAt) / 1000;
        playing = elapsed >= 0;
        position = Math.max(0, elapsed);
      } else if (playing) {
        position += (now - s.serverTime) / 1000;
      }
      if (s.duration > 0 && position >= s.duration) {
        position = s.duration;
        playing = false;
      }
      return {
        kind: media.kind,
        id: media.id,
        url: media.url,
        uri: media.uri,
        title: media.kind === 'youtube' ? media.id : media.title,
        mime: media.mime,
        videoId: media.kind === 'youtube' ? media.id : null,
        playing,
        position,
      };
    }

    /** 'youtube' | 'spotify' | 'file' | null */
    get kind() {
      const exp = this.expected();
      return exp ? exp.kind : null;
    }

    enforce() {
      const exp = this.expected();
      if (!exp) {
        this._pauseYouTube();
        this._pauseFile();
        this._pauseSpotify();
        this._showSurface(null);
        this._setBlocked(false);
        this._status({ kind: null, videoId: null });
        return;
      }
      if (exp.kind === 'file') {
        this._pauseYouTube();
        this._pauseSpotify();
        this._showSurface('file');
        this._enforceFile(exp);
      } else if (exp.kind === 'spotify') {
        this._pauseYouTube();
        this._pauseFile();
        this._showSurface(this.muted ? null : 'spotify');
        this._enforceSpotify(exp);
      } else {
        this._pauseFile();
        this._pauseSpotify();
        this._showSurface('youtube');
        this._enforceYouTube(exp);
      }
    }

    _showSurface(kind) {
      if (this.el) this.el.hidden = kind !== 'file';
      if (this.spWrap) this.spWrap.hidden = kind !== 'spotify';
      const iframe = this.ready && this.player.getIframe ? this.player.getIframe() : null;
      if (iframe) iframe.style.visibility = kind === 'youtube' ? 'visible' : 'hidden';
      // If Spotify won't start on its own, its own play button must be tappable.
      if (this.opts.shield) this.opts.shield.style.pointerEvents = kind === 'spotify' && this.blocked ? 'none' : '';
    }

    _pauseSpotify() {
      const sp = this.sp;
      if (sp && sp.ready && sp.state && !sp.state.isPaused) sp.ctl.pause();
    }

    /** Creates the Spotify embed on first use; later tracks reuse it via loadUri. */
    _initSpotify(exp) {
      if (this.sp || !this.spWrap) return;
      const sp = { ctl: null, ready: false, uri: exp.uri, state: null, lastPlay: 0, lastSeek: 0, error: null };
      this.sp = sp;
      const host = document.createElement('div');
      this.spWrap.appendChild(host);
      loadSpotifyApi().then((api) => {
        const startAt = Math.floor(this.expected() ? this.expected().position : 0);
        api.createController(host, { uri: exp.uri, width: '100%', height: '100%', theme: 'dark', startAt }, (ctl) => {
          sp.ctl = ctl;
          ctl.addListener('ready', () => {
            sp.ready = true;
            this.enforce();
          });
          ctl.addListener('playback_update', (e) => {
            const d = (e && e.data) || e || {};
            sp.ready = true;
            sp.state = {
              isPaused: !!d.isPaused,
              isBuffering: !!d.isBuffering,
              position: (d.position || 0) / 1000,
              duration: (d.duration || 0) / 1000,
              at: performance.now(),
            };
          });
          ctl.addListener('error', () => {
            sp.error = sp.uri;
            this.enforce();
          });
        });
      });
    }

    /** Rebuilds the Spotify embed, e.g. after logging in to Spotify in another tab. */
    reloadSpotify() {
      if (!this.sp) return;
      try { if (this.sp.ctl) this.sp.ctl.destroy(); } catch (_) { /* ignore */ }
      this.sp = null;
      if (this.spWrap) this.spWrap.textContent = '';
      this.enforce();
    }

    _enforceSpotify(exp) {
      if (this.muted) {
        // No volume control on the embed: a muted page leaves Spotify to the display.
        this._pauseSpotify();
        this._setBlocked(false);
        this.drift = 0;
        this._status({ ...exp, note: 'Spotify is playing on the display. Turn sound on to listen here too.' });
        return;
      }
      if (!this.spWrap) {
        this._status({ ...exp, error: 'This page cannot play Spotify.' });
        return;
      }
      this._initSpotify(exp);
      const sp = this.sp;
      if (!sp.ready) {
        this._status({ ...exp, note: 'Loading Spotify…' });
        return;
      }
      const nowMs = performance.now();
      if (sp.uri !== exp.uri) {
        sp.uri = exp.uri;
        sp.state = null;
        sp.error = null;
        sp.lastSeek = nowMs;
        sp.ctl.loadUri(exp.uri, false, Math.floor(exp.position));
        return;
      }
      if (sp.error === exp.uri) {
        this._setBlocked(false);
        this._status({ ...exp, error: 'Spotify can\'t play this track here.' });
        return;
      }
      const st = sp.state;
      // Spotify plays 30 s previews when not logged in, so only trusted pages report the length.
      if (this.opts.reportSpotifyDuration && st && st.duration > 31) this._reportDuration(exp.id, st.duration);
      const cur = st ? st.position + (st.isPaused || st.isBuffering ? 0 : (nowMs - st.at) / 1000) : 0;

      // Past the end of what Spotify lets this browser play (a 30 s preview when logged out):
      // stay quiet instead of restarting the preview over and over.
      if (exp.playing && st && st.duration > 0 && exp.position >= st.duration - 0.5) {
        if (!st.isPaused) sp.ctl.pause();
        this._setBlocked(false);
        this.drift = 0;
        const preview = st.duration <= 31;
        this._status({
          ...exp,
          previewEnded: preview,
          note: preview ? 'Spotify preview ended. Log in to Spotify in this browser for full songs.' : undefined,
        });
        return;
      }

      if (exp.playing) {
        if (!st || st.isPaused) {
          if (nowMs - sp.lastPlay > 1500) {
            sp.lastPlay = nowMs;
            if (st && Math.abs(cur - exp.position) > 1) sp.ctl.seek(exp.position);
            if (st && st.position > 0) sp.ctl.resume();
            else sp.ctl.play();
            if (!this.blockedSince) this.blockedSince = nowMs;
          }
        } else {
          this.blockedSince = 0;
        }
        this._setBlocked(this.blockedSince > 0 && nowMs - this.blockedSince > 3000);
        this.drift = st && !st.isPaused ? cur - exp.position : 0;
        if (st && !st.isPaused && !st.isBuffering && Math.abs(this.drift) > SPOTIFY_DRIFT_SEEK && nowMs - sp.lastSeek > SPOTIFY_SEEK_COOLDOWN_MS) {
          sp.lastSeek = nowMs;
          sp.ctl.seek(exp.position + 0.25);
        }
      } else {
        this.blockedSince = 0;
        this._setBlocked(false);
        if (st && !st.isPaused) sp.ctl.pause();
        if (st && Math.abs(cur - exp.position) > 1 && nowMs - sp.lastSeek > SPOTIFY_SEEK_COOLDOWN_MS) {
          sp.lastSeek = nowMs;
          sp.ctl.seek(exp.position);
        }
        this.drift = 0;
      }
      this._status({ ...exp, drift: this.drift });
    }

    _pauseYouTube() {
      if (!this.ready || !this.player || !this.player.getPlayerState) return;
      const st = this.player.getPlayerState();
      if (st === this.YT.PlayerState.PLAYING || st === this.YT.PlayerState.BUFFERING) this.player.pauseVideo();
    }

    _pauseFile() {
      if (this.el && !this.el.paused) this.el.pause();
    }

    _reportDuration(id, dur) {
      if (dur > 0 && Number.isFinite(dur) && this.reportedDurationFor !== id) {
        this.reportedDurationFor = id;
        this.socket.emit('yt:duration', { id, videoId: id, duration: dur });
      }
    }

    _enforceFile(exp) {
      const el = this.el;
      if (!el) {
        this._status({ ...exp, error: 'This page cannot play uploaded media.' });
        return;
      }
      const nowMs = performance.now();
      if (this.fileUrl !== exp.url) {
        this.fileUrl = exp.url;
        this.fileError = false;
        this.lastSeek = 0;
        el.src = exp.url;
        el.load();
      }
      if (this.fileError) {
        this._setBlocked(false);
        this._status({ ...exp, error: "This browser can't play the uploaded file's format." });
        return;
      }
      el.muted = this.muted;
      this._reportDuration(exp.id, el.duration);
      const cur = el.currentTime || 0;
      const canSeek = el.readyState >= 1 && nowMs - this.lastSeek > SEEK_COOLDOWN_MS;

      if (exp.playing) {
        if (el.paused && !this.playPending) {
          this.playPending = true;
          el.play()
            .then(() => {
              this.playPending = false;
              this._setBlocked(false);
            })
            .catch((err) => {
              this.playPending = false;
              // Autoplay policies may refuse playback until the user taps once.
              if (err && err.name === 'NotAllowedError') this._setBlocked(true);
            });
        }
        this.drift = el.paused ? 0 : cur - exp.position;
        const off = Math.abs(cur - exp.position);
        if (canSeek && off > (el.paused ? 1 : DRIFT_SEEK_THRESHOLD)) {
          this.lastSeek = nowMs;
          el.currentTime = exp.position + (el.paused ? 0 : 0.05);
        }
      } else {
        this._setBlocked(false);
        if (!el.paused) el.pause();
        if (canSeek && Math.abs(cur - exp.position) > 0.5) {
          this.lastSeek = nowMs;
          el.currentTime = exp.position;
        }
        this.drift = 0;
      }
      this._status({ ...exp, drift: this.drift });
    }

    _enforceYouTube(exp) {
      if (!this.ready || !this.player || !this.player.getPlayerState) return;
      const P = this.YT.PlayerState;

      if (exp.videoId !== this.loadedId) {
        this.loadedId = exp.videoId;
        this.lastSeek = performance.now();
        if (exp.playing) this.player.loadVideoById({ videoId: exp.videoId, startSeconds: exp.position });
        else this.player.cueVideoById({ videoId: exp.videoId, startSeconds: exp.position });
        return;
      }
      if (this.errorFor === exp.videoId) {
        this._setBlocked(false);
        this._status({ ...exp, error: "YouTube can't play this video (embedding disabled or unavailable)." });
        return;
      }

      const st = this.player.getPlayerState();
      const cur = this.player.getCurrentTime() || 0;
      const nowMs = performance.now();
      this._reportDuration(exp.videoId, this.player.getDuration ? this.player.getDuration() : 0);

      if (exp.playing) {
        if (st !== P.PLAYING && st !== P.BUFFERING) {
          this.player.playVideo();
          if (!this.blockedSince) this.blockedSince = nowMs;
        } else {
          this.blockedSince = 0;
        }
        // Autoplay policies may refuse playback until the user taps once.
        this._setBlocked(this.blockedSince > 0 && nowMs - this.blockedSince > 2000);

        if (st === P.PLAYING) {
          this.drift = cur - exp.position;
          if (Math.abs(this.drift) > DRIFT_SEEK_THRESHOLD && nowMs - this.lastSeek > SEEK_COOLDOWN_MS) {
            this.lastSeek = nowMs;
            // Small lead compensates for the time the seek itself takes.
            this.player.seekTo(exp.position + 0.12, true);
          }
        }
      } else {
        this.blockedSince = 0;
        this._setBlocked(false);
        if (st === P.PLAYING || st === P.BUFFERING) this.player.pauseVideo();
        if (Math.abs(cur - exp.position) > 0.5 && nowMs - this.lastSeek > SEEK_COOLDOWN_MS && st !== P.ENDED) {
          this.lastSeek = nowMs;
          this.player.seekTo(exp.position, true);
        }
        this.drift = 0;
      }
      this._status({ ...exp, drift: this.drift });
    }

    /** Call from a user gesture to satisfy autoplay policies. */
    unlock() {
      const exp = this.expected();
      if (this.el && exp && exp.kind === 'file' && exp.playing) {
        this.el.muted = this.muted;
        this.el.play().catch(() => {});
      }
      if (this.ready) {
        if (!this.muted) this.player.unMute();
        if (exp && exp.kind === 'youtube' && exp.playing) this.player.playVideo();
      }
      if (this.sp && this.sp.ready && !this.muted && exp && exp.kind === 'spotify' && exp.playing) this.sp.ctl.resume();
      this.blockedSince = 0;
      this._setBlocked(false);
      this.enforce();
    }

    setMuted(m) {
      this.muted = m;
      if (this.el) this.el.muted = m;
      if (m) this._pauseSpotify();
      if (this.ready) {
        if (m) this.player.mute();
        else this.player.unMute();
      }
      this.enforce();
    }

    _setBlocked(b) {
      if (b === this.blocked) return;
      this.blocked = b;
      const exp = this.expected();
      if (exp && exp.kind === 'spotify') this._showSurface(this.muted ? null : 'spotify');
      if (this.opts.onBlocked) this.opts.onBlocked(b);
    }

    _status(s) {
      if (this.opts.onStatus) this.opts.onStatus(s);
    }
  }

  /**
   * Uploads an audio/video file to the server, which then plays it in sync everywhere.
   * Uses XHR for upload progress. Resolves with the server's JSON reply.
   */
  function uploadMedia(file, onProgress, hostPin) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name || 'media'));
      if (hostPin) xhr.setRequestHeader('X-Host-Pin', hostPin);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch (_) {
          /* non-JSON (e.g. proxy error page) */
        }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.ok) resolve(body);
        else reject(new Error((body && body.error) || (xhr.status === 413 ? 'File too large (max 100 MB).' : `Upload failed (${xhr.status}).`)));
      };
      xhr.onerror = () => reject(new Error('Upload failed — network error.'));
      xhr.send(file);
    });
  }

  /**
   * Notices when the server runs different code from the one this page started with: it calls
   * onStale('updated') after a restart with new code, or onStale('outdated') when the server is
   * too old to report its build at all.
   */
  function watchServerBuild(socket, onStale) {
    let build = null;
    let timer = null;
    socket.on('server:info', (info) => {
      clearTimeout(timer);
      if (!info || !info.build) return;
      if (build && info.build !== build) onStale('updated');
      if (!build) build = info.build;
    });
    socket.on('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.connected && onStale('outdated'), 5000);
    });
  }

  /** Fixed banner at the top of the page; `action` adds a button. Replaces any previous banner. */
  function showBanner(text, action) {
    let el = document.getElementById('serverBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'serverBanner';
      el.className = 'server-banner';
      el.setAttribute('role', 'alert');
      document.body.appendChild(el);
    }
    el.textContent = text;
    if (action) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = action.label;
      b.addEventListener('click', action.run);
      el.appendChild(b);
    }
  }

  const STALE_TEXT = {
    updated: 'The server was restarted with new code. Reload to get the latest version.',
    outdated: 'The server is running old code. Restart it (npm run tunnel) to get the latest features.',
  };

  /**
   * YouTube / Spotify switch for a link form. `buttons` are elements with data-source; the
   * choice is remembered per browser. Returns a getter for the current source.
   */
  function sourcePicker(buttons, input, onChange) {
    const PLACEHOLDER = { youtube: 'Paste a YouTube link', spotify: 'Paste a Spotify song link' };
    let source = 'youtube';
    try { if (localStorage.getItem('pulse.source') === 'spotify') source = 'spotify'; } catch (_) { /* ignore */ }
    const apply = () => {
      buttons.forEach((b) => {
        b.classList.toggle('active', b.dataset.source === source);
        b.setAttribute('aria-pressed', String(b.dataset.source === source));
      });
      input.placeholder = PLACEHOLDER[source];
      if (onChange) onChange(source);
    };
    buttons.forEach((b) =>
      b.addEventListener('click', () => {
        source = b.dataset.source;
        try { localStorage.setItem('pulse.source', source); } catch (_) { /* ignore */ }
        apply();
      })
    );
    // Pasting an obvious link of the other kind switches for you.
    input.addEventListener('input', () => {
      const v = input.value;
      const guess = /spotify\.com|^spotify:/i.test(v) ? 'spotify' : /youtu\.?be/i.test(v) ? 'youtube' : null;
      if (guess && guess !== source) {
        source = guess;
        apply();
      }
    });
    apply();
    return () => source;
  }

  root.TimeSync = TimeSync;
  root.MediaSync = MediaSync;
  root.sourcePicker = sourcePicker;
  root.uploadMedia = uploadMedia;
  root.watchServerBuild = watchServerBuild;
  root.showBanner = showBanner;
  root.STALE_TEXT = STALE_TEXT;
})(window);