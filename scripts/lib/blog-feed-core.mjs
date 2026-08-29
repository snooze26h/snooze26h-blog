import { createHash } from 'node:crypto'
import { compile } from 'html-to-text'
import Parser from 'rss-parser'

export const MAX_ARTICLES_PER_SOURCE = 20
export const MAX_ARTICLES_TOTAL = 300
export const MAX_FEED_BYTES = 5 * 1024 * 1024
export const MAX_SUMMARY_LENGTH = 280
export const MAX_TITLE_LENGTH = 240

const MAX_HTML_INPUT_LENGTH = 200_000
const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT_MS = 15_000
const MONTH_INDEX = new Map(
  ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].map(
    (month, index) => [month, index]
  )
)
const TRACKING_PARAMETERS = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid'])
const SNAPSHOT_ITEM_KEYS = [
  'id',
  'published_at',
  'source_id',
  'source_name',
  'summary',
  'title',
  'url'
]

const htmlToPlainText = compile({
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'script', format: 'skip' },
    { selector: 'style', format: 'skip' },
    { selector: 'noscript', format: 'skip' },
    { selector: 'svg', format: 'skip' }
  ]
})

function getFieldText(value) {
  if (Array.isArray(value)) return getFieldText(value[0])
  if (value && typeof value === 'object') {
    if (typeof value._ === 'string') return value._
    if (typeof value.href === 'string') return value.href
  }
  return value == null ? '' : String(value)
}

function truncateText(value, maxLength) {
  const characters = Array.from(value)
  if (characters.length <= maxLength) return value
  return `${characters.slice(0, maxLength - 1).join('')}…`
}

export function toPlainText(value, maxLength = MAX_SUMMARY_LENGTH) {
  const input = getFieldText(value).slice(0, MAX_HTML_INPUT_LENGTH)
  if (!input) return ''

  const text = htmlToPlainText(input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .normalize('NFC')

  return truncateText(text, maxLength)
}

export function normalizeHttpUrl(value, { baseUrl, stripTracking = false } = {}) {
  const rawValue = getFieldText(value).trim()
  if (!rawValue) return null

  let url
  try {
    url = new URL(rawValue, baseUrl)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null

  url.hash = ''
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = ''
  }

  if (stripTracking) {
    for (const key of [...url.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || TRACKING_PARAMETERS.has(key.toLowerCase())) {
        url.searchParams.delete(key)
      }
    }
  }
  url.searchParams.sort()

  return url.toString()
}

function normalizeIdentity(value) {
  const identity = getFieldText(value).trim()
  if (!identity) return null
  return normalizeHttpUrl(identity, { stripTracking: true }) || identity
}

function createArticleId(sourceId, identity) {
  const digest = createHash('sha256').update(`${sourceId}\0${identity}`).digest('hex').slice(0, 24)
  return `${sourceId}:${digest}`
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareArticles(left, right) {
  return (
    compareStrings(right.published_at, left.published_at) ||
    compareStrings(left.source_id, right.source_id) ||
    compareStrings(left.id, right.id) ||
    compareStrings(left.url, right.url)
  )
}

function parsePublishedDate(value) {
  const rawValue = getFieldText(value).trim()
  if (!rawValue) return null

  if (/^\d{4}-\d{2}-\d{2}$/u.test(rawValue)) {
    const dateOnly = new Date(`${rawValue}T00:00:00.000Z`)
    return Number.isNaN(dateOnly.getTime()) ? null : dateOnly
  }

  const rfcDateOnly = rawValue.match(
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/iu
  )
  if (rfcDateOnly) {
    const day = Number(rfcDateOnly[1])
    const month = MONTH_INDEX.get(rfcDateOnly[2].toLowerCase())
    const year = Number(rfcDateOnly[3])
    if (month === undefined || year < 1000) return null

    const dateOnly = new Date(Date.UTC(year, month, day))
    return dateOnly.getUTCFullYear() === year &&
      dateOnly.getUTCMonth() === month &&
      dateOnly.getUTCDate() === day
      ? dateOnly
      : null
  }

  const hasTime = /\d{1,2}:\d{2}/u.test(rawValue)
  if (!hasTime) return null
  const hasExplicitZone = /(?:Z|GMT|UTC|[+-]\d{2}:?\d{2}|[A-Z]{3})(?:\s+\([^)]*\))?$/iu.test(
    rawValue
  )
  if (hasTime && !hasExplicitZone) return null

  const date = new Date(rawValue)
  return Number.isNaN(date.getTime()) ? null : date
}

class DeterministicFeedParser extends Parser {
  parseItemAtom(entry) {
    const normalizedEntry = { ...entry }
    for (const field of ['published', 'updated']) {
      if (entry?.[field] === undefined) continue
      const date = parsePublishedDate(entry[field])
      normalizedEntry[field] = date ? [date.toISOString()] : []
    }
    return super.parseItemAtom(normalizedEntry)
  }
}

export function normalizeFeedItem(source, item) {
  const url =
    normalizeHttpUrl(item?.link, { baseUrl: source.site_url, stripTracking: true }) ||
    normalizeHttpUrl(item?.guid, { stripTracking: true }) ||
    normalizeHttpUrl(item?.id, { stripTracking: true })
  if (!url) return null

  const rawDate =
    item?.pubDate || item?.published || item?.updated || item?.date || item?.isoDate || ''
  const publishedDate = parsePublishedDate(rawDate)
  if (!publishedDate) return null

  const title = toPlainText(item?.title, MAX_TITLE_LENGTH)
  if (!title) return null

  const identity = normalizeIdentity(item?.guid) || normalizeIdentity(item?.id) || url
  const summary = toPlainText(
    item?.summary ||
      item?.description ||
      item?.contentEncoded ||
      item?.content ||
      item?.contentSnippet ||
      ''
  )

  return {
    id: createArticleId(source.id, identity),
    source_id: source.id,
    source_name: source.name,
    title,
    published_at: publishedDate.toISOString(),
    summary,
    url
  }
}

export function normalizeFeedItems(source, items) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => normalizeFeedItem(source, item))
    .filter(Boolean)
    .sort(compareArticles)

  const seenIds = new Set()
  const seenUrls = new Set()
  const deduplicated = []

  for (const item of normalized) {
    if (seenIds.has(item.id) || seenUrls.has(item.url)) continue
    seenIds.add(item.id)
    seenUrls.add(item.url)
    deduplicated.push(item)
    if (deduplicated.length === MAX_ARTICLES_PER_SOURCE) break
  }

  return deduplicated
}

