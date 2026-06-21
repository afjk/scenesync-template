import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createViewerCore } from './create-viewer-core.js';
import { createPlayerTransportPanel } from './player-transport.js';

// Resolve scene.json relative to the document root, not the script location
const BASE_URL = new URL('./', document.baseURI).href;

function resolveFromRoot(path) {
  return new URL(path, BASE_URL).href;
}

function isTextInputTarget(target) {
  const tagName = target?.tagName?.toLowerCase?.();
  return tagName === 'input'
    || tagName === 'textarea'
    || tagName === 'select'
    || target?.isContentEditable === true;
}

function createKeyboardCameraNavigation({ camera, controls, domElement }) {
  const pressed = new Set();
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();
  const offset = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  function normalizeKey(key) {
    return String(key || '').toLowerCase();
  }

  function isMovementKey(key) {
    return key === 'w' || key === 'a' || key === 's' || key === 'd' || key === 'e' || key === 'q';
  }

  function handleKeyDown(event) {
    if (event.defaultPrevented || isTextInputTarget(event.target)) return;
    const key = normalizeKey(event.key);
    if (key === 'shift') {
      pressed.add(key);
      return;
    }
    if (!isMovementKey(key)) return;
    pressed.add(key);
    event.preventDefault();
  }

  function handleKeyUp(event) {
    const key = normalizeKey(event.key);
    if (key === 'shift') {
      pressed.delete(key);
      return;
    }
    if (!isMovementKey(key)) return;
    pressed.delete(key);
    event.preventDefault();
  }

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', () => pressed.clear());

  return {
    update(deltaSeconds) {
      if (pressed.size === 0) return;

      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 0.0001) {
        forward.set(0, 0, -1);
      } else {
        forward.normalize();
      }
      right.crossVectors(forward, up).normalize();

      offset.set(0, 0, 0);
      if (pressed.has('w')) offset.add(forward);
      if (pressed.has('s')) offset.sub(forward);
      if (pressed.has('d')) offset.add(right);
      if (pressed.has('a')) offset.sub(right);
      if (pressed.has('e')) offset.y += 1;
      if (pressed.has('q')) offset.y -= 1;

      if (offset.lengthSq() === 0) return;
      const speed = pressed.has('shift') ? 8 : 3.5;
      offset.normalize().multiplyScalar(speed * Math.max(0, deltaSeconds));
      camera.position.add(offset);
      controls.target.add(offset);
      controls.update();
      domElement?.focus?.();
    },
  };
}

function createXrSessionInit(mode) {
  if (mode === 'immersive-ar') {
    return {
      optionalFeatures: ['local-floor', 'bounded-floor', 'hit-test', 'dom-overlay'],
      domOverlay: { root: document.body },
    };
  }
  return {
    optionalFeatures: ['local-floor', 'bounded-floor'],
  };
}

