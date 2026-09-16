import { afterEach, describe, expect, it } from 'vitest';
import { TFile, WorkspaceLeaf, type ViewState } from 'obsidian';
import { WorkspaceLeaf as MockLeaf } from '../mocks/obsidian';
import { ViewRouter } from '../../src/obsidian/view-routing';

const MAP = 'mappy-map';

function file(path: string): TFile {
  const result = new TFile();
  result.path = path;
  return result;
}

function makeLeaf(): WorkspaceLeaf { return new WorkspaceLeaf(); }
function statesOf(target: WorkspaceLeaf): ViewState[] { return (target as unknown as MockLeaf).states; }

function router(mapFiles: string[] = ['Map.md']) {
  return new ViewRouter({ mapViewType: MAP, isMapFile: path => mapFiles.includes(path) });
}

const installed = (): unknown => Object.getOwnPropertyDescriptor(WorkspaceLeaf.prototype, 'setViewState')?.value;
const originalSetViewState = installed() as WorkspaceLeaf['setViewState'];
afterEach(() => { WorkspaceLeaf.prototype.setViewState = originalSetViewState; });

describe('ViewRouter.route', () => {
  it('rewrites markdown states of map notes and leaves other notes alone', () => {
    const leaf = makeLeaf();
    const state = { type: 'markdown', state: { file: 'Map.md' }, active: true };
    expect(router().route(leaf, state)).toEqual({ ...state, type: MAP });
    expect(router().route(leaf, { type: 'markdown', state: { file: 'Plain.md' } }))
      .toEqual({ type: 'markdown', state: { file: 'Plain.md' } });
  });

  it('never touches non-markdown types or states without a file', () => {
    const leaf = makeLeaf();
    for (const state of [
      { type: 'markdown', state: { file: null } },
      { type: 'markdown' },
      { type: 'excalidraw', state: { file: 'Map.md' } },
      { type: MAP, state: { file: 'Map.md' } },
    ]) expect(router().route(leaf, state)).toBe(state);
  });

  it('keeps a leaf on Markdown after openMarkdown until it shows another file', async () => {
    const instance = router();
    const leaf = makeLeaf();
    await instance.openMarkdown(leaf, file('Map.md'));
    expect(statesOf(leaf).at(-1)).toEqual({ type: 'markdown', state: { file: 'Map.md' }, active: true });
    expect(instance.route(leaf, { type: 'markdown', state: { file: 'Map.md' } }).type).toBe('markdown');
    // A different note in the same leaf resets the choice.
    expect(instance.route(leaf, { type: 'markdown', state: { file: 'Other.md' } }).type).toBe('markdown');
    expect(instance.route(leaf, { type: 'markdown', state: { file: 'Map.md' } }).type).toBe(MAP);
  });

  it('openMap clears the Markdown choice for that leaf', async () => {
    const instance = router();
    const leaf = makeLeaf();
    await instance.openMarkdown(leaf, file('Map.md'));
    await instance.openMap(leaf, file('Map.md'), false);
    expect(statesOf(leaf).at(-1)).toEqual({ type: MAP, state: { file: 'Map.md' }, active: false });
    expect(instance.route(leaf, { type: 'markdown', state: { file: 'Map.md' } }).type).toBe(MAP);
  });

  it('other leaves are unaffected by one leaf choosing Markdown', async () => {
    const instance = router();
    const chosen = makeLeaf();
    const other = makeLeaf();
    await instance.openMarkdown(chosen, file('Map.md'));
    expect(instance.route(other, { type: 'markdown', state: { file: 'Map.md' } }).type).toBe(MAP);
  });
});

describe('ViewRouter.install', () => {
  it('patches WorkspaceLeaf.setViewState so embedded and ordinary leaves are routed', async () => {
    const instance = router();
    const remove = instance.install();
    const leaf = makeLeaf();
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    await leaf.setViewState({ type: 'markdown', state: { file: 'Plain.md' } });
    expect(statesOf(leaf).map(state => state.type)).toEqual([MAP, 'markdown']);
    remove();
    expect(installed()).toBe(originalSetViewState);
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } });
    expect(statesOf(leaf).at(-1)?.type).toBe('markdown');
  });

  it('installs once and passes the second argument through', async () => {
    const instance = router();
    const first = instance.install();
    const second = instance.install();
    const leaf = makeLeaf();
    await leaf.setViewState({ type: 'markdown', state: { file: 'Map.md' } }, { line: 3 });
    expect((leaf as unknown as MockLeaf).eStates).toEqual([{ line: 3 }]);
    expect(statesOf(leaf).at(-1)?.type).toBe(MAP);
    first();
    second();
    expect(installed()).toBe(originalSetViewState);
  });
});
