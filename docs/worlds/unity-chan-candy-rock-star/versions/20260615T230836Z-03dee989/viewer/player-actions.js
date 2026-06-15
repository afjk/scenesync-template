export function createPlayerActions(core) {
  return {
    play() {
      core?.commands?.playSceneClock?.();
    },
    pause() {
      core?.commands?.pauseSceneClock?.();
    },
    stop() {
      core?.commands?.stopSceneClock?.();
    },
    seek(seconds) {
      core?.commands?.seekSceneClock?.(seconds);
    },
    setRate(rate) {
      core?.commands?.setSceneClockRate?.(rate);
    },
    setMode(mode) {
      core?.commands?.setSceneClockMode?.(mode);
    },
    requestControl() {
      core?.commands?.requestSceneClockControl?.();
    },
    releaseControl() {
      core?.commands?.releaseSceneClockControl?.();
    },
  };
}
