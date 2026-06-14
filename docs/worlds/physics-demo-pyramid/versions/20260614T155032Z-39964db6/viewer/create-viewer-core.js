import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { isValidSceneDocument } from './scene-document.js';
import { createStaticAssetResolver } from './static-asset-resolver.js';
import { createSceneSyncRuntime } from './loomlet/loomlet-scenesync-runtime.browser.js';
import { createObjectAudioController } from './object-audio-controller.js';
import {
  createScenePhysicsRuntime,
  normalizeScenePhysics,
} from './scene-physics.js';
import {
  calculateViewerPlaybackDuration,
  clipTimeForMode,
  createViewerSceneClock,
} from './viewer-scene-clock.js';

const DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/gltf/';

const AUDIO_SOURCE_EFFECT_TYPES = new Set([
  'audioSource.play',
  'audioSource.pause',
  'audioSource.stop',
  'audioSource.seek',
  'audioSource.playOneShot',
  'audioSource.setVolume',
  'audioSource.setClip',
  'audioSource.syncToAnimation',
  'audioSource.unsync',
]);

const TEXT_LAYOUT_DEFAULTS = Object.freeze({
  width: 2.4,
  height: 1.6,
  padding: 0.12,
  lineHeight: 1.35,
});

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function setVector3(target, values) {
  if (!target) return;
  if (typeof target.set === 'function') {
    target.set(values[0], values[1], values[2]);
  } else {
    target.x = values[0];
    target.y = values[1];
    target.z = values[2];
  }
}

function setQuaternion(target, values) {
  if (!target) return;
  if (typeof target.set === 'function') {
    target.set(values[0], values[1], values[2], values[3]);
  } else {
    target.x = values[0];
    target.y = values[1];
    target.z = values[2];
    target.w = values[3];
  }
}

function clonePosition(position) {
  if (!position) return null;
  if (typeof position.clone === 'function') return position.clone();
  return {
    x: Number(position.x || 0),
    y: Number(position.y || 0),
    z: Number(position.z || 0),
  };
}

function finiteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const OBJECT_TARGET_NODE_TYPES = new Set([
  'sceneSetPosition',
  'sceneOffsetPosition',
  'sceneSetRotation',
  'sceneSetScale',
  'sceneSetColor',
  'sceneSetVisible',
  'scene.setPosition',
  'scene.offsetPosition',
  'scene.setRotation',
  'scene.setScale',
  'scene.setColor',
  'scene.setVisible',
]);

function graphForRuntime(graph, scopeObjectId) {
  const cloned = cloneJson(graph);
  if (!scopeObjectId) return cloned;

  return {
    ...cloned,
    nodes: cloned.nodes.map((node) => {
      if (!OBJECT_TARGET_NODE_TYPES.has(node.type)) return node;
      const params = { ...(node.params || {}) };
      if (!params.target && !params.objectId) {
        params.target = scopeObjectId;
      }
      return { ...node, params };
    }),
  };
}

