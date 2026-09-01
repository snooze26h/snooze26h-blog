import { createHash } from 'node:crypto'
import { compile } from 'html-to-text'
import Parser from 'rss-parser'

export const MAX_ARTICLES_PER_SOURCE = 20
export const MAX_ARTICLES_TOTAL = 1000
export const MAX_FEED_BYTES = 5 * 1024 * 1024
export const MAX_SUMMARY_LENGTH = 280
export const MAX_TITLE_LENGTH = 240

const MAX_HTML_INPUT_LENGTH = 200_000
const MAX_FALLBACK_TITLE_LENGTH = 96
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
const LEGACY_SNAPSHOT_KEYS = ['content_updated_at', 'items', 'source_count', 'version']
const SNAPSHOT_KEYS = [
  'content_updated_at',
  'date_only_item_ids',
  'items',
  'monitoring_started_at',
  'new_item_ids',
  'source_baseline_day_urls',
  'source_count',
  'source_started_at',
  'version'
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

function isDateOnlyPublishedValue(value) {
  const rawValue = getFieldText(value).trim()
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(rawValue) ||
    /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*)?\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}$/iu.test(
      rawValue
    )
  )
}

class DeterministicFeedParser extends Parser {
  parseItemAtom(entry) {
    const normalizedEntry = { ...entry }
    const publishedDate = parsePublishedDate(entry?.published)
    const updatedDate = parsePublishedDate(entry?.updated)
    const publishedDateOnly = publishedDate
      ? isDateOnlyPublishedValue(entry.published)
      : updatedDate
        ? isDateOnlyPublishedValue(entry.updated)
        : false
    for (const field of ['published', 'updated']) {
      if (entry?.[field] === undefined) continue
      const date = parsePublishedDate(entry[field])
      normalizedEntry[field] = date ? [date.toISOString()] : []
    }
    const item = super.parseItemAtom(normalizedEntry)
    Object.defineProperty(item, '_published_date_only', { value: publishedDateOnly })
    return item
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

  const summary = toPlainText(
    item?.summary ||
      item?.description ||
      item?.contentEncoded ||
      item?.content ||
      item?.contentSnippet ||
      ''
  )
  const title =
    toPlainText(item?.title, MAX_TITLE_LENGTH) || truncateText(summary, MAX_FALLBACK_TITLE_LENGTH)
  const identity = normalizeIdentity(item?.guid) || normalizeIdentity(item?.id) || url

  const normalizedItem = {
    id: createArticleId(source.id, identity),
    source_id: source.id,
    source_name: source.name,
    title,
    published_at: publishedDate.toISOString(),
    summary,
    url
  }
  Object.defineProperty(normalizedItem, '_published_date_only', {
    value: item?._published_date_only === true || isDateOnlyPublishedValue(rawDate)
  })
  return normalizedItem
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
  const enabledFeedUrls = new Set()
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
    if (source.enabled) {
      const feedUrl = normalizeHttpUrl(source.feed_url)
      if (enabledFeedUrls.has(feedUrl)) {
        throw new Error(`Duplicate enabled feed URL: ${feedUrl}`)
      }
      enabledFeedUrls.add(feedUrl)
    }
  }

  return manifest
}

export function getEnabledSources(manifest) {
  validateManifest(manifest)
  return manifest.filter((source) => source.enabled)
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false
  const date = new Date(value)
  return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function isPublishedAfterSourceStart(
  item,
  sourceStartedAt,
  baselineDayUrls = [],
  isDateOnly = false
) {
  if (baselineDayUrls.includes(item.url)) return false
  if (isDateOnly) {
    return item.published_at.slice(0, 10) >= sourceStartedAt.slice(0, 10)
  }
  return item.published_at > sourceStartedAt
}

function getBaselineDayUrls(items, sourceId, startedAt) {
  return items
    .filter(
      (item) =>
        item.source_id === sourceId && item.published_at.slice(0, 10) === startedAt.slice(0, 10)
    )
    .map((item) => item.url)
    .sort(compareStrings)
}

function validateSnapshotItems(items) {
  if (!Array.isArray(items) || items.length > MAX_ARTICLES_TOTAL) {
    throw new Error('Feed snapshot has an invalid item collection')
  }
  const ids = new Set()
  const perSource = new Map()
  for (const item of items) {
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
    if (!item.id.startsWith(`${item.source_id}:`)) {
      throw new Error(`Feed snapshot item ${item.id} does not match its source id`)
    }
    if (toPlainText(item.source_name, MAX_TITLE_LENGTH) !== item.source_name) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid source name`)
    }
    if (toPlainText(item.title, MAX_TITLE_LENGTH) !== item.title) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid title`)
    }
    if (toPlainText(item.summary, MAX_SUMMARY_LENGTH) !== item.summary) {
      throw new Error(`Feed snapshot item ${item.id} has an invalid summary`)
    }
    if (!isIsoTimestamp(item.published_at)) {
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

  if (JSON.stringify([...items].sort(compareArticles)) !== JSON.stringify(items)) {
    throw new Error('Feed snapshot items are not deterministically sorted')
  }

  return ids
}

function validateLegacySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1) {
    throw new Error('Legacy feed snapshot must use schema version 1')
  }
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(LEGACY_SNAPSHOT_KEYS)) {
    throw new Error('Legacy feed snapshot contains missing or unexpected fields')
  }
  if (snapshot.content_updated_at !== null && !isIsoTimestamp(snapshot.content_updated_at)) {
    throw new Error('Legacy feed snapshot has an invalid content_updated_at value')
  }
  if (!Number.isInteger(snapshot.source_count) || snapshot.source_count < 0) {
    throw new Error('Legacy feed snapshot has an invalid source_count')
  }
  validateSnapshotItems(snapshot.items)
  return snapshot
}

