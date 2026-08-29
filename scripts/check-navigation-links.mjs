import { access, readFile } from 'node:fs/promises'
import path from 'node:path'

const distDir = path.resolve('dist')
const entryPages = ['index.html', 'en/index.html']
const routes = new Set()

for (const entryPage of entryPages) {
  const html = await readFile(path.join(distDir, entryPage), 'utf8')
  const header = html.match(/<header-component\b[^>]*>([\s\S]*?)<\/header-component>/)?.[1]

  if (!header) {
    throw new Error(`Header not found in dist/${entryPage}`)
  }

  for (const match of header.matchAll(/href=(?:"([^"]+)"|'([^']+)')/g)) {
    const href = match[1] ?? match[2]
    if (!href.startsWith('/') || href.startsWith('//')) continue

    const pathname = decodeURIComponent(new URL(href, 'https://local.invalid').pathname)
    routes.add(pathname.replace(/\/+$/, '') || '/')
  }
}

const missing = []

for (const route of [...routes].sort()) {
  const relativePath = route.replace(/^\//, '')
  const candidates =
    route === '/'
      ? [path.join(distDir, 'index.html')]
      : [path.join(distDir, relativePath, 'index.html'), path.join(distDir, `${relativePath}.html`)]

  let exists = false
  for (const candidate of candidates) {
    try {
      await access(candidate)
      exists = true
      break
    } catch {}
  }

  if (!exists) missing.push(route)
}

if (missing.length > 0) {
  console.error(`Missing navigation targets (${missing.length}): ${missing.join(', ')}`)
  process.exitCode = 1
} else {
  console.log(`Navigation check passed: ${routes.size} internal routes have matching HTML files.`)
}
