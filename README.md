# SNOOZE / 26H

这是基于官方 Axi-Theme 仓库制作的本地个人博客版本。视觉组件与页面结构保持原主题，只替换站点身份、导航、内容和隐私相关配置。

## 本地运行

```bash
pnpm install --frozen-lockfile
pnpm dev --host 127.0.0.1
```

打开 <http://127.0.0.1:4321/>。

## 本地静态构建

```bash
DEPLOYMENT_PLATFORM=local pnpm build
python3 -m http.server 4322 --directory dist
```

静态构建产物位于 `dist/`。本地访问不需要购买服务器；公开发布时再选择 Vercel、Cloudflare Pages 或 GitHub Pages，并替换域名、头像与社交分享图。

## 上游主题

### Axi 的博客主题

本人博客链接：[Axi 的博客](https://axi404.top/)

主要使用 [Astro](https://astro.build/) ，[参考](https://axi404.top/about#theme) 他人的 Blog 主题构建，并在此基础上大量自定义，以形成 Astro-Axi Theme。

更多请参考文档中内容 [Docs](https://theme.axi404.top/collection/docs)

### 更新提示

由于 Astro 的一些特性（例如构建产物与自动生成文件等），当你需要更新博客/主题时，建议使用差异对比工具来合并改动，比如 [WinMerge](https://winmerge.org/)。
