# cf-proxy

纯反代 Worker（无 UI），入口为 `worker.js`。

## 已实现能力

- 根路径健康检查：`/` 返回 `CF-Proxy is running`
- 反代目标格式保持不变：`/https://example.com/path` 或 `/example.com/path`
- `robots.txt`：`/robots.txt` 统一返回禁止抓取：
  - `User-agent: *`
  - `Disallow: /`
- 请求头稳健性：
  - 清理 hop-by-hop 头（如 `connection`、`keep-alive`、`transfer-encoding`、`upgrade` 等）
  - 保留并改进 Referer/Origin/User-Agent 处理
  - 清理敏感 Cloudflare 来源头（如 `cf-connecting-ip`、`x-forwarded-for` 等）
- 响应处理：
  - 保持原有 HTMLRewriter 机制与二进制流式透传
  - 继续处理重定向并将目标 `Location` 保持在代理内
- Cookie 代理化（`Set-Cookie`）：
  - 安全处理多 `Set-Cookie`（优先使用 Workers `getSetCookie()`；回退时使用 Expires 逗号安全拆分）
  - 将源站 `Path` 映射到代理路径前缀（如 `/https://example.com/...`）
  - 源站带 `Domain` 时映射到当前代理域名
  - 源站无 `Path` 时按默认规则推导路径后再映射
- CSS 资源重写：
  - 对 `Content-Type: text/css` 的响应重写 `url(...)` 中的 HTTP(S)/相对地址，使其继续走代理
  - 跳过 `data:`、`blob:`、`about:`、`javascript:`、`#...`
  - 设置大小上限：仅在 `Content-Length` 可解析且不超过 `512 KiB` 时执行重写；否则原样透传

## 限制说明

- 未引入全局浏览器 Hook（`window.fetch` / `XMLHttpRequest` / `history` 等）或全量 HTML 字符串注入。
- 未内置明文密码认证。如需访问保护，建议使用 Worker Secret（例如 `PROXY_PASSWORD`）在后续版本接入。

## 部署

仓库使用 Wrangler 配置（`wrangler.jsonc`）并保持 `main: "worker.js"`。

```bash
npx wrangler deploy
```

> 不需要 `assets` 静态目录配置。

## 测试

本仓库提供 Node 内置测试：

```bash
node --test worker.test.js
```
