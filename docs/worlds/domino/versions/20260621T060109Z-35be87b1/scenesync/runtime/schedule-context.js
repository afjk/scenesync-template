/**
 * @typedef {Object} SceneSyncScheduleContext
 * @property {number} now
 * @property {number} frameId
 * @property {Object|null} clockState
 * @property {string} [phase]
 * @property {Array<Object>} events
 * @property {Array<Object>} collisionEvents
 * @property {Array<Object>} diagnostics
 */

/**
 * @param {Object} [options]
 * @param {number} [options.now]
 * @param {number} [options.frameId]
 * @param {Object|null} [options.clockState]
 * @returns {SceneSyncScheduleContext}
 */
export function createSceneSyncScheduleContext({ now, frameId = 0, clockState = null } = {}) {
  return {
    now: Number.isFinite(now) ? now : (
      typeof performance !== 'undefined' ? performance.now() : Date.now()
    ),
    frameId,
    clockState,
    events: [],
    collisionEvents: [],
    diagnostics: [],
  };
}

/**
 * Emit an event into the scheduleContext.
 * If the event type starts with 'physics.collision.', it is also pushed to collisionEvents.
 *
 * @param {SceneSyncScheduleContext|null} scheduleContext
 * @param {Object} event
 * @returns {Object} the event
 */
export function emitScheduleEvent(scheduleContext, event) {
  if (!scheduleContext || !event) return event;
  scheduleContext.events.push(event);
  if (typeof event.type === 'string' && event.type.startsWith('physics.collision.')) {
    scheduleContext.collisionEvents.push(event);
  }
  return event;
}

/**
 * Emit a diagnostic into the scheduleContext.
 *
 * @param {SceneSyncScheduleContext|null} scheduleContext
 * @param {Object} diagnostic
 * @returns {Object} the diagnostic
 */
export function emitScheduleDiagnostic(scheduleContext, diagnostic) {
  if (!scheduleContext || !diagnostic) return diagnostic;
  scheduleContext.diagnostics.push(diagnostic);
  return diagnostic;
}