export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 2) {
    throw new Error('Feed snapshot must use schema version 2')
  }
  if (JSON.stringify(Object.keys(snapshot).sort()) !== JSON.stringify(SNAPSHOT_KEYS)) {
    throw new Error('Feed snapshot contains missing or unexpected fields')
  }
  if (!isIsoTimestamp(snapshot.monitoring_started_at)) {
    throw new Error('Feed snapshot has an invalid monitoring_started_at value')
  }
  if (snapshot.content_updated_at !== null && !isIsoTimestamp(snapshot.content_updated_at)) {
    throw new Error('Feed snapshot has an invalid content_updated_at value')
  }
  if (!Number.isInteger(snapshot.source_count) || snapshot.source_count < 0) {
    throw new Error('Feed snapshot has an invalid source_count')
  }
  if (
    !snapshot.source_started_at ||
    typeof snapshot.source_started_at !== 'object' ||
    Array.isArray(snapshot.source_started_at)
  ) {
    throw new Error('Feed snapshot has an invalid source_started_at value')
  }
  for (const [sourceId, startedAt] of Object.entries(snapshot.source_started_at)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(sourceId) || !isIsoTimestamp(startedAt)) {
      throw new Error(`Feed snapshot has an invalid source start: ${sourceId}`)
    }
  }
  if (
    !snapshot.source_baseline_day_urls ||
    typeof snapshot.source_baseline_day_urls !== 'object' ||
    Array.isArray(snapshot.source_baseline_day_urls)
  ) {
    throw new Error('Feed snapshot has an invalid source_baseline_day_urls value')
  }
  if (
    JSON.stringify(Object.keys(snapshot.source_baseline_day_urls)) !==
    JSON.stringify(Object.keys(snapshot.source_started_at))
  ) {
    throw new Error('Feed snapshot source baseline keys do not match source start keys')
  }
  for (const [sourceId, urls] of Object.entries(snapshot.source_baseline_day_urls)) {
    if (!Array.isArray(urls) || urls.length > MAX_ARTICLES_PER_SOURCE) {
      throw new Error(`Feed snapshot source ${sourceId} has invalid baseline day URLs`)
    }
    const normalizedUrls = urls.map((url) => normalizeHttpUrl(url, { stripTracking: true }))
    const expectedUrls = [...new Set(normalizedUrls)].sort(compareStrings)
    if (
      normalizedUrls.some((url) => !url) ||
      JSON.stringify(urls) !== JSON.stringify(expectedUrls)
    ) {
      throw new Error(`Feed snapshot source ${sourceId} has invalid baseline day URLs`)
    }
  }

  const itemIds = validateSnapshotItems(snapshot.items)
  const itemsById = new Map(snapshot.items.map((item) => [item.id, item]))
  if (!Array.isArray(snapshot.date_only_item_ids)) {
    throw new Error('Feed snapshot has an invalid date_only_item_ids value')
  }
  const dateOnlyItemIds = new Set()
  for (const itemId of snapshot.date_only_item_ids) {
    if (!itemIds.has(itemId) || dateOnlyItemIds.has(itemId)) {
      throw new Error(`Feed snapshot has an invalid date-only item id: ${itemId}`)
    }
    if (!itemsById.get(itemId).published_at.endsWith('T00:00:00.000Z')) {
      throw new Error(`Feed snapshot date-only item ${itemId} is not at UTC midnight`)
    }
    dateOnlyItemIds.add(itemId)
  }
  const expectedDateOnlyItemIds = snapshot.items
    .filter((item) => dateOnlyItemIds.has(item.id))
    .map((item) => item.id)
  if (JSON.stringify(snapshot.date_only_item_ids) !== JSON.stringify(expectedDateOnlyItemIds)) {
    throw new Error('Feed snapshot date_only_item_ids are not deterministically sorted')
  }
  if (!Array.isArray(snapshot.new_item_ids)) {
    throw new Error('Feed snapshot has an invalid new_item_ids value')
  }
  const newItemIds = new Set()
  for (const itemId of snapshot.new_item_ids) {
    if (!itemIds.has(itemId) || newItemIds.has(itemId)) {
      throw new Error(`Feed snapshot has an invalid new item id: ${itemId}`)
    }
    const item = itemsById.get(itemId)
    const sourceStartedAt = snapshot.source_started_at[item.source_id]
    const baselineDayUrls = snapshot.source_baseline_day_urls[item.source_id]
    if (!sourceStartedAt || !baselineDayUrls || baselineDayUrls.includes(item.url)) {
      throw new Error(`Feed snapshot new item ${itemId} does not belong to a monitored update`)
    }
    newItemIds.add(itemId)
  }
  const expectedNewItemIds = snapshot.items
    .filter((item) => newItemIds.has(item.id))
    .map((item) => item.id)
  if (JSON.stringify(snapshot.new_item_ids) !== JSON.stringify(expectedNewItemIds)) {
    throw new Error('Feed snapshot new_item_ids are not deterministically sorted')
  }

  return snapshot
}

