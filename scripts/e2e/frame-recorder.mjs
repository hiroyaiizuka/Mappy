/**
 * The frame recorder E45 (timeline-large) and E75 (panzoom-frames) share: requestAnimationFrame timestamps, long tasks
 * and long animation frames while an input runs, and optionally the style writes on one element (the map's world).
 *
 * Long tasks tell script from drawing: a slow frame with none is the renderer's (paint, raster, layerization), not the
 * map's code. A long animation frame (LoAF) covers the rendering too, from `renderStart` on, which is where LEV-213's
 * 0.45–0.97 s went.
 */

/**
 * `watch` (script expression, optional): the element whose `style` writes are counted. Only writes that changed the
 * value count (`attributeOldValue`): a write of the same transform, such as a pan clamped at a bound, moves nothing.
 */
export function makeFrameRecorder(evaluate, { watch = null } = {}) {
  return async drive => {
    await evaluate(`const state = window.__mappyE2EFrames = { frames: [], longTasks: 0, loaf: [], values: [], on: true };
      state.long = new PerformanceObserver(list => { state.longTasks += list.getEntries().length; });
      state.long.observe({ type: 'longtask' });
      state.animation = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) state.loaf.push({ duration: entry.duration, render: entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0 });
      });
      state.animation.observe({ type: 'long-animation-frame' });
      const watched = ${watch ?? 'null'};
      if (watched) {
        state.watched = watched;
        // Each record's old value is the attribute before that write; the value after the last write is the attribute
        // as it stands when the run ends. Together they are every value the element held, in order.
        state.watch = new MutationObserver(records => { for (const record of records) state.values.push(record.oldValue); });
        state.watch.observe(watched, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
      }
      const loop = time => { if (!state.on) return; state.frames.push(time); requestAnimationFrame(loop); };
      requestAnimationFrame(loop); return true;`);
    let raw = null;
    let failure = null;
    try {
      await drive();
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (error) {
      failure = error;
    } finally {
      // Stopped whatever happens: a recorder left running would share every later frame the case measures. A window
      // that reloaded under the run has no recorder left to stop, and says so instead of a TypeError further down.
      try {
        raw = await evaluate(`const state = window.__mappyE2EFrames; if (!state) return null;
          state.on = false; state.long.disconnect(); state.animation.disconnect();
          // Writes of the last moments not yet handed to the callback.
          for (const record of state.watch?.takeRecords() ?? []) state.values.push(record.oldValue);
          state.watch?.disconnect(); delete window.__mappyE2EFrames;
          const values = state.watched ? [...state.values, state.watched.getAttribute('style')] : [];
          return { frames: state.frames, longTasks: state.longTasks, loaf: state.loaf, values };`);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
    if (!raw) throw new Error('the frame recorder was gone when the run ended (did the window or the plugin reload?)');
    const { values, ...rest } = raw;
    const writes = values.slice(1).filter((value, index) => value !== values[index]).length;
    return { ...rest, writes, transforms: new Set(values).size };
  };
}
