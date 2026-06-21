// Use the deterministic build so that identical initial state + tick + inputs
// reproduce the same physics result across clients (cross-platform determinism).
import RAPIER from '@dimforge/rapier3d-deterministic-compat';

export const RAPIER_PHYSICS_ENGINE = 'rapier';
export const RAPIER_PACKAGE_VERSION = '0.19.3';
export const RAPIER_CORE_VERSION = '0.30.0';
export const RAPIER_BUILD_FLAVOR = 'deterministic-compat';
export const CANONICAL_PHYSICS_HASH_VERSION = 'SceneSyncCanonicalPhysicsHashV1';
export const DEFAULT_TIMESTEP_SECONDS = 1 / 60;
export const DEFAULT_MAX_STEPS_PER_UPDATE = 900;
export const DEFAULT_CHECKPOINT_INTERVAL_TICKS = 120;

const CANONICAL_INITIAL_NEXT_PID_CONTROLLER_ID = 1;
const MAX_GROUND_HALF_EXTENT = 4096;
const GROUND_THICKNESS = 0.1;
const GROUND_STABLE_ID = '__scenesync_ground__';
const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const FNV64_MASK = 0xffffffffffffffffn;
const CANONICAL_TEXT_ENCODER = new TextEncoder();
const FLOAT_SCRATCH = new ArrayBuffer(4);
const FLOAT_SCRATCH_VIEW = new DataView(FLOAT_SCRATCH);

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

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function combineRuleId(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 3 ? number : fallback;
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

function readQuatComponents(value, fallback = [0, 0, 0, 1]) {
  if (!Array.isArray(value) || value.length < 4) return [...fallback];
  return [
    finiteNumber(value[0], fallback[0] || 0),
    finiteNumber(value[1], fallback[1] || 0),
    finiteNumber(value[2], fallback[2] || 0),
    finiteNumber(value[3], fallback[3] ?? 1),
  ];
}

function fnv64Init() {
  return FNV64_OFFSET;
}

function hash64Byte(hash, byte) {
  return ((hash ^ BigInt(byte & 0xff)) * FNV64_PRIME) & FNV64_MASK;
}

function hash64Bytes(hash, bytes) {
  let next = hash;
  for (const byte of bytes || []) next = hash64Byte(next, byte);
  return next;
}

function hash64Uint8(hash, value) {
  return hash64Byte(hash, Number(value) || 0);
}

function hash64Uint32(hash, value) {
  const int = Number(value) >>> 0;
  let next = hash64Byte(hash, int);
  next = hash64Byte(next, int >>> 8);
  next = hash64Byte(next, int >>> 16);
  return hash64Byte(next, int >>> 24);
}

function hash64Uint64(hash, value) {
  let next = hash;
  let int = BigInt.asUintN(64, BigInt(value));
  for (let index = 0; index < 8; index += 1) {
    next = hash64Byte(next, Number(int & 0xffn));
    int >>= 8n;
  }
  return next;
}

function canonicalF32Bits(value) {
  const number = Number(value);
  if (number === 0) return 0;
  if (Number.isNaN(number)) return 0x7fc00000;
  FLOAT_SCRATCH_VIEW.setFloat32(0, Math.fround(number), true);
  return FLOAT_SCRATCH_VIEW.getUint32(0, true);
}

function hash64Float32(hash, value) {
  return hash64Uint32(hash, canonicalF32Bits(value));
}

function hash64String(hash, value) {
  const bytes = CANONICAL_TEXT_ENCODER.encode(String(value));
  return hash64Bytes(hash64Uint32(hash, bytes.length), bytes);
}

function hash64Vec3(hash, value, fallback = [0, 0, 0]) {
  const vec = readVec3(value, fallback);
  let next = hash64Float32(hash, vec[0]);
  next = hash64Float32(next, vec[1]);
  return hash64Float32(next, vec[2]);
}

function hash64Quat(hash, value, fallback = [0, 0, 0, 1]) {
  const quat = readQuatComponents(value, fallback);
  let next = hash64Float32(hash, quat[0]);
  next = hash64Float32(next, quat[1]);
  next = hash64Float32(next, quat[2]);
  return hash64Float32(next, quat[3]);
}

function hash64Pose(hash, position, rotation) {
  return hash64Quat(hash64Vec3(hash, position), rotation);
}

function hash64Hex(hash) {
  return BigInt.asUintN(64, hash).toString(16).padStart(16, '0');
}

export function stableIdHash(stableId) {
  return hash64Bytes(fnv64Init(), CANONICAL_TEXT_ENCODER.encode(String(stableId || '')));
}

export function stableIdHashHex(stableId) {
  return hash64Hex(stableIdHash(stableId));
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

/**
 * Raw Rapier world debug hash ordered by rigid-body handle.
 * Handles must be identical across the compared worlds (same creation order,
 * no remove/recreate, no snapshot restore with different body count).
 * For network divergence detection across clients, prefer networkStateHash()
 * on the createWorld() wrapper, which uses Scene Sync objectId order instead.
 * Returns an 8-character hex string.
 */
export function computeRapierWorldStateHash(rapierWorld) {
  let hash = hashInit();
  const handles = [];
  rapierWorld.forEachRigidBody((body) => handles.push(body.handle));
  handles.sort((a, b) => a - b);
  for (const handle of handles) {
    const body = rapierWorld.getRigidBody(handle);
    if (!body) continue;
    hash = hashInt(hash, handle);
    hash = hashInt(hash, body.bodyType());
    const t = body.translation();
    hash = hashNumber(hash, t.x);
    hash = hashNumber(hash, t.y);
    hash = hashNumber(hash, t.z);
    const r = body.rotation();
    hash = hashNumber(hash, r.x);
    hash = hashNumber(hash, r.y);
    hash = hashNumber(hash, r.z);
    hash = hashNumber(hash, r.w);
    const lv = body.linvel();
    hash = hashNumber(hash, lv.x);
    hash = hashNumber(hash, lv.y);
    hash = hashNumber(hash, lv.z);
    const av = body.angvel();
    hash = hashNumber(hash, av.x);
    hash = hashNumber(hash, av.y);
    hash = hashNumber(hash, av.z);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
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
  const colliderObject = world.createCollider(collider, body);
  return {
    id: GROUND_STABLE_ID,
    handle: body.handle,
    colliderHandle: colliderObject.handle,
    shape: 'box',
    halfExtents: [MAX_GROUND_HALF_EXTENT, GROUND_THICKNESS / 2, MAX_GROUND_HALF_EXTENT],
    radius: 0,
    static: true,
    linearDamping: typeof body.linearDamping === 'function' ? body.linearDamping() : 0,
    angularDamping: typeof body.angularDamping === 'function' ? body.angularDamping() : 0,
    gravityScale: typeof body.gravityScale === 'function' ? body.gravityScale() : 1,
    additionalSolverIterations: typeof body.additionalSolverIterations === 'function'
      ? body.additionalSolverIterations()
      : 0,
    canSleep: true,
    ccd: typeof body.isCcdEnabled === 'function' ? body.isCcdEnabled() : false,
    softCcdPrediction: typeof body.softCcdPrediction === 'function' ? body.softCcdPrediction() : 0,
    density: typeof colliderObject.density === 'function' ? colliderObject.density() : 1,
    friction: typeof colliderObject.friction === 'function' ? colliderObject.friction() : ground.friction,
    frictionCombineRule: typeof colliderObject.frictionCombineRule === 'function'
      ? colliderObject.frictionCombineRule()
      : 0,
    restitution: typeof colliderObject.restitution === 'function'
      ? colliderObject.restitution()
      : ground.restitution,
    restitutionCombineRule: typeof colliderObject.restitutionCombineRule === 'function'
      ? colliderObject.restitutionCombineRule()
      : 0,
    sensor: typeof colliderObject.isSensor === 'function' ? colliderObject.isSensor() : false,
  };
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
    .setLinearDamping(clampNumber(def.linearDamping, 0, 1024, 0))
    .setAngularDamping(clampNumber(def.angularDamping, 0, 1024, 0))
    .setGravityScale(clampNumber(def.gravityScale, -1024, 1024, 1))
    .setCanSleep(def.canSleep !== false)
    .setAdditionalSolverIterations(nonNegativeInteger(def.additionalSolverIterations, 0))
    .setSoftCcdPrediction(clampNumber(def.softCcdPrediction, 0, 1024, 0));

  if (!(def.static === true || def.mass <= 0)) {
    desc
      .setLinvel(velocity[0], velocity[1], velocity[2])
      .setAngvel(vectorObject(angularVelocity))
      .setCcdEnabled(def.ccd === true);
  }

  return desc;
}

function cloneBodyRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const handle = Number(record.handle);
  const colliderHandle = Number(record.colliderHandle);
  return {
    handle: Number.isFinite(handle) ? handle : null,
    colliderHandle: Number.isFinite(colliderHandle) ? colliderHandle : null,
    shape: record.shape === 'sphere' ? 'sphere' : 'box',
    radius: positiveNumber(record.radius, 0.5),
    halfExtents: readPositiveVec3(record.halfExtents, [0.5, 0.5, 0.5]),
    static: record.static === true,
    linearDamping: clampNumber(record.linearDamping, 0, 1024, 0),
    angularDamping: clampNumber(record.angularDamping, 0, 1024, 0),
    gravityScale: clampNumber(record.gravityScale, -1024, 1024, 1),
    additionalSolverIterations: nonNegativeInteger(record.additionalSolverIterations, 0),
    canSleep: record.canSleep !== false,
    ccd: record.ccd === true,
    softCcdPrediction: clampNumber(record.softCcdPrediction, 0, 1024, 0),
    density: finiteNumber(record.density, 1),
    friction: finiteNumber(record.friction, 0.5),
    frictionCombineRule: combineRuleId(record.frictionCombineRule, 0),
    restitution: finiteNumber(record.restitution, 0.2),
    restitutionCombineRule: combineRuleId(record.restitutionCombineRule, 0),
    sensor: record.sensor === true,
  };
}

function cloneSnapshotRecords(records) {
  if (!Array.isArray(records)) return null;
  return records
    .map((entry) => {
      if (!entry || typeof entry.id !== 'string') return null;
      const record = cloneBodyRecord(entry);
      return record ? { id: entry.id, ...record } : null;
    })
    .filter(Boolean);
}

function cloneSnapshot(snapshot) {
  if (!snapshot) return null;
  const groundRecord = cloneBodyRecord(snapshot.groundRecord);
  return {
    engine: RAPIER_PHYSICS_ENGINE,
    version: RAPIER_PACKAGE_VERSION,
    tick: Number.isInteger(snapshot.tick) ? snapshot.tick : 0,
    timestep: positiveNumber(snapshot.timestep, DEFAULT_TIMESTEP_SECONDS),
    data: snapshot.data instanceof Uint8Array
      ? snapshot.data.slice()
      : new Uint8Array(snapshot.data || []),
    records: cloneSnapshotRecords(snapshot.records),
    groundRecord: groundRecord ? { id: GROUND_STABLE_ID, ...groundRecord } : null,
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
  let groundRecord = createGround(world, worldOptions.ground);

  let eventQueue = null;
  try {
    eventQueue = new RAPIER.EventQueue(true);
  } catch {
    // EventQueue not available in this build; collision events disabled
  }

  let tick = 0;
  const bodyRecords = new Map();
  const colliderToObjectId = new Map();
  const checkpoints = new Map();

  function getRigidBodyByHandle(handle) {
    if (typeof handle !== 'number' || !Number.isFinite(handle)) return null;
    try {
      return world.getRigidBody(handle) || null;
    } catch {
      return null;
    }
  }

  function getColliderByHandle(handle) {
    if (typeof handle !== 'number' || !Number.isFinite(handle)) return null;
    try {
      return world.getCollider(handle) || null;
    } catch {
      return null;
    }
  }

  function getBodyHandle(id) {
    const record = bodyRecords.get(id);
    return record ? record.handle : null;
  }

  function getRigidBodyById(id) {
    const handle = getBodyHandle(id);
    if (handle == null) return null;
    return getRigidBodyByHandle(handle);
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
      records: Array.from(bodyRecords.entries())
        .map(([id, record]) => ({ id, ...cloneBodyRecord(record) }))
        .filter((record) => record.handle != null),
      groundRecord: groundRecord ? { id: GROUND_STABLE_ID, ...cloneBodyRecord(groundRecord) } : null,
    };
  }

  function restore(snap) {
    const source = cloneSnapshot(snap);
    if (!source?.data?.length) return false;
    // Drain and discard stale events before restoring to a past state
    if (eventQueue) {
      try { eventQueue.drainCollisionEvents(() => {}); } catch {}
    }
    const nextWorld = RAPIER.World.restoreSnapshot(source.data);
    nextWorld.timestep = source.timestep;
    const previousWorld = world;
    world = nextWorld;
    previousWorld?.free?.();
    tick = source.tick;

    bodyRecords.clear();
    colliderToObjectId.clear();
    if (source.records) {
      for (const { id, ...record } of source.records) {
        if (record.handle == null || !getRigidBodyByHandle(record.handle)) continue;
        if (record.colliderHandle != null && !getColliderByHandle(record.colliderHandle)) {
          record.colliderHandle = null;
        }
        bodyRecords.set(id, record);
        if (record.colliderHandle != null) {
          colliderToObjectId.set(record.colliderHandle, id);
        }
      }
    }

    groundRecord = null;
    if (source.groundRecord) {
      const { id: _id, ...record } = source.groundRecord;
      groundRecord = record.handle != null && getRigidBodyByHandle(record.handle)
        ? { id: GROUND_STABLE_ID, ...record }
        : null;
    }

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
      .setRestitutionCombineRule(combineRuleId(def.restitutionCombineRule, 0))
      .setFriction(clampNumber(def.friction, 0, 4, 0.5))
      .setFrictionCombineRule(combineRuleId(def.frictionCombineRule, 0));

    if (Number.isFinite(Number(def.density)) && typeof colliderDesc.setDensity === 'function') {
      colliderDesc.setDensity(Math.max(0, Number(def.density)));
    } else if (!isStatic) {
      colliderDesc.setMass(positiveNumber(def.mass, 1));
    }

    // Enable collision events so drainCollisionEvents() receives enter/exit signals
    if (RAPIER.ActiveEvents?.COLLISION_EVENTS != null) {
      try {
        colliderDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      } catch {}
    }

    const collider = world.createCollider(colliderDesc, body);
    if (collider?.handle != null) {
      colliderToObjectId.set(collider.handle, def.id);
    }
    const record = {
      handle: body.handle,
      colliderHandle: collider.handle,
      shape: def.shape === 'sphere' ? 'sphere' : 'box',
      radius: positiveNumber(def.radius, 0.5),
      halfExtents: readPositiveVec3(def.halfExtents, [0.5, 0.5, 0.5]),
      static: isStatic,
      linearDamping: typeof body.linearDamping === 'function'
        ? body.linearDamping()
        : clampNumber(def.linearDamping, 0, 1024, 0),
      angularDamping: typeof body.angularDamping === 'function'
        ? body.angularDamping()
        : clampNumber(def.angularDamping, 0, 1024, 0),
      gravityScale: typeof body.gravityScale === 'function'
        ? body.gravityScale()
        : clampNumber(def.gravityScale, -1024, 1024, 1),
      additionalSolverIterations: typeof body.additionalSolverIterations === 'function'
        ? body.additionalSolverIterations()
        : nonNegativeInteger(def.additionalSolverIterations, 0),
      canSleep: def.canSleep !== false,
      ccd: typeof body.isCcdEnabled === 'function'
        ? body.isCcdEnabled()
        : (!isStatic && def.ccd === true),
      softCcdPrediction: typeof body.softCcdPrediction === 'function'
        ? body.softCcdPrediction()
        : clampNumber(def.softCcdPrediction, 0, 1024, 0),
      density: typeof collider.density === 'function'
        ? collider.density()
        : (isStatic ? 1 : positiveNumber(def.mass, 1)),
      friction: typeof collider.friction === 'function'
        ? collider.friction()
        : clampNumber(def.friction, 0, 4, 0.5),
      frictionCombineRule: typeof collider.frictionCombineRule === 'function'
        ? collider.frictionCombineRule()
        : 0,
      restitution: typeof collider.restitution === 'function'
        ? collider.restitution()
        : clampNumber(def.restitution, 0, 1, 0.2),
      restitutionCombineRule: typeof collider.restitutionCombineRule === 'function'
        ? collider.restitutionCombineRule()
        : 0,
      sensor: typeof collider.isSensor === 'function' ? collider.isSensor() : false,
    };
    bodyRecords.set(def.id, record);
    return exportRigidBody(def.id, record, body);
  }

  function removeBody(id) {
    const record = bodyRecords.get(id);
    if (record) {
      // Remove all colliders associated with this body from the colliderToObjectId map
      try {
        const body = world.getRigidBody(record.handle);
        if (body && typeof body.numColliders === 'function') {
          for (let i = 0; i < body.numColliders(); i++) {
            const col = body.collider(i);
            if (col?.handle != null) colliderToObjectId.delete(col.handle);
          }
        }
      } catch {
        // If body is already removed or API differs, clean up by scanning
        for (const [handle, oid] of colliderToObjectId) {
          if (oid === id) colliderToObjectId.delete(handle);
        }
      }
    }
    const body = getRigidBodyById(id);
    if (body) world.removeRigidBody(body);
    return bodyRecords.delete(id);
  }

  function getBody(id) {
    const record = bodyRecords.get(id);
    if (!record) return null;
    return exportRigidBody(id, record, getRigidBodyByHandle(record.handle));
  }

  function getBodies() {
    return Array.from(bodyRecords.keys())
      .sort((left, right) => left.localeCompare(right))
      .map((id) => getBody(id))
      .filter(Boolean);
  }

  function step() {
    recordCheckpointIfDue();
    if (eventQueue) {
      world.step(eventQueue);
    } else {
      world.step();
    }
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

  function getCanonicalRecords() {
    const records = groundRecord ? [[groundRecord.id, groundRecord]] : [];
    for (const entry of bodyRecords.entries()) records.push(entry);
    return records
      .map(([id, record]) => ({
        id,
        idHash: stableIdHash(id),
        record,
        body: getRigidBodyById(id) || getRigidBodyByHandle(record.handle),
      }))
      .filter((entry) => entry.body)
      .sort((left, right) => {
        if (left.idHash < right.idHash) return -1;
        if (left.idHash > right.idHash) return 1;
        return left.id.localeCompare(right.id);
      });
  }

  function hashStableIdentity(hash, stableId) {
    return hash64Uint64(hash64Uint8(hash, 1), stableIdHash(stableId));
  }

  function hashCanonicalBody(hash, id, record, body) {
    const position = body.translation();
    const rotation = body.rotation();
    const velocity = record.static ? { x: 0, y: 0, z: 0 } : body.linvel();
    const angularVelocity = record.static ? { x: 0, y: 0, z: 0 } : body.angvel();

    let next = hashStableIdentity(hash, id);
    next = hash64Uint8(next, record.static ? 1 : 0);
    next = hash64Float32(
      next,
      typeof body.gravityScale === 'function' ? body.gravityScale() : record.gravityScale,
    );
    next = hash64Float32(
      next,
      typeof body.linearDamping === 'function' ? body.linearDamping() : record.linearDamping,
    );
    next = hash64Float32(
      next,
      typeof body.angularDamping === 'function' ? body.angularDamping() : record.angularDamping,
    );
    next = hash64Uint64(
      next,
      typeof body.additionalSolverIterations === 'function'
        ? body.additionalSolverIterations()
        : record.additionalSolverIterations,
    );
    next = hash64Uint8(
      next,
      typeof body.isCcdEnabled === 'function' ? (body.isCcdEnabled() ? 1 : 0) : (record.ccd ? 1 : 0),
    );
    next = hash64Float32(
      next,
      typeof body.softCcdPrediction === 'function' ? body.softCcdPrediction() : record.softCcdPrediction,
    );
    next = hash64Uint8(next, record.canSleep !== false ? 1 : 0);
    next = hash64Pose(
      next,
      [position.x, position.y, position.z],
      [rotation.x, rotation.y, rotation.z, rotation.w],
    );
    next = hash64Vec3(next, [velocity.x, velocity.y, velocity.z]);
    next = hash64Vec3(next, [angularVelocity.x, angularVelocity.y, angularVelocity.z]);
    next = hash64Uint8(next, typeof body.isSleeping === 'function' && body.isSleeping() ? 1 : 0);
    next = hash64Uint8(next, typeof body.isEnabled === 'function' && !body.isEnabled() ? 0 : 1);
    return next;
  }

  function hashCanonicalCollider(hash, id, record) {
    const collider = getColliderByHandle(record.colliderHandle);
    let next = hashStableIdentity(hash, id);
    next = hashStableIdentity(next, id);
    next = hash64Uint8(next, 1);
    next = hash64Pose(next, [0, 0, 0], [0, 0, 0, 1]);

    if (record.shape === 'sphere') {
      next = hash64Uint8(next, 1);
      next = hash64Float32(next, positiveNumber(record.radius, 0.5));
    } else {
      next = hash64Uint8(next, 2);
      next = hash64Vec3(next, readPositiveVec3(record.halfExtents, [0.5, 0.5, 0.5]));
    }

    const density = typeof collider?.density === 'function'
      ? collider.density()
      : positiveNumber(record.density, 1);
    const friction = typeof collider?.friction === 'function'
      ? collider.friction()
      : finiteNumber(record.friction, 0.5);
    const frictionCombineRule = typeof collider?.frictionCombineRule === 'function'
      ? collider.frictionCombineRule()
      : record.frictionCombineRule;
    const restitution = typeof collider?.restitution === 'function'
      ? collider.restitution()
      : finiteNumber(record.restitution, 0.2);
    const restitutionCombineRule = typeof collider?.restitutionCombineRule === 'function'
      ? collider.restitutionCombineRule()
      : record.restitutionCombineRule;
    const sensor = typeof collider?.isSensor === 'function' ? collider.isSensor() : record.sensor === true;
    const enabled = typeof collider?.isEnabled === 'function' ? collider.isEnabled() : true;
    next = hash64Float32(next, density);
    next = hash64Float32(next, friction);
    next = hash64Uint8(next, combineRuleId(frictionCombineRule, 0));
    next = hash64Float32(next, restitution);
    next = hash64Uint8(next, combineRuleId(restitutionCombineRule, 0));
    next = hash64Uint8(next, sensor ? 1 : 0);
    next = hash64Uint8(next, enabled ? 1 : 0);
    return next;
  }

  function canonicalStateHashBigInt() {
    const records = getCanonicalRecords();
    let hash = fnv64Init();
    hash = hash64String(hash, CANONICAL_PHYSICS_HASH_VERSION);
    hash = hash64String(hash, RAPIER_PHYSICS_ENGINE);
    hash = hash64String(hash, RAPIER_CORE_VERSION);
    hash = hash64Vec3(hash, worldOptions.gravity);
    hash = hash64Float32(hash, world.timestep);
    hash = hash64Uint64(hash, CANONICAL_INITIAL_NEXT_PID_CONTROLLER_ID);
    hash = hash64Uint64(hash, 0);

    hash = hash64Uint64(hash, records.length);
    for (const { id, record, body } of records) {
      hash = hashCanonicalBody(hash, id, record, body);
    }

    hash = hash64Uint64(hash, records.length);
    for (const { id, record } of records) {
      hash = hashCanonicalCollider(hash, id, record);
    }

    return hash;
  }

  function canonicalStateHash() {
    return hash64Hex(canonicalStateHashBigInt());
  }

  function canonicalStateDump() {
    const records = getCanonicalRecords();
    return {
      hashVersion: CANONICAL_PHYSICS_HASH_VERSION,
      rapierCoreVersion: RAPIER_CORE_VERSION,
      tick,
      gravity: [...worldOptions.gravity],
      timestep: world.timestep,
      bodies: records.map(({ id, record, body }) => {
        const position = body.translation();
        const rotation = body.rotation();
        const velocity = record.static ? { x: 0, y: 0, z: 0 } : body.linvel();
        const angularVelocity = record.static ? { x: 0, y: 0, z: 0 } : body.angvel();
        return {
          id,
          idHash: hash64Hex(stableIdHash(id)),
          type: record.static ? 'fixed' : 'dynamic',
          position: [position.x, position.y, position.z],
          rotation: [rotation.x, rotation.y, rotation.z, rotation.w],
          linvel: [velocity.x, velocity.y, velocity.z],
          angvel: [angularVelocity.x, angularVelocity.y, angularVelocity.z],
          gravityScale: typeof body.gravityScale === 'function' ? body.gravityScale() : record.gravityScale,
          linearDamping: typeof body.linearDamping === 'function' ? body.linearDamping() : record.linearDamping,
          angularDamping: typeof body.angularDamping === 'function' ? body.angularDamping() : record.angularDamping,
          additionalSolverIterations: typeof body.additionalSolverIterations === 'function'
            ? body.additionalSolverIterations()
            : record.additionalSolverIterations,
          canSleep: record.canSleep !== false,
          ccd: typeof body.isCcdEnabled === 'function' ? body.isCcdEnabled() : record.ccd,
          softCcdPrediction: typeof body.softCcdPrediction === 'function'
            ? body.softCcdPrediction()
            : record.softCcdPrediction,
          sleeping: typeof body.isSleeping === 'function' ? body.isSleeping() : false,
          enabled: typeof body.isEnabled === 'function' ? body.isEnabled() : true,
        };
      }),
      colliders: records.map(({ id, record }) => {
        const collider = getColliderByHandle(record.colliderHandle);
        return {
          id,
          idHash: hash64Hex(stableIdHash(id)),
          parentBodyId: id,
          shape: record.shape,
          localPosition: [0, 0, 0],
          localRotation: [0, 0, 0, 1],
          ...(record.shape === 'sphere'
            ? { radius: positiveNumber(record.radius, 0.5) }
            : { halfExtents: readPositiveVec3(record.halfExtents, [0.5, 0.5, 0.5]) }),
          density: typeof collider?.density === 'function' ? collider.density() : positiveNumber(record.density, 1),
          friction: typeof collider?.friction === 'function' ? collider.friction() : finiteNumber(record.friction, 0.5),
          frictionCombineRule: typeof collider?.frictionCombineRule === 'function'
            ? collider.frictionCombineRule()
            : record.frictionCombineRule,
          restitution: typeof collider?.restitution === 'function'
            ? collider.restitution()
            : finiteNumber(record.restitution, 0.2),
          restitutionCombineRule: typeof collider?.restitutionCombineRule === 'function'
            ? collider.restitutionCombineRule()
            : record.restitutionCombineRule,
          sensor: typeof collider?.isSensor === 'function' ? collider.isSensor() : record.sensor === true,
          enabled: typeof collider?.isEnabled === 'function' ? collider.isEnabled() : true,
        };
      }),
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

  // objectId-sorted hash intended for future network divergence detection.
  // Uses Scene Sync objectId order (same as getBodies()) rather than raw
  // Rapier handles, so it remains stable across remove/recreate and
  // snapshot restore as long as the scene composition is the same.
  function networkStateHash() {
    let hash = hashInit();
    hash = hashString(hash, RAPIER_PHYSICS_ENGINE);
    hash = hashString(hash, RAPIER_PACKAGE_VERSION);
    hash = hashInt(hash, tick);
    for (const { id, position, rotation, velocity, angularVelocity } of getBodies()) {
      hash = hashString(hash, id);
      hash = hashNumber(hash, position[0]);
      hash = hashNumber(hash, position[1]);
      hash = hashNumber(hash, position[2]);
      hash = hashNumber(hash, rotation[0]);
      hash = hashNumber(hash, rotation[1]);
      hash = hashNumber(hash, rotation[2]);
      hash = hashNumber(hash, rotation[3]);
      hash = hashNumber(hash, velocity[0]);
      hash = hashNumber(hash, velocity[1]);
      hash = hashNumber(hash, velocity[2]);
      hash = hashNumber(hash, angularVelocity[0]);
      hash = hashNumber(hash, angularVelocity[1]);
      hash = hashNumber(hash, angularVelocity[2]);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function drainCollisionEvents(callback) {
    if (!eventQueue || typeof callback !== 'function') return;
    try {
      eventQueue.drainCollisionEvents((handle1, handle2, started) => {
        const objectIdA = colliderToObjectId.get(handle1);
        const objectIdB = colliderToObjectId.get(handle2);
        if (objectIdA && objectIdB) {
          callback(objectIdA, objectIdB, started);
        }
      });
    } catch {
      // Silently ignore if EventQueue API differs from expected
    }
  }

  function free() {
    checkpoints.clear();
    bodyRecords.clear();
    colliderToObjectId.clear();
    if (eventQueue) {
      try { eventQueue.free?.(); } catch {}
      eventQueue = null;
    }
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
    canonicalStateHash,
    canonicalStateDump,
    stateHash,
    networkStateHash,
    drainCollisionEvents,
    free,
  };
}