export function initializeSnapshotBaseline({ sources, previousSnapshot, now = new Date() }) {
  validateManifest(sources)
  if (previousSnapshot?.version === 1) validateLegacySnapshot(previousSnapshot)
  else validateSnapshot(previousSnapshot)

  const enabledSources = getEnabledSources(sources)
  const startedAt = new Date(now).toISOString()
  const sourceNames = new Map(enabledSources.map((source) => [source.id, source.name]))
  const previousDateOnlyIds = new Set(previousSnapshot.date_only_item_ids || [])
  const items = previousSnapshot.items
    .filter((item) => sourceNames.has(item.source_id))
    .map((item) => ({ ...item, source_name: sourceNames.get(item.source_id) }))
    .sort(compareArticles)
    .slice(0, MAX_ARTICLES_TOTAL)
  const snapshot = {
    version: 2,
    monitoring_started_at: startedAt,
    content_updated_at: previousSnapshot.content_updated_at,
    source_count: enabledSources.length,
    source_started_at: Object.fromEntries(enabledSources.map((source) => [source.id, startedAt])),
    source_baseline_day_urls: Object.fromEntries(
      enabledSources.map((source) => [source.id, getBaselineDayUrls(items, source.id, startedAt)])
    ),
    date_only_item_ids: items
      .filter((item) => previousDateOnlyIds.has(item.id))
      .map((item) => item.id),
    new_item_ids: [],
    items
  }

  validateSnapshotAgainstManifest(snapshot, sources)
  return snapshot
}

