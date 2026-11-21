# FrameSlideshow

A small, dependency-free TypeScript class that plays a list of **frames** (background image + text + optional audio) with a **fade-through-a-color** transition. Time per frame is yours to set. It can loop forever or play once, and several slideshows can be **stitched** into one, each keeping its own display, timing and colors.

```
[ image + text ] ── fade to color ──▶ [ image + text ] ── fade to color ──▶ ...
```

## Features

- Frames from two parallel arrays (`images`, `texts`) or from explicit frame objects with per-frame overrides.
- Per-slideshow or per-frame `duration`, `fade` time, transition `color` and text alignment.
- Loop forever, or `loop: false` to play once and finish (a promise resolves, `onEnd` fires).
- **Stitching**: `a.stitch(b)` / `FrameSlideshow.stitchAll([a, b, c])` returns a new slideshow. The originals are untouched and keep playing on their own displays.
- Text rendered as HTML (so `<br>` works), with an optional sanitizer, and a `justify-all` mode that stretches every line to the same width.
- Audio: a global track, per-frame tracks, or a parallel `audios` array, from a URL or a `Blob`/`File`. Offsets, seeking, fades, volume, looping, spans across frames.
- Playback control: `start`, `stop`, `restart`, `toggle`, `next`, `prev`, `goTo`.
- Frame-based clock (`requestAnimationFrame`): no timer drift, pauses with a hidden tab, resumes without skipping frames.

## Files

```
frame-slideshow.ts    the library (class + types)          <- copy this
frame-slideshow.css   the styles it needs                  <- copy this
main.ts               demo: 3 clips + a stitched result
index.html            demo page
tsconfig.json         strict TS config
package.json          build scripts
```

Only the first two are the library. The rest is the demo. Put them anywhere in your project, as long as the `.ts` import path matches.

## Install and build

Browsers can't run `.ts`, so something must compile it. The demo uses esbuild:

```bash
pnpm install            # or npm i
pnpm approve-builds     # pnpm only: select esbuild (it blocks install scripts by default)
pnpm run build          # main.ts -> main.js (one bundled file)
# open index.html in a browser
```

For development, rebuild automatically on save by adding this script to `package.json`:

```json
"dev": "esbuild main.ts --bundle --outfile=main.js --format=iife --target=es2020 --watch"
```

Reload the page yourself after each rebuild. Without esbuild, `npx esbuild main.ts --bundle --outfile=main.js --format=iife --target=es2020` does the same thing.

Using Vite or another bundler instead? Import the CSS in your entry file (`import './frame-slideshow.css'`) and skip the build step above.

## Quick start

HTML: load the CSS and give the slideshow a container **with a size**.

```html
<link rel="stylesheet" href="frame-slideshow.css">
<div id="stage" style="width: 960px; height: 540px"></div>
<button id="play">Play</button>
<script src="main.js"></script>
```

`main.ts`:

```ts
import { FrameSlideshow } from './frame-slideshow';

const show = new FrameSlideshow(document.getElementById('stage'), {
  images: ['img/a.jpg', 'img/b.jpg', 'img/c.jpg'],
  texts:  ['First<br>slide', 'Second', 'Third'],
  duration: 4000,      // ms each frame occupies, fades included
  fade: 700,           // ms of each half of a transition
  color: '#000',       // the color it fades through
  loop: false,         // play once
});

document.getElementById('play')!.onclick = async () => {
  const reason = await show.start();   // call start() from a click so audio is allowed
  console.log(reason);                 // 'ended'
};
```

## How timing works

Every frame owns a window of `duration` ms. Inside it:

```
t = 0            t = fade                    t = duration - fade     t = duration
 │ overlay: 1 ──▶ 0 │      frame fully visible      │ overlay: 0 ──▶ 1 │
 │  (fade IN from   │                               │ (fade OUT to     │
 │   previous color)│                               │  this frame's    │
 │                  │                               │  color)          │
```

