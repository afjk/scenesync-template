import { createPlayerActions } from './player-actions.js';

const STYLE_ID = 'scene-sync-player-shell-style';
const DEFAULT_DURATION = 60;
const CLOCK_MODES = ['local-preview', 'shared-playback', 'room-time'];
const CLOCK_MODE_LABELS = {
  'local-preview': 'Local Preview',
  'shared-playback': 'Shared Playback',
  'room-time': 'Room Time',
  local: 'Local Preview',
  'host-follow': 'Room Time',
};

export async function ensurePlayerTransportStylesheet() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./player-shell.css', import.meta.url).href;
  document.head.appendChild(link);
}

function resolvePlayerDuration(core, state = null) {
  const duration = state?.duration ?? core?.getSceneClockState?.()?.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_DURATION;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(2).padStart(5, '0');
  return `${String(mins).padStart(2, '0')}:${secs}`;
}

function normalizeUiClockMode(mode) {
  if (mode === 'local') return 'local-preview';
  if (mode === 'host-follow') return 'room-time';
  return CLOCK_MODES.includes(mode) ? mode : 'local-preview';
}

function describeClockState(state = {}) {
  const mode = normalizeUiClockMode(state.mode);
  const controllerName = state.controller?.nickname || state.controller?.id || 'Unknown';
  if (mode === 'shared-playback') {
    return {
      title: CLOCK_MODE_LABELS[mode],
      detail: state.isController === false
        ? `Following ${controllerName}`
        : `Controller: ${controllerName}`,
      scope: '全員に反映',
    };
  }
  if (mode === 'room-time') {
    return {
      title: CLOCK_MODE_LABELS[mode],
      detail: '現在時刻に同期',
      scope: 'pause / seek 無効',
    };
  }
  return {
    title: CLOCK_MODE_LABELS[mode],
    detail: '自分だけに反映',
    scope: 'ローカル確認用',
  };
}

function createPanelHtml({ title, closeable }) {
  return `
    <header class="player-header">
      <span class="player-title">${title}</span>
      <div class="player-badges">
        <span class="player-mode-select-wrap" data-player-clock-mode data-mode="local-preview">
          <select class="player-mode-select" data-player-mode-select aria-label="Clock mode">
            <option value="local-preview">Local Preview</option>
            <option value="shared-playback">Shared Playback</option>
            <option value="room-time">Room Time</option>
          </select>
        </span>
        <span class="player-badge player-badge-status" data-player-clock-status data-paused="1">paused</span>
        ${closeable ? '<button class="player-close-btn" data-player-close type="button" title="Close">x</button>' : ''}
      </div>
    </header>
    <div class="player-mode-summary">
      <div>
        <div class="player-mode-title" data-player-mode-title>Local Preview</div>
        <div class="player-mode-detail" data-player-mode-detail>自分だけに反映</div>
      </div>
      <button class="player-controller-btn" data-player-controller type="button" hidden>Control</button>
    </div>
    <div class="player-seek-wrap">
      <input class="player-seek" data-player-seek type="range" min="0" max="60" step="0.01" value="0" />
    </div>
    <div class="player-transport-row">
      <div class="player-time-display">
        <span class="player-current-time" data-player-current-time>00:00.00</span>
        <span class="player-object-age" data-player-object-age>ObjectAge —</span>
      </div>
      <div class="player-controls">
        <button class="player-btn player-btn-stop" data-player-stop type="button" title="Stop">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="2"/>
          </svg>
        </button>
        <button class="player-btn player-btn-play-pause" data-player-play-pause data-player-playing="0" type="button" title="Play">
          <svg class="icon-play" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <polygon points="5,2 16,9 5,16"/>
          </svg>
          <svg class="icon-pause" width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true">
            <rect x="3" y="2" width="4" height="14" rx="1.5"/>
            <rect x="11" y="2" width="4" height="14" rx="1.5"/>
          </svg>
        </button>
      </div>
      <div class="player-rate-row">
        <span class="player-rate-label">Rate</span>
        <button class="player-rate-btn" data-player-rate="0.25" type="button">1/4x</button>
        <button class="player-rate-btn" data-player-rate="0.5" type="button">1/2x</button>
        <button class="player-rate-btn" data-player-rate="1" type="button" data-active="true">1x</button>
        <button class="player-rate-btn" data-player-rate="2" type="button">2x</button>
      </div>
    </div>
  `;
}