export async function parseFeedXml(source, xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new Error('Feed XML exceeded the input size limit')
  }
  if (/<!DOCTYPE\b/iu.test(xml)) throw new Error('Feed XML must not contain a DOCTYPE')

  const documentStart = xml
    .replace(/^\uFEFF/u, '')
    .replace(/^\s*<\?xml[^>]*>\s*/iu, '')
    .trimStart()
  const rootName = documentStart.match(/^<([\w:-]+)/u)?.[1]?.toLowerCase()
  const detectedKind =
    rootName === 'feed' ? 'atom' : rootName === 'rss' || rootName?.endsWith(':rdf') ? 'rss' : null
  if (detectedKind && detectedKind !== source.kind) {
    throw new Error(`Feed kind mismatch: expected ${source.kind}, received ${detectedKind}`)
  }

  const parser = new DeterministicFeedParser({
    customFields: {
      item: [
        'id',
        'summary',
        'description',
        'published',
        'updated',
        ['content:encoded', 'contentEncoded']
      ]
    }
  })
  const feed = await parser.parseString(xml)
  const items = normalizeFeedItems(source, feed.items)
  if (items.length === 0) throw new Error('Feed contained no valid dated articles')
  return items
}

async function readLimitedResponseBody(response, controller) {
  if (!response.body) throw new Error('Feed response did not contain a body')

  const reader = response.body.getReader()
  const chunks = []
  let byteLength = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      byteLength += value.byteLength
      if (byteLength > MAX_FEED_BYTES) {
        try {
          await reader.cancel('Feed exceeded the response size limit')
        } catch {
          // The request may already be aborted by the fetch implementation.
        }
        controller.abort()
        throw new Error('Feed exceeded the response size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const payload = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    payload.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(payload)
}

export async function fetchFeedSource(
  source,
  { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  const feedUrl = normalizeHttpUrl(source.feed_url)
  if (!feedUrl) throw new Error('Feed URL must use HTTP or HTTPS without credentials')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(feedUrl, {
      cache: 'no-store',
      headers: {
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9',
        'user-agent': 'snooze26h-blog-feed-monitor/1.0'
      },
      redirect: 'follow',
      signal: controller.signal
    })

    if (!response.ok) throw new Error(`Feed request returned HTTP ${response.status}`)
    if (!normalizeHttpUrl(response.url || feedUrl))
      throw new Error('Feed redirect was not HTTP or HTTPS')

    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > MAX_FEED_BYTES) {
      controller.abort()
      await response.body?.cancel().catch(() => undefined)
      throw new Error('Feed exceeded the response size limit')
    }

    return await parseFeedXml(source, await readLimitedResponseBody(response, controller))
  } finally {
    clearTimeout(timeout)
  }
}

export function validateManifest(manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new Error('Feed manifest must be a non-empty array')
  }

  const ids = new Set()
  for (const source of manifest) {
    if (!source || typeof source !== 'object') throw new Error('Feed source must be an object')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(source.id)) {
      throw new Error(`Invalid feed source id: ${source.id || '(missing)'}`)
    }
    if (ids.has(source.id)) throw new Error(`Duplicate feed source id: ${source.id}`)
    ids.add(source.id)

    if (
      !toPlainText(source.name, MAX_TITLE_LENGTH) ||
      toPlainText(source.name, MAX_TITLE_LENGTH) !== source.name
    ) {
      throw new Error(`Feed source ${source.id} has an invalid name`)
    }
    for (const field of ['site_url', 'discovery_url', 'feed_url']) {
      if (!normalizeHttpUrl(source[field])) {
        throw new Error(`Feed source ${source.id} has an invalid ${field}`)
      }
    }
    if (source.kind !== 'rss' && source.kind !== 'atom') {
      throw new Error(`Feed source ${source.id} has an invalid kind`)
    }
    if (typeof source.enabled !== 'boolean') {
      throw new Error(`Feed source ${source.id} must declare enabled as a boolean`)
    }
    if (!Number.isInteger(source.poll_interval_minutes) || source.poll_interval_minutes <= 0) {
      throw new Error(`Feed source ${source.id} has an invalid polling interval`)
    }
    if (!['verified', 'disabled_by_choice', 'unsupported'].includes(source.status)) {
      throw new Error(`Feed source ${source.id} has an invalid status`)
    }
    if (source.enabled && source.status !== 'verified') {
      throw new Error(`Enabled feed source ${source.id} must be verified`)
    }
  }

  return manifest
}

