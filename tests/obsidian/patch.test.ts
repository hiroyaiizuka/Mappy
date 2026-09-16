import { describe, expect, it } from 'vitest';
import { patchMethod } from '../../src/obsidian/patch';

class Host {
  log: string[] = [];
  greet(name: string): string { this.log.push(name); return `hello ${name}`; }
}

/** Read the installed member without binding it, so identity checks stay lint-clean. */
const installed = (): unknown => Object.getOwnPropertyDescriptor(Host.prototype, 'greet')?.value;

describe('patchMethod', () => {
  it('wraps a prototype method and restores it on removal', () => {
    const original = installed();
    const remove = patchMethod(Host.prototype, 'greet', next => function (this: Host, name: string) {
      return next.call(this, name.toUpperCase());
    });
    const host = new Host();
    expect(host.greet('a')).toBe('hello A');
    expect(host.log).toEqual(['A']);
    remove();
    expect(installed()).toBe(original);
    expect(host.greet('b')).toBe('hello b');
  });

  it('becomes a pass-through when removed while another wrapper sits on top', () => {
    const original = installed();
    const removeOurs = patchMethod(Host.prototype, 'greet', next => function (this: Host, name: string) {
      return next.call(this, `${name}!`);
    });
    const removeTheirs = patchMethod(Host.prototype, 'greet', next => function (this: Host, name: string) {
      return `[${next.call(this, name)}]`;
    });
    const host = new Host();
    expect(host.greet('x')).toBe('[hello x!]');
    removeOurs();
    // Their wrapper is still installed, so the prototype is untouched and ours no longer alters input.
    expect(installed()).not.toBe(original);
    expect(host.greet('y')).toBe('[hello y]');
    removeTheirs();
    // Their removal hands back our (now inert) wrapper, which unhooks itself on the next call.
    expect(host.greet('z')).toBe('hello z');
    expect(installed()).toBe(original);
  });

  it('is idempotent on repeated removal', () => {
    const original = installed();
    const remove = patchMethod(Host.prototype, 'greet', next => next);
    remove();
    remove();
    expect(installed()).toBe(original);
  });
});
