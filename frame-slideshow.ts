/**
 * FrameSlideshow: frames (image + text + optional audio) shown with a fade-through-color transition.
 * Needs frame-slideshow.css. Full API reference: see README.md.
 *
 *   const s = new FrameSlideshow(el, { images, texts, duration: 4000, fade: 700, color: '#000', loop: false });
 *   await s.start();                                  // 'ended' | 'stopped'
 *   const all = FrameSlideshow.stitchAll([a, b, c], { root: el2 });
 *
 * Text:   textMode 'html' (innerHTML, default) | 'sanitized' (innerHTML, allowlist) | 'text' (textContent)
 *         textAlign 'center' (default) | 'left' | 'right' | 'justify' | 'justify-all'
 * Audio:  trim a track with startOffset / endOffset (or length); global `audio` option, per-frame `audio`, or a parallel `audios` array. Each is a URL string,
 *         a Blob/File, or an AudioSpec. Call start() from a user gesture so the browser allows playback.
 */

export type TextAlign = 'left' | 'center' | 'right' | 'justify' | 'justify-all';
export type TextMode = 'html' | 'sanitized' | 'text';
export type EndReason = 'ended' | 'stopped';

export interface AudioSpec {
    /** URL/path, or a Blob/File (turned into an object URL internally). */
    src: string | Blob;
    /** 0..1, default 1. Multiplied by the slideshow's master `volume`. */
    volume?: number;
    /** Trim from the start: ms cut off the beginning of the file. Default 0. */
    startOffset?: number;
    /**
     * Trim from the end: ms cut off the end of the file. Needs the file's duration, so it takes effect
     * once the browser has loaded the metadata (not possible for streams of unknown length). Default 0.
     */
    endOffset?: number;
    /** Play at most this many ms, counted from the start of the clip (after startOffset). Ends at whichever comes first: this or endOffset. */
    length?: number;
    /** ms after the owning frame starts before the track begins (a delay in the SHOW, not a trim of the file). */
    offset?: number;
    /** ms of linear volume ramp up from the track's start. */
    fadeIn?: number;
    /** ms of linear ramp down before the track is cut (needs stopAtEnd, the default). */
    fadeOut?: number;
    /** Repeat while alive. A trimmed track repeats its clip (between startOffset and endOffset), not the whole file. */
    loop?: boolean;
    /** Number of frames the track covers, counted from its owning frame. Default 1. Infinity = whole pass. */
    span?: number;
    /** Default true: cut the track when its span ends. false: let it play to its natural end. */
    stopAtEnd?: boolean;
}
export type AudioInput = string | Blob | AudioSpec;
export type AudioList = AudioInput | AudioInput[] | null | undefined;

export interface FrameInput {
    image: string;
    text?: string;
    duration?: number;
    fade?: number;
    /** Color this frame fades OUT through; the next frame fades IN from the same color. */
    color?: string;
    textAlign?: TextAlign;
    audio?: AudioList;
}

/** A frame with every field filled in (what stitching copies). */
export interface ResolvedFrame {
    image: string;
    text: string;
    duration: number;
    fade: number;
    color: string;
    textAlign: TextAlign;
    audio: AudioSpec[];
}

export interface SlideshowOptions {
    frames?: FrameInput[];
    images?: string[];
    texts?: string[];
    /** Parallel to images/texts; use null for frames without audio. */
    audios?: AudioList[];
    /** Global track: starts when the slideshow starts (and again on every loop). */
    audio?: AudioInput;
    duration?: number;
    fade?: number;
    color?: string;
    loop?: boolean;
    textMode?: TextMode;
    textAlign?: TextAlign;
    /** Master volume 0..1, default 1. */
    volume?: number;
    onEnd?: (s: FrameSlideshow) => void;
    onFrame?: (index: number, s: FrameSlideshow) => void;
    onAudioError?: (err: unknown, spec: AudioSpec) => void;
    /** Override how <audio> elements are made (testing, custom loaders). */
    createAudio?: (url: string) => HTMLAudioElement;
}

export type StitchOptions = Omit<SlideshowOptions, 'frames' | 'images' | 'texts' | 'audios'> & {
    root?: HTMLElement | null;
    /** Drop every part's own audio so only `audio` (the track over the whole stitched show) plays. */
    dropPartAudio?: boolean;
};

interface Opts {
    duration: number;
    fade: number;
    color: string;
    loop: boolean;
    textMode: TextMode;
    textAlign: TextAlign;
    volume: number;
}