export function getEnabledSources(manifest) {
  validateManifest(manifest)

  const feedUrls = new Set()
  const sources = []
  for (const source of manifest) {
    if (!source.enabled) continue
    const feedUrl = normalizeHttpUrl(source.feed_url)
    if (feedUrls.has(feedUrl)) continue
    feedUrls.add(feedUrl)
    sources.push(source)
  }
  return sources
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1) {
    throw new Error('Feed snapshot must use schema version 1')
  }
  if (
    snapshot.content_updated_at !== null &&
    new Date(snapshot.content_updated_at).toISOString() !== snapshot.content_updated_at
  ) {
    throw new Error('Feed snapshot has an invalid content_updated_at value')
  }
  if (!Number.isInteger(snapshot.source_count) || snapshot.source_count < 0) {
    throw new Error('Feed snapshot has an invalid source_count')
  }
  if (!Array.isArray(snapshot.items) || snapshot.items.length > MAX_ARTICLES_TOTAL) {
    throw new Error('Feed snapshot has an invalid item collection')
  }

  const ids = new Set()
  const perSource = new Map()
  for (const item of snapshot.items) {
    const keys = Object.keys(item).sort()
    if (JSON.stringify(keys) !== JSON.stringify(SNAPSHOT_ITEM_KEYS)) {
      throw new Error('Feed snapshot item contains missing or unexpected fields')
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*:[a-f0-9]{24}$/u.test(item.id) || ids.has(item.id)) {
      throw new Error(`Feed snapshot has an invalid or duplicate item id: ${item.id}`)
    }
    ids.add(item.id)

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(item.source_id)) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid source id`)
    }
    if (toPlainText(item.source_name, MAX_TITLE_LENGTH) !== item.source_name) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid source name`)
    }
    if (!item.title || toPlainText(item.title, MAX_TITLE_LENGTH) !== item.title) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid title`)
    }
    if (toPlainText(item.summary, MAX_SUMMARY_LENGTH) !== item.summary) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid summary`)
    }
    if (new Date(item.published_at).toISOString() !== item.published_at) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid publication date`)
    }
    if (normalizeHttpUrl(item.url, { stripTracking: true }) !== item.url) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid article URL`)
    }

    const sourceCount = (perSource.get(item.source_id) || 0) + 1
    if (sourceCount > MAX_ARTICLES_PER_SOURCE) {
      throw new Error(`Feed snapshot source ${item.source_id} exceeded its item limit`)
    }
    perSource.set(item.source_id, sourceCount)
  }

  if (
    JSON.stringify([...snapshot.items].sort(compareArticles)) !== JSON.stringify(snapshot.items)
  ) {
    throw new Error('Feed snapshot items are not deterministically sorted')
  }

  return snapshot
}

