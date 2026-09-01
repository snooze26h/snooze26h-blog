import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNextSnapshot,
  fetchFeedSource,
  getEnabledSources,
  initializeSnapshotBaseline,
  MAX_FEED_BYTES,
  MAX_SUMMARY_LENGTH,
  normalizeFeedItems,
  parseFeedXml,
  refreshBlogFeeds,
  serializeSnapshot,
  validateSnapshot,
  validateSnapshotAgainstManifest
} from './lib/blog-feed-core.mjs'

const source = {
  id: 'fixture',
  name: 'Fixture Blog',
  site_url: 'https://example.com/',
  discovery_url: 'https://example.com/',
  feed_url: 'https://example.com/feed.xml',
  kind: 'rss',
  enabled: true,
  poll_interval_minutes: 120,
  status: 'verified'
}

const MONITORING_STARTED_AT = '2025-08-20T00:00:00.000Z'

function createSnapshot({
  contentUpdatedAt = null,
  dateOnlyItemIds,
  items = [],
  newItemIds = [],
  sourceCount = 1,
  sourceBaselineDayUrls,
  sourceStartedAt = { fixture: MONITORING_STARTED_AT }
} = {}) {
  const baselineDayUrls =
    sourceBaselineDayUrls ||
    Object.fromEntries(
      Object.entries(sourceStartedAt).map(([sourceId, startedAt]) => [
        sourceId,
        items
          .filter(
            (item) =>
              item.source_id === sourceId &&
              !newItemIds.includes(item.id) &&
              item.published_at.slice(0, 10) === startedAt.slice(0, 10)
          )
          .map((item) => item.url)
          .sort()
      ])
    )
  return {
    version: 2,
    monitoring_started_at: MONITORING_STARTED_AT,
    content_updated_at: contentUpdatedAt,
    source_count: sourceCount,
    source_started_at: sourceStartedAt,
    source_baseline_day_urls: baselineDayUrls,
    date_only_item_ids:
      dateOnlyItemIds ||
      items.filter((item) => item._published_date_only === true).map((item) => item.id),
    new_item_ids: newItemIds,
    items
  }
}

const emptySnapshot = createSnapshot()

test('RSS normalization removes malicious HTML, rejects invalid dates, and deduplicates GUIDs', async () => {
  const oversizedSummary = `<p>Hello <strong>world</strong></p><script>alert('x')</script>${'x'.repeat(400)}`
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Fixture</title><link>https://example.com/</link>
      <item><title>Older duplicate</title><link>https://example.com/old</link><guid>same-guid</guid><pubDate>Tue, 19 Aug 2025 12:00:00 GMT</pubDate></item>
      <item><title><![CDATA[<b>Safe title</b>]]></title><link>https://example.com/a?utm_source=test#fragment</link><guid>same-guid</guid><pubDate>Wed, 20 Aug 2025 12:00:00 GMT</pubDate><description><![CDATA[${oversizedSummary}]]></description></item>
      <item><title>Invalid date</title><link>https://example.com/b</link><guid>invalid</guid><pubDate>not-a-date</pubDate></item>
      <item><title>Ambiguous date</title><link>https://example.com/c</link><guid>ambiguous</guid><pubDate>2025-08-20T12:00:00</pubDate></item>
    </channel></rss>`

  const items = await parseFeedXml(source, xml)

  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Safe title')
  assert.equal(items[0].url, 'https://example.com/a')
  assert.ok(!items[0].summary.includes('<'))
  assert.ok(!items[0].summary.includes('alert'))
  assert.equal(Array.from(items[0].summary).length, MAX_SUMMARY_LENGTH)
})

test('a titleless item uses its sanitized summary as a fallback title', () => {
  const items = normalizeFeedItems(source, [
    {
      title: '',
      link: 'https://example.com/titleless',
      guid: 'titleless-guid',
      isoDate: '2025-08-20T12:00:00.000Z',
      description: '<p>Safe fallback summary</p><script>alert(1)</script>'
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'Safe fallback summary')
  assert.equal(items[0].summary, 'Safe fallback summary')
})

test('an item without a title or summary remains available for the localized UI fallback', () => {
  const items = normalizeFeedItems(source, [
    {
      title: '',
      link: 'https://example.com/untitled',
      guid: 'untitled-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].title, '')
  assert.equal(items[0].summary, '')
})

test('Atom normalization accepts stable ids and an absent summary', async () => {
  const atomSource = { ...source, kind: 'atom' }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Fixture Atom</title><id>https://example.com/</id><updated>2025-08-20T12:00:00Z</updated>
      <entry><title>Atom post</title><id>tag:example.com,2025:one</id><link href="https://example.com/atom"/><updated>2025-08-20T12:00:00Z</updated></entry>
    </feed>`

  const items = await parseFeedXml(atomSource, xml)

  assert.equal(items.length, 1)
  assert.equal(items[0].summary, '')
  assert.match(items[0].id, /^fixture:[a-f0-9]{24}$/u)
  assert.equal(items[0].url, 'https://example.com/atom')
})

