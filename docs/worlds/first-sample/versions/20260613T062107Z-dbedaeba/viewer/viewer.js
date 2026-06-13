import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createViewerCore } from './create-viewer-core.js';

// Resolve scene.json relative to the document root, not the script location
const BASE_URL = new URL('./', document.baseURI).href;

function resolveFromRoot(path) {
  return new URL(path, BASE_URL).href;
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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 1000);
  camera.position.set(0, 1.6, 5);

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1, 0);
  controls.update();

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

  if (hasObjectAudioSources && hasPlaybackTargets && controlsEl) {
    const audioBtn = document.createElement('button');
    audioBtn.className = 'viewer-btn';
    audioBtn.textContent = '▶ Play Audio';
    let playing = false;
    let pending = false;
    audioBtn.addEventListener('click', async () => {
      if (pending) return;
      if (playing) {
        viewerCore.pauseObjectAudioPlaybackTargets?.();
        audioBtn.textContent = '▶ Play Audio';
        playing = false;
      } else {
        const playbackElements = viewerCore.getObjectAudioPlaybackElements?.() || [];
        if (playbackElements.length > 0) {
          pending = true;
          audioBtn.disabled = true;
          await Promise.resolve(viewerCore.unlockObjectAudio?.()).catch(() => false);
          const results = await Promise.resolve(viewerCore.playObjectAudioPlaybackTargets?.()).catch(() => []);
          if (Array.isArray(results) && results.some((result) => (
            result.status === 'fulfilled' && result.value === true
          ))) {
            audioBtn.textContent = '⏸ Pause Audio';
            playing = true;
          }
          audioBtn.disabled = false;
          pending = false;
        }
      }
    });
    controlsEl.appendChild(audioBtn);
  } else if (hasObjectAudioSources && controlsEl) {
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

  // Immersive entry button
  if (navigator.xr && controlsEl) {
    for (const mode of ['immersive-vr', 'immersive-ar']) {
      const supported = await navigator.xr.isSessionSupported(mode).catch(() => false);
      if (supported) {
        const label = mode === 'immersive-ar' ? 'Enter AR' : 'Enter VR';
        const xrBtn = document.createElement('button');
        xrBtn.className = 'viewer-btn';
        xrBtn.textContent = label;
        xrBtn.addEventListener('click', async () => {
          try {
            const session = await navigator.xr.requestSession(mode, {
              optionalFeatures: ['local-floor', 'bounded-floor'],
            });
            renderer.xr.setSession(session);
          } catch (e) {
            console.warn('[viewer] XR session failed:', e);
          }
        });
        controlsEl.appendChild(xrBtn);
        break;
      }
    }
  }

  // Resize handling
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Render loop
  renderer.setAnimationLoop(() => {
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