export function validateSnapshotAgainstManifest(snapshot, manifest) {
  validateSnapshot(snapshot)
  const enabledSources = getEnabledSources(manifest)
  if (snapshot.source_count !== enabledSources.length) {
    throw new Error('Feed snapshot source_count does not match the enabled manifest sources')
  }

  const enabledIds = new Set(enabledSources.map((source) => source.id))
  const startedSourceIds = Object.keys(snapshot.source_started_at)
  const initializedIds = new Set(startedSourceIds)
  for (const sourceId of startedSourceIds) {
    if (!enabledIds.has(sourceId)) {
      throw new Error(`Feed snapshot initialized source ${sourceId} is not enabled in the manifest`)
    }
  }
  const expectedInitializedIds = enabledSources
    .filter((source) => initializedIds.has(source.id))
    .map((source) => source.id)
  if (JSON.stringify(startedSourceIds) !== JSON.stringify(expectedInitializedIds)) {
    throw new Error('Feed snapshot source_started_at keys do not follow manifest order')
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
  const sourceStartedAt = Object.fromEntries(
    Object.entries(previousSnapshot.source_started_at).filter(([sourceId]) =>
      enabledIds.has(sourceId)
    )
  )
  const sourceBaselineDayUrls = Object.fromEntries(
    Object.entries(previousSnapshot.source_baseline_day_urls).filter(([sourceId]) =>
      enabledIds.has(sourceId)
    )
  )
  const previousNewItemIds = new Set(previousSnapshot.new_item_ids)
  const previousDateOnlyItemIds = new Set(previousSnapshot.date_only_item_ids)
  const previousBySource = new Map()

  for (const item of previousSnapshot.items) {
    if (!enabledIds.has(item.source_id)) continue
    const items = previousBySource.get(item.source_id) || []
    items.push(item)
    previousBySource.set(item.source_id, items)
  }

  const outcomesBySource = new Map(outcomes.map((outcome) => [outcome.source.id, outcome]))
  const combinedItems = []
  const retainedNewItemIds = new Set()
  const retainedDateOnlyItemIds = new Set()

  for (const source of enabledSources) {
    const outcome = outcomesBySource.get(source.id)
    const previousItems = previousBySource.get(source.id) || []
    let sourceItems

    if (outcome?.status === 'fulfilled') {
      const wasInitialized = Object.hasOwn(sourceStartedAt, source.id)
      const previousById = new Map(previousItems.map((item) => [item.id, item]))
      const previousByUrl = new Map(previousItems.map((item) => [item.url, item]))
      sourceItems = outcome.value.map((item) => {
        const previousItem = previousById.get(item.id) || previousByUrl.get(item.url)
        const { _published_date_only: isDateOnly = false, ...snapshotItem } = item
        const normalizedItem = {
          ...snapshotItem,
          id: previousItem?.id || item.id,
          source_id: source.id,
          source_name: source.name
        }
        if (isDateOnly) retainedDateOnlyItemIds.add(normalizedItem.id)
        return normalizedItem
      })

      for (const item of sourceItems) {
        const previousItem = previousById.get(item.id) || previousByUrl.get(item.url)
        if (previousItem && previousNewItemIds.has(previousItem.id)) {
          retainedNewItemIds.add(item.id)
        } else if (
          !previousItem &&
          wasInitialized &&
          isPublishedAfterSourceStart(
            item,
            sourceStartedAt[source.id],
            sourceBaselineDayUrls[source.id],
            retainedDateOnlyItemIds.has(item.id)
          )
        ) {
          retainedNewItemIds.add(item.id)
        }
      }
      if (!wasInitialized) {
        const startedAt = new Date(now).toISOString()
        sourceStartedAt[source.id] = startedAt
        sourceBaselineDayUrls[source.id] = getBaselineDayUrls(sourceItems, source.id, startedAt)
      }
    } else {
      sourceItems = previousItems.map((item) => ({ ...item, source_name: source.name }))
      for (const item of sourceItems) {
        if (previousNewItemIds.has(item.id)) retainedNewItemIds.add(item.id)
        if (previousDateOnlyItemIds.has(item.id)) retainedDateOnlyItemIds.add(item.id)
      }
    }

    combinedItems.push(...sourceItems.slice(0, MAX_ARTICLES_PER_SOURCE))
  }

  const items = combinedItems.sort(compareArticles).slice(0, MAX_ARTICLES_TOTAL)
  const nextSourceStartedAt = Object.fromEntries(
    enabledSources
      .filter((source) => Object.hasOwn(sourceStartedAt, source.id))
      .map((source) => [source.id, sourceStartedAt[source.id]])
  )
  const nextSourceBaselineDayUrls = Object.fromEntries(
    enabledSources
      .filter((source) => Object.hasOwn(sourceBaselineDayUrls, source.id))
      .map((source) => [source.id, sourceBaselineDayUrls[source.id]])
  )
  const newItemIds = items.filter((item) => retainedNewItemIds.has(item.id)).map((item) => item.id)
  const dateOnlyItemIds = items
    .filter((item) => retainedDateOnlyItemIds.has(item.id))
    .map((item) => item.id)
  const contentChanged =
    previousSnapshot.source_count !== enabledSources.length ||
    JSON.stringify(previousSnapshot.source_started_at) !== JSON.stringify(nextSourceStartedAt) ||
    JSON.stringify(previousSnapshot.source_baseline_day_urls) !==
      JSON.stringify(nextSourceBaselineDayUrls) ||
    JSON.stringify(previousSnapshot.date_only_item_ids) !== JSON.stringify(dateOnlyItemIds) ||
    JSON.stringify(previousSnapshot.new_item_ids) !== JSON.stringify(newItemIds) ||
    JSON.stringify(previousSnapshot.items) !== JSON.stringify(items)

  const nextSnapshot = {
    version: 2,
    monitoring_started_at: previousSnapshot.monitoring_started_at,
    content_updated_at: contentChanged
      ? new Date(now).toISOString()
      : previousSnapshot.content_updated_at,
    source_count: enabledSources.length,
    source_started_at: nextSourceStartedAt,
    source_baseline_day_urls: nextSourceBaselineDayUrls,
    date_only_item_ids: dateOnlyItemIds,
    new_item_ids: newItemIds,
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