export function validateSnapshotAgainstManifest(snapshot, manifest) {
  validateSnapshot(snapshot)
  const enabledSources = getEnabledSources(manifest)
  if (snapshot.source_count !== enabledSources.length) {
    throw new Error('Feed snapshot source_count does not match the enabled manifest sources')
  }

  const sourceNames = new Map(enabledSources.map((source) => [source.id, source.name]))
  for (const item of snapshot.items) {
    if (sourceNames.get(item.source_id) !== item.source_name) {
      throw new Error(`Feed snapshot item ${item.id} does not match the manifest source`)
    }
  }

  return snapshot
}

export async function fetchEnabledSources(
  sources,
  { concurrency = DEFAULT_CONCURRENCY, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}
) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Feed concurrency must be a positive integer')
  }
  const outcomes = []
  for (let index = 0; index < sources.length; index += concurrency) {
    const batch = sources.slice(index, index + concurrency)
    const settled = await Promise.allSettled(
      batch.map((source) => fetchFeedSource(source, { fetchImpl, timeoutMs }))
    )
    outcomes.push(
      ...settled.map((result, resultIndex) => ({ source: batch[resultIndex], ...result }))
    )
  }
  return outcomes
}

export function createNextSnapshot({ sources, outcomes, previousSnapshot, now = new Date() }) {
  validateSnapshot(previousSnapshot)
  const enabledSources = getEnabledSources(sources)
  const enabledIds = new Set(enabledSources.map((source) => source.id))
  const previousBySource = new Map()

  for (const item of previousSnapshot.items) {
    if (!enabledIds.has(item.source_id)) continue
    const items = previousBySource.get(item.source_id) || []
    items.push(item)
    previousBySource.set(item.source_id, items)
  }

  const outcomesBySource = new Map(outcomes.map((outcome) => [outcome.source.id, outcome]))
  const combinedItems = []

  for (const source of enabledSources) {
    const outcome = outcomesBySource.get(source.id)
    const sourceItems =
      outcome?.status === 'fulfilled'
        ? outcome.value
        : (previousBySource.get(source.id) || []).map((item) => ({
            ...item,
            source_name: source.name
          }))
    combinedItems.push(...sourceItems.slice(0, MAX_ARTICLES_PER_SOURCE))
  }

  const items = combinedItems.sort(compareArticles).slice(0, MAX_ARTICLES_TOTAL)
  const contentChanged =
    previousSnapshot.source_count !== enabledSources.length ||
    JSON.stringify(previousSnapshot.items) !== JSON.stringify(items)

  const nextSnapshot = {
    version: 1,
    content_updated_at: contentChanged
      ? new Date(now).toISOString()
      : previousSnapshot.content_updated_at,
    source_count: enabledSources.length,
    items
  }

  validateSnapshotAgainstManifest(nextSnapshot, sources)
  return { contentChanged, snapshot: nextSnapshot }
}

export async function refreshBlogFeeds({
  sources,
  previousSnapshot,
  concurrency = DEFAULT_CONCURRENCY,
  fetchImpl = fetch,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const enabledSources = getEnabledSources(sources)
  const outcomes = await fetchEnabledSources(enabledSources, {
    concurrency,
    fetchImpl,
    timeoutMs
  })
  const successfulSourceCount = outcomes.filter((outcome) => outcome.status === 'fulfilled').length
  const failures = outcomes
    .filter((outcome) => outcome.status === 'rejected')
    .map((outcome) => ({
      source_id: outcome.source.id,
      message: outcome.reason instanceof Error ? outcome.reason.message : 'Unknown feed error'
    }))
  const { contentChanged, snapshot } = createNextSnapshot({
    sources,
    outcomes,
    previousSnapshot,
    now
  })

  return { contentChanged, failures, snapshot, successfulSourceCount }
}

export function serializeSnapshot(snapshot) {
  validateSnapshot(snapshot)
  return `${JSON.stringify(snapshot, null, 2)}\n`
}