async function main() {
  const fileWarning = document.getElementById('file-protocol-warning');
  const loadingOverlay = document.getElementById('loading-overlay');
  const missingNotice = document.getElementById('missing-notice');
  const controlsEl = document.getElementById('viewer-controls');

  if (location.protocol === 'file:') {
    fileWarning?.classList.remove('hidden');
    loadingOverlay?.classList.add('hidden');
    return;
  }

  let sceneDoc;
  try {
    const res = await fetch(resolveFromRoot('scene.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sceneDoc = await res.json();
  } catch (err) {
    if (loadingOverlay) loadingOverlay.textContent = `Failed to load scene.json: ${err.message}`;
    return;
  }

  // Build Three.js app
  const canvas = document.getElementById('viewer-canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearAlpha(1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  renderer.domElement.tabIndex = 0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 1.6, 5);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();
  const keyboardNavigation = createKeyboardCameraNavigation({
    camera,
    controls,
    domElement: renderer.domElement,
  });

  const missingAssets = [];

  // Rewrite asset paths to be absolute from root
  const docWithAbsolutePaths = rewriteAssetPaths(sceneDoc);

  let viewerCore;
  try {
    viewerCore = await createViewerCore({
      scene,
      renderer,
      pmremGenerator,
      sceneDoc: docWithAbsolutePaths,
      onMissingAsset: (info) => missingAssets.push(info),
      onProgress: (pct) => {
        if (loadingOverlay) loadingOverlay.textContent = `Loading… ${Math.round(pct * 100)}%`;
      },
    });
  } catch (err) {
    if (loadingOverlay) loadingOverlay.textContent = `Failed to load scene: ${err.message}`;
    return;
  }

  loadingOverlay?.classList.add('hidden');

  if (missingAssets.length > 0) {
    if (missingNotice) {
      missingNotice.textContent = `${missingAssets.length} asset(s) could not be loaded`;
      missingNotice.classList.remove('hidden');
    }
  }

  const playerTransport = createPlayerTransportPanel({
    title: 'SCENE SYNC · VIEWER',
    activateOnMount: true,
  });
  await playerTransport.mount({ core: viewerCore, root: document.body });

  // BGM button
  const bgmAudio = viewerCore.getBgmAudio();
  if (bgmAudio && controlsEl) {
    const bgmBtn = document.createElement('button');
    bgmBtn.className = 'viewer-btn';
    bgmBtn.textContent = '▶ Play BGM';
    let playing = false;
    bgmBtn.addEventListener('click', () => {
      if (playing) {
        bgmAudio.pause();
        bgmBtn.textContent = '▶ Play BGM';
        playing = false;
      } else {
        bgmAudio.play().then(() => {
          bgmBtn.textContent = '⏸ Pause BGM';
          playing = true;
        }).catch(() => {});
      }
    });
    controlsEl.appendChild(bgmBtn);
  }

  const objectAudioElements = viewerCore.getObjectAudioElements?.() || [];
  const hasObjectAudioSources = viewerCore.hasObjectAudioSources?.() ?? objectAudioElements.length > 0;
  const hasPlaybackTargets = viewerCore.hasObjectAudioPlaybackTargets?.()
    ?? (viewerCore.getObjectAudioPlaybackElements?.() || []).length > 0;

  if (hasObjectAudioSources && !hasPlaybackTargets && controlsEl) {
    const enableBtn = document.createElement('button');
    enableBtn.className = 'viewer-btn';
    enableBtn.textContent = 'Enable Audio';
    let pending = false;
    enableBtn.addEventListener('click', async () => {
      if (pending || viewerCore.isObjectAudioUnlocked?.()) return;
      pending = true;
      enableBtn.disabled = true;
      enableBtn.textContent = 'Enabling Audio...';

      const unlocked = await Promise.resolve(viewerCore.unlockObjectAudio?.()).catch(() => false);
      if (unlocked || viewerCore.isObjectAudioUnlocked?.()) {
        enableBtn.textContent = 'Audio Enabled';
      } else {
        enableBtn.textContent = 'Enable Audio';
        enableBtn.disabled = false;
      }
      pending = false;
    });
    controlsEl.appendChild(enableBtn);
  }

  let pendingXrMode = null;
  let savedSceneBackground = null;
  renderer.xr.addEventListener('sessionstart', () => {
    const session = renderer.xr.getSession();
    const isArSession = pendingXrMode === 'immersive-ar' || session?.environmentBlendMode !== 'opaque';
    if (isArSession) {
      savedSceneBackground = scene.background;
      scene.background = null;
      renderer.setClearAlpha(0);
    }
    pendingXrMode = null;
  });
  renderer.xr.addEventListener('sessionend', () => {
    if (savedSceneBackground !== null) {
      scene.background = savedSceneBackground;
      savedSceneBackground = null;
    }
    renderer.setClearAlpha(1);
    pendingXrMode = null;
  });

  // Immersive entry buttons
  if (navigator.xr && controlsEl) {
    for (const mode of ['immersive-vr', 'immersive-ar']) {
      const supported = await navigator.xr.isSessionSupported(mode).catch(() => false);
      if (!supported) continue;

      const label = mode === 'immersive-ar' ? 'Enter AR' : 'Enter VR';
      const xrBtn = document.createElement('button');
      xrBtn.className = 'viewer-btn';
      xrBtn.textContent = label;
      xrBtn.addEventListener('click', async () => {
        try {
          pendingXrMode = mode;
          const session = await navigator.xr.requestSession(mode, createXrSessionInit(mode));
          await renderer.xr.setSession(session);
        } catch (e) {
          pendingXrMode = null;
          console.warn('[viewer] XR session failed:', e);
        }
      });
      controlsEl.appendChild(xrBtn);
    }
  }

  // Resize handling
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Render loop
  let lastFrameNow = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const deltaSeconds = Math.min(0.1, Math.max(0, (now - lastFrameNow) / 1000));
    lastFrameNow = now;
    if (!renderer.xr.isPresenting) {
      keyboardNavigation.update(deltaSeconds);
    }
    viewerCore.update();
    controls.update();
    renderer.render(scene, camera);
  });
}

function rewriteAssetPaths(doc) {
  if (!doc) return doc;

  const objects = (doc.objects || []).map(obj => {
    const audioSources = rewriteAudioSourcePaths(obj.audioSources);
    if (!obj.asset?.path) {
      return audioSources === obj.audioSources ? obj : { ...obj, audioSources };
    }
    return {
      ...obj,
      asset: {
        ...obj.asset,
        path: resolveFromRoot(obj.asset.path),
      },
      audioSources,
    };
  });

  let skybox = doc.skybox;
  if (skybox?.asset?.path) {
    skybox = {
      ...skybox,
      asset: { ...skybox.asset, path: resolveFromRoot(skybox.asset.path) },
    };
  }

  let bgm = doc.bgm;
  if (bgm?.asset?.path) {
    bgm = { ...bgm, asset: { ...bgm.asset, path: resolveFromRoot(bgm.asset.path) } };
  }

  return { ...doc, objects, skybox, bgm };
}

function rewriteAudioSourcePaths(audioSources) {
  if (!audioSources || typeof audioSources !== 'object' || Array.isArray(audioSources)) {
    return audioSources;
  }

  let changed = false;
  const updated = {};
  for (const [name, source] of Object.entries(audioSources)) {
    if (source?.asset?.path) {
      changed = true;
      updated[name] = {
        ...source,
        asset: {
          ...source.asset,
          path: resolveFromRoot(source.asset.path),
        },
      };
    } else {
      updated[name] = source;
    }
  }
  return changed ? updated : audioSources;
}

main();
