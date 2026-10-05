# F1 赛事看板 / F1 Dashboard

一个独立、自托管的中文 F1 页面。包括赛程、分站成绩、WDC / WCC 积分、赛道地图、天气、轮胎与赛事简报、Sky Sports 新闻标题，以及账号偏好和比赛邮件订阅。深浅主题、响应式布局，所有比赛时间为北京时间（UTC+8）。

## 本地运行

需要 Node.js 22.13 或更高版本，推荐 Node.js 24。

```sh
npm ci
cp .env.example .env
npm start
```

打开 http://localhost:4321/。主页直接显示围场；`/f1` 是兼容入口。没有博客导航、摄影、文章、文件分享或个人主页。

赛事浏览无需登录。设置中可选择喜欢的车手与车队、管理账号、设置密码或通行密钥，并订阅比赛提醒。首次创建账号需配置邮箱验证码、GitHub 或 Google 中至少一种登录方式；未配置的入口隐藏。没有默认测试账号、预设密码或导入用户数据。

## 可选配置

配置项见 `.env.example`。生产环境设置实际 HTTPS `PUBLIC_ORIGIN`、`COOKIE_SECURE=true`，在反向代理后运行 Node 服务。OAuth 回调为 `PUBLIC_ORIGIN/api/auth/github/callback` 或 `PUBLIC_ORIGIN/api/auth/google/callback`。GitHub 管理员数字 ID 可选，不预设任何账号。通行密钥绑定当前域名；更换域名需要重新绑定。

邮件使用标准 SMTP：`SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASS`、`MAIL_FROM`。465 通常使用 TLS，587 使用 STARTTLS。绑定并验证收件邮箱后可订阅练习、排位、冲刺、冲刺排位、正赛。比赛周周四 09:00 发送欢迎邮件，选定场次开始前 30 分钟发送提醒。首次启用发送一封明确标注示例板块的测试邮件。服务运行时自动排程，停止期间不会发送邮件。账号设置支持关闭订阅、解绑邮箱与注销账号。

`DATA_DIR` 默认为 `data/`，保存 SQLite 账号与订阅数据、赛事缓存、随机恢复密钥和认证密钥。不要提交 `.env`、运行数据、密钥、邮件记录或数据库。备份和迁移时先停止服务，再复制整个数据目录。每次新部署生成独立数据，不沿用任何原站账号、收件邮箱或配置。

可信反向代理可配置 `TRUST_PROXY_IPS`；只有代理覆盖客户端 IP 头时才使用。Cloudflare Tunnel 可选择启用 `CLOUDFLARE_TUNNEL`，同时明确可信连接器 IP。

## 数据来源与限制

- Jolpica-F1：赛历与积分数据；15 分钟缓存、串行请求、并发合并和限流退避。
- Formula 1 官方网站：已公布成绩、赛道图及赛事资料。
- OpenF1、MultiViewer：补充赛事与赛道资料。
- FIA、Pirelli：公开赛事文件、处罚、升级及轮胎资讯。
- Open-Meteo：赛道当地天气。
- Sky Sports：最新三条 F1 新闻标题和原文链接；一小时缓存，不转载完整新闻。

来源不可用时显示有时间标识的缓存或明确提示不可用，不编造正式赛果。成绩以来源公布为准，本站不提供实时计时，也不是 F1 官方网站。

MIT 许可只适用于本仓库原创代码。第三方数据、图片、名称、商标及引用文件的权利属于各自权利人，使用时需遵守来源条款；不随代码许可授予这些内容的使用权。浏览器认证库的许可见 `public/vendor/LICENSE-simplewebauthn`。

## 验证

```sh
npm test
npm run test:ui
```

浏览器测试需要安装 Google Chrome，或相应 Playwright 浏览器。测试在临时目录使用虚构账号与本地模拟 SMTP，不读取生产数据，也不发送真实邮件。覆盖数据缓存与来源校验、赛道图、成绩、订阅发送与重试、账号隔离、登录、偏好、邮件和手机布局。

## 项目范围

独立页面与必要的服务端模块使用全新的 Git 历史。仓库不包含原博客源码、旧 Git 历史、个人资料、部署地址、真实账号、照片或运行配置。当前仓库先保持私人，审核确认后再公开。

## 许可

原创代码使用 [MIT License](LICENSE)。第三方来源与依赖见 [NOTICE.md](NOTICE.md)。