interface StoredFrame {
    image: string;
    text: string;
    duration?: number;
    fade?: number;
    color?: string;
    textAlign?: TextAlign;
    audio: AudioSpec[];
}

interface AudioEntry {
    spec: AudioSpec;
    endFrame: number;     // first frame index at which this track is cut (exclusive)
    cut: boolean;
    offsetMs: number;
    startMs: number;      // pass-time (ms) at which the owning frame started
    lenMs: number;        // total duration of the frames the track spans
    el: HTMLAudioElement | null;
    started: boolean;
    blocked: boolean;     // browser refused to play it (autoplay policy); retried on the next user gesture
    clipStart: number;    // seconds cut off the start of the file (startOffset)
    clipLen: number | undefined;   // seconds the clip may last at most (length); undefined = no limit
    manualLoop: boolean;  // looping a clip that does not span the whole file: we seek back ourselves
}

const clamp01 = (x: number): number => (Number.isNaN(x) ? 0 : x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x: number): number => x * x * (3 - 2 * x);

const toSpec = (a: AudioInput): AudioSpec => {
    const spec: AudioSpec = typeof a === 'string' || a instanceof Blob ? { src: a } : { ...a };
    if ((spec.startOffset ?? 0) < 0) throw new Error('audio startOffset must be >= 0');
    if ((spec.endOffset ?? 0) < 0) throw new Error('audio endOffset must be >= 0');
    if (spec.length !== undefined && spec.length <= 0) throw new Error('audio length must be greater than 0');
    return spec;
};

const toSpecs = (a: AudioList): AudioSpec[] =>
    a == null ? [] : (Array.isArray(a) ? a : [a]).map(toSpec);

// Events the browser counts as a user activation (so audio may start)
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'keydown', 'touchend'] as const;

const SAFE_TAGS = new Set(['BR', 'WBR', 'B', 'I', 'EM', 'STRONG', 'U', 'S', 'SMALL', 'SUB', 'SUP', 'MARK', 'SPAN']);
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

/** Allowlist sanitizer: keeps SAFE_TAGS (class attribute only); other elements become plain text. */
export function sanitizeHtml(html: string): string {
    const tpl = document.createElement('template');   // inert: nothing loads or runs while parsing
    tpl.innerHTML = html;
    const walk = (node: Node): void => {
        for (const child of Array.from(node.childNodes)) {
            if (child.nodeType === Node.TEXT_NODE) continue;
            if (child.nodeType !== Node.ELEMENT_NODE) { node.removeChild(child); continue; }
            const el = child as Element;
            if (DROP_TAGS.has(el.tagName)) { el.remove(); continue; }
            if (!SAFE_TAGS.has(el.tagName)) { el.replaceWith(document.createTextNode(el.textContent ?? '')); continue; }
            for (const attr of Array.from(el.attributes)) if (attr.name !== 'class') el.removeAttribute(attr.name);
            walk(el);
        }
    };
    walk(tpl.content);
    return tpl.innerHTML;
}

export class FrameSlideshow {
    readonly root: HTMLElement;
    readonly frames: StoredFrame[];
    readonly opts: Opts;
    onEnd?: (s: FrameSlideshow) => void;
    onFrame?: (index: number, s: FrameSlideshow) => void;
    onAudioError?: (err: unknown, spec: AudioSpec) => void;
    createAudio?: (url: string) => HTMLAudioElement;

    index = 0;
    /** ms elapsed within the current frame. */
    t = 0;
    running = false;
    ended = false;
    done: Promise<EndReason> = Promise.resolve('stopped');

    private readonly bg: HTMLElement;
    private readonly textEl: HTMLElement;
    private readonly overlay: HTMLElement;
    private raf = 0;
    private last = 0;
    private tok = 0;                 // invalidates stale preloads after stop()/restart()
    private passMs = 0;              // ms of the current pass spent in earlier frames
    private entered = false;
    private curColor: string | null = null;
    private resolveDone: ((r: EndReason) => void) | null = null;
    private audio: AudioEntry[] = [];
    private blobs = new Map<Blob, string>();
    private warmed = new Set<string>();
    private warm: HTMLAudioElement[] = [];
    private unlockArmed = false;