function createExportBehaviorRuntime(behaviorState, objectMap, audioController = null) {
  const runtimes = [];
  const behaviorBases = new Map();

  function applySceneEffect(effect, scopeKey) {
    if (effect?.type && AUDIO_SOURCE_EFFECT_TYPES.has(effect.type)) {
      audioController?.applyEffect(effect);
      return;
    }

    const objectId = effect?.objectId;
    if (!objectId) return;

    const object = objectMap.get(objectId);
    if (!object) return;

    if (effect.type === 'scene.setPosition' && Array.isArray(effect.position)) {
      setVector3(object.position, effect.position);
    } else if (effect.type === 'scene.offsetPosition' && Array.isArray(effect.offset)) {
      const baseKey = `${scopeKey}:${objectId}`;
      if (!behaviorBases.has(baseKey)) {
        const position = clonePosition(object.position);
        if (position) behaviorBases.set(baseKey, { target: objectId, position });
      }
      const base = behaviorBases.get(baseKey)?.position;
      if (base) {
        setVector3(object.position, [
          base.x + effect.offset[0],
          base.y + effect.offset[1],
          base.z + effect.offset[2],
        ]);
      }
    } else if (effect.type === 'scene.setRotation' && Array.isArray(effect.rotation)) {
      setQuaternion(object.quaternion || object.rotation, effect.rotation);
    } else if (effect.type === 'scene.setScale' && Array.isArray(effect.scale)) {
      setVector3(object.scale, effect.scale);
    } else if (effect.type === 'scene.setVisible') {
      object.visible = Boolean(effect.visible);
    } else if (effect.type === 'scene.setColor' && Array.isArray(effect.color)) {
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      material?.color?.setRGB?.(effect.color[0], effect.color[1], effect.color[2]);
    }
  }

  if (behaviorState?.bases && typeof behaviorState.bases === 'object') {
    for (const [key, base] of Object.entries(behaviorState.bases)) {
      if (!base?.position || !base.target) continue;
      const object = objectMap.get(base.target);
      if (object?.position) {
        setVector3(object.position, [base.position.x, base.position.y, base.position.z]);
      }
      behaviorBases.set(key, {
        target: base.target,
        position: { ...base.position },
      });
    }
  }

  function addRuntime(scopeKey, scope, graph) {
    const scopeObjectId = scope.type === 'object' ? scope.id : null;
    runtimes.push({
      scope,
      runtime: createSceneSyncRuntime(graphForRuntime(graph, scopeObjectId), {
        resolveTarget: (objectId) => objectMap.get(objectId) || null,
        applySceneEffect: (effect) => applySceneEffect(effect, scopeKey),
      }),
    });
  }

  if (behaviorState?.scene) {
    addRuntime('scene', { type: 'scene' }, behaviorState.scene);
  }
  if (behaviorState?.objects && typeof behaviorState.objects === 'object') {
    for (const [objectId, graph] of Object.entries(behaviorState.objects)) {
      if (graph) addRuntime(`object:${objectId}`, { type: 'object', id: objectId }, graph);
    }
  }

  return {
    tick(clockState = null, now = performance.now()) {
      const time = Number.isFinite(clockState?.t) ? clockState.t : now / 1000;
      for (const entry of runtimes) {
        entry.runtime.evaluateAt({ time, scope: entry.scope, events: [] }, now);
      }
    },
    dispose() {
      runtimes.length = 0;
      behaviorBases.clear();
    },
  };
}

function buildPrimitive(assetDef) {
  const color = assetDef.color || '#888888';
  const mat = new THREE.MeshStandardMaterial({ color });

  let geo;
  switch (assetDef.primitive) {
    case 'sphere':   geo = new THREE.SphereGeometry(0.5, 32, 16); break;
    case 'cylinder': geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 32); break;
    case 'cone':     geo = new THREE.ConeGeometry(0.5, 1, 32); break;
    case 'plane':    geo = new THREE.PlaneGeometry(1, 1); break;
    case 'torus':    geo = new THREE.TorusGeometry(0.5, 0.2, 16, 64); break;
    default:         geo = new THREE.BoxGeometry(1, 1, 1);
  }

  return new THREE.Mesh(geo, mat);
}

function applyTransform(obj, entry) {
  if (Array.isArray(entry.position) && entry.position.length >= 3) {
    obj.position.fromArray(entry.position);
  }
  if (Array.isArray(entry.rotation) && entry.rotation.length >= 4) {
    obj.quaternion.fromArray(entry.rotation);
  }
  if (Array.isArray(entry.scale) && entry.scale.length >= 3) {
    obj.scale.fromArray(entry.scale);
  }
  if (entry.visible === false) {
    obj.visible = false;
  }
}

function registerViewerObject(objectMap, entry, object) {
  object.userData.objectId = entry.id;
  if (entry.physics && typeof entry.physics === 'object') {
    object.userData.physics = cloneJson(entry.physics);
  }
  objectMap.set(entry.id, object);
}

