type Callable = (this: unknown, ...args: unknown[]) => unknown;

/**
 * Replace a prototype method with a wrapper and return a function that removes it.
 * Removal stays correct when another plugin wrapped the method after us: our
 * wrapper then becomes a pass-through instead of restoring a stale original.
 * This mirrors the semantics of the widely used `monkey-around` helper without
 * adding a runtime dependency.
 */
export function patchMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  factory: (original: T[K]) => T[K],
): () => void {
  const original = target[key];
  const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
  let current = factory(original);
  const wrapper = function (this: unknown, ...args: unknown[]): unknown {
    // Once removed while shadowed, delegate straight to the original.
    if (current === original && target[key] === member) remove();
    return (current as unknown as Callable).apply(this, args);
  };
  const member = wrapper as unknown as T[K];
  const remove = (): void => {
    if (target[key] === member) {
      if (hadOwn) target[key] = original;
      else delete target[key];
    }
    current = original;
  };
  target[key] = member;
  return remove;
}
