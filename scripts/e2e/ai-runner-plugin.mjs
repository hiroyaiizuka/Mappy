/**
 * The AI runner (src/ai, LEV-270) alone as a small plugin for the test vault, built by ai-runner.mjs. It is not Mappy:
 * Mappy wires the runner in `main.ts` (§11.8) and ai-runner.mjs `--mappy` drives that. This plugin takes the license as
 * granted and observes the processes from inside (pids, process groups, output gaps), which the wired plugin does not
 * expose, so the cancel, leftover and timing checks run here. Everything it runs is the real code: `loadNode()`, the
 * factory, the CLI runner, yt-dlp, pdf.js through `loadPdfJs()`.
 *
 * What it adds is only observation: the host is wrapped to note each spawned process (its pid, which leads its
 * process group, and its temporary directory) and when its standard output arrives, so the case can look for
 * leftovers with `ps` and report the gaps between output chunks (§11.3's timeouts).
 */
import { Plugin } from 'obsidian';
import { loadNode } from '../../src/ai/host/node-host';
import { vaultMaterials } from '../../src/ai/obsidian/material';
import { createRunnerFactory } from '../../src/ai/runner-factory';
import { DEFAULT_AI_PREFS, localPathsStore } from '../../src/ai/settings';

export default class AiRunnerProbe extends Plugin {
  onload() {
    const spawned = [];
    const watch = desktop => {
      const host = loadNode(desktop);
      if (!host) return null;
      return {
        ...host,
        spawn: (file, args, options) => {
          const child = host.spawn(file, args, options);
          const entry = { pid: child.pid, file, args, cwd: options.cwd, at: Date.now(), chunks: [] };
          spawned.push(entry);
          child.stdout?.on('data', chunk => { entry.chunks.push([Date.now(), chunk.byteLength]); });
          child.on('close', (code, signal) => { entry.closed = { code, signal, at: Date.now() }; });
          return child;
        },
      };
    };
    let prefs = { ...DEFAULT_AI_PREFS };
    const factory = createRunnerFactory({
      isEntitled: () => true,
      prefs: () => prefs,
      paths: localPathsStore(globalThis.localStorage),
      language: () => 'ja',
      load: watch,
    });
    // A PDF or a note is read before the run, as the input reads an attachment (`readAttachment`, LEV-271).
    const vault = vaultMaterials(this.app, file => this.app.vault.cachedRead(file));
    const readFirst = async (materials, signal) => Promise.all(materials.map(async material => {
      if (material.text !== '' || material.kind === 'youtube') return material;
      const read = material.kind === 'pdf' ? await vault.pdf(material.label, signal) : await vault.note(material.label);
      if (read.kind !== 'ok') throw new Error(`${material.label}: ${read.kind === 'failed' ? `${read.reason} ${read.detail}` : 'cancelled'}`);
      return { ...material, text: read.text };
    }));
    const results = {};
    globalThis.__mappyAiProbe = {
      availability: () => factory.availability(),
      setPrefs: next => { prefs = { ...prefs, ...next }; },
      spawned: () => spawned.map(({ chunks, ...rest }) => ({ ...rest, chunks: chunks.length, bytes: chunks.reduce((sum, [, size]) => sum + size, 0) })),
      results,
      /**
       * Starts a run under `id` (the CDP call returns at once; poll `results[id]`). `cancelAfterStartMs`: abort that
       * long after the runner reports `starting`, so a CLI is running when the cancel lands.
       */
      start: (id, request, cancelAfterStartMs) => {
        const runner = factory.create();
        if (!runner) { results[id] = { error: `no runner: ${factory.availability()}` }; return; }
        const controller = new AbortController();
        const progress = [];
        const started = Date.now();
        const from = spawned.length;
        results[id] = { running: true };
        let armed = false;
        const onProgress = step => {
          progress.push({ ms: Date.now() - started, ...step });
          if (cancelAfterStartMs && step.stage === 'starting' && !armed) { armed = true; setTimeout(() => { controller.abort(); }, cancelAfterStartMs); }
        };
        readFirst(request.materials, controller.signal).then(materials => runner.run({ ...request, materials }, onProgress, controller.signal)).then(result => {
          const mine = spawned.slice(from);
          const gaps = mine.map(entry => {
            const times = [entry.at, ...entry.chunks.map(([time]) => time)];
            return {
              file: entry.file.split('/').pop(), firstChunkMs: entry.chunks[0] ? entry.chunks[0][0] - entry.at : null,
              maxGapMs: times.slice(1).reduce((max, time, i) => Math.max(max, time - times[i]), 0),
              ms: (entry.closed?.at ?? Date.now()) - entry.at, closed: entry.closed ?? null,
            };
          });
          results[id] = { result, progress, ms: Date.now() - started, processes: mine.map(entry => ({ pid: entry.pid, cwd: entry.cwd, file: entry.file, args: entry.args })), gaps };
        }, error => { results[id] = { error: String(error) }; });
      },
    };
    this.register(() => { factory.dispose(); delete globalThis.__mappyAiProbe; });
  }
}