function resolveAnimationClip(clips, animState) {
  const clipName = typeof animState?.clipName === 'string' ? animState.clipName.trim() : '';
  if (clipName) {
    const byName = clips.find((clip) => clip.name === clipName);
    if (byName) return byName;
  }

  const clipIndex = Number.isInteger(animState?.clip) ? animState.clip : 0;
  const safeIndex = Math.max(0, Math.min(clipIndex, clips.length - 1));
  return clips[safeIndex];
}

function setupAnimation(mixer, gltf, animState) {
  const clips = gltf.animations;
  if (!Array.isArray(clips) || clips.length === 0) return null;
  if (animState && animState.enabled === false) return null;

  const clip = resolveAnimationClip(clips, animState);

  const action = mixer.clipAction(clip);
  action.reset();

  const mode = animState?.mode === 'once' ? THREE.LoopOnce : THREE.LoopRepeat;
  action.setLoop(mode, Infinity);
  action.clampWhenFinished = mode === THREE.LoopOnce;

  const speed = Number.isFinite(animState?.speed) ? animState.speed : 1;
  action.timeScale = speed;

  const offset = Number.isFinite(animState?.offset) ? animState.offset : 0;
  if (offset !== 0 && Number.isFinite(clip.duration) && clip.duration > 0) {
    action.time = mode === THREE.LoopRepeat
      ? ((offset % clip.duration) + clip.duration) % clip.duration
      : Math.max(0, Math.min(offset, clip.duration));
  }

  action.play();
  const clipIndex = Math.max(0, clips.indexOf(clip));
  const playbackMode = animState?.mode === 'once' ? 'once' : 'loop';
  return {
    action,
    clip,
    clips,
    enabled: true,
    clipIndex,
    mode: playbackMode,
    speed,
    offset,
    sampleAt(sceneTime) {
      const baseTime = Number.isFinite(sceneTime) ? sceneTime : 0;
      const duration = clip.duration || 1;
      const t = baseTime * speed + offset;
      action.enabled = true;
      action.paused = false;
      action.time = clipTimeForMode(t, duration, playbackMode);
      mixer.update(0);
    },
    getSample(requestedClipName = null) {
      const name = typeof requestedClipName === 'string' ? requestedClipName.trim() : '';
      if (name && clip.name && name !== clip.name) return null;
      return {
        time: Number.isFinite(action.time) ? action.time : 0,
        duration: Number.isFinite(clip.duration) ? clip.duration : null,
      };
    },
  };
}

function getTextLayout(assetDef) {
  const layout = assetDef?.layout && typeof assetDef.layout === 'object'
    ? assetDef.layout
    : {};

  return {
    width: positiveNumber(layout.width, TEXT_LAYOUT_DEFAULTS.width),
    height: positiveNumber(layout.height, TEXT_LAYOUT_DEFAULTS.height),
    padding: Math.max(0, finiteNumber(layout.padding, TEXT_LAYOUT_DEFAULTS.padding)),
    lineHeight: positiveNumber(layout.lineHeight, TEXT_LAYOUT_DEFAULTS.lineHeight),
  };
}

