import config from '@/site-config'

/**
 * Fixed display time zone for the whole site.
 *
 * `publishDate` / `updatedDate` in frontmatter are calendar dates, not moments in
 * time. `z.coerce.date()` parses a bare `YYYY-MM-DD` as UTC midnight, so formatting
 * it in the build machine's local zone can shift it by a day. Pinning one zone here
 * makes every rendered date depend only on what is written in the frontmatter.
 */
export const SITE_TIME_ZONE = 'Asia/Shanghai'

export function getFormattedDate(
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
  locale?: string
) {
  const dateLocale = locale?.startsWith('en') ? 'en-US' : config.locale.dateLocale || 'zh-CN'

  return new Intl.DateTimeFormat(dateLocale, {
    ...(config.locale.dateOptions as Intl.DateTimeFormatOptions),
    ...options,
    timeZone: SITE_TIME_ZONE
  }).format(new Date(date))
}

/** Year of a date in {@link SITE_TIME_ZONE}, so archive grouping matches the displayed date. */
export function getSiteYear(date: string | number | Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      timeZone: SITE_TIME_ZONE
    }).format(new Date(date))
  )
}
