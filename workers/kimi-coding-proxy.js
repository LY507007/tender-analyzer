const KIMI_CODING_ENDPOINT = "https://api.kimi.com/coding/v1/chat/completions";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://ly507007.github.io",
  "http://127.0.0.1:4332",
  "http://127.0.0.1:4331",
  "http://localhost:4332",
  "http://localhost:4331",
];

function getAllowedOrigins(env) {
  const configured = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowedOrigins = getAllowedOrigins(env);
  const allowOrigin = allowedOrigins.includes("*")
    ? "*"
    : allowedOrigins.includes(origin)
      ? origin
      : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(request, env, body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export default {
  async fetch(request, env) {
    const corsHeaders = getCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse(request, env, { error: "Method not allowed" }, 405);
    }

    const authHeader = request.headers.get("Authorization");
    const authorization = authHeader || (env.KIMI_API_KEY ? `Bearer ${env.KIMI_API_KEY}` : "");
    if (!authorization) {
      return jsonResponse(request, env, { error: "Missing Authorization header" }, 401);
    }

    const upstream = await fetch(KIMI_CODING_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "User-Agent": "tender-analyzer/1.0",
      },
      body: await request.text(),
    });

    const headers = new Headers(corsHeaders);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json; charset=utf-8");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  },
};
