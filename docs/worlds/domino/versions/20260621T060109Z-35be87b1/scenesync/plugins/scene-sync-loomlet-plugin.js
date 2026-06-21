/**
 * Thin wrapper that exposes an Export/Scene Loomlet adapter as a SceneSyncRuntimePlugin.
 *
 * The plugin boundary keeps Loomlet behavior evaluation isolated from
 * Clock, Physics, Audio, Animation, and shell-specific update loops.
 *
 * Current implementation is a single post-physics phase wrapper.
 * Future work: split into prePhysics/postPhysics phases.
 *
 * @typedef {Object} SceneSyncRuntimePlugin
 * @property {string} name
 * @property {(context: Object) => void} [init]
 * @property {(clockState: Object, scheduleContext: Object) => void} [update]
 * @property {() => void} [dispose]
 */

/**
 * @typedef {Object} SceneSyncLoomletPluginOptions
 * @property {Object} [loomAdapter] - Existing adapter from createExportBehaviorRuntime()
 * @property {Function} [createLoomAdapter] - Factory called during init() if no adapter is pre-built
 * @property {Function} [now] - Optional time source for tests
 */

/**
 * @param {SceneSyncLoomletPluginOptions} [options]
 * @returns {SceneSyncRuntimePlugin & { getAdapter(): Object|null }}
 */
export function createSceneSyncLoomletPlugin(options = {}) {
  const {
    loomAdapter: prebuiltAdapter,
    createLoomAdapter,
    now = () => performance.now(),
  } = options;
  let adapter = prebuiltAdapter || null;

  return {
    name: 'loomlet',

    init(context) {
      if (!adapter && typeof createLoomAdapter === 'function') {
        adapter = createLoomAdapter(context);
      }
    },

    /**
     * Current behavior:
     * - Single phase only
     * - Called after evaluateSceneAtClock(), which currently includes animation + physics
     * - scheduleContext.collisionEvents is available for future Behavior Graph consumption
     *
     * @param {Object} clockState
     * @param {import('../runtime/schedule-context.js').SceneSyncScheduleContext} [scheduleContext]
     */
    update(clockState, scheduleContext = {}) {
      if (!adapter) return;
      const currentNow = Number.isFinite(scheduleContext.now)
        ? scheduleContext.now
        : now();
      if (typeof adapter.setScheduleContext === 'function') {
        adapter.setScheduleContext(scheduleContext);
      }
      if (typeof adapter.tick === 'function') {
        adapter.tick(clockState, currentNow);
      }
    },

    dispose() {
      adapter?.dispose?.();
      adapter = null;
    },

    getAdapter() {
      return adapter;
    },
  };
}
