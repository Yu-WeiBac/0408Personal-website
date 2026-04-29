# 部署指南 — 给不会代码的你

## 你即将完成的事

把这套包含前台 + 后台的网站部署到 Cloudflare，最终你会拥有：
- `https://04080606.xyz` —— 公开的作品集前台
- `https://04080606.xyz/admin` —— 你专属的后台（密码登录）
- 后台可以拖拽上传视频，编辑作品列表

预计总耗时：**90 分钟**（第一次部署），熟练后再次操作只需要 5 分钟更新内容。

---

## 准备工作

需要 3 个账号：
- ✅ Cloudflare 账号（你已有）
- ✅ GitHub 账号（你已有）
- 💡 **域名 04080606.xyz 已经接入 Cloudflare**（如果还没，先做这一步）

---

## Step 1：把项目放进 GitHub 仓库

### 1.1 创建新仓库

1. 打开 https://github.com/new
2. **Repository name** 填：`yuwei-portfolio`（随便取，但记住）
3. 选 **Private**（私有，因为里面会有你的内容）
4. 点 **Create repository**

### 1.2 上传项目文件

最简单的办法 —— **网页上传**：

1. 在新仓库页面点 **uploading an existing file**
2. 把我给你的整个 `portfolio` 文件夹里的内容**全部拖进去**
   - 注意：拖的是文件夹**里面**的内容（`public` 文件夹、`functions` 文件夹、`docs` 文件夹），不是 `portfolio` 文件夹本身
3. 滚动到底部，**Commit changes**

完成后你的仓库根目录应该是这样的：

```
yuwei-portfolio/
├── public/
│   ├── index.html
│   ├── admin.html
│   └── _redirects
├── functions/
│   └── _middleware.js
└── docs/
    └── deploy.md
```

---

## Step 2：创建 Cloudflare KV 存储（存作品数据）

1. 登录 https://dash.cloudflare.com
2. 左侧菜单找 **Storage & Databases** → **KV**
3. 点 **Create a namespace**
4. **Namespace name** 填：`SITE_KV`
5. 点 **Add**

✅ 创建好后，你会看到这个 namespace 在列表里。**记住这个名字**，后面要绑定。

---

## Step 3：创建 Cloudflare R2 存储桶（存视频文件）

1. 左侧菜单找 **R2 Object Storage**
2. 第一次用 R2 会让你**同意付费协议**（放心，10GB 内免费，不会扣钱，但需要绑定一张信用卡或国内的 Visa/Master 卡——你之前问过 ZA Bank 卡，那张可以用）
3. 点 **Create bucket**
4. **Bucket name** 填：`yuwei-media`（随便取，但记住）
5. **Location** 选 **Automatic**
6. 点 **Create bucket**

### 3.1 让 R2 可以公开访问视频

1. 进入刚建的 `yuwei-media` bucket
2. 点 **Settings** 标签
3. 找到 **Public Access** → **R2.dev subdomain**，点 **Allow Access**
4. 你会看到一个长长的 URL，类似：
   `https://pub-xxxxxxxxxxxxx.r2.dev`
5. **复制这个 URL**，等下要用到

> 💡 **进阶（可选，今天先不做）**：以后可以把这个换成 `videos.04080606.xyz`，更专业。

---

## Step 4：在 Cloudflare Pages 部署项目

1. 左侧菜单找 **Workers & Pages**
2. 点 **Create** → **Pages** → **Connect to Git**
3. 授权 Cloudflare 访问 GitHub（如果是第一次）
4. 选择刚才建的 `yuwei-portfolio` 仓库，点 **Begin setup**
5. 配置如下：
   - **Project name**：`yuwei-portfolio`
   - **Production branch**：`main`
   - **Framework preset**：选 **None**
   - **Build command**：留空
   - **Build output directory**：`public`
6. 点 **Save and Deploy**

⏳ 等 1-2 分钟，第一次部署完成。你会得到一个临时网址，类似 `yuwei-portfolio.pages.dev`。

> ⚠️ 现在打开这个网址会看到首页，但**作品区会报错**——这是正常的，因为还没绑定 KV/R2。下面继续。

---

## Step 5：绑定 KV、R2 和环境变量

这步是把 Pages 项目和数据存储连起来。

1. 在 Pages 项目页面，点 **Settings** 标签
2. 左侧选 **Bindings**（旧版叫 **Functions**）

### 5.1 绑定 KV

- 点 **Add** → **KV namespace**
- **Variable name**：`SITE_KV`（必须一字不差！）
- **KV namespace**：选你刚建的 `SITE_KV`
- **Save**

### 5.2 绑定 R2

