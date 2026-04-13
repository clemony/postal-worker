const DEFAULT_ALLOWED_ORIGINS = [
  "https://lolpocket.com",
  "https://www.lolpocket.com",
  "http://localhost:3000",
  "http://127.0.0.1:3000"
]

export function json(
  payload: unknown,
  init: ResponseInit = {},
) {
  const headers = new Headers(init.headers)
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json; charset=utf-8")
  }

  return new Response(JSON.stringify(payload, null, 2), {
    ...init,
    headers
  })
}

export function notFound() {
  return new Response("Not found", { status: 404 })
}

export function methodNotAllowed() {
  return new Response("Method not allowed", { status: 405 })
}

export function badRequest(message: string) {
  return json({ error: message }, { status: 400 })
}

export function unauthorized(message: string) {
  return json({ error: message }, { status: 401 })
}

export function handleCorsPreflight(
  request: Request,
  allowedOrigins?: string,
) {
  if (request.method !== "OPTIONS") {
    return null
  }

  const headers = createCorsHeaders(request, allowedOrigins)
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS")
  headers.set(
    "access-control-allow-headers",
    "content-type, x-postal-refresh-secret",
  )
  headers.set("access-control-max-age", "86400")

  return new Response(null, {
    status: 204,
    headers
  })
}

export function withCors(
  request: Request,
  response: Response,
  allowedOrigins?: string,
) {
  const headers = new Headers(response.headers)
  const corsHeaders = createCorsHeaders(request, allowedOrigins)

  for (const [key, value] of corsHeaders.entries()) {
    headers.set(key, value)
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  })
}

function createCorsHeaders(request: Request, allowedOrigins?: string) {
  const headers = new Headers()
  const origin = request.headers.get("origin")
  const allowedOrigin = getAllowedOrigin(origin, allowedOrigins)

  headers.set("vary", "Origin")

  if (allowedOrigin) {
    headers.set("access-control-allow-origin", allowedOrigin)
  }

  return headers
}

function getAllowedOrigin(
  origin: string | null,
  allowedOrigins?: string,
) {
  if (!origin) {
    return null
  }

  const configuredOrigins = allowedOrigins
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  const candidates = configuredOrigins?.length
    ? configuredOrigins
    : DEFAULT_ALLOWED_ORIGINS

  return candidates.includes(origin) ? origin : null
}
