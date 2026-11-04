import { cp, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { Plugin } from 'vite'

const SOURCE = resolve(import.meta.dirname, 'node_modules/pdfjs-dist')
const DIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs']
const MOUNT = '/pdfjs/'
const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm', '.js': 'text/javascript', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf', '.icc': 'application/octet-stream',
}

/** Serves pdf.js runtime assets at /pdfjs/ in dev and copies them into the build: no CDN at runtime. */
export function pdfjsAssets(): Plugin {
  let outDir = 'dist'
  let root = process.cwd()
  return {
    name: 'shelf-pdfjs-assets',
    configResolved(config) {
      outDir = config.build.outDir
      root = config.root
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0] ?? ''
        if (!url.startsWith(MOUNT)) { next(); return }
        const rel = normalize(decodeURIComponent(url.slice(MOUNT.length)))
        const file = join(SOURCE, rel)
        if (!file.startsWith(SOURCE + sep) || !DIRS.includes(rel.split(sep)[0] ?? '')) { next(); return }
        const info = await stat(file).catch(() => null)
        if (!info?.isFile()) { next(); return }
        res.setHeader('Content-Type', TYPES[extname(file)] ?? 'application/octet-stream')
        res.setHeader('Content-Length', info.size)
        createReadStream(file).pipe(res)
      })
    },
    async closeBundle() {
      const target = resolve(root, outDir, 'pdfjs')
      await Promise.all(DIRS.map((d) => cp(join(SOURCE, d), join(target, d), {
        recursive: true,
        filter: (src) => !/LICENSE_?|quickjs/.test(src),
      })))
    },
  }
}
