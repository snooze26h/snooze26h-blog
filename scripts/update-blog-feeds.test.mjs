import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createNextSnapshot,
  fetchFeedSource,
  getEnabledSources,
  MAX_FEED_BYTES,
  MAX_SUMMARY_LENGTH,
  normalizeFeedItems,
  parseFeedXml,
  refreshBlogFeeds,
  serializeSnapshot,
  validateSnapshot
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

const emptySnapshot = {
  version: 1,
  content_updated_at: null,
  source_count: 1,
  items: []
}

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
  const previousSnapshot = {
    version: 1,
    content_updated_at: '2025-08-20T13:00:00.000Z',
    source_count: 1,
    items: [previousItem]
  }
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
  const previousSnapshot = {
    version: 1,
    content_updated_at: '2025-08-21T13:00:00.000Z',
    source_count: 1,
    items
  }
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
  const previousSnapshot = {
    version: 1,
    content_updated_at: '2025-08-20T13:00:00.000Z',
    source_count: 2,
    items: [staleItem]
  }
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
})

test('enabled sources are deduplicated by normalized feed URL', () => {
  const duplicate = {
    ...source,
    id: 'duplicate',
    feed_url: 'https://EXAMPLE.com:443/feed.xml#duplicate'
  }

  assert.deepEqual(
    getEnabledSources([source, duplicate]).map((item) => item.id),
    ['fixture']
  )
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
  const previousSnapshot = {
    version: 1,
    content_updated_at: '2025-08-20T13:00:00.000Z',
    source_count: 1,
    items: [previousItem]
  }
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
  assert.deepEqual(
    replacementResult.snapshot.items.map((item) => item.source_id),
    ['replacement']
  )
})
