export type Point = [number, number];

/**
 * Convert the absolute M/L/H/V path strings emitted by layoutTree into points.
 * Curves and relative commands are not produced by the layout and are rejected.
 */
export function pathToPoints(path: string): Point[] {
  const points: Point[] = [];
  const tokens = path.trim().split(/\s+/u);
  let index = 0;
  let command = '';
  const number = (): number => {
    const token = tokens[index++];
    const value = token === undefined ? Number.NaN : Number(token);
    if (!Number.isFinite(value)) throw new Error(`Unsupported path token: ${token ?? '(end)'}`);
    return value;
  };
  while (index < tokens.length) {
    const token = tokens[index] ?? '';
    if (/^[A-Za-z]$/u.test(token)) { command = token; index += 1; }
    const last = points[points.length - 1];
    switch (command) {
      case 'M': case 'L': points.push([number(), number()]); break;
      case 'H': if (!last) throw new Error('H requires a current point'); points.push([number(), last[1]]); break;
      case 'V': if (!last) throw new Error('V requires a current point'); points.push([last[0], number()]); break;
      default: throw new Error(`Unsupported path command: ${command || token}`);
    }
  }
  return points.filter((point, position) => {
    const previous = points[position - 1];
    return !previous || previous[0] !== point[0] || previous[1] !== point[1];
  });
}