function renderTextPanelTexture(assetDef, text) {
  const FONT_PRESETS = {
    'system-sans':    'system-ui, -apple-system, "Segoe UI", sans-serif',
    'serif':          'Georgia, "Times New Roman", serif',
    'monospace':      '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    'japanese-sans':  'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", "Meiryo", sans-serif',
    'japanese-serif': '"Hiragino Mincho ProN", "Yu Mincho", serif',
  };

  const layout = getTextLayout(assetDef);
  const pixelsPerUnit = 512;
  const cw = Math.max(256, Math.round(layout.width * pixelsPerUnit));
  const ch = Math.max(256, Math.round(layout.height * pixelsPerUnit));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;

  const ctx2d = canvas.getContext('2d');
  ctx2d.clearRect(0, 0, cw, ch);
  ctx2d.fillStyle = assetDef.backgroundColor || 'rgba(0,0,0,0.65)';
  ctx2d.fillRect(0, 0, cw, ch);

  const fontSize = positiveNumber(assetDef.fontSize, 32);
  const fontFamily = FONT_PRESETS[assetDef.fontFamily] || FONT_PRESETS['system-sans'];
  const fontWeight = assetDef.fontWeight || 'normal';
  const fontStyle = assetDef.fontStyle || 'normal';
  ctx2d.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
  ctx2d.fillStyle = assetDef.color || '#ffffff';
  ctx2d.textAlign = assetDef.align === 'left' ? 'left' : assetDef.align === 'right' ? 'right' : 'center';
  ctx2d.textBaseline = 'top';

  const paddingPx = layout.padding * pixelsPerUnit;
  const lineHeight = fontSize * layout.lineHeight;
  const scrollY = Math.max(0, finiteNumber(assetDef.scroll?.y, 0)) * pixelsPerUnit;
  const x = assetDef.align === 'left'
    ? paddingPx
    : assetDef.align === 'right'
      ? cw - paddingPx
      : cw / 2;

  let y = paddingPx - scrollY;
  for (const line of String(text || '').split(/\r?\n/)) {
    ctx2d.fillText(line, x, y, Math.max(1, cw - paddingPx * 2));
    y += lineHeight;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, width: layout.width, height: layout.height };
}

