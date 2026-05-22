import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ai-sdk/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "es2022",
  outExtension: ({ format }) => ({
    js: format === "cjs" ? ".cjs" : ".js",
  }),
});
