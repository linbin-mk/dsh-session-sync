import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * One suite for both halves of the package. Host specs run in the default Node
 * environment; the component specs that render React declare
 * `// @vitest-environment jsdom` themselves, so nothing needs a second config.
 */
export default defineConfig({
  resolve: {
    // The ui-primitives source links into the harness checkout, whose own
    // node_modules supplies a second React copy; dedupe pins every React
    // import in the test graph to this package's single copy.
    dedupe: ['react', 'react-dom', 'react/jsx-runtime'],
  },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    alias: {
      // The published browser bundle is built by tsdown; tests exercise the
      // source tree with the minimal primitive fakes instead.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL('./tests/ui-primitives.tsx', import.meta.url)),
    },
    // Component specs import stylesheets (the plugin's CSS Modules and the
    // published ui-primitives bundle's katex css); non-scoped class names
    // keep the rendered tree inspectable.
    css: {
      modules: { classNameStrategy: 'non-scoped' },
    },
    server: {
      deps: {
        // The published ui-primitives node bundle imports katex's stylesheet;
        // externalized node_modules would hand that import to Node (unknown
        // .css extension), so the bundle and katex run through vite's css
        // pipeline instead.
        inline: ['@deepseek-ai/dsh-client-ui-primitives', 'katex'],
      },
    },
  },
})
