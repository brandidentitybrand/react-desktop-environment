/// <reference types="vite/client" />
/// <reference types="vitest" />
import path, { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'glob'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import dts from 'vite-plugin-dts'
import { libInjectCss } from 'vite-plugin-lib-inject-css'
import { minify } from 'terser'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    libInjectCss(),
    dts({
      tsconfigPath: './tsconfig.app.json',
      entryRoot: 'src',
      exclude: [
        '**/*.stories.ts',
        '**/*.stories.tsx',
        'src/stories',
        'src/test',
        '**/*.test.tsx',
        'src/components/Desktop/(removed) index.tsx',
      ],
    }),
    {
      // Vite never minifies ES library output, so source comments would ship.
      // Strip them without compressing or mangling, keeping pure annotations.
      name: 'strip-comments',
      apply: 'build',
      enforce: 'post',
      async renderChunk(code) {
        const result = await minify(code, {
          compress: false,
          mangle: false,
          module: true,
          format: { beautify: true, comments: false, preserve_annotations: true },
        })
        return { code: result.code ?? code, map: null }
      },
    },
  ],
  publicDir: false,
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['es'],
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      input: Object.fromEntries(
        globSync([
          'src/components/**/index.tsx',
          'src/main.ts',
          './src/react-window-manager/**/*.*',
        ]).map((file) => {
          // This remove `src/` as well as the file extension from each
          // file, so e.g. src/nested/foo.js becomes nested/foo
          const entryName = path.relative(
            'src',
            file.slice(0, file.length - path.extname(file).length)
          )
          // This expands the relative paths to absolute paths, so e.g.
          // src/nested/foo becomes /project/src/nested/foo.js
          const entryUrl = fileURLToPath(new URL(file, import.meta.url))
          return [entryName, entryUrl]
        })
      ),
      output: {
        entryFileNames: '[name].js',
        assetFileNames: 'assets/[name][extname]',
        globals: {
          react: 'React',
          'react-dom': 'React-dom',
          'react/jsx-runtime': 'react/jsx-runtime',
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    // you might want to disable it, if you don't have tests that rely on CSS
    // since parsing CSS is slow
    css: true,
    coverage: {
      include: ['src/components'],
      exclude: ['**/*.stories.tsx'],
    },
  },
})
