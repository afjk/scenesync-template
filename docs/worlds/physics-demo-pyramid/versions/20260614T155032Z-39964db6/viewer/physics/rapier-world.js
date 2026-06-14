import RAPIER from '@dimforge/rapier3d-compat';

export const RAPIER_PHYSICS_ENGINE = 'rapier';
export const RAPIER_PACKAGE_VERSION = '0.19.3';
export const DEFAULT_TIMESTEP_SECONDS = 1 / 60;
export const DEFAULT_MAX_STEPS_PER_UPDATE = 900;
export const DEFAULT_CHECKPOINT_INTERVAL_TICKS = 120;

const MAX_GROUND_HALF_EXTENT = 4096;
const GROUND_THICKNESS = 0.1;

let rapierInitPromise = null;
let rapierReady = false;
let rapierInitError = null;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function clampNumber(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return Math.max(min, Math.min(max, fallback));
  return Math.max(min, Math.min(max, number));
}

function readVec3(value, fallback = [0, 0, 0]) {
  if (!Array.isArray(value) || value.length < 3) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0] || 0),
    finiteNumber(value[1], fallback[1] || 0),
    finiteNumber(value[2], fallback[2] || 0),
  ];
}

function readPositiveVec3(value, fallback) {
  return readVec3(value, fallback).map((component, index) => (
    positiveNumber(component, fallback[index] || 0.5)
  ));
}

function readQuat(value, fallback = [0, 0, 0, 1]) {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  const quat = [
    finiteNumber(value[0], fallback[0] || 0),
    finiteNumber(value[1], fallback[1] || 0),
    finiteNumber(value[2], fallback[2] || 0),
    finiteNumber(value[3], fallback[3] ?? 1),
  ];
  const length = Math.hypot(quat[0], quat[1], quat[2], quat[3]);
  if (!Number.isFinite(length) || length <= 0) return [...fallback];
  return quat.map((component) => component / length);
}

function vectorObject(value, fallback = [0, 0, 0]) {
  const vec = readVec3(value, fallback);
  return { x: vec[0], y: vec[1], z: vec[2] };
}

function quaternionObject(value, fallback = [0, 0, 0, 1]) {
  const quat = readQuat(value, fallback);
  return { x: quat[0], y: quat[1], z: quat[2], w: quat[3] };
}

function readRotationArray(rotation) {
  if (Array.isArray(rotation)) return readQuat(rotation);
  if (rotation && typeof rotation === 'object') {
    return readQuat([rotation.x, rotation.y, rotation.z, rotation.w]);
  }
  return [0, 0, 0, 1];
}

function hashInit() {
  return 0x811c9dc5;
}

function hashByte(hash, byte) {
  return Math.imul(hash ^ (byte & 0xff), 0x01000193) >>> 0;
}

function hashInt(hash, value) {
  const int = value >>> 0;
  let next = hashByte(hash, int);
  next = hashByte(next, int >>> 8);
  next = hashByte(next, int >>> 16);
  return hashByte(next, int >>> 24);
}

function hashNumber(hash, value) {
  const scaled = Number.isFinite(value) ? Math.round(value * 1_000_000) : 0;
  return hashInt(hash, scaled);
}

function hashString(hash, value) {
  let next = hash;
  for (const char of String(value)) {
    next = hashByte(next, char.charCodeAt(0));
  }
  return hashByte(next, 0);
}

function hashBytes(hash, bytes) {
  let next = hash;
  for (const byte of bytes || []) next = hashByte(next, byte);
  return next;
}

export function initRapierPhysics() {
  if (rapierReady) return Promise.resolve(RAPIER);
  if (!rapierInitPromise) {
    const originalWarn = console.warn;
    console.warn = (...args) => {
      const message = String(args[0] ?? '');
      if (message.includes('using deprecated parameters for the initialization function')) return;
      originalWarn(...args);
    };
    rapierInitPromise = RAPIER.init()
      .then(() => {
        rapierReady = true;
        rapierInitError = null;
        return RAPIER;
      })
      .catch((error) => {
        rapierInitError = error;
        rapierInitPromise = null;
        throw error;
      })
      .finally(() => {
        console.warn = originalWarn;
      });
  }
  return rapierInitPromise;
}

export function isRapierPhysicsReady() {
  return rapierReady;
}

export function getRapierPhysicsInitError() {
  return rapierInitError;
}

