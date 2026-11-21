"use strict";
(() => {
  // frame-slideshow.ts
  var clamp01 = (x) => Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x;
  var ease = (x) => x * x * (3 - 2 * x);
  var toSpec = (a) => typeof a === "string" || a instanceof Blob ? { src: a } : { ...a };
  var toSpecs = (a) => a == null ? [] : (Array.isArray(a) ? a : [a]).map(toSpec);
  var SAFE_TAGS = /* @__PURE__ */ new Set(["BR", "WBR", "B", "I", "EM", "STRONG", "U", "S", "SMALL", "SUB", "SUP", "MARK", "SPAN"]);
  var DROP_TAGS = /* @__PURE__ */ new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "TEMPLATE"]);
  function sanitizeHtml(html) {
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const walk = (node) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          node.removeChild(child);
          continue;
        }
        const el = child;
        if (DROP_TAGS.has(el.tagName)) {
          el.remove();
          continue;
        }
        if (!SAFE_TAGS.has(el.tagName)) {
          el.replaceWith(document.createTextNode(el.textContent ?? ""));
          continue;
        }
        for (const attr of Array.from(el.attributes)) if (attr.name !== "class") el.removeAttribute(attr.name);
        walk(el);
      }
    };
    walk(tpl.content);
    return tpl.innerHTML;
  }
  var FrameSlideshow = class _FrameSlideshow {
    constructor(root, options) {
      this.index = 0;
      /** ms elapsed within the current frame. */
      this.t = 0;
      this.running = false;
      this.ended = false;
      this.done = Promise.resolve("stopped");
      this.raf = 0;
      this.last = 0;
      this.tok = 0;
      // invalidates stale preloads after stop()/restart()
      this.passMs = 0;
      // ms of the current pass spent in earlier frames
      this.entered = false;
      this.curColor = null;
      this.resolveDone = null;
      this.audio = [];
      this.blobs = /* @__PURE__ */ new Map();
      this.warmed = /* @__PURE__ */ new Set();
      this.warm = [];
      this.onVis = () => {
        this.last = performance.now();
        if (document.hidden) this.pauseAudio();
        else if (this.running) this.resumeAudio();
      };
      this.tick = (now) => {
        if (!this.running) return;
        this.t += Math.min(now - this.last, 100);
        this.last = now;
        const n = this.frames.length;
        let cur = this.resolve(this.index);
        while (this.t >= cur.duration) {
          this.t -= cur.duration;
          if (this.index === n - 1 && !this.opts.loop) {
            this.finish(cur);
            return;
          }
          this.passMs += cur.duration;
          const wrapped = this.index === n - 1;
          this.index = (this.index + 1) % n;
          if (wrapped) this.passMs = 0;
          this.render();
          this.enter(wrapped);
          cur = this.resolve(this.index);
        }
        const D = cur.duration;
        const F = cur.fade;
        let o = 0;
        let color = cur.color;
        if (this.t < F) {
          const prev = this.index > 0 ? this.index - 1 : this.opts.loop ? n - 1 : 0;
          color = this.resolve(prev).color;
          o = 1 - ease(this.t / F);
        } else if (this.t > D - F) {
          o = ease((this.t - (D - F)) / F);
        }
        this.setColor(color);
        this.overlay.style.opacity = o.toFixed(3);
        const pos = this.passMs + this.t;
        for (const e of this.audio) {
          if (!e.started) {
            if (pos - e.startMs >= e.offsetMs) this.startEntry(e);
          } else this.applyVolume(e);
        }
        this.raf = requestAnimationFrame(this.tick);
      };
      const {
        frames,
        images,
        texts,
        audios,
        audio,
        duration = 5e3,
        fade = 800,
        color = "#000",
        loop = true,
        textMode = "html",
        textAlign = "center",
        volume: volume2 = 1,
        onEnd,
        onFrame,
        onAudioError: onAudioError2,
        createAudio
      } = options;
      let list;
      if (frames) {
        list = frames.map((f) => _FrameSlideshow.store(f));
      } else {
        if (!images || !texts) throw new Error("pass either frames, or images + texts arrays");
        if (images.length !== texts.length) throw new Error("images and texts must be the same length");
        if (audios && audios.length !== images.length) throw new Error("audios must match images in length");
        list = images.map((image, i) => _FrameSlideshow.store({ image, text: texts[i], audio: audios?.[i] }));
      }
      if (!list.length) throw new Error("need at least one frame");
      if (audio != null) {
        const g = toSpec(audio);
        list[0].audio.unshift({ ...g, span: g.span ?? Infinity });
      }
      this.frames = list;
      this.opts = { duration, fade, color, loop, textMode, textAlign, volume: volume2 };
      this.onEnd = onEnd;
      this.onFrame = onFrame;
      this.onAudioError = onAudioError2;
      this.createAudio = createAudio;
      this.root = root ?? document.createElement("div");
      this.root.classList.add("fs");
      this.root.innerHTML = '<div class="fs-bg"></div><div class="fs-text-wrap"><div class="fs-text"></div></div><div class="fs-overlay"></div>';
      this.bg = this.root.querySelector(".fs-bg");
      this.textEl = this.root.querySelector(".fs-text");
      this.overlay = this.root.querySelector(".fs-overlay");
      this.setColor(this.resolve(0).color);
      document.addEventListener("visibilitychange", this.onVis);
    }
    static store(f) {
      if (typeof f.image !== "string" || !f.image) throw new Error("every frame needs an image string");
      return {
        image: f.image,
        text: String(f.text ?? ""),
        duration: f.duration,
        fade: f.fade,
        color: f.color,
        textAlign: f.textAlign,
        audio: toSpecs(f.audio)
      };
    }
    /* ---------- data side ---------- */
    resolve(i) {
      const f = this.frames[i];
      const o = this.opts;
      const duration = Math.max(f.duration ?? o.duration, 100);
      return {
        image: f.image,
        text: f.text,
        duration,
        fade: Math.min(f.fade ?? o.fade, duration / 2),
        color: f.color ?? o.color,
        textAlign: f.textAlign ?? o.textAlign,
        audio: f.audio
      };
    }
    /** Every field filled in. Tracks are clamped to their own slideshow so they never bleed into the next part. */
    baked() {
      const n = this.frames.length;
      return this.frames.map((_, i) => {
        const r = this.resolve(i);
        return { ...r, audio: r.audio.map((a) => ({ ...a, span: Math.min(a.span ?? 1, n - i) })) };
      });
    }
    get totalMs() {
      let sum = 0;
      for (let i = 0; i < this.frames.length; i++) sum += this.resolve(i).duration;
      return sum;
    }
    push(frame) {
      this.frames.push(_FrameSlideshow.store(frame));
      return this;
    }
    setOptions(o) {
      Object.assign(this.opts, o);
      if (this.t >= this.resolve(this.index).duration) this.t = 0;
    }
    /** New slideshow = frames of all parts, in order. The parts are untouched and keep their own displays. */
    static stitchAll(parts, opts = {}) {
      if (!parts.length) throw new Error("nothing to stitch");
      const first = parts[0];
      const { root, ...rest } = opts;
      return new _FrameSlideshow(root, {
        loop: first.opts.loop,
        textMode: first.opts.textMode,
        volume: first.opts.volume,
        ...rest,
        frames: parts.flatMap((p) => p.baked())
      });
    }
    stitch(other, opts) {
      return _FrameSlideshow.stitchAll([this, other], opts);
    }
    /* ---------- playback ---------- */
    /** Resolves 'ended' when a non-looping run finishes, 'stopped' on stop()/restart()/destroy(). */
    start() {
      if (this.running) return this.done;
      if (this.ended) this.reset();
      this.running = true;
      this.done = new Promise((r) => {
        this.resolveDone = r;
      });
      const tok = ++this.tok;
      void this.preload().then(() => {
        if (tok !== this.tok || !this.running) return;
        this.render();
        if (!this.entered) {
          this.entered = true;
          this.enter(false);
        } else this.resumeAudio();
        this.last = performance.now();
        this.raf = requestAnimationFrame(this.tick);
      });
      return this.done;
    }
    stop() {
      this.running = false;
      this.tok++;
      cancelAnimationFrame(this.raf);
      this.pauseAudio();
      this.settle("stopped");
    }
    restart() {
      this.stop();
      this.reset();
      return this.start();
    }
    destroy() {
      this.stop();
      this.killAll();
      document.removeEventListener("visibilitychange", this.onVis);
      for (const url of this.blobs.values()) URL.revokeObjectURL(url);
      this.blobs.clear();
      this.warm = [];
      this.root.innerHTML = "";
    }
    reset() {
      this.killAll();
      this.index = 0;
      this.t = 0;
      this.passMs = 0;
      this.ended = false;
      this.entered = false;
      this.overlay.style.opacity = "1";
    }
    settle(reason) {
      const r = this.resolveDone;
      this.resolveDone = null;
      r?.(reason);
    }
    preload() {
      for (const f of this.frames)
        for (const a of f.audio) if (typeof a.src === "string") this.warmAudio(a.src);
      const srcs = [...new Set(this.frames.map((f) => f.image))];
      return Promise.all(srcs.map((src) => new Promise((res) => {
        const img = new Image();
        img.onload = () => res();
        img.onerror = () => res();
        img.src = src;
      })));
    }
    setColor(c) {
      if (c === this.curColor) return;
      this.curColor = c;
      this.root.style.setProperty("--fs-color", c);
    }
    render() {
      const f = this.resolve(this.index);
      this.bg.style.backgroundImage = `url(${JSON.stringify(f.image)})`;
      if (this.opts.textMode === "text") this.textEl.textContent = f.text;
      else this.textEl.innerHTML = this.opts.textMode === "sanitized" ? sanitizeHtml(f.text) : f.text;
      const all = f.textAlign === "justify-all";
      this.textEl.style.textAlign = all ? "justify" : f.textAlign;
      this.textEl.style.setProperty("text-align-last", all ? "justify" : "auto");
      this.onFrame?.(this.index, this);
    }
    finish(cur) {
      this.running = false;
      this.ended = true;
      this.killAll();
      this.setColor(cur.color);
      this.overlay.style.opacity = "1";
      this.onEnd?.(this);
      this.settle("ended");
    }
    /* ---------- audio ---------- */
    makeAudio(url) {
      return this.createAudio ? this.createAudio(url) : new Audio(url);
    }
    url(src) {
      if (typeof src === "string") return src;
      let u = this.blobs.get(src);
      if (!u) {
        u = URL.createObjectURL(src);
        this.blobs.set(src, u);
      }
      return u;
    }
    warmAudio(src) {
      if (this.warmed.has(src)) return;
      this.warmed.add(src);
      try {
        const el = this.makeAudio(src);
        el.preload = "auto";
        this.warm.push(el);
      } catch {
      }
    }
    /** Called whenever a frame becomes current: cut tracks whose span is over, queue this frame's tracks. */
    enter(wrapped) {
      this.audio = this.audio.filter((e) => {
        if (e.cut && (wrapped || this.index >= e.endFrame)) {
          this.kill(e);
          return false;
        }
        return true;
      });
      const n = this.frames.length;
      for (const spec of this.frames[this.index].audio) {
        const span = Math.max(1, spec.span ?? 1);
        let lenMs = 0;
        for (let k = this.index; k < Math.min(this.index + span, n); k++) lenMs += this.resolve(k).duration;
        this.audio.push({
          spec,
          endFrame: this.index + span,
          cut: spec.stopAtEnd !== false,
          offsetMs: Math.max(0, spec.offset ?? 0),
          startMs: this.passMs,
          lenMs,
          el: null,
          started: false
        });
      }
    }
    startEntry(e) {
      e.started = true;
      let el;
      try {
        el = this.makeAudio(this.url(e.spec.src));
      } catch (err) {
        this.onAudioError?.(err, e.spec);
        return;
      }
      el.preload = "auto";
      el.loop = !!e.spec.loop;
      if (e.spec.startAt) {
        try {
          el.currentTime = e.spec.startAt / 1e3;
        } catch {
        }
      }
      el.addEventListener("ended", () => {
        this.audio = this.audio.filter((x) => x !== e);
      });
      e.el = el;
      this.applyVolume(e);
      this.play(e);
    }
    applyVolume(e) {
      if (!e.el) return;
      const pos = this.passMs + this.t - e.startMs;
      const fi = e.spec.fadeIn ?? 0;
      const fo = e.spec.fadeOut ?? 0;
      let v = (e.spec.volume ?? 1) * this.opts.volume;
      if (fi > 0) v *= clamp01((pos - e.offsetMs) / fi);
      if (fo > 0 && e.cut) v *= clamp01((e.lenMs - pos) / fo);
      v = clamp01(v);
      e.el.volume = v;
      e.el.muted = v === 0;
    }
    play(e) {
      if (!e.el) return;
      try {
        void Promise.resolve(e.el.play()).catch((err) => this.onAudioError?.(err, e.spec));
      } catch (err) {
        this.onAudioError?.(err, e.spec);
      }
    }
    kill(e) {
      e.el?.pause();
      e.el = null;
    }
    killAll() {
      for (const e of this.audio) this.kill(e);
      this.audio = [];
    }
    pauseAudio() {
      for (const e of this.audio) e.el?.pause();
    }
    resumeAudio() {
      for (const e of this.audio) if (e.el && !e.el.ended) this.play(e);
    }
  };

  // main.ts
  var $ = (id) => document.getElementById(id);
  var svg = (a, b, c) => "data:image/svg+xml," + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient><radialGradient id="r" cx=".7" cy=".3" r=".5"><stop offset="0" stop-color="${c}" stop-opacity=".8"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs><rect width="1600" height="1000" fill="url(#g)"/><rect width="1600" height="1000" fill="url(#r)"/></svg>`
  );
  function tone(freq, ms) {
    const rate = 8e3;
    const n = Math.floor(rate * ms / 1e3);
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (o, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
    };
    w(0, "RIFF");
    v.setUint32(4, 36 + n, true);
    w(8, "WAVE");
    w(12, "fmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, rate, true);
    v.setUint32(28, rate, true);
    v.setUint16(32, 1, true);
    v.setUint16(34, 8, true);
    w(36, "data");
    v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) {
      const env = Math.min(1, i / 400, (n - i) / 400);
      v.setUint8(44 + i, 128 + Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 60 * env));
    }
    return new Blob([buf], { type: "audio/wav" });
  }
  var volume = 0;
  var onAudioError = (err, spec) => console.debug("audio blocked/failed", spec.src, err);
  function mountClip(title, make) {
    const fig = document.createElement("figure");
    fig.className = "cell";
    fig.innerHTML = '<div class="stage"></div><figcaption><span><b></b><span class="status"></span></span><button>&#9654; Replay</button></figcaption>';
    $("clips").append(fig);
    fig.querySelector("b").textContent = title;
    const status = fig.querySelector(".status");
    const show = make(fig.querySelector(".stage"));
    const play = () => {
      status.textContent = "playing\u2026";
      void show.restart().then((r) => {
        if (r === "ended") status.textContent = "\u2713 finished";
      });
    };
    fig.querySelector("button").onclick = play;
    play();
    return show;
  }
  var A = mountClip("A", (root) => new FrameSlideshow(root, {
    images: [svg("#0f2027", "#2c5364", "#7dd3fc"), svg("#134e5e", "#71b280", "#fde68a"), svg("#232526", "#414345", "#fca5a5")],
    texts: ["A \xB7 one<br>two<br>three lines here", "Short<br>and a much longer line", "Last<br>one"],
    textAlign: "justify-all",
    audio: { src: tone(220, 7500), volume: 0.6, fadeIn: 500, fadeOut: 800 },
    // global: plays across the clip
    duration: 2500,
    fade: 500,
    color: "#000000",
    loop: false,
    volume,
    onAudioError
  }));
  var B = mountClip("B", (root) => new FrameSlideshow(root, {
    images: [svg("#42275a", "#734b6d", "#f9a8d4"), svg("#1e3c72", "#2a5298", "#a5b4fc"), svg("#3a1c71", "#d76d77", "#ffaf7b")],
    texts: ["B \xB7 four", "B \xB7 <b>five</b>", "B \xB7 six"],
    duration: 3e3,
    fade: 600,
    color: "#1a1033",
    loop: false,
    volume,
    onAudioError
  }));
  var C = mountClip("C", (root) => new FrameSlideshow(root, {
    frames: [
      {
        image: svg("#355c7d", "#6c5b7b", "#c06c84"),
        text: "C \xB7 seven",
        duration: 2e3,
        color: "#ffffff",
        audio: { src: tone(523, 1800), offset: 200 }
      },
      {
        image: svg("#11998e", "#38ef7d", "#ffffff"),
        text: "C \xB7 eight<br>(with a fade-out)",
        duration: 3500,
        fade: 900,
        color: "#ffffff",
        textAlign: "justify-all",
        audio: { src: tone(659, 3e3), fadeIn: 300, fadeOut: 600 }
      }
    ],
    loop: false,
    volume,
    onAudioError
  }));
  var stitched = null;
  function playStitched() {
    stitched?.destroy();
    stitched = FrameSlideshow.stitchAll([A, B, C], { root: $("bigStage"), loop: $("loopChk").checked, volume, onAudioError });
    $("stitchInfo").textContent = "playing\u2026 (" + (stitched.totalMs / 1e3).toFixed(1) + "s total)";
    void stitched.start().then((r) => {
      if (r === "ended") $("stitchInfo").textContent = "\u2713 finished";
    });
  }
  $("stitchBtn").onclick = playStitched;
  $("loopChk").onchange = playStitched;
  $("soundChk").onchange = (e) => {
    volume = e.target.checked ? 1 : 0;
    for (const s of [A, B, C, stitched]) s?.setOptions({ volume });
  };
  playStitched();
})();
