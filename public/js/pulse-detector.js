/*
 * Photoplethysmography (PPG) pulse detector.
 * Feed it the mean red-channel intensity of each camera frame (fingertip over lens + flash).
 * Pipeline: EMA detrend (high-pass) -> EMA smoothing (low-pass) -> invert -> envelope
 * normalisation -> hysteresis peak detection with refractory period -> median inter-beat interval.
 */
(function (root) {
  'use strict';

  const MIN_IBI = 60 / 200; // 200 BPM
  const MAX_IBI = 60 / 40;  // 40 BPM
  const WARMUP_S = 1.5;

  function median(arr) {
    const s = arr.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  class PulseDetector {
    constructor() {
      this.reset();
    }

    reset() {
      this.lastT = null;
      this.base = null;
      this.base2 = 0;
      this.lp = 0;
      this.env = 1e-3;
      this.signal = 0;
      this.prevSignal = 0;
      this.armed = false;
      this.peakVal = 0;
      this.peakT = 0;
      this.lastPeakT = -Infinity;
      this.ibis = [];
      this.rejectStreak = 0;
      this.bpm = 0;
      this.confidence = 0;
      this.contactSince = null;
      this.pendingBeat = false;
      this.beatCount = 0;
    }

    /**
     * @param {number} value mean red intensity (0-255)
     * @param {number} tMs timestamp in milliseconds
     * @param {boolean} [contact=true] whether a fingertip appears to cover the lens
     */
    addSample(value, tMs, contact = true) {
      const t = tMs / 1000;
      if (!contact || !Number.isFinite(value)) {
        if (this.contactSince !== null) this.reset();
        return this.signal;
      }
      if (this.contactSince === null) this.contactSince = t;

      if (this.lastT === null || t <= this.lastT || t - this.lastT > 0.5) {
        // First sample or a gap in the stream: re-seed filters without counting a beat.
        this.lastT = t;
        this.base = value;
        this.base2 = 0;
        this.lp = 0;
        return this.signal;
      }
      const dt = t - this.lastT;
      this.lastT = t;

      // Two cascaded high-pass stages: a single EMA detrend leaves a constant offset on
      // linear drift (auto-exposure, finger pressure); the second stage removes it.
      this.base += (value - this.base) * (1 - Math.exp(-dt / 0.6));
      const hp1 = value - this.base;
      this.base2 += (hp1 - this.base2) * (1 - Math.exp(-dt / 0.6));
      const hp = hp1 - this.base2;
      this.lp += (hp - this.lp) * (1 - Math.exp(-dt / 0.06));
      const s = -this.lp; // more blood => more absorption => darker frame

      this.env = Math.max(Math.abs(s), this.env * Math.exp(-dt / 1.5), 1e-3);
      const norm = Math.max(-1, Math.min(1, s / this.env));

      this.prevSignal = this.signal;
      this.signal = norm;

      // Hysteresis peak picking: arm above HIGH, track the maximum, commit when falling below LOW.
      // Far more robust to sensor noise than looking for slope sign changes.
      const warmedUp = t - this.contactSince > WARMUP_S;
      if (!this.armed) {
        if (warmedUp && norm > 0.45) {
          this.armed = true;
          this.peakVal = norm;
          this.peakT = t;
        }
      } else {
        if (norm > this.peakVal) {
          this.peakVal = norm;
          this.peakT = t;
        }
        if (norm < 0.0) {
          this.armed = false;
          this._onPeak(this.peakT);
        }
      }

      if (t - this.lastPeakT > MAX_IBI * 2) {
        this.confidence *= Math.exp(-dt / 1.0);
      }
      return this.signal;
    }

    _onPeak(peakT) {
      const ibi = peakT - this.lastPeakT;
      const refractory = this.ibis.length >= 3 ? Math.max(MIN_IBI, median(this.ibis) * 0.55) : MIN_IBI;
      if (ibi < refractory) return;
      if (ibi <= MAX_IBI) this._acceptInterval(ibi);
      this.lastPeakT = peakT;
      this.pendingBeat = true;
      this.beatCount++;
    }

    _acceptInterval(ibi) {
      if (this.ibis.length >= 3) {
        const m = median(this.ibis);
        if (Math.abs(ibi - m) / m > 0.35) {
          // Tolerate occasional misses/double-counts, but re-lock if the rhythm truly changed.
          if (++this.rejectStreak < 4) return;
          this.ibis = [];
        }
      }
      this.rejectStreak = 0;
      this.ibis.push(ibi);
      if (this.ibis.length > 8) this.ibis.shift();
      this._updateEstimate();
    }

    _updateEstimate() {
      const n = this.ibis.length;
      if (n < 2) return;
      const m = median(this.ibis);
      this.bpm = 60 / m;
      const mean = this.ibis.reduce((a, b) => a + b, 0) / n;
      const variance = this.ibis.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
      const cv = Math.sqrt(variance) / mean;
      this.confidence = Math.min(1, n / 4) * Math.max(0, Math.min(1, 1 - cv * 4));
    }

    /** Returns true once per detected beat. */
    takeBeat() {
      const b = this.pendingBeat;
      this.pendingBeat = false;
      return b;
    }

    get hasContact() {
      return this.contactSince !== null;
    }
  }

  /** Heuristic: a fingertip lit by the flash makes the frame bright, saturated red and fairly uniform. */
  PulseDetector.detectContact = function (r, g, b) {
    return r > 45 && r > g * 1.5 && r > b * 1.5;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = PulseDetector;
  else root.PulseDetector = PulseDetector;
})(typeof self !== 'undefined' ? self : this);
