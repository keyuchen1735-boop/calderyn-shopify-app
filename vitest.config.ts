import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    // Live Meta tests (META_LIVE_TEST=1) mutate one shared real campaign;
    // interleaved files would corrupt each other's pre-state reads/restores.
    fileParallelism: process.env.META_LIVE_TEST !== "1",
  },
});
