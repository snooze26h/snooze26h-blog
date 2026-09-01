#!/usr/bin/env node
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  getEnabledSources,
  initializeSnapshotBaseline,
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

async function writeSnapshot(snapshot) {
  const nextContents = serializeSnapshot(snapshot)
  const previousContents = await readFile(snapshotUrl, 'utf8')
  if (nextContents === previousContents) return false

  try {
    await writeFile(temporarySnapshotUrl, nextContents, 'utf8')
    await rename(temporarySnapshotUrl, snapshotUrl)
  } finally {
    await rm(temporarySnapshotUrl, { force: true })
  }
  return true
}

async function initializeBaseline() {
  const manifest = validateManifest(await readJson(manifestUrl))
  const previousSnapshot = await readJson(snapshotUrl)
  const baselineStartedAt = new Date()
  const seedSnapshot = initializeSnapshotBaseline({
    sources: manifest,
    previousSnapshot,
    now: baselineStartedAt
  })
  const result = await refreshBlogFeeds({
    sources: manifest,
    previousSnapshot: seedSnapshot,
    now: baselineStartedAt
  })
  for (const failure of result.failures) {
    console.warn(`Feed baseline warning [${failure.source_id}]: ${failure.message}`)
  }
  if (result.successfulSourceCount !== getEnabledSources(manifest).length) {
    throw new Error('Every enabled feed must succeed before the monitoring baseline is replaced')
  }

  const snapshot = initializeSnapshotBaseline({
    sources: manifest,
    previousSnapshot: result.snapshot,
    now: baselineStartedAt
  })
  await writeSnapshot(snapshot)
  console.log(
    `Feed monitoring baseline initialized: ${snapshot.items.length} existing articles across ${snapshot.source_count} sources are treated as read.`
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

  if (!(await writeSnapshot(result.snapshot))) {
    console.log(
      `Feed content is unchanged: ${result.successfulSourceCount} sources checked successfully.`
    )
    return
  }

  console.log(
    `Feed snapshot updated: ${result.snapshot.items.length} articles from ${result.snapshot.source_count} sources.`
  )
}

const flags = new Set(process.argv.slice(2))
const allowedFlags = new Set(['--initialize-baseline', '--validate-only'])
for (const flag of flags) {
  if (!allowedFlags.has(flag)) throw new Error(`Unknown option: ${flag}`)
}
if (flags.size > 1) throw new Error('Choose exactly one feed operation')

if (flags.has('--validate-only')) await validateFiles()
else if (flags.has('--initialize-baseline')) await initializeBaseline()
else await updateFeeds()

console.log(`Validated ${fileURLToPath(snapshotUrl)}.`)
