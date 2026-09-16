import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'

export default defineConfig(({ mode }) => ({
  plugins: [
    dts({ rollupTypes: true })
  ],
  build: {
    lib: {
      entry: {
        index: './src/lib/index.ts',
        widget: './src/lib/widget/index.ts'
      },
      formats: ['es']
    },
    rollupOptions: {
      // Peer dependencies and lib0 subpath imports must stay external —
      // they're provided by the consuming app, not bundled.
      external: [/^yjs$/, /^y-protocols(\/.+)?$/, /^peerjs$/, /^lib0(\/.+)?$/],
      output: {
        // Produce readable file names for each entry.
        entryFileNames: (chunk) => `${chunk.name}.js`
      }
    }
  },
  // Only used by `vitest`: resolve `peerjs` to the in-repo mock broker so
  // the provider's sync/awareness logic can be tested in plain Node without
  // a browser or real WebRTC/network stack.
  test: mode === 'test'
    ? {
        alias: {
          peerjs: fileURLToPath(new URL('./test/mock-peerjs/index.js', import.meta.url))
        }
      }
    : undefined
}))