export function normalizeRapierWorldOptions(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const gravity = Array.isArray(source.gravity)
    ? readVec3(source.gravity, [0, -9.81, 0])
    : [0, finiteNumber(source.gravity, -9.81), 0];
  const timestep = positiveNumber(source.timestep, DEFAULT_TIMESTEP_SECONDS);
  const groundSource = source.ground;
  const ground = groundSource === null || groundSource === false
    ? null
    : {
        y: finiteNumber(groundSource?.y, 0),
        restitution: clampNumber(groundSource?.restitution, 0, 1, 0.2),
        friction: clampNumber(groundSource?.friction, 0, 4, 0.5),
      };

  return {
    engine: RAPIER_PHYSICS_ENGINE,
    gravity,
    ground,
    timestep,
    maxStepsPerUpdate: Number.isInteger(source.maxStepsPerUpdate) && source.maxStepsPerUpdate > 0
      ? source.maxStepsPerUpdate
      : DEFAULT_MAX_STEPS_PER_UPDATE,
    checkpointIntervalTicks: Number.isInteger(source.checkpointIntervalTicks) && source.checkpointIntervalTicks > 0
      ? source.checkpointIntervalTicks
      : DEFAULT_CHECKPOINT_INTERVAL_TICKS,
  };
}

function createGround(world, ground) {
  if (!ground) return null;

  const desc = RAPIER.RigidBodyDesc.fixed()
    .setTranslation(0, ground.y - GROUND_THICKNESS / 2, 0);
  const body = world.createRigidBody(desc);
  const collider = RAPIER.ColliderDesc
    .cuboid(MAX_GROUND_HALF_EXTENT, GROUND_THICKNESS / 2, MAX_GROUND_HALF_EXTENT)
    .setRestitution(ground.restitution)
    .setFriction(ground.friction);
  world.createCollider(collider, body);
  return body;
}

function createColliderDesc(def) {
  if (def.shape === 'sphere') {
    return RAPIER.ColliderDesc.ball(positiveNumber(def.radius, 0.5));
  }

  const halfExtents = readPositiveVec3(def.halfExtents, [0.5, 0.5, 0.5]);
  return RAPIER.ColliderDesc.cuboid(halfExtents[0], halfExtents[1], halfExtents[2]);
}

function createRigidBodyDesc(def) {
  const position = readVec3(def.position, [0, 0, 0]);
  const rotation = readRotationArray(def.rotation);
  const velocity = readVec3(def.velocity, [0, 0, 0]);
  const angularVelocity = readVec3(def.angularVelocity, [0, 0, 0]);
  const desc = def.static === true || def.mass <= 0
    ? RAPIER.RigidBodyDesc.fixed()
    : RAPIER.RigidBodyDesc.dynamic();

  desc
    .setTranslation(position[0], position[1], position[2])
    .setRotation(quaternionObject(rotation))
    .setCanSleep(def.canSleep !== false);

  if (!(def.static === true || def.mass <= 0)) {
    desc
      .setLinvel(velocity[0], velocity[1], velocity[2])
      .setAngvel(vectorObject(angularVelocity))
      .setCcdEnabled(def.ccd === true);
  }

  return desc;
}

function cloneSnapshot(snapshot) {
  if (!snapshot) return null;
  return {
    engine: RAPIER_PHYSICS_ENGINE,
    version: RAPIER_PACKAGE_VERSION,
    tick: Number.isInteger(snapshot.tick) ? snapshot.tick : 0,
    timestep: positiveNumber(snapshot.timestep, DEFAULT_TIMESTEP_SECONDS),
    data: snapshot.data instanceof Uint8Array
      ? snapshot.data.slice()
      : new Uint8Array(snapshot.data || []),
  };
}

function exportRigidBody(id, record, body) {
  if (!body) return null;
  const position = body.translation();
  const rotation = body.rotation();
  const velocity = record.static ? { x: 0, y: 0, z: 0 } : body.linvel();
  const angularVelocity = record.static ? { x: 0, y: 0, z: 0 } : body.angvel();
  return {
    id,
    shape: record.shape,
    static: record.static,
    position: [position.x, position.y, position.z],
    rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
    velocity: [velocity.x, velocity.y, velocity.z],
    angularVelocity: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
    sleeping: typeof body.isSleeping === 'function' ? body.isSleeping() : false,
  };
}