- 点 **Add** → **R2 bucket**
- **Variable name**：`MEDIA_BUCKET`（必须一字不差！）
- **R2 bucket**：选你刚建的 `yuwei-media`
- **Save**

### 5.3 添加环境变量（密码、密钥等）

左侧选 **Variables and Secrets**（或者 **Environment variables**）。

加 **3 个变量**，**Type 都选 Secret**：

| Variable name      | Value（你要填的内容）                              |
|--------------------|---------------------------------------------|
| `INITIAL_PASSWORD` | 你想要的初始密码，例如 `MyStrong#Pass2026`        |
| `JWT_SECRET`       | 一段随机字符串（越长越好），例如 `kJ8mN2pQ9rT4vY7zA3bC6dE` |
| `R2_PUBLIC_URL`    | Step 3.1 复制的那个 R2.dev URL                  |

> 💡 `JWT_SECRET` 怎么生成？打开浏览器按 F12 → Console，粘贴这行回车：
> ```
> Array.from(crypto.getRandomValues(new Uint8Array(32)), b=>b.toString(16).padStart(2,'0')).join('')
> ```
> 复制输出的内容用作 JWT_SECRET。

### 5.4 重新部署让绑定生效

回到 **Deployments** 标签，点最新部署右侧的 **⋯** → **Retry deployment**。等 1 分钟。

---

## Step 6：第一次登录后台

1. 打开 `https://yuwei-portfolio.pages.dev/admin`（用你实际的 Pages URL）
2. 输入 Step 5.3 设置的 `INITIAL_PASSWORD`
3. 登录成功 ✓

### 6.1 立即修改密码

1. 进入 **账号** 标签
2. 输入新密码（至少 8 位）→ 修改密码
3. 之后用新密码登录

> 🔐 密码修改后，`INITIAL_PASSWORD` 环境变量就**作废了**（哈希存进 KV，以 KV 里的为准）。但建议你也回 Cloudflare 把 `INITIAL_PASSWORD` 删掉。

---

## Step 7：上传第一个作品

1. 在后台 **作品管理** 点 **+ 添加新作品**
2. 填标题、标签、年份
3. **视频文件** 区域：拖拽你的 mp4 进去（建议先压缩到 50MB 以内）
4. **封面图**（可选，但推荐）
5. **保存**

回到 `https://yuwei-portfolio.pages.dev/`，刷新页面，作品就出来了 ✨

### 7.1 上传首屏背景视频

后台 **网站设置** → **首屏背景视频** 拖一个视频上去 → **保存设置**。这就是你的代表作首屏。

---

## Step 8：绑定自定义域名 04080606.xyz

1. Pages 项目 → **Custom domains** 标签
2. **Set up a custom domain**
3. 输入 `04080606.xyz`，下一步
4. 因为域名已经在 Cloudflare，会自动配置 DNS
5. 等 DNS 生效（通常 1-5 分钟）

完成后访问 `https://04080606.xyz` 就是你的网站了！

---

## 视频压缩小贴士

R2 免费 10GB 存储，但**带宽**也有限制（虽然每月几百 GB 出站免费，但不要传 1GB 以上的源文件）。

**强烈推荐先压视频再上传**：

1. 下载免费工具 [HandBrake](https://handbrake.fr/)
2. 拖入你的视频
3. 预设选 **Web → Vimeo YouTube HQ 1080p60**
4. 不需要 4K 的话改成 **720p**
5. 输出到 mp4

一段 30 秒的 4K 视频通常能从几百 MB 压到 5-15 MB，**画质几乎看不出区别**。

---

## 常见问题

**Q: 后台登录提示"系统未初始化"**
A: 你忘了配 `INITIAL_PASSWORD` 环境变量，或者配完没重新部署。

**Q: 上传视频报错 "HTTP 413"**
A: 单次上传 Cloudflare 限制大约 100MB。把视频压小一点，或者分多个作品。

**Q: 上传成功但前台不显示视频**
A: 检查 `R2_PUBLIC_URL` 环境变量末尾是否多了 `/`，应该没有。也要确认 R2 bucket 的 Public Access 开了。

**Q: 修改了 HTML 文件想更新到线上**
A: 在 GitHub 网页直接编辑文件 → Commit。Cloudflare Pages 会自动检测并重新部署，1-2 分钟生效。

**Q: 后台密码忘了**
A: 去 Cloudflare KV 删除 `admin_password_hash` 这条数据，再用 `INITIAL_PASSWORD` 重新登录。

---

## 下次更新内容的流程

以后日常使用就只需要：

1. 打开 `https://04080606.xyz/admin`
2. 输入密码登录
3. 拖视频、改文字、保存
4. 完成 ✓

不用碰代码，不用碰 GitHub。