export function createPlayerTransportPanel({
  title = 'SCENE SYNC · PLAYER',
  className = '',
  closeable = false,
  hidden = false,
  activateOnMount = false,
  onClose = null,
} = {}) {
  let panel = null;
  let actions = null;
  let removeStateListener = null;
  let rafId = null;
  let isSeeking = false;
  let lastSeekValue = null;
  let mountedCore = null;
  const disposers = [];

  function getClockState(core) {
    return core?.getSceneClockState?.() ?? {};
  }

  function updateDisplay(core) {
    if (!panel) return;
    const state = getClockState(core);
    const time = Number.isFinite(state.time) ? state.time : (state.t ?? 0);
    const isPaused = state.isPaused === true || state.playing === false;
    const mode = normalizeUiClockMode(state.mode);
    const modeInfo = describeClockState({ ...state, mode });
    const rate = state.rate ?? 1;
    const duration = resolvePlayerDuration(core, state);
    const roomTimeMode = mode === 'room-time';
    const sharedFollower = mode === 'shared-playback' && state.isController === false;
    const controlsDisabled = roomTimeMode || sharedFollower;

    const timeEl = panel.querySelector('[data-player-current-time]');
    if (timeEl) timeEl.textContent = formatTime(time);

    const objectAgeEl = panel.querySelector('[data-player-object-age]');
    if (objectAgeEl) {
      const objectAge = state.selectedObjectAge;
      objectAgeEl.textContent = Number.isFinite(objectAge?.age)
        ? `ObjectAge ${objectAge.objectId}: ${objectAge.age.toFixed(2)}s`
        : 'ObjectAge —';
    }

    const modeTitleEl = panel.querySelector('[data-player-mode-title]');
    if (modeTitleEl) modeTitleEl.textContent = modeInfo.title;

    const modeDetailEl = panel.querySelector('[data-player-mode-detail]');
    if (modeDetailEl) modeDetailEl.textContent = `${modeInfo.detail} · ${modeInfo.scope}`;

    const controllerBtn = panel.querySelector('[data-player-controller]');
    if (controllerBtn) {
      controllerBtn.hidden = mode !== 'shared-playback';
      controllerBtn.textContent = state.isController === false ? 'Control' : 'Release';
      controllerBtn.disabled = mode !== 'shared-playback';
    }

    if (!isSeeking) {
      const seekEl = panel.querySelector('[data-player-seek]');
      if (seekEl) {
        if (parseFloat(seekEl.max) !== duration) seekEl.max = duration;
        seekEl.value = Math.min(time, duration);
        seekEl.disabled = controlsDisabled;
      }
    }

    const playPauseBtn = panel.querySelector('[data-player-play-pause]');
    if (playPauseBtn) {
      const playing = !isPaused;
      if (playPauseBtn.dataset.playerPlaying !== (playing ? '1' : '0')) {
        playPauseBtn.dataset.playerPlaying = playing ? '1' : '0';
        playPauseBtn.title = playing ? 'Pause' : 'Play';
      }
      playPauseBtn.disabled = controlsDisabled;
    }

    const stopBtn = panel.querySelector('[data-player-stop]');
    if (stopBtn) stopBtn.disabled = controlsDisabled;

    const modeEl = panel.querySelector('[data-player-clock-mode]');
    if (modeEl) {
      modeEl.dataset.mode = mode;
    }

    const modeSelect = panel.querySelector('[data-player-mode-select]');
    if (modeSelect && modeSelect.value !== mode) {
      modeSelect.value = mode;
    }

    const statusEl = panel.querySelector('[data-player-clock-status]');
    if (statusEl) {
      const pausedStr = isPaused ? '1' : '0';
      if (statusEl.dataset.paused !== pausedStr) {
        statusEl.textContent = isPaused ? 'paused' : 'playing';
        statusEl.dataset.paused = pausedStr;
      }
    }

    panel.querySelectorAll('[data-player-rate]').forEach(btn => {
      const active = String(parseFloat(btn.dataset.playerRate) === rate);
      if (btn.dataset.active !== active) btn.dataset.active = active;
      btn.disabled = controlsDisabled;
    });
  }

  function startLoop(core) {
    function tick() {
      updateDisplay(core);
      rafId = requestAnimationFrame(tick);
    }
    tick();
  }

  function stopLoop() {
    if (rafId != null) cancelAnimationFrame(rafId);
    rafId = null;
  }

  return {
    get element() {
      return panel;
    },

    async mount({ core, root = document.body } = {}) {
      await ensurePlayerTransportStylesheet();
      mountedCore = core;
      actions = createPlayerActions(core);

      panel = document.createElement('section');
      panel.className = ['scene-sync-player-shell', className].filter(Boolean).join(' ');
      panel.setAttribute('aria-label', title);
      panel.hidden = hidden;
      panel.innerHTML = createPanelHtml({ title, closeable });

      // Player UI 内部の操作が背後の Scene 選択 / TransformControls に流れないようにする
      const stopPanelEvent = (event) => event.stopPropagation();
      [
        'pointerdown',
        'pointermove',
        'pointerup',
        'click',
        'dblclick',
        'touchstart',
        'touchmove',
        'wheel',
      ].forEach((type) => {
        disposers.push(addListener(panel, type, stopPanelEvent, { passive: false }));
      });

      const seekEl = panel.querySelector('[data-player-seek]');
      disposers.push(
        addListener(seekEl, 'pointerdown', () => { isSeeking = true; }),
        addListener(seekEl, 'input', (e) => {
          const value = parseFloat(e.target.value);
          if (!Number.isFinite(value)) return;

          const timeEl = panel.querySelector('[data-player-current-time]');
          if (timeEl) timeEl.textContent = formatTime(value);

          if (lastSeekValue !== value) {
            lastSeekValue = value;
            actions.seek(value);
          }
        }),
        addListener(seekEl, 'change', (e) => {
          const value = parseFloat(e.target.value);
          if (Number.isFinite(value) && lastSeekValue !== value) {
            lastSeekValue = value;
            actions.seek(value);
          }
          isSeeking = false;
        }),
        addListener(panel.querySelector('[data-player-play-pause]'), 'click', () => {
          const state = getClockState(core);
          const isPaused = state.isPaused === true || state.playing === false;
          if (isPaused) actions.play();
          else actions.pause();
        }),
        addListener(panel.querySelector('[data-player-stop]'), 'click', () => actions.stop())
      );

      disposers.push(addListener(panel.querySelector('[data-player-mode-select]'), 'change', (event) => {
        actions.setMode(event.target.value);
      }));

      disposers.push(addListener(panel.querySelector('[data-player-controller]'), 'click', () => {
        const state = getClockState(core);
        if (state.isController === false) actions.requestControl();
        else actions.releaseControl();
      }));

      panel.querySelectorAll('[data-player-rate]').forEach(btn => {
        disposers.push(addListener(btn, 'click', () => {
          const rate = parseFloat(btn.dataset.playerRate);
          if (Number.isFinite(rate)) actions.setRate(rate);
        }));
      });

      if (closeable) {
        disposers.push(addListener(panel.querySelector('[data-player-close]'), 'click', () => {
          onClose?.();
        }));
      }

      root.appendChild(panel);
      removeStateListener = core?.onStateChange?.(() => updateDisplay(core)) ?? null;
      if (activateOnMount) core?.commands?.activateSceneClockTransport?.();
      if (!hidden) {
        startLoop(core);
      }
    },

    setHidden(nextHidden) {
      if (!panel) return;
      const shouldHide = !!nextHidden;
      if (panel.hidden === shouldHide) return;
      panel.hidden = shouldHide;
      if (shouldHide) {
        stopLoop();
      } else {
        updateDisplay(mountedCore);
        startLoop(mountedCore);
      }
    },

    unmount() {
      stopLoop();
      removeStateListener?.();
      removeStateListener = null;
      for (const dispose of disposers.splice(0)) dispose();
      panel?.remove();
      panel = null;
      actions = null;
      mountedCore = null;
      isSeeking = false;
      lastSeekValue = null;
    },
  };
}

function addListener(target, type, handler, options) {
  if (!target) return () => {};
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}
