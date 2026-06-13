const AUDIO_SOURCE_STATES = new Set(['stopped', 'playing', 'paused']);

function defaultNow() {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function defaultCreateAudio(url) {
  const audio = new Audio(url);
  audio.preload = 'auto';
  return audio;
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp01(value, fallback = 1) {
  const n = Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, n));
}

function safePause(audio) {
  try { audio?.pause?.(); } catch {}
}

function safeSeek(audio, time) {
  if (!audio || !Number.isFinite(time) || time < 0) return;
  try { audio.currentTime = time; } catch {}
}

function safeLoad(audio) {
  try { audio?.load?.(); } catch {}
}

function resolveAudioPath(source, resolver) {
  return resolver.resolveAsset(source?.asset) || source?.url || null;
}

function desiredStateForSource(source) {
  if (AUDIO_SOURCE_STATES.has(source?.state)) return source.state;
  if (source?.playOnAwake === true) return 'playing';
  return 'stopped';
}

function normalizeAnimationSync(sync) {
  if (!sync || typeof sync !== 'object' || sync.mode !== 'animation') return null;

  const result = {
    mode: 'animation',
    offset: finiteNumber(sync.offset, 0),
    resyncOnLoop: sync.resyncOnLoop !== false,
  };

  if (typeof sync.animationClipName === 'string' && sync.animationClipName.trim()) {
    result.animationClipName = sync.animationClipName.trim();
  }
  if (Number.isFinite(sync.driftThreshold) && sync.driftThreshold >= 0) {
    result.driftThreshold = sync.driftThreshold;
  }

  return result;
}

function audioDuration(audio) {
  return Number.isFinite(audio?.duration) && audio.duration > 0 ? audio.duration : null;
}

function animationTargetTime(audio, sampleTime, offset, loop) {
  const duration = audioDuration(audio);
  let target = sampleTime + offset;
  if (duration) {
    target = loop ? ((target % duration) + duration) % duration : Math.min(Math.max(0, target), duration);
  } else if (target < 0) {
    target = 0;
  }
  return target;
}

function applyAudioElementConfig(audio, source) {
  if (!audio) return;
  audio.loop = source.loop === true;
  audio.volume = clamp01(source.volume, 1);
  try { audio.playbackRate = positiveNumber(source.playbackRate, 1); } catch {}
  if ('preload' in audio) audio.preload = 'auto';
}

