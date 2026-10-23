/**
 * Deep Research Agent - Brave Search CORS Relay
 * Cloudflare Worker
 *
 * This worker is a restricted relay. It does NOT store any API keys.
 * The user's Brave Search API key is forwarded directly from their browser
 * to the Brave Search API. This worker only adds CORS headers so browsers
 * can communicate with the Brave API from allowed app origins.
 *
 * Deploy to: https://dash.cloudflare.com → Workers & Pages → Create Worker
 */

const BRAVE_SEARCH_BASE = "https://api.search.brave.com";

// Browser origins allowed to use this worker.
// Add every domain from which you serve the app.
const ALLOWED_ORIGINS = [
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5502",
  "http://127.0.0.1:5502",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "https://osinv.org",
];

const MAX_PROXY_BYTES = 1_000_000;
const MAX_PDF_BYTES = 15_000_000; // PDFs can be larger; 15 MB ceiling
const MAX_REDIRECTS = 3;
const ALLOWED_PROXY_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PROXY_CONTENT_TYPES = [
  "text/html",
  "text/plain",
  "application/xhtml+xml",
  "application/xml",
  "text/xml",
  "application/pdf",
];

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight (OPTIONS) requests
    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(request)) {
        return new Response("Forbidden", { status: 403 });
      }
      return corsResponse(null, 204, request);
    }

    if (!isAllowedOrigin(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    // Only allow GET requests
    if (request.method !== "GET") {
      return corsResponse("Method Not Allowed", 405, request);
    }

    const url = new URL(request.url);

    // Handle Generic URL Proxy (for fetching website HTML)
    // e.g. https://your-worker.workers.dev/proxy?url=https://example.com
    if (url.pathname.startsWith("/proxy")) {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return corsResponse("Missing url parameter", 400, request);
      }

      let parsedTarget;
      try {
        parsedTarget = new URL(targetUrl);
      } catch {
        return corsResponse("Invalid url parameter", 400, request);
      }

      if (!ALLOWED_PROXY_PROTOCOLS.has(parsedTarget.protocol)) {
        return corsResponse("Unsupported URL protocol", 400, request);
      }
      
      try {
        const response = await fetchProxyTarget(parsedTarget.toString());
        const contentType = response.headers.get("Content-Type") || "text/html";
        const normalizedContentType = contentType.split(";")[0].trim().toLowerCase();

        if (!ALLOWED_PROXY_CONTENT_TYPES.includes(normalizedContentType)) {
          return corsResponse("Unsupported content type", 415, request);
        }

        // PDFs are binary — return bytes directly so the browser can parse them.
        if (normalizedContentType === "application/pdf") {
          const bytes = await readLimitedBytes(response, MAX_PDF_BYTES);
          return new Response(bytes, {
            status: response.status,
            headers: {
              "Content-Type": "application/pdf",
              "Access-Control-Allow-Origin": request.headers.get("Origin"),
              "Access-Control-Allow-Methods": "GET, OPTIONS",
              "Access-Control-Allow-Headers": "Content-Type, X-Subscription-Token",
              "Vary": "Origin",
            },
          });
        }

        const body = await readLimitedText(response, MAX_PROXY_BYTES);
        return corsResponse(body, response.status, request, {
          "Content-Type": contentType,
        });
      } catch (err) {
        return corsResponse(`Failed to fetch: ${err.message}`, 502, request);
      }
    }

    // The worker proxies /res/v1/web/search for Brave API
    if (!url.pathname.startsWith("/res/v1/")) {
      return corsResponse("Not Found", 404, request);
    }

    // Grab the API key from the incoming request header
    const apiKey = request.headers.get("X-Subscription-Token");
    if (!apiKey) {
      return corsResponse(
        JSON.stringify({ error: "Missing X-Subscription-Token header" }),
        401,
        request,
        { "Content-Type": "application/json" }
      );
    }

    // Build the upstream Brave Search URL
    const braveUrl = `${BRAVE_SEARCH_BASE}${url.pathname}${url.search}`;

    // Forward the request to Brave with the user's own API key
    let braveResponse;
    try {
      braveResponse = await fetch(braveUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });
    } catch (err) {
      return corsResponse(
        JSON.stringify({ error: "Failed to reach Brave Search API", detail: err.message }),
        502,
        request,
        { "Content-Type": "application/json" }
      );
    }

    // Read Brave's response body
    const body = await braveResponse.text();

    // Return Brave's response with CORS headers added
    return corsResponse(body, braveResponse.status, request, {
      "Content-Type": braveResponse.headers.get("Content-Type") || "application/json",
    });
  },
};

/**
 * Build a Response with CORS headers.
 */
function corsResponse(body, status, request, extraHeaders = {}) {
  const origin = request.headers.get("Origin");

  return new Response(body, {
    status,
    headers: {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Subscription-Token",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
      ...extraHeaders,
    },
  });
}

function isAllowedOrigin(request) {
  const origin = request.headers.get("Origin");
  return origin && ALLOWED_ORIGINS.includes(origin);
}

async function fetchProxyTarget(url, redirectsRemaining = MAX_REDIRECTS) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectsRemaining <= 0) throw new Error("Too many redirects");

    const location = response.headers.get("Location");
    if (!location) throw new Error("Redirect without location");

    const nextUrl = new URL(location, url);
    if (!ALLOWED_PROXY_PROTOCOLS.has(nextUrl.protocol)) {
      throw new Error("Redirected to unsupported protocol");
    }

    return fetchProxyTarget(nextUrl.toString(), redirectsRemaining - 1);
  }

  return response;
}

// Read the response as a raw Uint8Array — used for binary content like PDFs.
async function readLimitedBytes(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readLimitedText(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }

    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(body);
}