    constructor(root: HTMLElement | null | undefined, options: SlideshowOptions) {
        const {
            frames, images, texts, audios, audio,
            duration = 5000, fade = 800, color = '#000', loop = true,
            textMode = 'html', textAlign = 'center', volume = 1,
            onEnd, onFrame, onAudioError, createAudio,
        } = options;

        let list: StoredFrame[];
        if (frames) {
            list = frames.map(f => FrameSlideshow.store(f));
        } else {
            if (!images || !texts) throw new Error('pass either frames, or images + texts arrays');
            if (images.length !== texts.length) throw new Error('images and texts must be the same length');
            if (audios && audios.length !== images.length) throw new Error('audios must match images in length');
            list = images.map((image, i) => FrameSlideshow.store({ image, text: texts[i], audio: audios?.[i] }));
        }
        if (!list.length) throw new Error('need at least one frame');
        if (audio != null) {
            const g = toSpec(audio);
            list[0].audio.unshift({ ...g, span: g.span ?? Infinity });   // global = frame 0 track spanning the pass
        }

        this.frames = list;
        this.opts = { duration, fade, color, loop, textMode, textAlign, volume };
        this.onEnd = onEnd;
        this.onFrame = onFrame;
        this.onAudioError = onAudioError;
        this.createAudio = createAudio;

        this.root = root ?? document.createElement('div');
        this.root.classList.add('fs');
        this.root.innerHTML =
            '<div class="fs-bg"></div><div class="fs-text-wrap"><div class="fs-text"></div></div><div class="fs-overlay"></div>';
        this.bg = this.root.querySelector<HTMLElement>('.fs-bg')!;
        this.textEl = this.root.querySelector<HTMLElement>('.fs-text')!;
        this.overlay = this.root.querySelector<HTMLElement>('.fs-overlay')!;
        this.setColor(this.resolve(0).color);

        document.addEventListener('visibilitychange', this.onVis);
    }

    private static store(f: FrameInput): StoredFrame {
        if (typeof f.image !== 'string' || !f.image) throw new Error('every frame needs an image string');
        return {
            image: f.image,
            text: String(f.text ?? ''),
            duration: f.duration,
            fade: f.fade,
            color: f.color,
            textAlign: f.textAlign,
            audio: toSpecs(f.audio),
        };
    }

    /* ---------- data side ---------- */