export function createWorld(options = {}) {
  if (!isRapierPhysicsReady()) {
    throw new Error('Rapier physics is not initialized. Call initRapierPhysics() first.');
  }

  const worldOptions = normalizeRapierWorldOptions(options);
  let world = new RAPIER.World({
    x: worldOptions.gravity[0],
    y: worldOptions.gravity[1],
    z: worldOptions.gravity[2],
  });
  world.timestep = worldOptions.timestep;
  createGround(world, worldOptions.ground);

  let tick = 0;
  const bodyRecords = new Map();
  const checkpoints = new Map();

  function getBodyHandle(id) {
    const record = bodyRecords.get(id);
    return record ? record.handle : null;
  }

  function getRigidBodyById(id) {
    const handle = getBodyHandle(id);
    if (handle == null) return null;
    return world.getRigidBody(handle);
  }

  function recordCheckpointIfDue() {
    if (tick === 0 || tick % worldOptions.checkpointIntervalTicks !== 0) return;
    if (checkpoints.has(tick)) return;
    checkpoints.set(tick, snapshot());
    const maxCheckpoints = 16;
    while (checkpoints.size > maxCheckpoints) {
      const oldestTick = Math.min(...checkpoints.keys());
      checkpoints.delete(oldestTick);
    }
  }

  function snapshot() {
    return {
      engine: RAPIER_PHYSICS_ENGINE,
      version: RAPIER_PACKAGE_VERSION,
      tick,
      timestep: world.timestep,
      data: world.takeSnapshot().slice(),
    };
  }

  function restore(snap) {
    const source = cloneSnapshot(snap);
    if (!source?.data?.length) return false;
    const nextWorld = RAPIER.World.restoreSnapshot(source.data);
    nextWorld.timestep = source.timestep;
    const previousWorld = world;
    world = nextWorld;
    previousWorld?.free?.();
    tick = source.tick;
    return true;
  }

  function restoreNearestCheckpoint(targetTick) {
    let bestTick = -1;
    for (const checkpointTick of checkpoints.keys()) {
      if (checkpointTick <= targetTick && checkpointTick > bestTick) {
        bestTick = checkpointTick;
      }
    }
    if (bestTick < 0) return false;
    return restore(checkpoints.get(bestTick));
  }

  function addBody(def) {
    if (!def || typeof def.id !== 'string' || def.id.length === 0) return null;
    removeBody(def.id);

    const isStatic = def.static === true || def.mass <= 0;
    const body = world.createRigidBody(createRigidBodyDesc({ ...def, static: isStatic }));
    const colliderDesc = createColliderDesc(def)
      .setRestitution(clampNumber(def.restitution, 0, 1, 0.2))
      .setFriction(clampNumber(def.friction, 0, 4, 0.5));

    if (!isStatic) {
      colliderDesc.setMass(positiveNumber(def.mass, 1));
    }

    world.createCollider(colliderDesc, body);
    const record = {
      handle: body.handle,
      shape: def.shape === 'sphere' ? 'sphere' : 'box',
      static: isStatic,
    };
    bodyRecords.set(def.id, record);
    return exportRigidBody(def.id, record, body);
  }

  function removeBody(id) {
    const body = getRigidBodyById(id);
    if (body) world.removeRigidBody(body);
    return bodyRecords.delete(id);
  }

  function getBody(id) {
    const record = bodyRecords.get(id);
    if (!record) return null;
    return exportRigidBody(id, record, world.getRigidBody(record.handle));
  }

  function getBodies() {
    return Array.from(bodyRecords.keys())
      .sort((left, right) => left.localeCompare(right))
      .map((id) => getBody(id))
      .filter(Boolean);
  }

  function step() {
    recordCheckpointIfDue();
    world.step();
    tick += 1;
    return tick;
  }

  function stepTo(targetTick) {
    if (!Number.isInteger(targetTick) || targetTick < 0) {
      return { tick, reached: false, reason: 'invalid-target' };
    }

    if (targetTick < tick && !restoreNearestCheckpoint(targetTick)) {
      return { tick, reached: false, reason: 'restore-required' };
    }

    if (targetTick - tick > worldOptions.maxStepsPerUpdate) {
      return {
        tick,
        reached: false,
        steps: 0,
        limited: true,
        reason: 'step-limit',
      };
    }

    let steps = 0;
    while (tick < targetTick) {
      step();
      steps += 1;
    }

    return {
      tick,
      reached: tick === targetTick,
      steps,
      limited: tick !== targetTick,
    };
  }

  function stateHash() {
    let hash = hashInit();
    hash = hashString(hash, RAPIER_PHYSICS_ENGINE);
    hash = hashString(hash, RAPIER_PACKAGE_VERSION);
    hash = hashInt(hash, tick);
    hash = hashNumber(hash, world.timestep);
    hash = hashBytes(hash, world.takeSnapshot());
    return hash >>> 0;
  }

  function free() {
    checkpoints.clear();
    bodyRecords.clear();
    world?.free?.();
    world = null;
  }

  return {
    engine: RAPIER_PHYSICS_ENGINE,
    options: worldOptions,
    get tick() {
      return tick;
    },
    get timestep() {
      return world?.timestep || worldOptions.timestep;
    },
    addBody,
    removeBody,
    getBody,
    getBodies,
    step,
    stepTo,
    snapshot,
    restore,
    stateHash,
    free,
  };
}
