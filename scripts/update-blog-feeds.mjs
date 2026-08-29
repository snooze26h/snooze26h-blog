#!/usr/bin/env node
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  getEnabledSources,
  refreshBlogFeeds,
  serializeSnapshot,
  validateManifest,
  validateSnapshot,
  validateSnapshotAgainstManifest
} from './lib/blog-feed-core.mjs'

const manifestUrl = new URL('../src/data/blog-feeds.json', import.meta.url)
const snapshotUrl = new URL('../src/data/blog-feed-snapshot.json', import.meta.url)
const temporarySnapshotUrl = new URL('../src/data/.blog-feed-snapshot.json.tmp', import.meta.url)

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'))
}

async function validateFiles() {
  const manifest = validateManifest(await readJson(manifestUrl))
  const snapshot = validateSnapshotAgainstManifest(await readJson(snapshotUrl), manifest)
  console.log(
    `Feed data is valid: ${getEnabledSources(manifest).length} enabled sources, ${snapshot.items.length} articles.`
  )
}

async function updateFeeds() {
  const manifest = validateManifest(await readJson(manifestUrl))
  const previousSnapshot = validateSnapshot(await readJson(snapshotUrl))
  const result = await refreshBlogFeeds({ sources: manifest, previousSnapshot })

  for (const failure of result.failures) {
    console.warn(`Feed update warning [${failure.source_id}]: ${failure.message}`)
  }
  if (result.successfulSourceCount === 0) {
    throw new Error('Every enabled feed failed; the previous snapshot was preserved')
  }

  const nextContents = serializeSnapshot(result.snapshot)
  const previousContents = await readFile(snapshotUrl, 'utf8')
  if (nextContents === previousContents) {
    console.log(
      `Feed content is unchanged: ${result.successfulSourceCount} sources checked successfully.`
    )
    return
  }

  try {
    await writeFile(temporarySnapshotUrl, nextContents, 'utf8')
    await rename(temporarySnapshotUrl, snapshotUrl)
  } finally {
    await rm(temporarySnapshotUrl, { force: true })
  }

  console.log(
    `Feed snapshot updated: ${result.snapshot.items.length} articles from ${result.snapshot.source_count} sources.`
  )
}

const validateOnly = process.argv.includes('--validate-only')
await (validateOnly ? validateFiles() : updateFeeds())

console.log(`Validated ${fileURLToPath(snapshotUrl)}.`)
