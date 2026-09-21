// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf as ObsidianLeaf, ViewStateResult } from 'obsidian';
import { installObsidianDom } from '../../harness/browser/dom';
import { HarnessApp } from '../../harness/browser/app';
import { WorkspaceLeaf } from '../../harness/browser/obsidian';
import { findFixture } from '../../harness/browser/fixtures';
import { captureScene, type ImageResolver } from '../../src/export/svg-capture';
import { buildSvg } from '../../src/export/svg-document';
import { DocumentStore } from '../../src/obsidian/document-store';
import type { ViewRouter } from '../../src/obsidian/view-routing';
import { MindmapView } from '../../src/ui/mindmap-view';
import { writeFileSync } from 'node:fs';

vi.mock('obsidian', () => import('../../harness/browser/obsidian'));
beforeAll(() => { installObsidianDom(); });
const CANVAS = { x: 0, y: 0, left: 0, top: 0, width: 1200, height: 800, right: 1200, bottom: 800, toJSON: () => ({}) };
const passthrough: ImageResolver = image => Promise.resolve(image.src.startsWith('data:') ? image.src : null);

describe('xr svg probe', () => {
  it('whitespace-prefixed and control-char schemes', async () => {
    const fixture = findFixture('uneven-branches');
    if (!fixture) throw new Error('no fixture');
    const app = new HarnessApp();
    app.put(fixture.path, fixture.source);
    const leaf = new WorkspaceLeaf(app.asApp<App>());
    const store = new DocumentStore(app.asApp<App>());
    const view = new MindmapView(leaf as unknown as ObsidianLeaf, store, {} as ViewRouter);
    leaf.view = view as unknown as WorkspaceLeaf['view'];
    document.body.append(view.containerEl);
    view.load();
    await view.onOpen();
    const canvas = view.containerEl.querySelector<HTMLElement>('.mappy-canvas');
    if (!canvas) throw new Error('no canvas');
    canvas.getBoundingClientRect = () => CANVAS;
    await view.setState({ file: fixture.path, layout: 'mindmap' }, { history: false } satisfies ViewStateResult);
    for (let r = 0; r < 3; r += 1) await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    const label = view.containerEl.querySelector<HTMLElement>('.mappy-node-label');
    label?.insertAdjacentHTML('beforeend',
      '<a class="x1" href=" javascript:alert(1)">sp</a>'
      + '<a class="x2" href="java&#9;script:alert(2)">tab</a>'
      + '<a class="x3" href="//evil.example.com/x">proto</a>'
      + '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><a class="x4" xlink:href="&#10;javascript:alert(4)"><circle r="1"/></a></svg>');
    const source = await view.exportSource();
    const scene = await captureScene(source, { resolveImage: passthrough });
    const svg = buildSvg(scene);
    const lines = ['x1', 'x2', 'x3', 'x4'].map(cls => {
      const m = new RegExp(`<a[^>]*class="[^"]*${cls}[^"]*"[^>]*>`, 'u').exec(svg);
      return `${cls}: ${m ? JSON.stringify(m[0]) : 'NOT FOUND'}`;
    });
    lines.push(`contains javascript: ${svg.includes('javascript')}`);
    writeFileSync('/tmp/claude-501/xr-svg.txt', lines.join('\n'));
    expect(true).toBe(true);
  });
});
