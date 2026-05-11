# Kimi Coding Proxy

GitHub Pages 是纯静态站点，浏览器不能直接跨域请求 Kimi Coding Plan API。
把 `kimi-coding-proxy.js` 部署到 Cloudflare Workers 后，在页面 API 配置里填写 Worker 地址即可。

推荐配置：

- Worker URL: `https://your-worker.workers.dev`
- Allowed origins: `https://ly507007.github.io`

Worker 默认转发浏览器请求里的 `Authorization` header，因此 API Key 仍由页面本地保存。
也可以在 Worker 环境变量里配置 `KIMI_API_KEY`，让 Worker 统一持有 Key。
