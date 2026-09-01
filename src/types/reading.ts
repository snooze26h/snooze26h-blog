export type BlogFeedKind = 'rss' | 'atom'
export type BlogFeedStatus = 'verified' | 'disabled_by_choice' | 'unsupported'

export interface BlogFeedProfile {
  avatar?: string
  avatar_fit?: 'cover' | 'contain'
  accent: string
  description: string
  description_en: string
  topics: string[]
  topics_en: string[]
}

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
  profile?: BlogFeedProfile
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
  version: 2
  monitoring_started_at: string
  content_updated_at: string | null
  source_count: number
  date_only_item_ids: string[]
  source_started_at: Record<string, string>
  source_baseline_day_urls: Record<string, string[]>
  new_item_ids: string[]
  items: BlogFeedItem[]
}
