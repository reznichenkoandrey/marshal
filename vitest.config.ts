import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Tests run against the TypeScript source directly (no `npm run build`
    // step). Vitest handles .ts imports natively via esbuild.
    typecheck: { enabled: false },
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: [
        "desktop/settings-store.ts",
        "desktop/translator/translator-service.ts",
        "agent/bridge/factory.ts"
      ]
    }
  }
});
