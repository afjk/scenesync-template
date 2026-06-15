const DEFAULT_DURATION = 60;

function isPositiveFiniteNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeDuration(value) {
  return isPositiveFiniteNumber(value) ? value : DEFAULT_DURATION;
}

function clampTime(value, duration) {
  const time = Math.max(0, Number(value) || 0);
  return isPositiveFiniteNumber(duration) ? Math.min(time, duration) : time;
}

function getClipDuration(clip) {
  return isPositiveFiniteNumber(clip?.duration) ? clip.duration : 0;
}

function clampClipIndex(value, clipCount) {
  const index = Number.parseInt(value, 10);
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.max(0, clipCount - 1), index));
}

function normalizeSpeed(value) {
  return isPositiveFiniteNumber(value) ? value : 1;
}

export function clipTimeForMode(t, duration, mode) {
  const safeDuration = duration > 0 ? duration : 1;
  return mode === 'loop'
    ? ((t % safeDuration) + safeDuration) % safeDuration
    : Math.min(Math.max(0, t), safeDuration);
}

export function calculateAnimationPlaybackDuration(entry) {
  if (!entry || entry.enabled === false) return 0;

  const clips = Array.isArray(entry.clips) ? entry.clips : [];
  if (clips.length === 0) return 0;

  const clipIndex = clampClipIndex(entry.clipIndex ?? entry.clip, clips.length);
  const duration = getClipDuration(clips[clipIndex]);
  if (duration <= 0) return 0;

  const speed = Number(entry.speed);
  if (speed === 0) return 0;

  const normalizedSpeed = normalizeSpeed(speed);
  if (entry.mode === 'once') {
    const offset = Number.isFinite(entry.offset) ? entry.offset : 0;
    return Math.max(0, duration - offset) / normalizedSpeed;
  }

  return duration / normalizedSpeed;
}

export function calculateViewerPlaybackDuration({
  animationEntries = [],
  physicsDuration = 0,
  defaultDuration = DEFAULT_DURATION,
} = {}) {
  let duration = normalizeDuration(defaultDuration);

  for (const entry of animationEntries) {
    duration = Math.max(duration, calculateAnimationPlaybackDuration(entry));
  }
  if (isPositiveFiniteNumber(physicsDuration)) {
    duration = Math.max(duration, physicsDuration);
  }

  return Math.ceil(duration * 100) / 100;
}

export function createViewerSceneClock({
  duration = DEFAULT_DURATION,
  now = () => performance.now(),
} = {}) {
  const listeners = new Set();
  const state = {
    mode: 'local',
    paused: true,
    localTime: 0,
    pausedAt: 0,
    lastUpdateNow: now(),
    rate: 1,
    transportActive: false,
    duration: normalizeDuration(duration),
  };

  function emit() {
    for (const listener of listeners) {
      listener(getState());
    }
  }

  function getTime(nowMs = now()) {
    if (state.paused) return state.pausedAt ?? state.localTime;
    const elapsed = Math.max(0, (nowMs - state.lastUpdateNow) / 1000);
    return clampTime(state.localTime + elapsed * state.rate, state.duration);
  }

  function tick(nowMs = now()) {
    const previous = state.localTime;
    const time = getTime(nowMs);
    let delta = Math.max(0, time - previous);

    if (!state.paused) {
      state.localTime = time;
      state.lastUpdateNow = nowMs;
      if (isPositiveFiniteNumber(state.duration) && time >= state.duration) {
        state.paused = true;
        state.pausedAt = state.duration;
        delta = Math.max(0, state.duration - previous);
        emit();
      }
    }

    return getState({ time, delta });
  }

  function getState(overrides = {}) {
    const time = Number.isFinite(overrides.time) ? overrides.time : getTime();
    const delta = Number.isFinite(overrides.delta) ? overrides.delta : 0;
    return {
      time,
      t: time,
      delta,
      isPaused: state.paused,
      playing: !state.paused,
      mode: state.mode,
      rate: state.rate,
      duration: state.duration,
      transportActive: state.transportActive,
    };
  }

  function pause(nowMs = now()) {
    const time = getTime(nowMs);
    state.localTime = time;
    state.pausedAt = time;
    state.lastUpdateNow = nowMs;
    state.paused = true;
    emit();
  }

  function play(nowMs = now()) {
    if (isPositiveFiniteNumber(state.duration) && getTime(nowMs) >= state.duration) {
      state.localTime = 0;
      state.pausedAt = 0;
    } else {
      state.localTime = getTime(nowMs);
      state.pausedAt = null;
    }
    state.lastUpdateNow = nowMs;
    state.paused = false;
    emit();
  }

  function stop(nowMs = now()) {
    state.localTime = 0;
    state.pausedAt = 0;
    state.lastUpdateNow = nowMs;
    state.paused = true;
    emit();
  }

  function seek(seconds, nowMs = now()) {
    const wasPaused = state.paused;
    const nextTime = clampTime(seconds, state.duration);
    state.localTime = nextTime;
    state.lastUpdateNow = nowMs;
    state.paused = wasPaused;
    state.pausedAt = wasPaused ? nextTime : null;
    emit();
  }

  function setRate(rate, nowMs = now()) {
    const nextRate = Number(rate);
    if (!Number.isFinite(nextRate) || nextRate < 0) return;
    state.localTime = getTime(nowMs);
    state.lastUpdateNow = nowMs;
    state.rate = nextRate;
    emit();
  }

  function activateTransport(nowMs = now()) {
    state.transportActive = true;
    setRate(1, nowMs);
    stop(nowMs);
  }

  function deactivateTransport(nowMs = now()) {
    state.transportActive = false;
    stop(nowMs);
  }

  function setDuration(nextDuration) {
    state.duration = normalizeDuration(nextDuration);
    state.localTime = clampTime(state.localTime, state.duration);
    if (state.pausedAt != null) {
      state.pausedAt = clampTime(state.pausedAt, state.duration);
    }
    emit();
  }

  return {
    getState,
    tick,
    play,
    pause,
    stop,
    seek,
    setRate,
    activateTransport,
    deactivateTransport,
    setDuration,
    onChange(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