export function createObjectAudioController({
  sceneDoc,
  resolver,
  onMissingAsset = null,
  getAnimationSample = null,
  createAudio = defaultCreateAudio,
  now = defaultNow,
}) {
  const entries = [];
  const byKey = new Map();
  const oneShots = new Set();
  const startMs = now();
  let audioUnlocked = false;

  function keyFor(objectId, name = 'default') {
    return `${objectId}:${name || 'default'}`;
  }

  function findEntry(objectId, name = 'default') {
    return byKey.get(keyFor(objectId, name));
  }

  function getPlaybackTargetEntries() {
    return entries.filter((entry) => entry.desiredState === 'playing');
  }

  function cancelEntryOneShot(entry) {
    if (!entry) return;
    entry.oneShotToken += 1;
    entry.oneShotActive = false;
  }

  function restoreAfterUnlockAttempt(entry, snapshot) {
    const audio = entry.audio;
    if (!audio) return;

    safePause(audio);
    safeSeek(audio, snapshot.currentTime);
    audio.muted = snapshot.muted;

    if (!snapshot.paused && entry.desiredState === 'playing' && !entry.userPaused) {
      tryPlay(entry, { force: true });
    }
  }

  function unlockEntryAudio(entry) {
    const audio = entry?.audio;
    if (!audio) return Promise.resolve(false);

    const snapshot = {
      paused: audio.paused !== false,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      muted: audio.muted === true,
    };

    try {
      audio.muted = true;
      const result = audio.play?.();
      return Promise.resolve(result).then(() => {
        entry.autoplayBlocked = false;
        entry.warnedAutoplayBlocked = false;
        restoreAfterUnlockAttempt(entry, snapshot);
        return true;
      }).catch(() => {
        restoreAfterUnlockAttempt(entry, snapshot);
        return false;
      });
    } catch {
      restoreAfterUnlockAttempt(entry, snapshot);
      return Promise.resolve(false);
    }
  }

  function tryPlay(entry, { force = false } = {}) {
    if (!entry?.audio) return Promise.resolve(false);
    if (entry.audio.paused === false) return Promise.resolve(true);
    if (entry.autoplayBlocked && !force) return Promise.resolve(false);
    if (force) entry.autoplayBlocked = false;

    try {
      const result = entry.audio.play?.();
      if (result && typeof result.then === 'function') {
        return result.then(() => {
          entry.autoplayBlocked = false;
          return true;
        }).catch((err) => {
          entry.autoplayBlocked = true;
          if (!entry.warnedAutoplayBlocked) {
            entry.warnedAutoplayBlocked = true;
            console.warn('[viewer] AudioSource playback blocked:', err?.message || err);
          }
          return false;
        });
      }
      entry.autoplayBlocked = false;
      return Promise.resolve(true);
    } catch (err) {
      entry.autoplayBlocked = true;
      if (!entry.warnedAutoplayBlocked) {
        entry.warnedAutoplayBlocked = true;
        console.warn('[viewer] AudioSource playback failed:', err?.message || err);
      }
      return Promise.resolve(false);
    }
  }

  function seekToConfiguredOffset(entry) {
    const offset = Math.max(0, finiteNumber(entry.source.offset, 0));
    if (offset <= 0) return;
    const duration = audioDuration(entry.audio);
    safeSeek(entry.audio, duration ? Math.min(offset, duration) : offset);
  }

  function syncAnimationEntry(entry) {
    const sync = entry.sync;
    if (!sync || sync.mode !== 'animation' || typeof getAnimationSample !== 'function') return false;

    const sample = getAnimationSample(entry.objectId, sync.animationClipName);
    if (!sample || !Number.isFinite(sample.time)) return false;

    const target = animationTargetTime(
      entry.audio,
      sample.time,
      (sync.offset || 0) + (entry.source.offset || 0),
      entry.source.loop === true
    );
    const driftThreshold = Number.isFinite(sync.driftThreshold) ? sync.driftThreshold : 0.05;
    const looped = entry.lastSampleTime != null && sample.time < entry.lastSampleTime;
    entry.lastSampleTime = sample.time;

    const drift = Math.abs((entry.audio.currentTime || 0) - target);
    if (drift > driftThreshold && (sync.resyncOnLoop !== false || !looped)) {
      safeSeek(entry.audio, target);
    }

    return true;
  }

  function tickEntry(entry, nowMs) {
    if (!entry.audio) return;
    if (entry.oneShotActive) return;

    applyAudioElementConfig(entry.audio, entry.source);

    if (entry.desiredState === 'stopped') {
      if (entry.audio.paused === false) safePause(entry.audio);
      return;
    }
    if (entry.desiredState === 'paused') {
      if (entry.audio.paused === false) safePause(entry.audio);
      return;
    }
    if (entry.userPaused) return;

    const syncedToAnimation = syncAnimationEntry(entry);
    if (!syncedToAnimation && !entry.started) {
      const elapsed = Math.max(0, (nowMs - startMs) / 1000);
      const target = (entry.source.offset || 0) + elapsed;
      const duration = audioDuration(entry.audio);
      safeSeek(entry.audio, duration && entry.source.loop
        ? ((target % duration) + duration) % duration
        : target);
    }

    entry.started = true;
    tryPlay(entry);
  }

  function playUnlockedEntryOneShot(entry, url, options = {}) {
    const audio = entry?.audio;
    if (!audio) return Promise.resolve(false);

    const snapshot = {
      src: audio.src,
      currentTime: Number.isFinite(audio.currentTime) ? audio.currentTime : 0,
      muted: audio.muted === true,
      volume: Number.isFinite(audio.volume) ? audio.volume : 1,
      playbackRate: Number.isFinite(audio.playbackRate) ? audio.playbackRate : 1,
      loop: audio.loop === true,
    };
    const token = entry.oneShotToken + 1;

    let restored = false;
    const restore = () => {
      if (entry.oneShotToken !== token) return;
      if (restored) return;
      restored = true;
      entry.oneShotActive = false;
      safePause(audio);
      audio.loop = snapshot.loop;
      audio.volume = snapshot.volume;
      audio.muted = snapshot.muted;
      try { audio.playbackRate = snapshot.playbackRate; } catch {}
      if (snapshot.src && audio.src !== snapshot.src) {
        audio.src = snapshot.src;
        safeLoad(audio);
      }
      safeSeek(audio, snapshot.currentTime);
      applyAudioElementConfig(audio, entry.source);
    };

    entry.oneShotToken = token;
    entry.oneShotActive = true;
    safePause(audio);
    if (url && audio.src !== url) {
      audio.src = url;
      safeLoad(audio);
    }
    audio.loop = false;
    audio.muted = false;
    audio.volume = clamp01(options.volume, snapshot.volume);
    try { audio.playbackRate = positiveNumber(options.playbackRate, snapshot.playbackRate); } catch {}
    safeSeek(audio, Math.max(0, finiteNumber(options.offset, 0)));
    audio.addEventListener?.('ended', restore, { once: true });

    try {
      const result = audio.play?.();
      if (result && typeof result.then === 'function') {
        return result.then(() => true).catch(() => {
          restore();
          return false;
        });
      }
      return Promise.resolve(true);
    } catch {
      restore();
      return Promise.resolve(false);
    }
  }

  function createEntry(objectEntry, name, source) {
    const audioPath = resolveAudioPath(source, resolver);
    if (!audioPath) {
      onMissingAsset?.({
        id: `${objectEntry.id}:${name}`,
        objectId: objectEntry.id,
        kind: 'audioSource',
        name,
        reason: 'no path or url',
      });
      return null;
    }

    const audio = createAudio(audioPath);
    if ('src' in audio && !audio.src) audio.src = audioPath;
    applyAudioElementConfig(audio, source);

    const entry = {
      objectId: objectEntry.id,
      name: source.name || name || 'default',
      source: { ...source, url: audioPath },
      sync: normalizeAnimationSync(source.sync),
      audio,
      desiredState: desiredStateForSource(source),
      started: false,
      userPaused: false,
      autoplayBlocked: false,
      warnedAutoplayBlocked: false,
      lastSampleTime: null,
      oneShotActive: false,
      oneShotToken: 0,
    };

    if (typeof audio.addEventListener === 'function') {
      audio.addEventListener('loadedmetadata', () => seekToConfiguredOffset(entry), { once: true });
    }
    seekToConfiguredOffset(entry);

    entries.push(entry);
    byKey.set(keyFor(entry.objectId, entry.name), entry);
    return entry;
  }

  for (const objectEntry of sceneDoc.objects || []) {
    const audioSources = objectEntry.audioSources;
    if (!audioSources || typeof audioSources !== 'object' || Array.isArray(audioSources)) continue;

    for (const [name, source] of Object.entries(audioSources)) {
      if (!source || typeof source !== 'object') continue;
      createEntry(objectEntry, name, source);
    }
  }

  return {
    elements: entries.map((entry) => entry.audio),

    hasAudioSources() {
      return entries.length > 0;
    },

    hasPlaybackTargets() {
      return getPlaybackTargetEntries().length > 0;
    },

    isAudioUnlocked() {
      return audioUnlocked;
    },

    unlockAudio() {
      if (audioUnlocked) return Promise.resolve(true);
      if (entries.length === 0) return Promise.resolve(false);

      const attempts = entries.map((entry) => unlockEntryAudio(entry));
      return Promise.allSettled(attempts).then((results) => {
        const unlocked = results.some((result) => (
          result.status === 'fulfilled' && result.value === true
        ));
        if (unlocked) audioUnlocked = true;
        return unlocked;
      });
    },

    getPlaybackTargetElements() {
      return getPlaybackTargetEntries().map((entry) => entry.audio);
    },

    playPlaybackTargets() {
      return Promise.allSettled(getPlaybackTargetEntries().map((entry) => {
        entry.userPaused = false;
        return tryPlay(entry, { force: true });
      }));
    },

    pausePlaybackTargets() {
      for (const entry of getPlaybackTargetEntries()) {
        cancelEntryOneShot(entry);
        entry.userPaused = true;
        safePause(entry.audio);
      }
    },

    applyEffect(effect) {
      const objectId = effect.objectId || effect.target;
      const name = effect.name || 'default';
      const entry = findEntry(objectId, name);
      if (!entry) return;

      if (effect.type === 'audioSource.play') {
        cancelEntryOneShot(entry);
        entry.desiredState = 'playing';
        entry.userPaused = false;
        tryPlay(entry, { force: true });
      } else if (effect.type === 'audioSource.pause') {
        cancelEntryOneShot(entry);
        entry.desiredState = 'paused';
        entry.userPaused = false;
        safePause(entry.audio);
      } else if (effect.type === 'audioSource.stop') {
        cancelEntryOneShot(entry);
        entry.desiredState = 'stopped';
        entry.userPaused = false;
        safePause(entry.audio);
        safeSeek(entry.audio, 0);
      } else if (effect.type === 'audioSource.seek') {
        safeSeek(entry.audio, Math.max(0, finiteNumber(effect.time, 0)));
      } else if (effect.type === 'audioSource.playOneShot') {
        const options = effect.options || {};
        const url = typeof options.url === 'string' && options.url ? options.url : entry.source.url;
        if (!url) return;

        if (audioUnlocked && entry.desiredState !== 'playing') {
          playUnlockedEntryOneShot(entry, url, options);
          return;
        }

        const oneShot = createAudio(url);
        oneShot.loop = false;
        oneShot.volume = clamp01(options.volume, entry.audio.volume);
        try { oneShot.playbackRate = positiveNumber(options.playbackRate, entry.audio.playbackRate || 1); } catch {}
        safeSeek(oneShot, Math.max(0, finiteNumber(options.offset, 0)));
        const cleanup = () => {
          oneShots.delete(oneShot);
          try {
            oneShot.removeAttribute?.('src');
            oneShot.src = '';
            oneShot.load?.();
          } catch {}
        };
        oneShot.addEventListener?.('ended', cleanup, { once: true });
        oneShots.add(oneShot);
        const result = oneShot.play?.();
        if (result && typeof result.then === 'function') result.catch(cleanup);
      } else if (effect.type === 'audioSource.setVolume') {
        const volume = clamp01(effect.volume, entry.audio.volume);
        entry.source.volume = volume;
        entry.audio.volume = volume;
      } else if (effect.type === 'audioSource.setClip' && typeof effect.url === 'string') {
        cancelEntryOneShot(entry);
        entry.source.url = effect.url;
        entry.audio.src = effect.url;
        entry.started = false;
        entry.autoplayBlocked = false;
        safeLoad(entry.audio);
      } else if (effect.type === 'audioSource.syncToAnimation') {
        entry.sync = normalizeAnimationSync({ mode: 'animation', ...(effect.sync || effect.options || {}) });
        entry.lastSampleTime = null;
      } else if (effect.type === 'audioSource.unsync') {
        entry.sync = null;
        entry.lastSampleTime = null;
      }
    },

    tick(nowMs = now()) {
      for (const entry of entries) tickEntry(entry, nowMs);
    },

    dispose() {
      for (const entry of entries) {
        safePause(entry.audio);
        try {
          entry.audio.removeAttribute?.('src');
          entry.audio.src = '';
          entry.audio.load?.();
        } catch {}
      }
      for (const audio of oneShots) {
        safePause(audio);
        try {
          audio.removeAttribute?.('src');
          audio.src = '';
          audio.load?.();
        } catch {}
      }
      entries.length = 0;
      oneShots.clear();
      byKey.clear();
      audioUnlocked = false;
    },
  };
}
