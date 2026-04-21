import { getCachedJson, putCachedJson, readCachedString } from "./lib/kv"
import {
  badRequest,
  handleCorsPreflight,
  json,
  methodNotAllowed,
  notFound,
  unauthorized,
  withCors
} from "./lib/response"
import type {
  ManualRefreshTarget,
  StoredPatchNotesMeta,
  StoredPbeMeta
} from "./meta/service"
import { refreshPatchNotesMeta, refreshPbeMeta } from "./meta/service"
import { listRedditPosts, upsertRedditPosts } from "./reddit/db"
import type { StoredRedditFeed } from "./reddit/service"
import {
  filterFeedItems,
  parseFeedQuery,
  refreshLeagueOfLegendsRedditFeed
} from "./reddit/service"
import type { Env } from "./types"

const REDDIT_MAIN_FEED_KEY = "reddit:leagueoflegends:main-feed:v1"

export default {
  async fetch(request, env): Promise<Response> {
    const preflight = handleCorsPreflight(request, env.POSTAL_ALLOWED_ORIGINS)
    if (preflight) {
      return preflight
    }

    const url = new URL(request.url)
    let response: Response

    if (request.method === "GET") {
      if (url.pathname === "/api/feed/reddit") {
        response = await handleRedditFeedRequest(url, env)
        return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
      }

      if (url.pathname === "/cdn/meta/pbe_latest.json") {
        response = await handleStaticMetaRequest<StoredPbeMeta>(
          "meta:pbe:latest",
          env,
          60 * 60
        )
        return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
      }

      if (url.pathname === "/cdn/meta/patch_latest.json") {
        response = await handleStaticMetaRequest<StoredPatchNotesMeta>(
          "meta:patch:latest",
          env,
          60 * 60
        )
        return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
      }
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/internal/refresh")
    ) {
      try {
        response = await handleManualRefresh(request, url, env)
      } catch (error) {
        const target = url.pathname.replace(/^\/internal\/refresh\/?/, "").trim() || null
        console.error("Manual refresh failed", {
          error,
          target,
          url: request.url
        })

        response = json(
          {
            error: getErrorMessage(error),
            target
          },
          {
            status: 500
          }
        )
      }

      return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
    }

    if (request.method !== "GET" && request.method !== "POST") {
      response = methodNotAllowed()
      return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
    }

    response = notFound()
    return withCors(request, response, env.POSTAL_ALLOWED_ORIGINS)
  },

  async scheduled(controller, env, ctx): Promise<void> {
    switch (controller.cron) {
      case "17 * * * *":
        ctx.waitUntil(runRedditRefresh(env))
        break
      case "13 14 * * *":
        ctx.waitUntil(runMetaRefresh(env, "all"))
        break
    }
  }
} satisfies ExportedHandler<Env>

async function handleRedditFeedRequest(url: URL, env: Env) {
  const query = parseFeedQuery(url)
  const useCachedFeed = shouldUseCachedRedditFeed(query)

  if (useCachedFeed) {
    const feed = await getCachedJson<StoredRedditFeed>(
      env.POSTS,
      REDDIT_MAIN_FEED_KEY
    ) ?? await getCachedJson<StoredRedditFeed>(
      env.POSTS,
      "reddit:leagueoflegends:latest"
    )

    if (feed) {
      const filtered = filterFeedItems(feed.items, query)
      const offset = query.offset ?? 0
      const limit = query.limit ?? 25

      return json(
        {
          items: filtered.slice(offset, offset + limit),
          total: filtered.length
        },
        {
          headers: {
            "cache-control": "public, max-age=300"
          }
        }
      )
    }
  }

  const result = await listRedditPosts(env.DB, query)

  return json(
    result,
    {
      headers: {
        "cache-control": "public, max-age=300"
      }
    }
  )
}

async function handleStaticMetaRequest<T>(
  key: string,
  env: Env,
  maxAgeSeconds: number
) {
  const payload = await readCachedString(env.POSTS, key)
  if (!payload) {
    return notFound()
  }

  return new Response(payload, {
    headers: {
      "cache-control": `public, max-age=${maxAgeSeconds}`,
      "content-type": "application/json; charset=utf-8"
    }
  })
}

async function handleManualRefresh(request: Request, url: URL, env: Env) {
  if (!isAuthorized(request, env)) {
    return unauthorized("Invalid refresh secret")
  }

  const target = url.pathname.replace(/^\/internal\/refresh\/?/, "").trim()
  if (!target) {
    return badRequest("Missing refresh target")
  }

  if (target === "reddit") {
    const result = await runRedditRefresh(env)
    return json(result)
  }

  if (target === "meta") {
    const result = await runMetaRefresh(env, "all")
    return json(result)
  }

  if (target === "meta/pbe") {
    const result = await runMetaRefresh(env, "pbe")
    return json(result)
  }

  if (target === "meta/patch") {
    const result = await runMetaRefresh(env, "patch")
    return json(result)
  }

  return badRequest(`Unknown refresh target: ${target}`)
}

function isAuthorized(request: Request, env: Env) {
  if (!env.POSTAL_REFRESH_SECRET) {
    return false
  }

  return (
    request.headers.get("x-postal-refresh-secret") === env.POSTAL_REFRESH_SECRET
  )
}

async function runRedditRefresh(env: Env) {
  const result = await refreshLeagueOfLegendsRedditFeed(env)

  await upsertRedditPosts(env.DB, result.feed.items)
  await putCachedJson(
    env.POSTS,
    REDDIT_MAIN_FEED_KEY,
    {
      ...result.feed,
      items: result.feed.items.slice(0, 25)
    }
  )

  return result
}

async function runMetaRefresh(env: Env, target: ManualRefreshTarget) {
  const locale = env.POSTAL_LOCALE ?? "en-us"
  const output: Record<string, unknown> = {}

  if (target === "all" || target === "pbe") {
    const pbe = await refreshPbeMeta(locale)
    await putCachedJson(env.POSTS, "meta:pbe:latest", pbe)
    output.pbe = {
      key: "meta:pbe:latest",
      url: pbe.url
    }
  }

  if (target === "all" || target === "patch") {
    const patch = await refreshPatchNotesMeta(locale)
    await putCachedJson(env.POSTS, "meta:patch:latest", patch)
    output.patch = {
      key: "meta:patch:latest",
      patch: patch.patch,
      url: patch.url
    }
  }

  return {
    refreshedAt: new Date().toISOString(),
    target,
    ...output
  }
}

function shouldUseCachedRedditFeed(query: ReturnType<typeof parseFeedQuery>) {
  return (
    (query.subreddit ?? "leagueoflegends") === "leagueoflegends" &&
    !query.keyword &&
    (!query.keywords || query.keywords.length === 0) &&
    !query.flair &&
    typeof query.spoiler !== "boolean" &&
    (query.offset ?? 0) === 0 &&
    (query.limit ?? 25) <= 25
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "string") {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return "Unknown error"
  }
}
