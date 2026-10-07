const GITHUB_HOSTS = new Set([
  "api.github.com",
  "uploads.github.com",
]);

const REDIRECT_CODES = new Set([
  301,
  302,
  303,
  307,
  308,
]);

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/110.0.0.0 Safari/537.36";

const CSS_REWRITE_MAX_BYTES = 512 * 1024;

const STRIPPED_HEADERS = [
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "true-client-ip",
  "x-forwarded-for",
  "x-real-ip",
];

const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

const REWRITE_ATTRIBUTES = {
  a: "href",
  img: "src",
  link: "href",
  script: "src",
  form: "action",
  iframe: "src",
  source: "src",
  video: "src",
  audio: "src",
  input: "src",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods":
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "*",
};

const HTML_SELECTOR =
  "a, img, link, script, form, iframe, source, video, audio, input";

if (typeof addEventListener === "function") {
  addEventListener("fetch", (event) => {
    event.respondWith(handleRequest(event.request));
  });
}


/**
 * 重写 HTML 中可以直接识别的资源链接。
 */
class DOMRewriter {
  constructor(proxyOrigin, targetUrl) {
    this.proxyOrigin = proxyOrigin;
    this.targetUrl = targetUrl;
  }

  element(element) {
    const attribute =
      REWRITE_ATTRIBUTES[element.tagName];

    if (!attribute) return;

    rewriteAttribute(
      element,
      attribute,
      this.proxyOrigin,
      this.targetUrl,
    );

    // img/source/video 等可能使用 srcset。
    if (
      element.tagName === "img" ||
      element.tagName === "source"
    ) {
      rewriteSrcset(
        element,
        this.proxyOrigin,
        this.targetUrl,
      );
    }

    // video 的封面图。
    if (element.tagName === "video") {
      rewriteAttribute(
        element,
        "poster",
        this.proxyOrigin,
        this.targetUrl,
      );
    }
  }
}


async function handleRequest(request) {
  const requestUrl = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }

  if (requestUrl.pathname === "/") {
    return textResponse("CF-Proxy is running");
  }

  if (requestUrl.pathname === "/robots.txt") {
    return textResponse("User-agent: *\nDisallow: /\n");
  }

  try {
    /*
     * 优先处理浏览器产生的相对路径请求。
     *
     * 例如代理页面：
     * /https://example.com/foo/index.html
     *
     * JS 请求：
     * /api/data
     *
     * 应恢复成：
     * https://example.com/api/data
     */
    const refererTarget =
      resolveRefererTarget(request, requestUrl);

    if (refererTarget) {
      return Response.redirect(
        proxyUrl(requestUrl.origin, refererTarget),
        302,
      );
    }

    const targetUrl = resolveTargetUrl(requestUrl);

    if (!targetUrl) {
      return textResponse(
        "Invalid target URL. Example: /https://example.com/",
        400,
      );
    }

    const response =
      await fetchTarget(request, targetUrl);

    if (REDIRECT_CODES.has(response.status)) {
      const redirected = rewriteRedirect(
        response,
        requestUrl.origin,
        targetUrl,
      );

      if (redirected) {
        return redirected;
      }
    }

    return await buildResponse(
      response,
      requestUrl.origin,
      targetUrl,
    );
  } catch (error) {
    return textResponse(
      `Proxy request failed: ${errorMessage(error)}`,
      502,
    );
  }
}


/**
 * 解析正常的代理目标。
 *
 * /https://example.com/foo
 * /example.com/foo
 */
function resolveTargetUrl(requestUrl) {
  let target =
    requestUrl.pathname.replace(/^\/+/, "") +
    requestUrl.search;

  if (!/^https?:\/\//i.test(target)) {
    if (!target.includes(".")) {
      return null;
    }

    target = `https://${target}`;
  }

  return parseHttpUrl(target);
}


/**
 * 处理无法由 HTMLRewriter 捕获的相对资源请求。
 *
 * 主要覆盖：
 * - JS fetch/XHR 相对地址
 * - CSS url(...)
 * - 动态加载资源
 */