export async function createViewerCore({
  scene,
  renderer,
  pmremGenerator,
  sceneDoc,
  onMissingAsset,
  onProgress,
}) {
  if (!isValidSceneDocument(sceneDoc)) {
    throw new Error('Invalid scene document');
  }

  const resolver = createStaticAssetResolver();
  const objectMap = new Map();
  const animationSamples = new Map();
  const animationRuntimes = [];

  // Ambient + directional lights as fallback
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
  scene.add(ambientLight);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(5, 10, 7);
  scene.add(dirLight);

  // GLB loader with Draco
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  // Load environment (HDRI)
  let envLoaded = false;
  if (sceneDoc.skybox?.asset?.path) {
    try {
      const rgbeLoader = new RGBELoader();
      const texture = await rgbeLoader.loadAsync(resolver.resolveAsset(sceneDoc.skybox.asset));
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const envMap = pmremGenerator.fromEquirectangular(texture).texture;
      scene.environment = envMap;
      scene.background = envMap;
      texture.dispose();
      envLoaded = true;
    } catch {
      onMissingAsset?.({ kind: 'skybox', path: sceneDoc.skybox.asset.path });
    }
  }

  if (!envLoaded) {
    scene.background = new THREE.Color(0x222233);
  }

  const total = sceneDoc.objects.length;
  let loaded = 0;

  // Load scene objects
  for (const entry of sceneDoc.objects) {
    const assetDef = entry.asset;

    if (!assetDef || assetDef.type === 'primitive') {
      const mesh = buildPrimitive(assetDef || {});
      applyTransform(mesh, entry);
      scene.add(mesh);
      registerViewerObject(objectMap, entry, mesh);
    } else if (assetDef.type === 'image') {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'image', reason: 'no path or url' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const texture = await new THREE.TextureLoader().loadAsync(assetPath);
        texture.colorSpace = THREE.SRGBColorSpace;

        const aspect = (texture.image.width / texture.image.height) || 1;
        const maxEdge = 2;
        const w = aspect >= 1 ? maxEdge : Math.max(maxEdge * aspect, 0.1);
        const h = aspect >= 1 ? Math.max(maxEdge / aspect, 0.1) : maxEdge;

        const geo = new THREE.PlaneGeometry(w, h);
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = h / 2; // align origin to bottom edge, matching web runtime

        const group = new THREE.Group();
        group.add(mesh);
        applyTransform(group, entry);
        scene.add(group);
        registerViewerObject(objectMap, entry, group);
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'image', path: assetPath });
      }
    } else if (assetDef.type === 'video') {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'video', reason: 'no path or url' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.loop = true;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';

        // Wait for real dimensions before building geometry
        await new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
          video.src = assetPath;
        });

        const aspect = (video.videoWidth / video.videoHeight) || (16 / 9);
        const maxEdge = 2;
        const videoW = aspect >= 1 ? maxEdge : Math.max(maxEdge * aspect, 0.1);
        const videoH = aspect >= 1 ? Math.max(maxEdge / aspect, 0.1) : maxEdge;

        const texture = new THREE.VideoTexture(video);
        texture.colorSpace = THREE.SRGBColorSpace;

        const geo = new THREE.PlaneGeometry(videoW, videoH);
        const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = videoH / 2; // align origin to bottom edge, matching web runtime

        const group = new THREE.Group();
        group.add(mesh);
        applyTransform(group, entry);
        scene.add(group);
        registerViewerObject(objectMap, entry, group);

        video.autoplay = true;
        video.play().catch(() => {});
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'video', path: assetPath });
      }
    } else if (assetDef.type === 'text') {
      let text = '';
      if (assetDef.source === 'inline') {
        text = assetDef.text || '';
      } else {
        const assetPath = resolver.resolveAsset(assetDef);
        if (assetPath) {
          try {
            const res = await fetch(assetPath);
            if (res.ok) text = await res.text();
          } catch {}
        }
      }

      const { texture, width, height } = renderTextPanelTexture(assetDef, text);
      const geo = new THREE.PlaneGeometry(width, height);
      const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = height / 2; // align origin to bottom edge, matching web runtime

      const group = new THREE.Group();
      group.add(mesh);
      applyTransform(group, entry);
      scene.add(group);
      registerViewerObject(objectMap, entry, group);
    } else {
      const assetPath = resolver.resolveAsset(assetDef);
      if (!assetPath) {
        onMissingAsset?.({ id: entry.id, kind: 'mesh', reason: 'no path' });
        loaded++;
        onProgress?.(loaded / total);
        continue;
      }

      try {
        const gltf = await gltfLoader.loadAsync(assetPath);

        if (assetDef.visualBasis === 'unity') {
          gltf.scene.rotation.y = Math.PI;
        }

        const wrapper = new THREE.Group();
        wrapper.add(gltf.scene);
        applyTransform(wrapper, entry);
        scene.add(wrapper);
        registerViewerObject(objectMap, entry, wrapper);

        if (Array.isArray(gltf.animations) && gltf.animations.length > 0) {
          const mixer = new THREE.AnimationMixer(wrapper);
          const animationRuntime = setupAnimation(mixer, gltf, entry.animation);
          if (animationRuntime) {
            animationRuntimes.push(animationRuntime);
            animationSamples.set(entry.id, animationRuntime);
          }
        }
      } catch {
        onMissingAsset?.({ id: entry.id, kind: 'mesh', path: assetPath });
      }
    }

    loaded++;
    onProgress?.(loaded / total);
  }

  const objectAudioController = createObjectAudioController({
    sceneDoc,
    resolver,
    onMissingAsset,
    getAnimationSample: (objectId, clipName) => animationSamples.get(objectId)?.getSample(clipName) || null,
  });

  // BGM setup - returns control object
  let bgmAudio = null;
  let bgmReady = false;
  if (sceneDoc.bgm?.asset?.path) {
    const bgmPath = resolver.resolveAsset(sceneDoc.bgm.asset);
    if (bgmPath) {
      bgmAudio = new Audio(bgmPath);
      bgmAudio.loop = sceneDoc.bgm.loop !== false;
      bgmAudio.volume = Math.max(0, Math.min(1, sceneDoc.bgm.volume ?? 1));
      bgmAudio.preload = 'auto';
      bgmReady = true;
    }
  }

  // Loomlet behavior graph runtime
  let loomAdapter = null;
  if (sceneDoc.behaviors) {
    loomAdapter = createExportBehaviorRuntime(sceneDoc.behaviors, objectMap, objectAudioController);
  }

  const physicsState = normalizeScenePhysics(sceneDoc.physics);
  const sceneClock = createViewerSceneClock({
    duration: calculateViewerPlaybackDuration({
      animationEntries: animationRuntimes,
      physicsDuration: physicsState.enabled ? physicsState.duration : 0,
    }),
  });
  const physicsRuntime = createScenePhysicsRuntime({
    getScenePhysics: () => physicsState,
    getObjectEntries: () => (sceneDoc.objects || []).map((entry) => ({
      objectId: entry.id,
      object: objectMap.get(entry.id),
      physics: entry.physics,
    })),
    isClockActive: (clockState) => clockState?.transportActive === true,
  });

  function evaluateSceneAtClock(clockState) {
    const time = Number.isFinite(clockState?.t) ? clockState.t : 0;
    for (const runtime of animationRuntimes) {
      runtime.sampleAt(time);
    }
    if (!physicsState.enabled) return;
    physicsRuntime.update(clockState);
  }

  const commands = {
    playSceneClock() {
      sceneClock.play();
    },
    pauseSceneClock() {
      sceneClock.pause();
    },
    stopSceneClock() {
      sceneClock.stop();
      evaluateSceneAtClock(sceneClock.getState());
    },
    seekSceneClock(seconds) {
      sceneClock.seek(seconds);
      evaluateSceneAtClock(sceneClock.getState());
    },
    setSceneClockRate(rate) {
      sceneClock.setRate(rate);
    },
    activateSceneClockTransport() {
      sceneClock.activateTransport();
      evaluateSceneAtClock(sceneClock.getState());
    },
    deactivateSceneClockTransport() {
      sceneClock.deactivateTransport();
      evaluateSceneAtClock(sceneClock.getState());
    },
  };

  const api = {
    update() {
      const now = performance.now();
      const clockState = sceneClock.tick(now);
      evaluateSceneAtClock(clockState);
      if (loomAdapter) {
        loomAdapter.tick(clockState, now);
      }
      objectAudioController.tick(now);
    },

    getSceneClockState() {
      return sceneClock.getState();
    },

    onStateChange(listener) {
      return sceneClock.onChange(listener);
    },

    commands,

    hasPhysics() {
      return physicsState.enabled && physicsRuntime.hasBodies();
    },

    getPhysicsPlaybackState() {
      const state = sceneClock.getState();
      return { time: state.time, duration: state.duration, playing: state.playing };
    },

    playPhysics() {
      commands.playSceneClock();
    },

    pausePhysics() {
      commands.pauseSceneClock();
    },

    resetPhysics() {
      commands.stopSceneClock();
    },

    seekPhysics(time) {
      commands.seekSceneClock(time);
    },

    getBgmAudio() {
      return bgmReady ? bgmAudio : null;
    },

    getObjectAudioElements() {
      return objectAudioController.elements;
    },

    hasObjectAudioSources() {
      return objectAudioController.hasAudioSources();
    },

    hasObjectAudioPlaybackTargets() {
      return objectAudioController.hasPlaybackTargets();
    },

    getObjectAudioPlaybackElements() {
      return objectAudioController.getPlaybackTargetElements();
    },

    unlockObjectAudio() {
      return objectAudioController.unlockAudio();
    },

    isObjectAudioUnlocked() {
      return objectAudioController.isAudioUnlocked();
    },

    playObjectAudioPlaybackTargets() {
      return objectAudioController.playPlaybackTargets();
    },

    pauseObjectAudioPlaybackTargets() {
      objectAudioController.pausePlaybackTargets();
    },

    dispose() {
      dracoLoader.dispose();
      bgmAudio?.pause();
      objectAudioController.dispose();
      loomAdapter?.dispose?.();
      physicsRuntime.dispose();
    },
  };

  return api;
}
