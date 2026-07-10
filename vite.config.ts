import { defineConfig } from 'vite'
import { crx } from '@crxjs/vite-plugin'
import manifest from './manifest.config'

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      // Pages not referenced by the manifest UI keys (opened via
      // chrome.runtime.getURL) must be declared as entries explicitly,
      // otherwise the build ships them with raw ./*.ts script tags.
      input: {
        onboarding: 'src/onboarding/index.html',
      },
    },
  },
})
