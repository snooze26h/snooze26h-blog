import config from '@/site-config'

export function getFormattedDate(
  date: string | number | Date,
  options?: Intl.DateTimeFormatOptions,
  locale?: string
) {
  const dateLocale = locale?.startsWith('en') ? 'en-US' : config.locale.dateLocale || 'zh-CN'

  return new Intl.DateTimeFormat(dateLocale, {
    ...(config.locale.dateOptions as Intl.DateTimeFormatOptions),
    ...options,
    timeZone: 'UTC'
  }).format(new Date(date))
}
