import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { decode } from "html-entities"
import { renderRedditSelftext } from "../src/reddit/service"

interface RedditAccessTokenResponse {
  access_token: string
}

interface RedditInfoResponse {
  data?: {
    children?: Array<{
      data?: DebugRedditPost
    }>
  }
}

interface DebugRedditPost {
  author?: string
  id: string
  num_comments?: number
  permalink?: string
  score?: number
  selftext?: string
  selftext_html?: string | null
  subreddit?: string
  title?: string
  url?: string
}

async function main() {
  loadLocalEnv()

  const sourceId = process.argv[2] ?? "1srfed4"
  const clientId = process.env.REDDIT_CLIENT_ID
  const clientSecret = process.env.REDDIT_CLIENT_SECRET
  const userAgent = process.env.REDDIT_USER_AGENT
    ?? "postal-worker-debug/1.0"

  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing REDDIT_CLIENT_ID or REDDIT_CLIENT_SECRET in the current shell environment.",
    )
  }

  const token = await getAccessToken(clientId, clientSecret, userAgent)
  const post = await fetchRedditPost(sourceId, token, userAgent)

  if (!post) {
    throw new Error(`No Reddit post found for source_id ${sourceId}.`)
  }

  const redditHtml = post.selftext_html ? decode(post.selftext_html) : null
  const renderedHtml = renderRedditSelftext(post.selftext)

  console.log(`source_id: ${post.id}`)
  console.log(`title: ${post.title ?? ""}`)
  console.log(`subreddit: ${post.subreddit ?? ""}`)
  console.log(`author: ${post.author ?? ""}`)
  console.log(`score: ${post.score ?? 0}`)
  console.log(`comments: ${post.num_comments ?? 0}`)
  console.log(`url: ${post.url ?? ""}`)
  console.log(
    `permalink: ${post.permalink ? `https://www.reddit.com${post.permalink}` : ""}`,
  )

  console.log("\n=== RAW SELFTEXT ===\n")
  console.log(post.selftext?.length ? formatLines(post.selftext) : "[empty]")

  console.log("\n=== REDDIT SELFTEXT_HTML ===\n")
  console.log(redditHtml?.trim() ? redditHtml : "[missing]")

  console.log("\n=== POSTAL RENDERED HTML ===\n")
  console.log(renderedHtml?.trim() ? renderedHtml : "[empty]")
}

async function getAccessToken(
  clientId: string,
  clientSecret: string,
  userAgent: string,
) {
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": userAgent,
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }),
  })

  if (!response.ok) {
    throw new Error(
      `Reddit token request failed: ${response.status} ${response.statusText}`,
    )
  }

  const payload = (await response.json()) as RedditAccessTokenResponse
  return payload.access_token
}

async function fetchRedditPost(
  sourceId: string,
  token: string,
  userAgent: string,
) {
  const url = new URL("https://oauth.reddit.com/api/info")
  url.searchParams.set("id", `t3_${sourceId}`)
  url.searchParams.set("raw_json", "1")

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": userAgent,
    },
  })

  if (!response.ok) {
    throw new Error(
      `Reddit info request failed: ${response.status} ${response.statusText}`,
    )
  }

  const payload = (await response.json()) as RedditInfoResponse
  return payload.data?.children?.[0]?.data ?? null
}

function loadLocalEnv() {
  const envPath = resolve(process.cwd(), ".env")
  if (!existsSync(envPath)) {
    return
  }

  const contents = readFileSync(envPath, "utf8")

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const separatorIndex = line.indexOf("=")
    if (separatorIndex <= 0) {
      continue
    }

    const key = line.slice(0, separatorIndex).trim()
    if (!key || process.env[key] !== undefined) {
      continue
    }

    const rawValue = line.slice(separatorIndex + 1).trim()
    process.env[key] = stripWrappingQuotes(rawValue)
  }
}

function stripWrappingQuotes(value: string) {
  const startsWithSingle = value.startsWith("'") && value.endsWith("'")
  const startsWithDouble = value.startsWith("\"") && value.endsWith("\"")

  if ((startsWithSingle || startsWithDouble) && value.length >= 2) {
    return value.slice(1, -1)
  }

  return value
}

function formatLines(value: string) {
  return value
    .split(/\r?\n/)
    .map((line, index) => `${String(index + 1).padStart(3, " ")}| ${line}`)
    .join("\n")
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
