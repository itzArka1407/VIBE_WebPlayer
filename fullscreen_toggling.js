const el = document.getElementById('mainStageWrapper');
const fsToggleBtn = el.getElementsByClassName('fstogglebtn')[0];
const stageEl = document.getElementById('bigStage');

fsToggleBtn.addEventListener('click', function() {
    document.fullscreenElement ? document.exitFullscreen() : (() => {
        stageEl.requestFullscreen();
        stageEl.focus({ preventScroll: true })
    })();
});

stageEl.addEventListener('keydown', function(ev) {
    const key = ev.key;
    switch (key) {
        case "ArrowLeft":
            ev.preventDefault();
            break;
        case "ArrowRight":
            ev.preventDefault();
            break;
        case "R":
            if (ev.shiftKey) { }
            ev.preventDefault();
            break;
        default:
            ev.preventDefault();
    }
})
