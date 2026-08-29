# snooze26h Blog

`snooze26h` 的中英双语个人博客，基于 Astro 5 和 Tailwind CSS 3，使用 pnpm 管理依赖。这里用于整理研究笔记、工程实践、生活记录与个人思考。

站点目前只在本地维护，尚未公开发布。

## 本地开发

```bash
pnpm install
pnpm dev
```

开发服务器默认运行在 <http://127.0.0.1:4321/>。

## 本地静态构建与预览

```bash
DEPLOYMENT_PLATFORM=local pnpm build
DEPLOYMENT_PLATFORM=local pnpm preview
```

静态构建产物位于 `dist/`。

## 内容编写

每篇文章放在独立目录中，中英文版本共用同一个 slug：

- `src/content/blogs/<slug>/index.mdx`：中文
- `src/content/blogs/<slug>/index-en.mdx`：英文

按照本项目的写作约定，新文章需要填写 `title`、`description`、`publishDate`、`category` 和 `tags`：

```yaml
---
title: 文章标题
description: 一句话摘要
publishDate: 2026-08-29
category: tech
tags:
  - example
---
```

可选的 `draft: true` 表示文章在 `pnpm dev` 中可见，但会在生产构建后隐藏。中英文文章还可以分别使用 `language: zh` 和 `language: en` 显式标记语言。

## 站点配置

统一配置入口是 `src/site.config.ts`，常用配置包括：

- 站点名称、作者和中英文描述
- 语言、导航链接和页脚信息
- favicon、logo/头像和自定义样式
- 联系方式与各部署平台的域名
- 搜索、评论等主题集成

## 部署

站点目前尚未公开发布。`DEPLOYMENT_PLATFORM` 支持以下目标：

- `vercel`：Vercel，也是未设置变量时的默认目标
- `cloudflare`：Cloudflare Pages
- `github`：GitHub Pages
- `local`：本地静态构建与预览

公开发布前，需要先在 `src/site.config.ts` 中补全对应平台的域名。

## 致谢

本项目基于 [Axi-Theme](https://github.com/Axi404/Axi-Theme) 二次开发；上游项目采用 Apache-2.0 许可证。