- The swap to the next frame happens while the overlay is fully opaque, so you never see a half-changed picture.
- A frame's `color` is the color it fades **out** through, and the next frame fades **in** from that same color, so there's never a color jump between frames.
- The first frame fades in from its own color (or from the last frame's color when looping). A non-looping show ends fully covered by the last frame's color.
- `fade` is capped at half of `duration`. The minimum `duration` is 100 ms.
- Images are preloaded before the first frame. A broken image doesn't block playback.

## API

### Constructor

```ts
new FrameSlideshow(root: HTMLElement | null | undefined, options: SlideshowOptions)
```

`root` needs a width and height (or `aspect-ratio`). Pass `null` to get a detached `<div>` at `show.root`, which you can append wherever you like.

Give frames **either** as `images` + `texts` (equal length) **or** as `frames`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `images` | `string[]` | - | Image URLs or data URIs. Same length as `texts`. |
| `texts` | `string[]` | - | Text for each frame (HTML by default). |
| `audios` | `(AudioInput \| AudioInput[] \| null)[]` | - | Per-frame audio, parallel to `images`. Use `null` for none. |
| `frames` | `FrameInput[]` | - | Explicit frames with per-frame overrides (see below). Use instead of `images`/`texts`. |
| `audio` | `AudioInput` | - | Global track: starts with the show and spans the whole run. |
| `duration` | `number` (ms) | `5000` | Time per frame, fades included. |
| `fade` | `number` (ms) | `800` | Length of each half of a transition. |
| `color` | `string` | `'#000'` | Transition color. |
| `loop` | `boolean` | `true` | `false` = play once and finish. |
| `textMode` | `'html' \| 'sanitized' \| 'text'` | `'html'` | How text is inserted (see Text). |
| `textAlign` | `'left' \| 'center' \| 'right' \| 'justify' \| 'justify-all'` | `'center'` | Text alignment. |
| `volume` | `number` 0..1 | `1` | Master volume, multiplied into every track. |
| `onEnd` | `(s) => void` | - | A non-looping show finished. |
| `onFrame` | `(index, s) => void` | - | A frame just became current. |
| `onAudioError` | `(err, spec) => void` | - | Audio failed or was blocked (see Audio). |
| `createAudio` | `(url) => HTMLAudioElement` | `new Audio(url)` | Override how audio elements are made (testing, custom loaders). |

### Frame objects

```ts
interface FrameInput {
  image: string;
  text?: string;
  duration?: number;      // overrides the slideshow default for this frame
  fade?: number;
  color?: string;         // the color this frame fades OUT through
  textAlign?: TextAlign;
  audio?: AudioInput | AudioInput[] | null;
}
```

```ts
new FrameSlideshow(el, {
  frames: [
    { image: 'a.jpg', text: 'Hello',   duration: 2000, color: '#fff' },
    { image: 'b.jpg', text: 'Goodbye', duration: 3500, fade: 900, textAlign: 'justify-all' },
  ],
  loop: false,
});
```

### Methods

| Method | Returns | What it does |
|---|---|---|
| `start()` | `Promise<'ended' \| 'stopped'>` | Start or resume. Resolves `'ended'` when a non-looping show finishes, `'stopped'` if you stop it. Starting a finished show replays it from the beginning. |
| `stop()` | `void` | Pause, keeping the position. Audio pauses too. |
| `toggle()` | `void` | Pause if playing, resume if paused. |
| `restart()` | `Promise<…>` | Go back to frame 0 and play. |
| `next()` | `void` | Jump to the next frame. At the end it wraps only if `loop` is true. |
| `prev()` | `void` | Restart the current frame if it has played for more than 1 s, otherwise go back one. |
| `goTo(i)` | `void` | Jump to frame `i` (clamped). While playing, its intro fade plays. While paused, the frame is shown fully visible. |
| `push(frame)` | `this` | Append a frame (`FrameInput`). |
| `setOptions({...})` | `void` | Change `duration`, `fade`, `color`, `loop`, `textMode`, `textAlign` or `volume` live. |
| `stitch(other, opts?)` | `FrameSlideshow` | New slideshow = this frames + `other`'s frames. |
| `FrameSlideshow.stitchAll(parts, opts?)` | `FrameSlideshow` | Same for any number of parts. |
| `destroy()` | `void` | Stop, kill audio, remove listeners, clear the DOM. Call it when you discard an instance. |

### Properties

| Property | Meaning |
|---|---|
| `root` | The element it renders into. |
| `index` | Current frame index. |
| `t` | ms elapsed within the current frame. |
| `running`, `ended` | Playback state. |
| `totalMs` | Sum of all frame durations. |
| `done` | Promise for the current run (same value `start()` returned). |
| `frames`, `opts` | Read-only views of the frames and current default options. Use `push` / `setOptions` to change them. |
| `onEnd`, `onFrame`, `onAudioError` | Callbacks, assignable after construction. |

## Text

Each frame's `text` goes into a shrink-to-fit box (`.fs-text`, up to `max-width: 22ch`, centered).

| `textMode` | Behaviour |
|---|---|
| `'html'` (default) | Raw `innerHTML`: `<br>`, `<b>`, `<span style="...">` all work. **Only use with text you wrote yourself.** Untrusted input runs as HTML. |
| `'sanitized'` | `innerHTML` after an allowlist: only `br wbr b i em strong u s small sub sup mark span` survive, with only the `class` attribute. Other elements become plain text, and `script`/`style`/`iframe` are dropped. |
| `'text'` | `textContent`: tags are shown literally. |

`sanitizeHtml(html)` is also exported if you want to use the sanitizer on its own.

### Alignment and "same-width lines"

`text-align: justify` stretches every line except the **last** one, and each line ended by a `<br>` counts as a last line. To justify those too you also need `text-align-last: justify`. The `justify-all` option sets both:

```ts
textAlign: 'justify-all'      // globally, or per frame
```

Because the box is as wide as its longest line, shorter lines are stretched to match it. Notes:

- A line with a single word can't stretch. Uncomment `text-justify: inter-character` in the CSS to spread its letters instead.
- This evens line widths by changing spacing. It does not scale the font per line.
- Text size scales with the slideshow's own size (CSS container units), not the viewport, so it also looks right in small previews.

## Audio

Audio is a URL string, a `Blob`/`File`, or an `AudioSpec`:

```ts
interface AudioSpec {
  src: string | Blob;
  volume?: number;      // 0..1, default 1 (multiplied by the master volume)
  offset?: number;      // ms after the owning frame starts before it begins
  startAt?: number;     // ms to seek into the file before playing
  fadeIn?: number;      // ms of linear ramp up from the track's start
  fadeOut?: number;     // ms of linear ramp down before it is cut (needs stopAtEnd)
  loop?: boolean;       // repeat while alive (you decide; nothing is automatic)
  span?: number;        // frames covered, counted from the owning frame. Default 1. Infinity = whole run
  stopAtEnd?: boolean;  // default true: cut when the span ends. false: play to its natural end
}
```

### Three ways to attach audio

```ts
new FrameSlideshow(el, {
  images, texts,
  loop: false,

  // 1. global: starts with the show, spans all frames
  audio: { src: 'music/bgm.mp3', volume: 0.5, fadeIn: 500, fadeOut: 1000 },

  // 2. per frame, parallel to images (null = nothing)
  audios: [null, 'sfx/whoosh.mp3', { src: 'voice/line3.mp3', offset: 300 }],
});

// 3. per frame in explicit frames
{ image: 'a.jpg', text: 'Hi', audio: { src: 'hi.mp3', span: 2 } }   // covers this frame and the next
```

A frame can have several tracks: `audio: ['a.mp3', { src: 'b.mp3', offset: 500 }]`.

### Behaviour

- A per-frame track starts when its frame starts (plus `offset`) and is cut when its `span` ends. Set `stopAtEnd: false` to let it finish on its own.
- The global `audio` option is a track on frame 0 with `span: Infinity`. It starts again each time a looping show wraps.
- `loop: true` repeats a clip that is shorter than its span. It restarts at the beginning of the file, not at `startAt`, and some MP3s leave a small gap at the loop point (use WAV/OGG if that's audible).
- `fadeOut` ramps the volume down over the last `fadeOut` ms before the track is cut.
- `stop()`, `toggle()` and a hidden browser tab pause the audio together with the visuals.
- `goTo`, `next` and `prev` re-queue any tracks that cover the new position and seek them into place.
- `Blob`/`File` sources are turned into object URLs internally and released on `destroy()`.

### Browser autoplay rules

Browsers refuse to play sound until the user has interacted with the page. In practice:

1. Call `start()` from a click/tap/keypress handler, and audio just works.
2. If a track is blocked anyway (for example a show that auto-starts on page load), `onAudioError` is called with a `NotAllowedError`, and the track is **retried automatically on the next click, tap or keypress**, seeked to where it would be if it had started on time. Ignore it in your handler if you don't want to log it:

```ts
onAudioError: (err, spec) => {
  if ((err as { name?: string }).name === 'NotAllowedError') return;  // retried automatically
  console.error('audio failed', spec.src, err);
}
```

3. Several slideshows running at once all retry on the same click. If you only want one to make sound, don't auto-start the others.

### File paths

`src` is a URL the **browser** loads, so `~/Downloads/x.mp3` won't work (the `~` is a shell feature, and web pages can't read arbitrary disk paths). Put the files next to your page and use a relative path (`music/x.mp3`), or let the user pick a file:

```ts
input.onchange = () => {
  const file = input.files![0];
  new FrameSlideshow(el, { images, texts, audio: file, loop: false }).start();
};
```

## Stitching

```ts
const ab  = a.stitch(b, { root: elAB });
const all = FrameSlideshow.stitchAll([a, b, c], { root: elAll, loop: false });
await all.start();
```

- Returns a **new** slideshow with its own display. `a`, `b` and `c` are untouched and can keep playing independently.
- Every frame keeps its own resolved `duration`, `fade`, `color`, text alignment and audio from the part it came from.
- Each part's own tracks stay inside that part (a part's global track is clamped to that part's frames).
- `loop` defaults to the first part's setting. `textMode` and `volume` also default to the first part's.
- `StitchOptions` accepts everything in the constructor options except `frames`, `images`, `texts` and `audios`, plus:

| Option | Meaning |
|---|---|
| `root` | Element to render into (omit for a detached `<div>` at `result.root`). |
| `audio` | One track over the **whole** stitched show, layered under the parts' own tracks. |
| `dropPartAudio` | `true` = drop every part's own audio so only `audio` plays. |

```ts
// a background track across all clips, repeated if it's shorter than the show
const all = FrameSlideshow.stitchAll([a, b, c], {
  root: el,
  loop: false,
  dropPartAudio: true,
  audio: { src: 'music/bgm.mp3', volume: 0.4, loop: true, fadeIn: 1000, fadeOut: 2000 },
});
```

When you re-stitch (for example on a button press), `destroy()` the previous stitched instance first so its listeners and audio are released.

## Keyboard and fullscreen

The clock belongs to the `FrameSlideshow` instance, not to any DOM element, so key handlers call methods on the instance. Read the *current* instance each time if you replace it.

```ts
const stageEl = document.getElementById('stage')!;
stageEl.tabIndex = 0;          // a div only receives key events if it can take focus

stageEl.addEventListener('keydown', ev => {
  switch (ev.key) {
    case 'ArrowRight': show.next(); break;
    case 'ArrowLeft':  show.prev(); break;
    case ' ':          show.toggle(); break;
    case 'r': case 'R': void show.restart(); break;
    default: return;           // leave other keys (F5, Ctrl+R, Tab...) alone
  }
  ev.preventDefault();
});

button.addEventListener('click', () => {
  document.fullscreenElement
    ? document.exitFullscreen()
    : (stageEl.requestFullscreen(), stageEl.focus({ preventScroll: true }));
});
```

## Styling

The CSS is small and uses these classes inside the root: `.fs` (root), `.fs-bg`, `.fs-text-wrap`, `.fs-text`, `.fs-overlay`. The transition color is the CSS variable `--fs-color` on the root. Adjust `.fs-text` (font size, `max-width`, shadow) to taste.

## Demo

`index.html` + `main.ts` show:

- Three independent clips (A, B, C), each playing once with its own Replay button: arrays form with `<br>` and `justify-all` plus a global track (A), a different timing and color (B), and explicit frames with per-frame audio (C).
- A stitched A + B + C result with a loop checkbox.
- A **sound** checkbox. Master volume starts at 0, so tick it first and then press a Replay button.

The demo's audio uses generated tones (`tone()` makes a WAV `Blob`) so it needs no files. Swap in your own files by editing the `MAIN SECTION` in `main.ts`, and rebuild after every edit to `main.ts`, because the browser runs `main.js`.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| No sound at all | Demo master volume starts at 0: tick **sound**, then press Replay. Browsers need a click before audio plays. |
| Edits to `main.ts` have no effect | The page runs `main.js`. Rebuild (`pnpm run build`) or run the `dev` watcher, then hard-refresh. |
| `~/...` path doesn't load | Web pages can't use shell paths. Copy the file next to the page and use a relative path. |
| Console: "Autoplay is only allowed when approved by the user…" | Expected on auto-start. The track is retried on your first click. |
| A track from a different clip is audible | Every running slideshow retries blocked audio on the same click. Don't auto-start several at once. |
| Keys don't work on the stage | The element needs `tabindex="0"` (or `el.tabIndex = 0`) to take focus and receive `keydown`. |
| `ERR_PNPM_IGNORED_BUILDS` | Run `pnpm approve-builds` and select esbuild. |
| Text too big or small in a preview | Text scales with the slideshow's own size. Give the root an explicit width and height. |

## Verification and known limits

- The library type-checks under `tsc --strict`. A jsdom test suite (58 checks) covers play-once and looping, stitching, text modes, seeking, pause and resume, and audio timing and blocking. The tests use a mocked clock and mocked audio.
- **Not yet verified in real browsers:** actual audio output, autoplay-policy behavior across browsers, fullscreen, and visual rendering. Test those in the browsers you target.
- Audio relies on `HTMLAudioElement`. Mobile Safari may be stricter about playback and `preload`.
- There is no video export yet. A `render(t)` method that draws any time position without a running clock would be the starting point for exporting frames.
- Raw `'html'` text mode trusts its input.

## License

See `LICENSE`.
