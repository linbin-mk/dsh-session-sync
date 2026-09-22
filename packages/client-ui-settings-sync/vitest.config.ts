import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

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
    // The self-package /client entry resolves to the browser bundle in the
    // published artifact layout; tests exercise the source entry instead.
    alias: {
      '@linbin-mk/dsh-client-ui-settings-sync/client': fileURLToPath(new URL('./src/client/index.ts', import.meta.url)),
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
