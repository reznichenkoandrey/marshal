import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // E2E tests boot the packaged Electron app and cannot share the vitest
    // worker pool. They run via `npm run test:e2e` instead.
    exclude: ["tests/e2e/**", "node_modules/**", "dist/**", "release/**"],
    // Tests run against the TypeScript source directly (no `npm run build`
    // step). Vitest handles .ts imports natively via esbuild.
    typecheck: { enabled: false },
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      // Limit to modules that already have meaningful tests so the coverage
      // number stays honest. Add new files here as new test suites land.
      include: [
        "desktop/settings-store.ts",
        "desktop/backend-client.ts",
        "desktop/translator/translator-service.ts",
        "desktop/translator/languages.ts",
        "desktop/translator/glossary-store.ts",
        "desktop/translator/window-policy.ts",
        "desktop/translator/backends/errors.ts",
        "desktop/translator/insert-service.ts",
        "desktop/translator/backends/shared.ts",
        "desktop/translator/backends/alternatives.ts",
        "desktop/translator/translator-backend-factory.ts",
        "desktop/translator/clipboard-monitor.ts",
        "desktop/translator/history-store.ts",
        "desktop/translator/layout-switcher.ts",
        "desktop/dictation/hotkey-manager.ts",
        "desktop/dictation/whisper-backend.ts",
        "desktop/dictation/model-installer.ts",
        "agent/bridge/factory.ts",
        "agent/tools/fs.ts",
        "agent/runtime/marshal.ts",
        "agent/core/one-shot-executor.ts"
      ],
      // Regression gate — ratchets upward as we add tests. Each new PR is
      // expected to either keep coverage flat or bump the floor; a drop
      // fails CI so we notice deletions / dead-code growth.
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 65
      }
    }
  }
});