test('Atom normalization preserves date-only precision before ISO conversion', async () => {
  const atomSource = { ...source, kind: 'atom' }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Fixture Atom</title><id>https://example.com/</id><updated>2025-08-20</updated>
      <entry><title>Date-only Atom post</title><id>tag:example.com,2025:date-only</id><link href="https://example.com/atom-date-only"/><published>2025-08-20</published></entry>
    </feed>`

  const items = await parseFeedXml(atomSource, xml)

  assert.equal(items[0].published_at, '2025-08-20T00:00:00.000Z')
  assert.equal(items[0]._published_date_only, true)
})

test('Atom normalization isolates an entry with an invalid date', async () => {
  const atomSource = { ...source, kind: 'atom' }
  const xml = `<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Fixture Atom</title><id>https://example.com/</id><updated>2025-08-20T12:00:00Z</updated>
      <entry><title>Invalid post</title><id>tag:example.com,2025:invalid</id><link href="https://example.com/invalid"/><published>not-a-date</published></entry>
      <entry><title>Valid post</title><id>tag:example.com,2025:valid</id><link href="https://example.com/valid"/><published>2025-08-20T12:00:00Z</published><updated>2025-08-21T12:00:00Z</updated></entry>
      <entry><title>Updated fallback</title><id>tag:example.com,2025:fallback</id><link href="https://example.com/fallback"/><published>not-a-date</published><updated>2025-08-19T12:00:00Z</updated></entry>
    </feed>`

  const items = await parseFeedXml(atomSource, xml)

  assert.equal(items.length, 2)
  assert.equal(
    items.find((item) => item.title === 'Valid post')?.published_at,
    '2025-08-20T12:00:00.000Z'
  )
  assert.equal(
    items.find((item) => item.title === 'Updated fallback')?.published_at,
    '2025-08-19T12:00:00.000Z'
  )
})

test('date-only RFC dates normalize to UTC midnight', () => {
  const originalTimeZone = process.env.TZ
  const normalizeDateOnly = () =>
    normalizeFeedItems(source, [
      {
        title: 'Date-only post',
        link: 'https://example.com/date-only',
        guid: 'date-only-guid',
        pubDate: 'Wed, 20 Aug 2025'
      }
    ])[0].published_at

  try {
    process.env.TZ = 'UTC'
    const utcResult = normalizeDateOnly()
    process.env.TZ = 'America/Los_Angeles'
    const losAngelesResult = normalizeDateOnly()

    assert.equal(utcResult, '2025-08-20T00:00:00.000Z')
    assert.equal(losAngelesResult, utcResult)
  } finally {
    if (originalTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimeZone
  }
})

test('network failures reject one source without producing replacement data', async () => {
  await assert.rejects(
    fetchFeedSource(source, {
      fetchImpl: async () => {
        throw new Error('network unavailable')
      },
      timeoutMs: 50
    }),
    /network unavailable/u
  )
})

test('a timed-out request is aborted', async () => {
  let aborted = false
  await assert.rejects(
    fetchFeedSource(source, {
      fetchImpl: async (_url, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted = true
            reject(new Error('request aborted'))
          })
        }),
      timeoutMs: 5
    }),
    /request aborted/u
  )
  assert.equal(aborted, true)
})

test('a chunked response is cancelled when it exceeds the byte limit', async () => {
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_FEED_BYTES))
      controller.enqueue(new Uint8Array(1))
    },
    cancel() {
      cancelled = true
    }
  })

  await assert.rejects(
    fetchFeedSource(source, {
      fetchImpl: async () => new Response(body, { status: 200 })
    }),
    /response size limit/u
  )
  assert.equal(cancelled, true)
})

test('an oversized declared response is aborted before reading', async () => {
  let requestSignal
  let cancelled = false
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1))
    },
    cancel() {
      cancelled = true
    }
  })

  await assert.rejects(
    fetchFeedSource(source, {
      fetchImpl: async (_url, { signal }) => {
        requestSignal = signal
        return new Response(body, {
          headers: { 'content-length': String(MAX_FEED_BYTES + 1) },
          status: 200
        })
      }
    }),
    /response size limit/u
  )
  assert.equal(requestSignal.aborted, true)
  assert.equal(cancelled, true)
})

test('a failed source retains its previous items and preserves the content timestamp', () => {
  const previousItem = normalizeFeedItems(source, [
    {
      title: 'Previous post',
      link: 'https://example.com/previous',
      guid: 'previous-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const previousSnapshot = createSnapshot({
    contentUpdatedAt: '2025-08-20T13:00:00.000Z',
    items: [previousItem]
  })
  const outcomes = [{ source, status: 'rejected', reason: new Error('offline') }]

  const result = createNextSnapshot({
    sources: [source],
    outcomes,
    previousSnapshot,
    now: new Date('2025-08-21T00:00:00.000Z')
  })

  assert.equal(result.contentChanged, false)
  assert.equal(result.snapshot.content_updated_at, previousSnapshot.content_updated_at)
  assert.deepEqual(result.snapshot.items, previousSnapshot.items)
})

test('substantive content changes update the timestamp and serialize deterministically', () => {
  const items = normalizeFeedItems(source, [
    {
      title: 'New post',
      link: 'https://example.com/new',
      guid: 'new-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    }
  ])
  const outcomes = [{ source, status: 'fulfilled', value: items }]

  const result = createNextSnapshot({
    sources: [source],
    outcomes,
    previousSnapshot: emptySnapshot,
    now: new Date('2025-08-21T13:00:00.000Z')
  })

  assert.equal(result.contentChanged, true)
  assert.equal(result.snapshot.content_updated_at, '2025-08-21T13:00:00.000Z')
  assert.deepEqual(result.snapshot.new_item_ids, [items[0].id])
  assert.equal(
    serializeSnapshot(result.snapshot),
    serializeSnapshot(validateSnapshot(result.snapshot))
  )
})

test('a successful unchanged source preserves byte-identical snapshot content', () => {
  const items = normalizeFeedItems(source, [
    {
      title: 'Existing post',
      link: 'https://example.com/existing',
      guid: 'existing-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    }
  ])
  const previousSnapshot = createSnapshot({
    contentUpdatedAt: '2025-08-21T13:00:00.000Z',
    items
  })
  const result = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: items }],
    previousSnapshot,
    now: new Date('2025-08-22T13:00:00.000Z')
  })

  assert.equal(result.contentChanged, false)
  assert.equal(serializeSnapshot(result.snapshot), serializeSnapshot(previousSnapshot))
})

test('mixed feed outcomes retain stale data only for the failed source', async () => {
  const failedSource = {
    ...source,
    id: 'failed',
    name: 'Failed Blog',
    feed_url: 'https://failed.example/feed.xml'
  }
  const staleItem = normalizeFeedItems(failedSource, [
    {
      title: 'Stale post',
      link: 'https://failed.example/stale',
      guid: 'stale-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const xml = `<?xml version="1.0"?>
    <rss version="2.0"><channel><title>Fixture</title><link>https://example.com/</link>
      <item><title>Fresh post</title><link>https://example.com/fresh</link><guid>fresh-guid</guid><pubDate>Thu, 21 Aug 2025 12:00:00 GMT</pubDate></item>
    </channel></rss>`
  const previousSnapshot = createSnapshot({
    contentUpdatedAt: '2025-08-20T13:00:00.000Z',
    items: [staleItem],
    newItemIds: [staleItem.id],
    sourceCount: 2,
    sourceStartedAt: {
      fixture: MONITORING_STARTED_AT,
      failed: MONITORING_STARTED_AT
    }
  })
  const result = await refreshBlogFeeds({
    sources: [source, failedSource],
    previousSnapshot,
    fetchImpl: async (url) => {
      if (url.includes('failed.example')) throw new Error('offline')
      return new Response(xml, { status: 200 })
    },
    now: new Date('2025-08-21T13:00:00.000Z')
  })

  assert.equal(result.successfulSourceCount, 1)
  assert.deepEqual(result.failures, [{ source_id: 'failed', message: 'offline' }])
  assert.deepEqual(
    new Set(result.snapshot.items.map((item) => item.source_id)),
    new Set(['fixture', 'failed'])
  )
  assert.ok(result.snapshot.new_item_ids.includes(staleItem.id))
})

test('duplicate normalized feed URLs are rejected', () => {
  const duplicate = {
    ...source,
    id: 'duplicate',
    feed_url: 'https://EXAMPLE.com:443/feed.xml#duplicate'
  }

  assert.throws(() => getEnabledSources([source, duplicate]), /Duplicate enabled feed URL/u)
})

test('snapshot generation migrates enabled sources and source names', () => {
  const previousItem = normalizeFeedItems(source, [
    {
      title: 'Previous post',
      link: 'https://example.com/previous',
      guid: 'previous-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const previousSnapshot = createSnapshot({
    contentUpdatedAt: '2025-08-20T13:00:00.000Z',
    items: [previousItem]
  })
  const renamedSource = { ...source, name: 'Renamed Fixture Blog' }
  const renamedResult = createNextSnapshot({
    sources: [renamedSource],
    outcomes: [{ source: renamedSource, status: 'rejected', reason: new Error('offline') }],
    previousSnapshot,
    now: new Date('2025-08-21T00:00:00.000Z')
  })

  assert.equal(renamedResult.snapshot.items[0].source_name, renamedSource.name)

  const replacementSource = {
    ...source,
    id: 'replacement',
    name: 'Replacement Blog',
    feed_url: 'https://replacement.example/feed.xml'
  }
  const replacementItems = normalizeFeedItems(replacementSource, [
    {
      title: 'Replacement post',
      link: 'https://replacement.example/post',
      guid: 'replacement-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    }
  ])
  const replacementResult = createNextSnapshot({
    sources: [{ ...source, enabled: false, status: 'disabled_by_choice' }, replacementSource],
    outcomes: [{ source: replacementSource, status: 'fulfilled', value: replacementItems }],
    previousSnapshot,
    now: new Date('2025-08-21T13:00:00.000Z')
  })

  assert.equal(replacementResult.snapshot.source_count, 1)
  assert.deepEqual(replacementResult.snapshot.source_started_at, {
    replacement: '2025-08-21T13:00:00.000Z'
  })
  assert.deepEqual(replacementResult.snapshot.new_item_ids, [])
  assert.deepEqual(
    replacementResult.snapshot.items.map((item) => item.source_id),
    ['replacement']
  )
})

test('baseline initialization treats every existing article as already read', () => {
  const existingItem = normalizeFeedItems(source, [
    {
      title: 'Existing post',
      link: 'https://example.com/existing',
      guid: 'existing-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const legacySnapshot = {
    version: 1,
    content_updated_at: '2025-08-20T13:00:00.000Z',
    source_count: 1,
    items: [existingItem]
  }

  const snapshot = initializeSnapshotBaseline({
    sources: [source],
    previousSnapshot: legacySnapshot,
    now: new Date('2025-08-21T00:00:00.000Z')
  })

  assert.equal(snapshot.version, 2)
  assert.equal(snapshot.monitoring_started_at, '2025-08-21T00:00:00.000Z')
  assert.deepEqual(snapshot.source_started_at, {
    fixture: '2025-08-21T00:00:00.000Z'
  })
  assert.deepEqual(snapshot.source_baseline_day_urls, { fixture: [] })
  assert.deepEqual(snapshot.new_item_ids, [])
  assert.deepEqual(snapshot.items, [existingItem])
})

test('multiple new articles remain flagged across unchanged refreshes', () => {
  const existingItem = normalizeFeedItems(source, [
    {
      title: 'Existing post',
      link: 'https://example.com/existing',
      guid: 'existing-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const fetchedItems = normalizeFeedItems(source, [
    {
      title: 'Newest post',
      link: 'https://example.com/newest',
      guid: 'newest-guid',
      isoDate: '2025-08-22T12:00:00.000Z'
    },
    {
      title: 'New post',
      link: 'https://example.com/new',
      guid: 'new-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    },
    {
      title: 'Existing post',
      link: 'https://example.com/existing',
      guid: 'existing-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])
  const firstResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: fetchedItems }],
    previousSnapshot: createSnapshot({ items: [existingItem] }),
    now: new Date('2025-08-22T13:00:00.000Z')
  })

  assert.deepEqual(
    firstResult.snapshot.new_item_ids,
    fetchedItems.slice(0, 2).map((item) => item.id)
  )

  const secondResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: fetchedItems }],
    previousSnapshot: firstResult.snapshot,
    now: new Date('2025-08-23T13:00:00.000Z')
  })

  assert.equal(secondResult.contentChanged, false)
  assert.equal(serializeSnapshot(secondResult.snapshot), serializeSnapshot(firstResult.snapshot))
})

test('a changed GUID for the same article URL preserves identity and update state', () => {
  const previousItem = normalizeFeedItems(source, [
    {
      title: 'Stable post',
      link: 'https://example.com/stable',
      guid: 'old-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const fetchedItem = normalizeFeedItems(source, [
    {
      title: 'Stable post',
      link: 'https://example.com/stable',
      guid: 'new-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const result = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [fetchedItem] }],
    previousSnapshot: createSnapshot({
      items: [previousItem],
      newItemIds: [previousItem.id]
    }),
    now: new Date('2025-08-21T13:00:00.000Z')
  })

  assert.equal(result.snapshot.items[0].id, previousItem.id)
  assert.deepEqual(result.snapshot.new_item_ids, [previousItem.id])
})

test('a new source baselines its first successful backlog after an initial failure', () => {
  const addedSource = {
    ...source,
    id: 'added',
    name: 'Added Blog',
    site_url: 'https://added.example/',
    discovery_url: 'https://added.example/',
    feed_url: 'https://added.example/feed.xml'
  }
  const backlogItem = normalizeFeedItems(addedSource, [
    {
      title: 'Backlog post',
      link: 'https://added.example/backlog',
      guid: 'backlog-guid',
      isoDate: '2025-08-20T12:00:00.000Z'
    }
  ])[0]
  const sources = [source, addedSource]
  const failedResult = createNextSnapshot({
    sources,
    outcomes: [
      { source, status: 'rejected', reason: new Error('offline') },
      { source: addedSource, status: 'rejected', reason: new Error('offline') }
    ],
    previousSnapshot: createSnapshot(),
    now: new Date('2025-08-21T13:00:00.000Z')
  })

  assert.deepEqual(failedResult.snapshot.source_started_at, {
    fixture: MONITORING_STARTED_AT
  })

  const recoveredResult = createNextSnapshot({
    sources,
    outcomes: [
      { source, status: 'rejected', reason: new Error('offline') },
      { source: addedSource, status: 'fulfilled', value: [backlogItem] }
    ],
    previousSnapshot: failedResult.snapshot,
    now: new Date('2025-08-22T13:00:00.000Z')
  })

  assert.deepEqual(recoveredResult.snapshot.source_started_at, {
    fixture: MONITORING_STARTED_AT,
    added: '2025-08-22T13:00:00.000Z'
  })
  assert.deepEqual(recoveredResult.snapshot.new_item_ids, [])
  assert.equal(recoveredResult.snapshot.items[0].id, backlogItem.id)

  const laterItem = normalizeFeedItems(addedSource, [
    {
      title: 'Later post',
      link: 'https://added.example/later',
      guid: 'later-guid',
      isoDate: '2025-08-23T12:00:00.000Z'
    }
  ])[0]
  const updatedResult = createNextSnapshot({
    sources,
    outcomes: [
      { source, status: 'rejected', reason: new Error('offline') },
      { source: addedSource, status: 'fulfilled', value: [laterItem, backlogItem] }
    ],
    previousSnapshot: recoveredResult.snapshot,
    now: new Date('2025-08-23T13:00:00.000Z')
  })

  assert.deepEqual(updatedResult.snapshot.new_item_ids, [laterItem.id])
})

test('a historical article is not new when it leaves and later returns to the feed window', () => {
  const historicalItem = normalizeFeedItems(source, [
    {
      title: 'Historical post',
      link: 'https://example.com/historical',
      guid: 'historical-guid',
      isoDate: '2025-08-19T12:00:00.000Z'
    }
  ])[0]
  const otherHistoricalItem = normalizeFeedItems(source, [
    {
      title: 'Other historical post',
      link: 'https://example.com/other-historical',
      guid: 'other-historical-guid',
      isoDate: '2025-08-19T13:00:00.000Z'
    }
  ])[0]
  const disappearedResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [otherHistoricalItem] }],
    previousSnapshot: createSnapshot({ items: [historicalItem] }),
    now: new Date('2025-08-21T13:00:00.000Z')
  })
  const returnedResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [otherHistoricalItem, historicalItem] }],
    previousSnapshot: disappearedResult.snapshot,
    now: new Date('2025-08-22T13:00:00.000Z')
  })

  assert.deepEqual(returnedResult.snapshot.new_item_ids, [])
})

test('a newly observed date-only article on the monitoring start day is new', () => {
  const dateOnlyItem = normalizeFeedItems(source, [
    {
      title: 'Same-day post',
      link: 'https://example.com/same-day',
      guid: 'same-day-guid',
      isoDate: '2025-08-20'
    }
  ])[0]
  const result = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [dateOnlyItem] }],
    previousSnapshot: createSnapshot({
      sourceBaselineDayUrls: { fixture: [] },
      sourceStartedAt: { fixture: '2025-08-20T12:00:00.000Z' }
    }),
    now: new Date('2025-08-20T20:00:00.000Z')
  })

  assert.deepEqual(result.snapshot.new_item_ids, [dateOnlyItem.id])
  assert.deepEqual(result.snapshot.date_only_item_ids, [dateOnlyItem.id])
})

test('an exact-midnight timestamp before the cutoff is not mistaken for a date-only update', () => {
  const midnightItem = normalizeFeedItems(source, [
    {
      title: 'Midnight post',
      link: 'https://example.com/midnight',
      guid: 'midnight-guid',
      isoDate: '2025-08-20T00:00:00Z'
    }
  ])[0]
  const result = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [midnightItem] }],
    previousSnapshot: createSnapshot({
      sourceBaselineDayUrls: { fixture: [] },
      sourceStartedAt: { fixture: '2025-08-20T12:00:00.000Z' }
    }),
    now: new Date('2025-08-20T20:00:00.000Z')
  })

  assert.deepEqual(result.snapshot.new_item_ids, [])
  assert.deepEqual(result.snapshot.date_only_item_ids, [])
})

test('a known update stays new when its feed date gains midnight precision', () => {
  const dateOnlyItem = normalizeFeedItems(source, [
    {
      title: 'Corrected date post',
      link: 'https://example.com/corrected-date',
      guid: 'corrected-date-guid',
      isoDate: '2025-08-20'
    }
  ])[0]
  const preciseItem = normalizeFeedItems(source, [
    {
      title: 'Corrected date post',
      link: 'https://example.com/corrected-date',
      guid: 'corrected-date-guid',
      isoDate: '2025-08-20T00:00:00Z'
    }
  ])[0]
  const previousSnapshot = createSnapshot({
    dateOnlyItemIds: [dateOnlyItem.id],
    items: [dateOnlyItem],
    newItemIds: [dateOnlyItem.id],
    sourceBaselineDayUrls: { fixture: [] },
    sourceStartedAt: { fixture: '2025-08-20T12:00:00.000Z' }
  })
  const result = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [preciseItem] }],
    previousSnapshot,
    now: new Date('2025-08-21T12:00:00.000Z')
  })

  assert.deepEqual(result.snapshot.new_item_ids, [dateOnlyItem.id])
  assert.deepEqual(result.snapshot.date_only_item_ids, [])
})

test('a same-day baseline article stays old when it leaves and later returns', () => {
  const baselineItem = normalizeFeedItems(source, [
    {
      title: 'Baseline post',
      link: 'https://example.com/baseline-day',
      guid: 'baseline-day-guid',
      isoDate: '2025-08-20'
    }
  ])[0]
  const olderItem = normalizeFeedItems(source, [
    {
      title: 'Older post',
      link: 'https://example.com/older-day',
      guid: 'older-day-guid',
      isoDate: '2025-08-19'
    }
  ])[0]
  const previousSnapshot = createSnapshot({
    items: [baselineItem],
    sourceBaselineDayUrls: { fixture: [baselineItem.url] },
    sourceStartedAt: { fixture: '2025-08-20T12:00:00.000Z' }
  })
  const disappearedResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [olderItem] }],
    previousSnapshot,
    now: new Date('2025-08-21T12:00:00.000Z')
  })
  const returnedResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [baselineItem, olderItem] }],
    previousSnapshot: disappearedResult.snapshot,
    now: new Date('2025-08-22T12:00:00.000Z')
  })

  assert.deepEqual(returnedResult.snapshot.new_item_ids, [])
})

test('a disabled and re-enabled source receives a fresh backlog baseline', () => {
  const backlogItem = normalizeFeedItems(source, [
    {
      title: 'Backlog post',
      link: 'https://example.com/backlog',
      guid: 'backlog-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    }
  ])[0]
  const disabledSource = { ...source, enabled: false, status: 'disabled_by_choice' }
  const disabledResult = createNextSnapshot({
    sources: [disabledSource],
    outcomes: [],
    previousSnapshot: createSnapshot({ items: [backlogItem], newItemIds: [backlogItem.id] }),
    now: new Date('2025-08-22T13:00:00.000Z')
  })
  const reEnabledResult = createNextSnapshot({
    sources: [source],
    outcomes: [{ source, status: 'fulfilled', value: [backlogItem] }],
    previousSnapshot: disabledResult.snapshot,
    now: new Date('2025-08-23T13:00:00.000Z')
  })

  assert.deepEqual(disabledResult.snapshot.source_started_at, {})
  assert.deepEqual(reEnabledResult.snapshot.source_started_at, {
    fixture: '2025-08-23T13:00:00.000Z'
  })
  assert.deepEqual(reEnabledResult.snapshot.new_item_ids, [])
})

test('validation rejects new items for a source without a monitoring start', () => {
  const item = normalizeFeedItems(source, [
    {
      title: 'Uninitialized post',
      link: 'https://example.com/uninitialized',
      guid: 'uninitialized-guid',
      isoDate: '2025-08-21T12:00:00.000Z'
    }
  ])[0]
  const snapshot = createSnapshot({
    items: [item],
    newItemIds: [item.id],
    sourceStartedAt: {}
  })

  assert.throws(
    () => validateSnapshotAgainstManifest(snapshot, [source]),
    /does not belong to a monitored update/u
  )
})

test('validation rejects a non-midnight article marked as date-only', () => {
  const item = normalizeFeedItems(source, [
    {
      title: 'Precise post',
      link: 'https://example.com/precise',
      guid: 'precise-guid',
      isoDate: '2025-08-21T10:00:00Z'
    }
  ])[0]
  const snapshot = createSnapshot({ dateOnlyItemIds: [item.id], items: [item] })

  assert.throws(() => validateSnapshot(snapshot), /is not at UTC midnight/u)
})
