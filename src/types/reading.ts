export type BlogFeedKind = 'rss' | 'atom'
export type BlogFeedStatus = 'verified' | 'disabled_by_choice' | 'unsupported'

export interface BlogFeedSource {
  id: string
  name: string
  site_url: string
  discovery_url: string
  feed_url: string
  kind: BlogFeedKind
  enabled: boolean
  poll_interval_minutes: number
  status: BlogFeedStatus
}

export interface BlogFeedItem {
  id: string
  source_id: string
  source_name: string
  title: string
  published_at: string
  summary: string
  url: string
}

export interface BlogFeedSnapshot {
  version: 1
  content_updated_at: string | null
  source_count: number
  items: BlogFeedItem[]
}
