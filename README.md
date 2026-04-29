# 于未氵 · 个人作品集网站

数字创作者于未氵的个人作品集，基于 Cloudflare Pages + Functions + KV + R2。

## 目录结构

```
.
├── public/                 # 静态文件（部署到 Cloudflare Pages）
│   ├── index.html          # 前台首页
│   ├── admin.html          # 后台管理页
│   └── _redirects          # 路由规则（/admin -> admin.html）
├── functions/              # Cloudflare Pages Functions（后端 API）
│   └── _middleware.js      # 处理所有 /api/* 请求
└── docs/
    └── deploy.md           # 部署指南（详细操作步骤）
```

## 部署

请按 [docs/deploy.md](./docs/deploy.md) 一步步操作。

## 技术栈

- **前端**：原生 HTML/CSS/JS + GSAP（动画）
- **后端**：Cloudflare Pages Functions
- **数据存储**：Cloudflare KV（作品 / 设置 / 密码哈希）
- **媒体存储**：Cloudflare R2
- **认证**：HMAC-SHA256 签名的简单 JWT

## 环境变量（在 Cloudflare Pages 设置）

| 变量名 | 类型 | 说明 |
|---|---|---|
| `SITE_KV` | KV binding | KV namespace |
| `MEDIA_BUCKET` | R2 binding | R2 bucket |
| `INITIAL_PASSWORD` | Secret | 初始密码（首次登录后失效） |
| `JWT_SECRET` | Secret | Token 签名密钥（任意随机字符串） |
| `R2_PUBLIC_URL` | Secret | R2 公开访问的 URL |

## 日常使用

部署完成后，访问 `/admin` 用密码登录即可：
- 上传 / 删除视频
- 添加 / 编辑 / 删除作品
- 修改首页文案、关于、联系方式
- 修改后台密码

不需要写代码、不需要 push GitHub，所有改动实时生效。

## License

仅供个人使用。