function resolveRefererTarget(
  request,
  requestUrl,
) {
  const target =
    requestUrl.pathname.replace(/^\/+/, "");

  // 已经是完整代理 URL，不需要补偿。
  if (/^https?:\/\//i.test(target)) {
    return null;
  }

  const referer = request.headers.get("Referer");

  if (!referer) {
    return null;
  }

  try {
    const refererUrl = new URL(referer);

    // 必须来自当前 Worker。
    if (
      refererUrl.origin !== requestUrl.origin ||
      refererUrl.pathname === "/"
    ) {
      return null;
    }

    let base =
      refererUrl.pathname.replace(/^\/+/, "");

    if (!/^https?:\/\//i.test(base)) {
      if (!base.includes(".")) {
        return null;
      }

      base = `https://${base}`;
    }

    const baseUrl = parseHttpUrl(base);

    if (!baseUrl) {
      return null;
    }

    return new URL(
      requestUrl.pathname + requestUrl.search,
      baseUrl,
    );
  } catch {
    return null;
  }
}


/**
 * 向目标服务器转发请求。
 */
async function fetchTarget(request, targetUrl) {
  const headers = new Headers(request.headers);
  stripHopByHopHeaders(headers);

  // Host 由 fetch 根据 targetUrl 自动生成。
  headers.set("Referer", targetUrl.origin);
  headers.set("Origin", targetUrl.origin);

  for (const name of STRIPPED_HEADERS) {
    headers.delete(name);
  }

  /*
   * 保持原项目行为。
   *
   * GitHub API 总是提供稳定的 UA，
   * 并仅向白名单 GitHub 主机注入 Token。
   */
  if (
    targetUrl.protocol === "https:" &&
    GITHUB_HOSTS.has(targetUrl.hostname)
  ) {
    headers.set(
      "User-Agent",
      DEFAULT_USER_AGENT,
    );

    const token = getGithubToken();

    if (token) {
      headers.set(
        "Authorization",
        `Bearer ${token}`,
      );
    }
  } else if (!headerValue(headers, "User-Agent")) {
    headers.set(
      "User-Agent",
      DEFAULT_USER_AGENT,
    );
  }

  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };

  if (
    request.method !== "GET" &&
    request.method !== "HEAD"
  ) {
    init.body = request.body;
  }

  return fetch(targetUrl, init);
}


/**
 * 将目标网站的重定向继续留在代理内。
 *
 * 不使用 Response.redirect()，
 * 这样可以尽量保留源站响应头。
 */
function rewriteRedirect(
  response,
  proxyOrigin,
  targetUrl,
) {
  const location =
    response.headers.get("Location");

  if (!location) {
    return null;
  }

  let redirectUrl;

  try {
    redirectUrl = new URL(
      location,
      targetUrl,
    );
  } catch {
    return null;
  }

  if (!isHttpUrl(redirectUrl)) {
    return null;
  }

  const headers =
    new Headers(response.headers);

  headers.set(
    "Location",
    proxyUrl(proxyOrigin, redirectUrl),
  );

  applyCors(headers);

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


/**
 * 构造代理响应，并对 HTML 做链接重写。
 */
async function buildResponse(
  response,
  proxyOrigin,
  targetUrl,
) {
  const headers =
    new Headers(response.headers);

  rewriteSetCookieHeaders(
    headers,
    proxyOrigin,
    targetUrl,
  );
  applyCors(headers);

  /*
   * 页面经过代理后 origin 已改变。
   * 原 CSP / X-Frame-Options 经常导致脚本、
   * iframe 或跨域资源无法工作。
   */
  headers.delete(
    "Content-Security-Policy",
  );
  headers.delete(
    "Content-Security-Policy-Report-Only",
  );
  headers.delete("X-Frame-Options");

  const result = new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );

  const contentType =
    headers.get("Content-Type") || "";

  if (
    contentType
      .toLowerCase()
      .includes("text/css")
  ) {
    return rewriteCssResponse(
      result,
      proxyOrigin,
      targetUrl,
    );
  }

  if (
    !contentType
      .toLowerCase()
      .includes("text/html")
  ) {
    return result;
  }

  return new HTMLRewriter()
    .on(
      HTML_SELECTOR,
      new DOMRewriter(
        proxyOrigin,
        targetUrl,
      ),
    )
    .transform(result);
}


/**
 * 重写普通 URL 属性。
 */
