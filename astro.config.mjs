// @ts-check

import { rehypeHeadingIds } from '@astrojs/markdown-remark'
// Adapters
import vercel from '@astrojs/vercel'
import cloudflare from '@astrojs/cloudflare'
// Integrations
import AstroAxiIntegration from './src/axi-integration.ts'
import { defineConfig } from 'astro/config'
// Rehype & remark packages
import rehypeKatex from 'rehype-katex'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'

// Others
// import { visualizer } from 'rollup-plugin-visualizer'

// Local integrations
import { outputCopier } from './src/plugins/output-copier.ts'
// Local rehype & remark plugins
import rehypeAutolinkHeadings from './src/plugins/rehype-auto-link-headings.ts'
// Shiki
import {
  addCopyButton,
  addLanguage,
  addTitle,
  transformerNotationDiff,
  transformerNotationHighlight,
  updateStyle
} from './src/plugins/shiki-transformers.ts'
import config from './src/site.config.ts'

const platform = process.env.DEPLOYMENT_PLATFORM || 'vercel'
const isCloudflare = platform === 'cloudflare'
const isGithubPages = platform === 'github'
const isLocal = platform === 'local'
const isVercel = platform === 'vercel'
const mainDomain = config.personal?.domains?.main || 'example.com'
const mainSite = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(mainDomain)
  ? `http://${mainDomain}/`
  : `https://${mainDomain}/`

// https://astro.build/config
export default defineConfig({
  // Top-Level Options
  site: isGithubPages
    ? `https://${config.personal?.domains?.githubPages || 'example.github.io'}/`
    : isCloudflare
      ? `https://${config.personal?.domains?.cloudflare || 'example.pages.dev'}/`
      : mainSite,
  // base: '/docs',
  trailingSlash: 'never',

  // Internationalization
  i18n: {
    locales: ['zh', 'en'],
    defaultLocale: 'zh',
    routing: {
      prefixDefaultLocale: false
    }
  },

  adapter: isGithubPages || isLocal ? undefined : isCloudflare ? cloudflare() : vercel(),
  output: isGithubPages || isLocal || isCloudflare ? 'static' : 'server',

  image: {
    service: {
      entrypoint: 'astro/assets/services/sharp'
    }
  },

  integrations: [
    // astro-axi will automatically add sitemap, mdx & tailwind
    // sitemap(),
    // mdx(),
    // tailwind({ applyBaseStyles: false }),
    AstroAxiIntegration(config),
    // (await import('@playform/compress')).default({
    //   SVG: false,
    //   Exclude: ['index.*.js']
    // }),

    // Temporary Vercel adapter fix; static builds already place assets in dist.
    ...(isVercel
      ? [
          outputCopier({
            integ: ['sitemap', 'pagefind']
          })
        ]
      : [])
  ],
  // root: './my-project-directory',

  // Prefetch Options
  prefetch: true,
  // Server Options
  server: {
    host: true
  },
  // Markdown Options
  markdown: {
    remarkPlugins: [remarkMath, remarkGfm],
    rehypePlugins: [
      rehypeHeadingIds,
      [rehypeKatex, {}],
      [
        rehypeAutolinkHeadings,
        {
          behavior: 'append',
          properties: { className: ['anchor'] },
          content: { type: 'text', value: '#' }
        }
      ]
    ],
    remarkRehype: {
      footnoteLabel: '脚注',
      footnoteBackLabel: '返回内容',
      footnoteBackContent: '↑'
    },
    // https://docs.astro.build/en/guides/syntax-highlighting/
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark'
      },
      transformers: [
        transformerNotationDiff(),
        transformerNotationHighlight(),
        updateStyle(),
        addTitle(),
        addLanguage(),
        addCopyButton(2000)
      ]
    }
  },
  vite: {
    // plugins: [
    //   visualizer({
    //     emitFile: true,
    //     filename: 'stats.html'
    //   })
    // ]
  }
})
