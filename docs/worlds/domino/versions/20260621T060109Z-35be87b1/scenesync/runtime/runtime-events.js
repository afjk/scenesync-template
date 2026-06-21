/**
 * Helpers for creating and sorting Scene Sync Runtime Events.
 * See docs/runtime-events.md for the full event schema.
 */

/**
 * Return the canonical pairKey for two objectIds (sorted alphabetically).
 * Returns '' if either id is falsy.
 *
 * @param {string} objectIdA
 * @param {string} objectIdB
 * @returns {string}
 */
export function createCollisionPairKey(objectIdA, objectIdB) {
  if (!objectIdA || !objectIdB) return '';
  const [a, b] = [String(objectIdA), String(objectIdB)].sort();
  return `${a}|${b}`;
}

/**
 * Create a physics collision event in the standard Runtime Event shape.
 *
 * @param {Object} options
 * @param {string} options.type - 'physics.collision.enter' | 'physics.collision.exit'
 * @param {Object|null} options.clockState
 * @param {number} [options.frameId]
 * @param {number} [options.tick] - Physics tick (preferred over clockState.tick)
 * @param {string} options.objectIdA
 * @param {string} options.objectIdB
 * @param {Object} [options.payload]
 * @returns {Object}
 */
export function createPhysicsCollisionEvent({
  type,
  clockState,
  frameId,
  tick,
  objectIdA,
  objectIdB,
  payload = {},
}) {
  const [a, b] = [String(objectIdA), String(objectIdB)].sort();
  const event = {
    type,
    source: 'physics',
    phase: 'postPhysics',
    time: Number.isFinite(clockState?.t) ? clockState.t : 0,
    objectIdA: a,
    objectIdB: b,
    pairKey: `${a}|${b}`,
    payload,
  };
  // Prefer explicit tick (physics tick) over clockState.tick
  const eventTick = Number.isFinite(tick) ? tick
    : Number.isFinite(clockState?.tick) ? clockState.tick : undefined;
  if (eventTick !== undefined) {
    event.tick = eventTick;
  }
  if (frameId !== undefined && frameId !== null) {
    event.frameId = frameId;
  }
  return event;
}

/**
 * Sort runtime events by type, then tick, then pairKey for stable ordering.
 *
 * @param {Array<Object>} events
 * @returns {Array<Object>}
 */
export function sortRuntimeEvents(events) {
  return [...events].sort((a, b) => {
    const typeCompare = String(a.type).localeCompare(String(b.type));
    if (typeCompare !== 0) return typeCompare;
    const tickCompare = (a.tick ?? 0) - (b.tick ?? 0);
    if (tickCompare !== 0) return tickCompare;
    return String(a.pairKey || '').localeCompare(String(b.pairKey || ''));
  });
}
