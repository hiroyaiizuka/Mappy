/** Fixture text is bundled by esbuild's `?raw` plugin and by Vite in Vitest. */
declare module "*?raw" {
  const content: string;
  export default content;
}
