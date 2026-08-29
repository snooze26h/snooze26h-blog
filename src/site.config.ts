import type { CardListData, Config, IntegrationUserConfig, ThemeUserConfig } from './types'

export const theme: ThemeUserConfig = {
  // === Basic configuration ===
  /** Title for your website. Will be used in metadata and as browser tab title. */
  title: 'snooze26h',
  /** Will be used in index page & copyright declaration */
  author: 'snooze26h',
  author_en: 'snooze26h',
  /** Description metadata for your website. Can be used in page metadata. */
  description: 'snooze26h 的个人博客。本科：北京交通大学。记录研究、技术、生活与个人思考。',
  description_en:
    'The personal blog of snooze26h. Undergraduate studies at Beijing Jiaotong University, with notes on research, technology, life, and personal ideas.',
  /** The default favicon for your site which should be a path to an image in the `public/` directory. */
  favicon: '/favicon/favicon.svg',
  /** Specify the default language for this site. */
  locale: {
    lang: 'zh-CN',
    attrs: 'zh_CN',
    // Date locale
    dateLocale: 'zh-CN',
    dateOptions: {
      day: 'numeric',
      month: 'short',
      year: 'numeric'
    }
  },
  /** Set a logo image to show in the homepage. */
  logo: {
    src: 'src/assets/avatar.webp',
    alt: 'Avatar'
  },

  // === Global configuration ===
  titleDelimiter: '•',
  prerender: true,
  npmCDN: 'https://cdn.jsdelivr.net/npm',

  // in test
  head: [],
  customCss: [],

  /** Configure the header of your site. */
  header: {
    menu: [
      { title: 'Blog', link: '/blog/tech' },
      { title: 'Archives', link: '/archives' },
      { title: 'Collections', link: '/collection' },
      { title: 'Links', link: '/links' },
      { title: 'About', link: '/about' }
    ]
  },

  /** Configure the footer of your site. */
  footer: {
    // Registration information for ICP (optional)
    registration: {
      // url: '',
      // text: '',
      // website: '' // only show ICP if url === website
    },
    /** Enable displaying a "Astro & Axi theme powered" link in your site's footer. */
    credits: true,
    /** Optional details about the social media accounts for this site. */
    social: {}
  },

  content: {
    externalLinksContent: ' ↗',
    /** Blog page size for pagination (optional) */
    blogPageSize: 15,
    externalLinkArrow: true, // show external link arrow
    // Currently support weibo, x, bluesky
    share: ['weibo', 'x', 'bluesky']
  },

  /** Personal information configuration */
  personal: {
    /** Education shown beside the profile */
    location: '北京交通大学 · 本科',
    location_en: 'Beijing Jiaotong University · Undergraduate',
    /** Public contact addresses */
    email: 'snooze062@gmail.com',
    secondaryEmail: 'snooze26h@gmail.com',
    /** GitHub username: shows the profile label and the contribution calendar on the homepage */
    githubUsername: 'snooze26h',
    /** Blog start date for statistics */
    blogStartDate: '2026-08-23',
    /** Domain configuration */
    domains: {
      main: 'localhost:4321'
      // githubPages: '',
      // cloudflare: '',
      // friendCircle: '',
    }
  }
}

export const integ: IntegrationUserConfig = {
  links: {
    logbook: [],
    // Yourself link info
    applyTip: [
      { name: 'Name', val: theme.title },
      { name: 'Desc', val: theme.description || 'Null' },
      { name: 'Link', val: 'http://localhost:4321' },
      { name: 'Avatar', val: 'http://localhost:4321/avatar/avatar.webp' }
    ]
  },
  // Enable page search function
  pagefind: true,
  // Required by the theme schema; no Quote component is mounted by default.
  quote: {
    server: 'https://api.quotable.io/quotes/random?maxLength=60',
    target: `(data) => data[0].content || 'Error'`
  },
  // Tailwindcss typography
  typography: {
    // https://github.com/tailwindlabs/tailwindcss-typography
    class: 'break-words prose prose-axi dark:prose-invert dark:prose-axi prose-headings:font-medium'
  },
  // A lightbox library that can add zoom effect
  mediumZoom: {
    enable: true, // disable it will not load the whole library
    selector: '.prose .zoomable',
    options: {
      className: 'zoomable'
    }
  },
  // Comment system
  waline: {
    enable: false,
    // Refer https://waline.js.org/en/guide/features/emoji.html
    emoji: ['bmoji', 'weibo'],
    // Refer https://waline.js.org/en/reference/client/props.html
    additionalConfigs: {
      // search: false,
      pageview: true,
      comment: true,
      locale: {
        reaction0: 'Like',
        placeholder: 'Welcome to comment. (Email to receive replies. Login is unnecessary)'
      },
      imageUploader: false
    }
  }
}

export const terms: CardListData = {
  title: '站点说明 / Site Notes',
  title_en: 'Site Notice',
  list: [
    {
      title: 'Privacy / 隐私说明',
      title_en: 'Privacy Policy',
      link: '/terms/privacy-policy'
    },
    {
      title: 'Copyright / 版权说明',
      title_en: 'Copyright',
      link: '/terms/copyright'
    }
  ]
}

const config = { ...theme, integ } as Config
export default config