    private resolve(i: number): ResolvedFrame {
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
            audio: f.audio,
        };
    }

    /** Every field filled in. Tracks are clamped to their own slideshow so they never bleed into the next part. */
    private baked(): FrameInput[] {
        const n = this.frames.length;
        return this.frames.map((_, i) => {
            const r = this.resolve(i);
            return { ...r, audio: r.audio.map(a => ({ ...a, span: Math.min(a.span ?? 1, n - i) })) };
        });
    }

    get totalMs(): number {
        let sum = 0;
        for (let i = 0; i < this.frames.length; i++) sum += this.resolve(i).duration;
        return sum;
    }

    push(frame: FrameInput): this {
        this.frames.push(FrameSlideshow.store(frame));
        return this;
    }

    setOptions(o: Partial<Opts>): void {
        Object.assign(this.opts, o);
        if (this.t >= this.resolve(this.index).duration) this.t = 0;
    }

    /**
     * New slideshow = frames of all parts, in order. The parts are untouched and keep their own displays.
     * Each part's own tracks stay inside that part. Pass `audio` to add one track over the WHOLE stitched
     * show (it plays under the parts' tracks); add `loop: true` to it to repeat a clip shorter than the show.
     */
    static stitchAll(parts: FrameSlideshow[], opts: StitchOptions = {}): FrameSlideshow {
        if (!parts.length) throw new Error('nothing to stitch');
        const first = parts[0];
        const { root, dropPartAudio, ...rest } = opts;
        const frames = parts.flatMap(p => p.baked());
        if (dropPartAudio) for (const f of frames) f.audio = [];
        return new FrameSlideshow(root, {
            loop: first.opts.loop,
            textMode: first.opts.textMode,
            volume: first.opts.volume,
            ...rest,
            frames,
        });
    }

    stitch(other: FrameSlideshow, opts?: StitchOptions): FrameSlideshow {
        return FrameSlideshow.stitchAll([this, other], opts);
    }

    /* ---------- playback ---------- */

    /** Resolves 'ended' when a non-looping run finishes, 'stopped' on stop()/restart()/destroy(). */
    start(): Promise<EndReason> {
        if (this.running) return this.done;
        if (this.ended) this.reset();
        this.running = true;
        this.done = new Promise<EndReason>(r => { this.resolveDone = r; });
        const tok = ++this.tok;
        void this.preload().then(() => {
            if (tok !== this.tok || !this.running) return;   // stopped or restarted meanwhile
            this.render();
            if (!this.entered) { this.entered = true; this.enter(false); } else this.resumeAudio();
            this.last = performance.now();
            this.raf = requestAnimationFrame(this.tick);
        });
        return this.done;
    }

    stop(): void {
        this.running = false;
        this.tok++;
        cancelAnimationFrame(this.raf);
        this.pauseAudio();
        this.settle('stopped');
    }

    restart(): Promise<EndReason> {
        this.stop();
        this.reset();
        return this.start();
    }

    /** Pause if playing, resume if paused (a finished show replays from the start). */
    toggle(): void {
        if (this.running) this.stop();
        else void this.start();
    }

    /**
     * Jump to a frame (clamped). While playing, the frame's intro fade plays; while paused the frame is
     * shown fully visible. Tracks that cover the new position are re-queued and seeked into place.
     */
    goTo(index: number): void {
        const n = this.frames.length;
        const i = Math.max(0, Math.min(n - 1, Math.floor(index)));
        this.killAll();
        this.index = i;
        this.t = 0;
        this.passMs = 0;
        this.ended = false;
        this.entered = true;
        for (let j = 0; j <= i; j++) {
            this.queueTracks(j, this.passMs, i);
            if (j < i) this.passMs += this.resolve(j).duration;
        }
        this.render();
        if (!this.running) {
            this.setColor(this.resolve(i).color);
            this.overlay.style.opacity = '0';
        }
    }

    next(): void {
        if (this.index < this.frames.length - 1) this.goTo(this.index + 1);
        else if (this.opts.loop) this.goTo(0);
    }

    /** Like a media player: restarts the current frame, or goes back one if it has just begun. */
    prev(): void {
        this.goTo(this.t > 1000 || this.index === 0 ? this.index : this.index - 1);
    }

    destroy(): void {
        this.stop();
        this.killAll();
        this.disarmUnlock();
        document.removeEventListener('visibilitychange', this.onVis);
        for (const url of this.blobs.values()) URL.revokeObjectURL(url);
        this.blobs.clear();
        this.warm = [];
        this.root.innerHTML = '';
    }

    private reset(): void {
        this.killAll();
        this.index = 0;
        this.t = 0;
        this.passMs = 0;
        this.ended = false;
        this.entered = false;
        this.overlay.style.opacity = '1';
    }

    private settle(reason: EndReason): void {
        const r = this.resolveDone;
        this.resolveDone = null;
        r?.(reason);
    }

    private readonly onVis = (): void => {
        this.last = performance.now();
        if (document.hidden) this.pauseAudio();            // rAF stops when hidden; keep audio in sync with it
        else if (this.running) this.resumeAudio();
    };

    private preload(): Promise<unknown> {
        for (const f of this.frames)
            for (const a of f.audio) if (typeof a.src === 'string') this.warmAudio(a.src);   // not awaited
        const srcs = [...new Set(this.frames.map(f => f.image))];
        return Promise.all(srcs.map(src => new Promise<void>(res => {
            const img = new Image();
            img.onload = () => res();
            img.onerror = () => res();                     // a broken image must not block playback
            img.src = src;
        })));
    }

    private setColor(c: string): void {
        if (c === this.curColor) return;
        this.curColor = c;
        this.root.style.setProperty('--fs-color', c);
    }

    private render(): void {
        const f = this.resolve(this.index);
        this.bg.style.backgroundImage = `url(${JSON.stringify(f.image)})`;
        if (this.opts.textMode === 'text') this.textEl.textContent = f.text;
        else this.textEl.innerHTML = this.opts.textMode === 'sanitized' ? sanitizeHtml(f.text) : f.text;
        const all = f.textAlign === 'justify-all';          // justify every line, including ones ended by <br>
        this.textEl.style.textAlign = all ? 'justify' : f.textAlign;
        this.textEl.style.setProperty('text-align-last', all ? 'justify' : 'auto');
        this.onFrame?.(this.index, this);
    }

    private finish(cur: ResolvedFrame): void {
        this.running = false;
        this.ended = true;
        this.killAll();
        this.setColor(cur.color);
        this.overlay.style.opacity = '1';                   // finish fully covered by the last color
        this.onEnd?.(this);
        this.settle('ended');
    }

    private readonly tick = (now: number): void => {
        if (!this.running) return;
        // Clamp dt: after a hidden tab or a long frame we resume instead of skipping frames.
        this.t += Math.min(now - this.last, 100);
        this.last = now;

        const n = this.frames.length;
        let cur = this.resolve(this.index);
        while (this.t >= cur.duration) {                    // advance only while the overlay is fully opaque
            this.t -= cur.duration;
            if (this.index === n - 1 && !this.opts.loop) { this.finish(cur); return; }
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
        if (this.t < F) {                                   // previous color -> this frame
            const prev = this.index > 0 ? this.index - 1 : this.opts.loop ? n - 1 : 0;
            color = this.resolve(prev).color;
            o = 1 - ease(this.t / F);
        } else if (this.t > D - F) {                        // this frame -> its own color
            o = ease((this.t - (D - F)) / F);
        }
        this.setColor(color);
        this.overlay.style.opacity = o.toFixed(3);

        const pos = this.passMs + this.t;
        for (const e of this.audio) {
            if (!e.started) { if (pos - e.startMs >= e.offsetMs) this.startEntry(e); }
            else { this.applyVolume(e); this.checkClip(e); }
        }

        this.raf = requestAnimationFrame(this.tick);
    };

    /* ---------- audio ---------- */

    private makeAudio(url: string): HTMLAudioElement {
        return this.createAudio ? this.createAudio(url) : new Audio(url);
    }

    private url(src: string | Blob): string {
        if (typeof src === 'string') return src;
        let u = this.blobs.get(src);
        if (!u) { u = URL.createObjectURL(src); this.blobs.set(src, u); }
        return u;
    }

    private warmAudio(src: string): void {
        if (this.warmed.has(src)) return;
        this.warmed.add(src);
        try {
            const el = this.makeAudio(src);
            el.preload = 'auto';
            this.warm.push(el);
        } catch { /* warming is best effort */ }
    }

    /** Called whenever a frame becomes current: cut tracks whose span is over, queue this frame's tracks. */
    private enter(wrapped: boolean): void {
        this.audio = this.audio.filter(e => {
            if (e.cut && (wrapped || this.index >= e.endFrame)) { this.kill(e); return false; }
            return true;
        });
        this.queueTracks(this.index, this.passMs, this.index);
    }

    /**
     * Queue the tracks owned by frame j, which started at startMs. When j is before `upto` (a seek),
     * only tracks that still cover frame `upto` are queued; the rest are already over.
     */
    private queueTracks(j: number, startMs: number, upto: number): void {
        const n = this.frames.length;
        for (const spec of this.frames[j].audio) {
            const span = Math.max(1, spec.span ?? 1);
            const cut = spec.stopAtEnd !== false;
            if (j < upto && !(cut && j + span > upto)) continue;
            let lenMs = 0;
            for (let k = j; k < Math.min(j + span, n); k++) lenMs += this.resolve(k).duration;
            const clipStart = (spec.startOffset ?? 0) / 1000;
            const clipLen = spec.length === undefined ? undefined : spec.length / 1000;
            this.audio.push({
                spec,
                clipStart,
                clipLen,
                manualLoop: !!spec.loop && (clipStart > 0 || clipLen !== undefined || (spec.endOffset ?? 0) > 0),
                endFrame: j + span,
                cut,
                offsetMs: Math.max(0, spec.offset ?? 0),
                startMs,
                lenMs,
                el: null,
                started: false,
                blocked: false,
            });
        }
    }

    private startEntry(e: AudioEntry): void {
        e.started = true;
        let el: HTMLAudioElement;
        try {
            el = this.makeAudio(this.url(e.spec.src));
        } catch (err) {
            this.onAudioError?.(err, e.spec);
            return;
        }
        el.preload = 'auto';
        el.loop = !!e.spec.loop && !e.manualLoop;          // a clip is looped by us (see checkClip)
        e.el = el;
        const late = this.passMs + this.t - e.startMs - e.offsetMs;   // > 0 when started after a seek
        if (late > 300) {                                  // genuinely late (after a jump): catch up inside the clip
            if (!this.seekToNow(e)) { this.dropEntry(e); return; }
        } else if (e.clipStart > 0) {                      // on time: begin exactly at the chosen clip start
            try { el.currentTime = e.clipStart; } catch { /* metadata not ready yet */ }
        }
        if (late > 300 && (e.spec.endOffset ?? 0) > 0 && !Number.isFinite(el.duration)) {
            el.addEventListener('loadedmetadata', () => {      // the file's length is known now: re-sync inside the clip
                if (e.el === el && !this.seekToNow(e)) this.dropEntry(e);
            }, { once: true });
        }
        el.addEventListener('ended', () => {
            if (e.manualLoop && e.el === el) {             // reached the end of the file while looping a clip
                try { el.currentTime = e.clipStart; } catch { /* ignore */ }
                this.play(e);
                return;
            }
            this.audio = this.audio.filter(x => x !== e);
        });
        this.applyVolume(e);
        this.play(e);
    }

    private applyVolume(e: AudioEntry): void {
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

    private play(e: AudioEntry): void {
        const el = e.el;
        if (!el) return;
        const fail = (err: unknown): void => {
            if ((err as { name?: string } | null)?.name === 'NotAllowedError') {
                e.blocked = true;                          // retry on the next click / tap / keypress
                this.armUnlock();
            }
            this.onAudioError?.(err, e.spec);
        };
        try {
            void Promise.resolve(el.play()).catch(fail);
        } catch (err) {
            fail(err);
        }
    }

    /** Where the clip ends, in seconds into the file (undefined = no end to watch, or the file's length isn't known yet). */
    private clipEnd(e: AudioEntry): number | undefined {
        let end = e.clipLen === undefined ? undefined : e.clipStart + e.clipLen;
        const trim = (e.spec.endOffset ?? 0) / 1000;
        const d = e.el?.duration;
        if (trim > 0 && d !== undefined && Number.isFinite(d)) {
            const fromTail = d - trim;
            end = end === undefined ? fromTail : Math.min(end, fromTail);
        }
        return end;
    }

    /**
     * Move a track to where it would be if it had started on time, inside its clip.
     * Returns false when the clip is empty, or a non-looping clip is already over (nothing left to play).
     */
    private seekToNow(e: AudioEntry): boolean {
        const el = e.el;
        if (!el) return false;
        const played = Math.max(0, this.passMs + this.t - e.startMs - e.offsetMs) / 1000;
        let target = e.clipStart + played;
        const end = this.clipEnd(e);
        if (end !== undefined) {
            const len = end - e.clipStart;
            if (len <= 0) return false;
            if (e.spec.loop) target = e.clipStart + (played % len);
            else if (target >= end) return false;
        } else if (e.spec.loop && Number.isFinite(el.duration)) {
            const len = el.duration - e.clipStart;
            if (len > 0) target = e.clipStart + (played % len);
        }
        try { el.currentTime = target; } catch { /* metadata not ready yet */ }
        return true;
    }

    private armUnlock(): void {
        if (this.unlockArmed) return;
        this.unlockArmed = true;
        for (const t of UNLOCK_EVENTS) document.addEventListener(t, this.unlock, true);
    }

    private disarmUnlock(): void {
        this.unlockArmed = false;
        for (const t of UNLOCK_EVENTS) document.removeEventListener(t, this.unlock, true);
    }

    private readonly unlock = (): void => {
        this.disarmUnlock();                               // if play() fails again, it re-arms
        if (!this.running) return;                         // resumeAudio() retries blocked tracks on start()
        for (const e of this.audio) {
            if (e.el && e.blocked) {
                e.blocked = false;
                if (this.seekToNow(e)) this.play(e); else this.dropEntry(e);
            }
        }
    };

    /** Called every frame: stop (or loop) a trimmed track when it reaches its clip end. */
    private checkClip(e: AudioEntry): void {
        const el = e.el;
        if (!el) return;
        const end = this.clipEnd(e);
        if (end === undefined) return;                   // no end to watch yet
        if (end <= e.clipStart) {                        // startOffset + endOffset leave nothing to play
            this.onAudioError?.(new Error('audio clip is empty: startOffset + endOffset cover the whole file'), e.spec);
            this.dropEntry(e);
            return;
        }
        if (el.paused || el.currentTime < end) return;
        if (e.spec.loop) {
            try { el.currentTime = e.clipStart; } catch { /* ignore */ }
        } else {
            this.dropEntry(e);
        }
    }

    private dropEntry(e: AudioEntry): void {
        this.kill(e);
        this.audio = this.audio.filter(x => x !== e);
    }

    private kill(e: AudioEntry): void {
        e.el?.pause();
        e.el = null;
    }

    private killAll(): void {
        for (const e of this.audio) this.kill(e);
        this.audio = [];
    }

    private pauseAudio(): void {
        for (const e of this.audio) e.el?.pause();
    }

    private resumeAudio(): void {
        for (const e of this.audio) {
            if (!e.el || e.el.ended) continue;
            if (e.blocked) {
                e.blocked = false;
                if (!this.seekToNow(e)) { this.dropEntry(e); continue; }
            }
            this.play(e);
        }
    }
}