function rewriteAttribute(
  element,
  attribute,
  proxyOrigin,
  baseUrl,
) {
  const value =
    element.getAttribute(attribute);

  if (!value) return;

  const trimmed = value.trim();

  if (
    !trimmed ||
    trimmed.startsWith("#") ||
    /^(?:javascript|mailto|data|blob|tel):/i
      .test(trimmed)
  ) {
    return;
  }

  try {
    const url = new URL(
      trimmed,
      baseUrl,
    );

    if (
      !isHttpUrl(url) ||
      url.origin === proxyOrigin
    ) {
      return;
    }

    element.setAttribute(
      attribute,
      proxyUrl(proxyOrigin, url),
    );
  } catch {
    // 非法 URL 保持原样。
  }
}


/**
 * 基础 srcset 支持。
 *
 * example.jpg 1x, example@2x.jpg 2x
 */
function rewriteSrcset(
  element,
  proxyOrigin,
  baseUrl,
) {
  const value =
    element.getAttribute("srcset");

  if (!value) return;

  const rewritten = value
    .split(",")
    .map((candidate) => {
      const part = candidate.trim();

      if (!part) return part;

      const match =
        part.match(/^(\S+)(.*)$/);

      if (!match) return part;

      const [, rawUrl, descriptor] =
        match;

      try {
        const url =
          new URL(rawUrl, baseUrl);

        if (!isHttpUrl(url)) {
          return part;
        }

        return (
          proxyUrl(proxyOrigin, url) +
          descriptor
        );
      } catch {
        return part;
      }
    })
    .join(", ");

  element.setAttribute(
    "srcset",
    rewritten,
  );
}


function proxyUrl(origin, targetUrl) {
  return `${origin}/${targetUrl}`;
}


function stripHopByHopHeaders(headers) {
  const connection =
    headers.get("Connection");

  for (const name of HOP_BY_HOP_HEADERS) {
    headers.delete(name);
  }

  if (!connection) {
    return;
  }

  for (const token of connection.split(",")) {
    const name = token.trim();

    if (name) {
      headers.delete(name);
    }
  }
}


function rewriteSetCookieHeaders(
  headers,
  proxyOrigin,
  targetUrl,
) {
  const rawCookies =
    readSetCookies(headers);

  if (!rawCookies.length) {
    return;
  }

  headers.delete("Set-Cookie");

  for (const cookie of rawCookies) {
    headers.append(
      "Set-Cookie",
      rewriteSetCookie(
        cookie,
        proxyOrigin,
        targetUrl,
      ),
    );
  }
}


function readSetCookies(headers) {
  /*
   * Workers 运行时支持 getSetCookie() 时优先使用，
   * 避免多 Set-Cookie 被错误合并。
   */
  if (typeof headers.getSetCookie === "function") {
    const cookies =
      headers.getSetCookie();

    if (Array.isArray(cookies)) {
      return cookies.filter(Boolean);
    }
  }

  const combined =
    headers.get("Set-Cookie");

  if (!combined) {
    return [];
  }

  return splitSetCookieHeader(combined);
}


function splitSetCookieHeader(value) {
  const cookies = [];
  let start = 0;
  let inExpires = false;

  for (let i = 0; i < value.length; i++) {
    const next =
      value.slice(i, i + 8).toLowerCase();

    if (next === "expires=") {
      inExpires = true;
      i += 7;
      continue;
    }

    const char = value[i];

    if (inExpires && char === ";") {
      inExpires = false;
      continue;
    }

    if (char === "," && !inExpires) {
      const cookie =
        value.slice(start, i).trim();

      if (cookie) {
        cookies.push(cookie);
      }

      start = i + 1;
    }
  }

  const last =
    value.slice(start).trim();

  if (last) {
    cookies.push(last);
  }

  return cookies;
}


