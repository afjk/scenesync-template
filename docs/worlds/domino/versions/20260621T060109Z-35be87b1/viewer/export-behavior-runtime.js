import { createSceneSyncRuntime } from './loomlet/loomlet-scenesync-runtime.browser.js';

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

const EVENT_TYPE_ALIASES = new Map([
  ['collision.enter', 'physics.collision.enter'],
  ['collision.exit', 'physics.collision.exit'],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function stringifyText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

function normalizeEventType(type) {
  const value = stringifyText(type).trim();
  return EVENT_TYPE_ALIASES.get(value) || value;
}

function finiteOption(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function triggerIsActive(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

function graphForRuntime(graph, scopeObjectId) {
  const cloned = cloneJson(graph);
  if (!scopeObjectId || !Array.isArray(cloned?.nodes)) return cloned;

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

export function eventMatchesScope(event, scope) {
  if (!event || !scope) return false;
  if (scope.type === 'scene') return true;
  if (scope.type !== 'object') return true;

  const objectId = stringifyText(scope.id);
  if (!objectId) return false;

  return event.objectIdA === objectId ||
    event.objectIdB === objectId ||
    event.objectId === objectId ||
    event.target === objectId ||
    (Array.isArray(event.targets) && event.targets.includes(objectId));
}

export function filterRuntimeEventsForScope(events, scope) {
  if (!Array.isArray(events)) return [];
  return events.filter((event) => eventMatchesScope(event, scope));
}

export function toLoomletRuntimeEvent(event) {
  if (!isObject(event)) return null;
  const eventType = normalizeEventType(event.type ?? event.channel);
  const timestamp = Number.isFinite(event.timestamp)
    ? event.timestamp
    : Number.isFinite(event.time)
      ? event.time
      : 0;
  return {
    ...event,
    type: event.type ?? eventType,
    channel: typeof event.channel === 'string' ? event.channel : eventType,
    timestamp,
  };
}

function prepareLoomletEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(toLoomletRuntimeEvent).filter(Boolean);
}

function eventsForType(events, type) {
  const requestedType = normalizeEventType(type);
  if (!requestedType) return events;
  return events.filter((event) => (
    normalizeEventType(event.type ?? event.channel) === requestedType ||
    normalizeEventType(event.channel) === requestedType
  ));
}

function runtimeEvents(ctx, type) {
  return eventsForType(Array.isArray(ctx.env?.events) ? ctx.env.events : [], type);
}

function optionBag(inputs) {
  const options = {};
  const volume = finiteOption(inputs.volume);
  const playbackRate = finiteOption(inputs.playbackRate);
  const offset = finiteOption(inputs.offset);
  const url = stringifyText(inputs.url).trim();
  if (volume !== undefined) options.volume = volume;
  if (playbackRate !== undefined) options.playbackRate = playbackRate;
  if (offset !== undefined) options.offset = offset;
  if (url) options.url = url;
  return options;
}

export function createExportBehaviorNodeTypes() {
  const audioSourcePlayOneShot = {
    inputs: [
      { name: 'trigger', default: true },
      { name: 'objectId', default: '' },
      { name: 'name', default: 'default' },
      { name: 'volume', default: undefined },
      { name: 'playbackRate', default: undefined },
      { name: 'offset', default: undefined },
      { name: 'url', default: '' },
    ],
    params: [
      { name: 'trigger', default: true },
      { name: 'objectId', default: '' },
      { name: 'name', default: 'default' },
      { name: 'volume', default: undefined },
      { name: 'playbackRate', default: undefined },
      { name: 'offset', default: undefined },
      { name: 'url', default: '' },
      { name: 'target', default: '' },
    ],
    evaluate: (inputs, params, ctx) => {
      if (!triggerIsActive(inputs.trigger)) return {};
      const inputObjectId = stringifyText(inputs.objectId ?? params.objectId).trim();
      const targetObjectId = stringifyText(params.target).trim();
      const objectId = inputObjectId || targetObjectId || stringifyText(ctx.scopeObjectId).trim();
      if (!objectId) return {};

      const name = stringifyText(inputs.name ?? params.name).trim() || 'default';
      ctx.recordEffect({
        type: 'audioSource.playOneShot',
        objectId,
        name,
        options: optionBag(inputs),
        target: 'scenesync',
        nodeId: ctx.currentNodeId,
      });
      return {};
    },
  };

  return {
    'event.exists': {
      inputs: [{ name: 'type', default: '' }],
      outputs: [{ name: 'out', default: false }],
      params: [{ name: 'type', default: '' }],
      evaluate: (inputs, params, ctx) => ({
        out: runtimeEvents(ctx, inputs.type ?? params.type).length > 0,
      }),
    },
    'event.count': {
      inputs: [{ name: 'type', default: '' }],
      outputs: [{ name: 'out', default: 0 }],
      params: [{ name: 'type', default: '' }],
      evaluate: (inputs, params, ctx) => ({
        out: runtimeEvents(ctx, inputs.type ?? params.type).length,
      }),
    },
    'event.first': {
      inputs: [{ name: 'type', default: '' }],
      outputs: [{ name: 'out', default: null }],
      params: [{ name: 'type', default: '' }],
      evaluate: (inputs, params, ctx) => ({
        out: runtimeEvents(ctx, inputs.type ?? params.type)[0] || null,
      }),
    },
    'event.field': {
      inputs: [
        { name: 'event', default: null },
        { name: 'field', default: '' },
        { name: 'default', default: null },
      ],
      outputs: [{ name: 'out' }],
      params: [
        { name: 'field', default: '' },
        { name: 'default', default: null },
      ],
      evaluate: (inputs, params) => {
        const event = inputs.event;
        const field = stringifyText(inputs.field ?? params.field);
        if (!isObject(event) || !field || !Object.prototype.hasOwnProperty.call(event, field)) {
          return { out: inputs.default ?? params.default ?? null };
        }
        return { out: event[field] };
      },
    },
    'event.otherObject': {
      inputs: [{ name: 'event', default: null }],
      outputs: [{ name: 'out', default: null }],
      evaluate: (inputs, params, ctx) => {
        const event = inputs.event;
        const scopeObjectId = stringifyText(ctx.env?.scope?.id ?? ctx.scopeObjectId);
        if (!isObject(event) || !scopeObjectId) return { out: null };
        if (event.objectIdA === scopeObjectId) return { out: event.objectIdB ?? null };
        if (event.objectIdB === scopeObjectId) return { out: event.objectIdA ?? null };
        return { out: null };
      },
    },
    'audioSource.playOneShot': audioSourcePlayOneShot,
    audioSourcePlayOneShot,
  };
}

function normalizeAudioSourceEffect(effect, scope) {
  const directObjectId = stringifyText(effect?.objectId).trim();
  const targetObjectId = effect?.target === 'scenesync' ? '' : stringifyText(effect?.target).trim();
  const scopeObjectId = scope?.type === 'object' ? stringifyText(scope.id).trim() : '';
  const objectId = directObjectId || targetObjectId || scopeObjectId;
  if (!objectId) return null;

  const name = stringifyText(effect?.name).trim() || 'default';
  const normalized = { ...effect, objectId, name };
  if (effect?.type === 'audioSource.playOneShot') {
    normalized.options = isObject(effect.options) ? { ...effect.options } : {};
    for (const key of ['volume', 'playbackRate', 'offset']) {
      const value = finiteOption(effect[key]);
      if (value !== undefined) normalized.options[key] = value;
    }
    const url = stringifyText(effect.url).trim();
    if (url) normalized.options.url = url;
  }
  return normalized;
}

export function createExportBehaviorRuntime(behaviorState, objectMap, audioController = null, options = {}) {
  const runtimes = [];
  const behaviorBases = new Map();
  const createRuntime = options.createRuntime || createSceneSyncRuntime;
  const nodeTypes = {
    ...createExportBehaviorNodeTypes(),
    ...(options.nodeTypes || {}),
  };
  let currentScheduleContext = null;

  const audioSource = {
    play(objectId, name = 'default') {
      audioController?.applyEffect({ type: 'audioSource.play', objectId, name });
    },
    pause(objectId, name = 'default') {
      audioController?.applyEffect({ type: 'audioSource.pause', objectId, name });
    },
    stop(objectId, name = 'default') {
      audioController?.applyEffect({ type: 'audioSource.stop', objectId, name });
    },
    seek(objectId, seconds, name = 'default') {
      audioController?.applyEffect({ type: 'audioSource.seek', objectId, name, time: seconds });
    },
    playOneShot(objectId, name = 'default', options = {}) {
      audioController?.applyEffect({ type: 'audioSource.playOneShot', objectId, name, options });
    },
  };

  function applySceneEffect(effect, scopeKey, scope) {
    if (effect?.type && AUDIO_SOURCE_EFFECT_TYPES.has(effect.type)) {
      const normalizedEffect = normalizeAudioSourceEffect(effect, scope);
      if (normalizedEffect) audioController?.applyEffect(normalizedEffect);
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
      runtime: createRuntime(graphForRuntime(graph, scopeObjectId), {
        resolveTarget: (objectId) => objectMap.get(objectId) || null,
        applySceneEffect: (effect) => applySceneEffect(effect, scopeKey, scope),
        nodeTypes,
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
      const runtimeEvents = Array.isArray(currentScheduleContext?.events) ? currentScheduleContext.events : [];
      const collisionEvents = Array.isArray(currentScheduleContext?.collisionEvents)
        ? currentScheduleContext.collisionEvents
        : [];

      for (const entry of runtimes) {
        const scopedEvents = prepareLoomletEvents(filterRuntimeEventsForScope(runtimeEvents, entry.scope));
        const scopedCollisionEvents = prepareLoomletEvents(filterRuntimeEventsForScope(collisionEvents, entry.scope));
        entry.runtime.evaluateAt({
          time,
          scope: entry.scope,
          events: scopedEvents,
          collisionEvents: scopedCollisionEvents,
        }, now);
      }
    },

    setScheduleContext(scheduleContext) {
      currentScheduleContext = scheduleContext || null;
    },

    getRuntimeEvents() {
      return currentScheduleContext?.events || [];
    },

    getCollisionEvents() {
      return currentScheduleContext?.collisionEvents || [];
    },

    audioSource,

    dispose() {
      runtimes.length = 0;
      behaviorBases.clear();
      currentScheduleContext = null;
    },
  };
}
