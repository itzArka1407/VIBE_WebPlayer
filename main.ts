import { FrameSlideshow, type AudioSpec } from './frame-slideshow';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/* ---------- demo helpers: inline SVG gradients and generated WAV tones, so nothing is fetched ---------- */
const svg = (a: string, b: string, c: string): string =>
    'data:image/svg+xml,' + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1000"><defs>` +
        `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>` +
        `<radialGradient id="r" cx=".7" cy=".3" r=".5"><stop offset="0" stop-color="${c}" stop-opacity=".8"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient></defs>` +
        `<rect width="1600" height="1000" fill="url(#g)"/><rect width="1600" height="1000" fill="url(#r)"/></svg>`);

function tone(freq: number, ms: number): Blob {
    const rate = 8000;
    const n = Math.floor((rate * ms) / 1000);
    const buf = new ArrayBuffer(44 + n);
    const v = new DataView(buf);
    const w = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    w(36, 'data'); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) {
        const env = Math.min(1, i / 400, (n - i) / 400);
        v.setUint8(44 + i, 128 + Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 60 * env));
    }
    return new Blob([buf], { type: 'audio/wav' });
}

let volume = 1;   // master volume, driven by the "sound" checkbox
const onAudioError = (err: unknown, spec: AudioSpec): void => console.error('audio failed', spec.src, err);

// One display per clip: its own stage, replay button and status.
function mountClip(title: string, make: (root: HTMLElement) => FrameSlideshow): FrameSlideshow {
    const fig = document.createElement('figure');
    fig.className = 'cell';
    fig.innerHTML = '<div class="stage"></div><figcaption><span><b></b><span class="status"></span></span><button>&#9654; Replay</button></figcaption>';
    $('clips').append(fig);
    fig.querySelector('b')!.textContent = title;
    const status = fig.querySelector<HTMLElement>('.status')!;

    const show = make(fig.querySelector<HTMLElement>('.stage')!);
    const play = (): void => {
        status.textContent = 'playing…';
        void show.restart().then(r => { if (r === 'ended') status.textContent = '✓ finished'; });
    };
    fig.querySelector('button')!.onclick = play;
    return show;
}

// ===================== MAIN SECTION =============================
// Alter code to directly change the animations and all

// Clip A: arrays form, <br> in the text, every line justified to the same width, one global audio track
const A = mountClip('A', root => new FrameSlideshow(root, {
    images: [svg('#0f2027', '#2c5364', '#7dd3fc'), svg('#134e5e', '#71b280', '#fde68a'), svg('#232526', '#414345', '#fca5a5')],
    texts: ['A · one<br>two<br>three lines here', 'Short<br>and a much longer line', 'Last<br>one'],
    textAlign: 'justify-all',
    audio: { src: /*tone(220, 7500)*/ 'music/melancholy.mp3', volume: 0.6, fadeIn: 500, fadeOut: 800 },   // global: plays across the clip
    duration: 2500, fade: 500, color: '#000000', loop: false,
    volume, onAudioError,
}));

// Clip B: different timing and transition color, centered text
const B = mountClip('B', root => new FrameSlideshow(root, {
    images: [svg('#42275a', '#734b6d', '#f9a8d4'), svg('#1e3c72', '#2a5298', '#a5b4fc'), svg('#3a1c71', '#d76d77', '#ffaf7b')],
    texts: ['B · four', 'B · <b>five</b>', 'B · six'],
    duration: 3000, fade: 600, color: '#1a1033', loop: false,
    volume, onAudioError,
}));

// Clip C: explicit frames with per-frame overrides, including per-frame audio
const C = mountClip('C', root => new FrameSlideshow(root, {
    frames: [
        {
            image: svg('#355c7d', '#6c5b7b', '#c06c84'), text: 'C · seven', duration: 2000, color: '#ffffff',
            audio: { src: tone(523, 1800), offset: 200 }
        },
        {
            image: svg('#11998e', '#38ef7d', '#ffffff'), text: 'C · eight<br>(with a fade-out)', duration: 3500, fade: 900, color: '#ffffff',
            textAlign: 'justify-all', audio: { src: tone(659, 3000), fadeIn: 300, fadeOut: 600 }
        },
    ],
    loop: false,
    volume, onAudioError,
}));

// Stitch them: new slideshow with its own display; A, B and C are untouched.
//   const ab  = A.stitch(B, { root });
//   const all = FrameSlideshow.stitchAll([A, B, C], { root, loop: false });
let stitched: FrameSlideshow | null = null;
function playStitched(): void {
    stitched?.destroy();
    stitched = FrameSlideshow.stitchAll([A, B, C], { root: $('bigStage'), loop: $<HTMLInputElement>('loopChk').checked, volume, onAudioError });
    $('stitchInfo').textContent = 'playing… (' + (stitched.totalMs / 1000).toFixed(1) + 's total)';
    void stitched.start().then(r => { if (r === 'ended') $('stitchInfo').textContent = '✓ finished'; });
}
$('stitchBtn').onclick = playStitched;
$('loopChk').onchange = playStitched;
$<HTMLInputElement>('soundChk').onchange = e => {
    volume = (e.target as HTMLInputElement).checked ? 1 : 0;
    for (const s of [A, B, C, stitched]) s?.setOptions({ volume });
};
playStitched();

(window as any).dbg = { A, B, C };

const el = document.getElementById('mainStageWrapper');
const fsToggleBtn = el!.getElementsByClassName('fstogglebtn')[0];
const stageEl = document.getElementById('bigStage')!;

fsToggleBtn.addEventListener('click', function() {
    document.fullscreenElement ? document.exitFullscreen() : (() => {
        stageEl.requestFullscreen();
        stageEl.focus({ preventScroll: true })
    })();
});

stageEl.addEventListener('keydown', ev => {
    const show = stitched;                    // read it fresh: playStitched() swaps the instance
    if (!show) return;
    switch (ev.key) {
        case 'ArrowRight': show.next(); break;
        case 'ArrowLeft': show.prev(); break;
        case ' ': show.toggle(); break;
        case 'r': case 'R': void show.restart(); break;
        default: return;                      // leave every other key alone
    }
    ev.preventDefault();
});
