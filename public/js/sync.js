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


  /**
   * Keeps the shared media locked to server state. The server's `media` is either a YouTube
   * video (played in an embedded YouTube player) or an uploaded file (played in a native
   * <video> element, which also allows same-origin Web Audio analysis).
   * Options: { muted, mediaElement, onStatus(statusObj), onBlocked(bool) }
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
        title: media.kind === 'file' ? media.title : media.id,
        mime: media.mime,
        videoId: media.kind === 'youtube' ? media.id : null,
        playing,
        position,
      };
    }

    /** 'youtube' | 'file' | null */
    get kind() {
      const exp = this.expected();
      return exp ? exp.kind : null;
    }

    enforce() {
      const exp = this.expected();
      if (!exp) {
        this._pauseYouTube();
        this._pauseFile();
        this._showSurface(null);
        this._setBlocked(false);
        this._status({ kind: null, videoId: null });
        return;
      }
      if (exp.kind === 'file') {
        this._pauseYouTube();
        this._showSurface('file');
        this._enforceFile(exp);
      } else {
        this._pauseFile();
        this._showSurface('youtube');
        this._enforceYouTube(exp);
      }
    }

    _showSurface(kind) {
      if (this.el) this.el.hidden = kind !== 'file';
      const iframe = this.ready && this.player.getIframe ? this.player.getIframe() : null;
      if (iframe) iframe.style.visibility = kind === 'youtube' ? 'visible' : 'hidden';
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
      this.blockedSince = 0;
      this._setBlocked(false);
      this.enforce();
    }

    setMuted(m) {
      this.muted = m;
      if (this.el) this.el.muted = m;
      if (!this.ready) return;
      if (m) this.player.mute();
      else this.player.unMute();
    }

    _setBlocked(b) {
      if (b === this.blocked) return;
      this.blocked = b;
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

  root.TimeSync = TimeSync;
  root.MediaSync = MediaSync;
  root.uploadMedia = uploadMedia;
  root.watchServerBuild = watchServerBuild;
  root.showBanner = showBanner;
  root.STALE_TEXT = STALE_TEXT;
})(window);