function rewriteSetCookie(
  cookie,
  proxyOrigin,
  targetUrl,
) {
  const parts =
    cookie.split(";");
  const nameValue =
    parts.shift();

  if (!nameValue || !nameValue.includes("=")) {
    return cookie;
  }

  let hasPath = false;
  let hasDomain = false;
  const attributes = [];

  for (const rawPart of parts) {
    const part = rawPart.trim();

    if (!part) {
      continue;
    }

    const equalIndex =
      part.indexOf("=");
    const key = (
      equalIndex === -1
        ? part
        : part.slice(0, equalIndex)
    ).trim()
      .toLowerCase();
    const value =
      equalIndex === -1
        ? ""
        : part.slice(equalIndex + 1).trim();

    if (key === "path") {
      hasPath = true;
      attributes.push(
        `Path=${proxyCookiePath(
          targetUrl,
          normalizeCookiePath(value),
        )}`,
      );
      continue;
    }

    if (key === "domain") {
      hasDomain = true;
      continue;
    }

    attributes.push(part);
  }

  if (!hasPath) {
    attributes.push(
      `Path=${proxyCookiePath(
        targetUrl,
        defaultCookiePath(
          targetUrl.pathname,
        ),
      )}`,
    );
  }

  if (hasDomain) {
    attributes.push(
      `Domain=${new URL(proxyOrigin).hostname}`,
    );
  }

  return [
    nameValue.trim(),
    ...attributes,
  ].join("; ");
}


function defaultCookiePath(pathname) {
  if (!pathname || pathname === "/") {
    return "/";
  }

  const lastSlash =
    pathname.lastIndexOf("/");

  if (lastSlash <= 0) {
    return "/";
  }

  return pathname.slice(0, lastSlash);
}


function normalizeCookiePath(path) {
  if (!path || path[0] !== "/") {
    return "/";
  }

  return path;
}


function proxyCookiePath(targetUrl, path) {
  return `/${targetUrl.protocol}//${targetUrl.host}${path}`;
}


async function rewriteCssResponse(
  response,
  proxyOrigin,
  targetUrl,
) {
  const lengthHeader =
    response.headers.get("Content-Length");
  const contentLength =
    lengthHeader === null
      ? Number.NaN
      : Number(lengthHeader);

  if (
    !Number.isFinite(contentLength) ||
    contentLength > CSS_REWRITE_MAX_BYTES
  ) {
    return response;
  }

  const cssText =
    await response.text();
  const rewritten =
    rewriteCssUrls(
      cssText,
      proxyOrigin,
      targetUrl,
    );
  const headers =
    new Headers(response.headers);

  headers.delete("Content-Length");

  return new Response(rewritten, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}


function rewriteCssUrls(
  cssText,
  proxyOrigin,
  baseUrl,
) {
  return cssText.replace(
    /url\(\s*(["']?)([^"'()]+)\1\s*\)/gi,
    (match, quote, rawValue) => {
      const value = rawValue.trim();

      if (
        !value ||
        value.startsWith("#") ||
        /^(?:data|blob|about|javascript):/i.test(
          value,
        )
      ) {
        return match;
      }

      try {
        const url = new URL(
          value,
          baseUrl,
        );

        if (
          !isHttpUrl(url) ||
          url.origin === proxyOrigin
        ) {
          return match;
        }

        return `url(${quote}${proxyUrl(
          proxyOrigin,
          url,
        )}${quote})`;
      } catch {
        return match;
      }
    },
  );
}


function parseHttpUrl(value) {
  try {
    const url = new URL(value);
    return isHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}


function isHttpUrl(url) {
  return (
    url.protocol === "http:" ||
    url.protocol === "https:"
  );
}


function applyCors(headers) {
  for (
    const [name, value]
    of Object.entries(CORS_HEADERS)
  ) {
    headers.set(name, value);
  }
}


function getGithubToken() {
  const token =
    globalThis.GH_TOKEN;

  return (
    typeof token === "string" &&
    token.trim()
  )
    ? token.trim()
    : null;
}


function headerValue(headers, name) {
  const value = headers.get(name);
  return (
    typeof value === "string" &&
    value.trim()
  )
    ? value.trim()
    : "";
}


function textResponse(
  message,
  status = 200,
) {
  return new Response(message, {
    status,
    headers: {
      "Content-Type":
        "text/plain; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}


function errorMessage(error) {
  return error instanceof Error
    ? error.message
    : String(error);
}


if (typeof module !== "undefined") {
  module.exports = {
    CSS_REWRITE_MAX_BYTES,
    defaultCookiePath,
    handleRequest,
    proxyCookiePath,
    rewriteCssUrls,
    rewriteSetCookie,
    splitSetCookieHeader,
    stripHopByHopHeaders,
  };
}
