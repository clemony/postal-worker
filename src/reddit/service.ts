import { decode } from "html-entities"
import MarkdownIt from "markdown-it"
import { full as markdownItEmoji } from "markdown-it-emoji"
import markdownItRedditSpoiler from "markdown-it-reddit-spoiler"
import sanitizeHtml from "sanitize-html"
import type { Env, Post, PostListQuery, PostRefreshResponse, PostVideoProvider } from "../types"
import { deriveFeedKeywords } from "./keywords"

const REDDIT_FEED_MIN_COMMENTS = 30
const REDDIT_FEED_MIN_SCORE = 100
const REDDIT_EXCERPT_MAX_LENGTH = 400
const REDDIT_MARKDOWN_FENCE_RE = /^\s*(```|~~~)/
const REDDIT_MALFORMED_HEADING_RE = /^(\s{0,3})(#{1,6})([^\s#].*)$/
const REDDIT_QUOTED_LINE_RE = /^\s{0,3}>/
const REDDIT_SUBREDDIT_RE = /^([A-Za-z0-9_]+)(?:\/)?(?![A-Za-z0-9_])/
const REDDIT_SPOILER_OPEN_TAG = "<details><summary>Spoiler</summary>"
const REDDIT_SPOILER_CLOSE_TAG = "</details>"
const REDDIT_SUPERSCRIPT_WORD_RE = /^(?:\[[^\]]*\]\([^)]*\)|[^\s^])+/
const REDDIT_USERNAME_RE = /^([A-Za-z0-9_-]+)(?:\/)?(?![A-Za-z0-9_-])/
const REDDIT_URL_RE = /^https?:\/\//
const WHITESPACE_RE = /\s+/g
const YOUTUBE_HOSTS = new Set([
  "youtu.be",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com"
])
const REDDIT_REFERENCE_MARKDOWN = new MarkdownIt("zero").enable("reference")
const REDDIT_HTML_SANITIZE_OPTIONS = {
  allowedAttributes: {
    a: ["href", "rel", "target", "title"],
    code: ["class"],
    img: ["alt", "height", "loading", "src", "title", "width"]
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedTags: [
    "a",
    "blockquote",
    "br",
    "caption",
    "code",
    "details",
    "em",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "hr",
    "img",
    "li",
    "ol",
    "p",
    "pre",
    "summary",
    "sup",
    "strong",
    "table",
    "tbody",
    "td",
    "th",
    "thead",
    "tr",
    "ul"
  ],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      rel: "noopener noreferrer nofollow ugc",
      target: "_blank"
    }),
    img: sanitizeHtml.simpleTransform("img", {
      loading: "lazy"
    })
  }
}
const REDDIT_TEXT_SANITIZE_OPTIONS = {
  allowedAttributes: {},
  allowedTags: []
}

interface RedditAccessTokenResponse {
  access_token: string
  expires_in: number
}

interface RedditListingChild {
  data: RedditPost
}

interface RedditListingResponse {
  data: {
    children: RedditListingChild[]
  }
}

interface RedditHostedVideo {
  dash_url?: string
  duration?: number
  fallback_url?: string
  hls_url?: string
  height?: number
  width?: number
}

interface RedditPost {
  author: string
  author_is_blocked?: boolean
  created_utc: number
  domain?: string
  id: string
  is_self: boolean
  is_video: boolean
  link_flair_text: string | null
  media?: {
    reddit_video?: RedditHostedVideo
  }
  num_comments: number
  over_18: boolean
  permalink: string
  post_hint?: string
  spoiler: boolean
  preview?: {
    images?: Array<{
      source?: {
        url?: string
      }
    }>
    reddit_video_preview?: RedditHostedVideo
  }
  score: number
  secure_media?: {
    reddit_video?: RedditHostedVideo
  }
  selftext?: string
  stickied: boolean
  subreddit: string
  thumbnail?: string
  title: string
  url: string
  url_overridden_by_dest?: string
}

interface RedditListingSpec {
  limit: number
  sort: "hot" | "new" | "top"
  time?: "day"
}

interface RedditTokenCache {
  accessToken: string
  expiresAt: number
}

let cachedToken: RedditTokenCache | undefined

export interface StoredRedditFeed {
  generatedAt: string
  items: Post[]
  subreddit: string
}

export async function refreshLeagueOfLegendsRedditFeed(env: Env) {
  const subreddit = "leagueoflegends"
  const [recent, top] = await Promise.all([
    fetchRedditListing(env, subreddit, { limit: 50, sort: "new" }),
    fetchRedditListing(env, subreddit, { limit: 50, sort: "top", time: "day" })
  ])

  const items = dedupePosts([...recent, ...top]).filter(shouldPersistRedditPost)
  const generatedAt = new Date().toISOString()

  const feed: StoredRedditFeed = {
    generatedAt,
    items,
    subreddit
  }

  const result: PostRefreshResponse & { feed: StoredRedditFeed } = {
    cleanedBefore: generatedAt,
    deletedCount: 0,
    fetchedCount: recent.length + top.length,
    sources: ["reddit:new", "reddit:top:day"],
    upsertedCount: items.length,
    feed
  }

  return result
}

export function parseFeedQuery(url: URL): PostListQuery {
  const rawKeywords = url.searchParams.getAll("keywords")
  const commaSeparated = rawKeywords.flatMap((value) => value.split(","))
  const keywords = commaSeparated
    .map((keyword) => keyword.trim().toLowerCase())
    .filter(Boolean)

  const keyword = url.searchParams.get("keyword")?.trim().toLowerCase()
    ?? url.searchParams.get("k")?.trim().toLowerCase()
    ?? undefined

  return {
    flair: url.searchParams.get("flair")?.trim() ?? undefined,
    keyword,
    keywords: keywords.length > 0 ? keywords : undefined,
    limit: parsePositiveInteger(url.searchParams.get("limit"), 25, 100),
    offset: parsePositiveInteger(url.searchParams.get("offset"), 0),
    spoiler: parseBooleanQuery(url.searchParams.get("spoiler")),
    subreddit: url.searchParams.get("subreddit") ?? "leagueoflegends"
  }
}

export function filterFeedItems(items: Post[], query: PostListQuery) {
  const subreddit = query.subreddit ?? "leagueoflegends"
  const keywordFilters = [
    ...(query.keyword ? [query.keyword] : []),
    ...(query.keywords ?? [])
  ]

  return items.filter((item) => {
    if (item.subreddit !== subreddit) {
      return false
    }

    if (query.flair && item.flair !== query.flair) {
      return false
    }

    if (
      typeof query.spoiler === "boolean" &&
      Boolean(item.metadata.spoiler) !== query.spoiler
    ) {
      return false
    }

    if (keywordFilters.length === 0) {
      return true
    }

    return keywordFilters.some((keyword) => item.keywords.includes(keyword))
  })
}

async function fetchRedditListing(
  env: Env,
  subreddit: string,
  spec: RedditListingSpec,
): Promise<Post[]> {
  const token = await getRedditAccessToken(env)
  const url = new URL(`https://oauth.reddit.com/r/${subreddit}/${spec.sort}`)
  url.searchParams.set("limit", String(spec.limit))
  url.searchParams.set("raw_json", "1")
  if (spec.time) {
    url.searchParams.set("t", spec.time)
  }

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": getUserAgent(env)
    }
  })

  if (!response.ok) {
    throw new Error(`Reddit listing request failed: ${response.status} ${response.statusText}`)
  }

  const listing = (await response.json()) as RedditListingResponse

  return listing.data.children
    .map(({ data }) => normalizeRedditPost(data))
    .filter((item): item is Post => item !== null)
}

function normalizeRedditPost(post: RedditPost): Post | null {
  const permalink = decodeRedditUrl(`https://www.reddit.com${post.permalink}`)
  const url = decodeRedditUrl(post.url_overridden_by_dest ?? post.url)
  const preview = decodeRedditUrl(post.preview?.images?.[0]?.source?.url)
  const thumbnail = decodeRedditUrl(post.thumbnail)

  if (!permalink || !url) return null

  const resolvedUrl = post.is_self ? permalink : url
  const { videoId, videoProvider } = extractYouTubeVideo(resolvedUrl)
  const {
    videoDashUrl,
    videoDuration,
    videoHeight,
    videoHlsUrl,
    videoUrl,
    videoWidth
  } = extractRedditVideo(post)
  const resolvedVideoProvider: PostVideoProvider | null =
    videoProvider ?? (videoUrl || videoHlsUrl || videoDashUrl ? "reddit" : null)

  return {
    author: post.author || null,
    excerpt: post.is_self ? createExcerpt(post.selftext) : null,
    text: createTextPost(post.selftext),
    fetched_at: new Date().toISOString(),
    flair: post.link_flair_text,
    keywords: deriveFeedKeywords({
      flair: post.link_flair_text,
      subreddit: post.subreddit,
      title: post.title
    }),
    metadata: {
      authorIsBlocked: post.author_is_blocked,
      domain: post.domain ?? null,
      isSelf: post.is_self,
      isVideo: post.is_video,
      linkFlairText: post.link_flair_text,
      over18: post.over_18,
      postHint: post.post_hint ?? null,
      spoiler: post.spoiler,
      stickied: post.stickied
    },
    num_comments: post.num_comments ?? 0,
    permalink,
    preview_image_url: preview,
    score: post.score ?? 0,
    source: "reddit",
    source_created_at: new Date(post.created_utc * 1000).toISOString(),
    source_id: post.id,
    subreddit: post.subreddit,
    thumbnail_url: thumbnail,
    title: post.title,
    url: resolvedUrl,
    video_dash_url: videoDashUrl,
    video_duration: videoDuration,
    video_height: videoHeight,
    video_hls_url: videoHlsUrl,
    video_id: videoId,
    video_provider: resolvedVideoProvider,
    video_url: videoUrl,
    video_width: videoWidth
  }
}

async function getRedditAccessToken(env: Env) {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken
  }

  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) {
    throw new Error("Missing REDDIT_CLIENT_ID or REDDIT_CLIENT_SECRET")
  }

  const auth = btoa(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`)
  const body = new URLSearchParams({ grant_type: "client_credentials" })
  const response = await fetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": getUserAgent(env)
    },
    body
  })

  if (!response.ok) {
    throw new Error(`Reddit token request failed: ${response.status} ${response.statusText}`)
  }

  const token = (await response.json()) as RedditAccessTokenResponse
  cachedToken = {
    accessToken: token.access_token,
    expiresAt: Date.now() + token.expires_in * 1000
  }

  return token.access_token
}

function decodeRedditUrl(url?: string | null) {
  if (!url || !REDDIT_URL_RE.test(url)) return null
  return decodeRedditText(url)
}

function decodeRedditText(value?: string) {
  if (!value) return null
  return decode(value)
}

function truncateText(value: string, maxLength: number) {
  if (value.length <= maxLength) return value

  const sliced = value.slice(0, maxLength + 1)
  const boundary = sliced.lastIndexOf(" ")

  if (boundary < Math.floor(maxLength * 0.6)) {
    return `${value.slice(0, maxLength).trim()}...`
  }

  return `${sliced.slice(0, boundary).trim()}...`
}

function normalizeRedditMarkdown(value: string) {
  const lines = value.split(/\r?\n/)
  let inFence = false

  return lines.map((line, index) => {
    if (REDDIT_MARKDOWN_FENCE_RE.test(line)) {
      inFence = !inFence
      return line
    }

    if (inFence) {
      return line
    }

    if (
      line.trim() === "" &&
      REDDIT_QUOTED_LINE_RE.test(lines[index - 1] ?? "") &&
      REDDIT_QUOTED_LINE_RE.test(lines[index + 1] ?? "")
    ) {
      return ">"
    }

    const match = line.match(REDDIT_MALFORMED_HEADING_RE)
    if (!match) {
      return line
    }

    const [, indent, hashes, content] = match
    const leadingChar = content.charAt(0)

    // Preserve values like "#1" that are more likely text than an intended heading.
    if (leadingChar >= "0" && leadingChar <= "9") {
      return line
    }

    return `${indent}${hashes} ${content}`
  }).join("\n")
}

function configureRedditAutolinks(renderer: MarkdownIt) {
  for (const [prefix, path, pattern] of [
    ["r/", "r", REDDIT_SUBREDDIT_RE],
    ["/r/", "r", REDDIT_SUBREDDIT_RE],
    ["u/", "u", REDDIT_USERNAME_RE],
    ["/u/", "u", REDDIT_USERNAME_RE]
  ] as const) {
    renderer.linkify.add(prefix, {
      normalize: (match) => {
        const handle = match.raw.replace(/^\/?[ru]\//, "").replace(/\/$/, "")
        match.text = match.raw
        match.url = `https://www.reddit.com/${path}/${handle}`
      },
      validate: (text, pos) => text.slice(pos).match(pattern)?.[0].length ?? 0
    })
  }
}

function configureRedditSuperscript(renderer: MarkdownIt) {
  renderer.inline.ruler.before(
    "emphasis",
    "reddit_superscript",
    (state: any, silent: boolean) => {
      const start = state.pos

      if (state.src.charCodeAt(start) !== 0x5E /* ^ */) {
        return false
      }

      const next = start + 1
      if (next >= state.posMax) {
        return false
      }

      let content = ""
      let end = next

      if (state.src.charCodeAt(next) === 0x28 /* ( */) {
        const closing = findSuperscriptClosingParen(state.src, next + 1, state.posMax)
        if (closing < 0 || closing === next + 1) {
          return false
        }

        content = state.src.slice(next + 1, closing)
        end = closing + 1
      } else {
        const match = state.src.slice(next, state.posMax).match(REDDIT_SUPERSCRIPT_WORD_RE)
        if (!match?.[0]) {
          return false
        }

        content = match[0]
        end = next + match[0].length
      }

      if (silent) {
        return true
      }

      const open = state.push("sup_open", "sup", 1)
      open.markup = "^"

      const text = state.push("text", "", 0)
      text.content = content

      const close = state.push("sup_close", "sup", -1)
      close.markup = "^"

      state.pos = end
      return true
    },
  )
}

function findSuperscriptClosingParen(src: string, start: number, max: number) {
  let depth = 1

  for (let index = start; index < max; index += 1) {
    const code = src.charCodeAt(index)

    if (code === 0x5C /* \\ */) {
      index += 1
      continue
    }

    if (code === 0x28 /* ( */) {
      depth += 1
      continue
    }

    if (code === 0x29 /* ) */) {
      depth -= 1
      if (depth === 0) {
        return index
      }
    }
  }

  return -1
}

function createRedditMarkdownRenderer(options?: { nested?: boolean }) {
  const renderer = new MarkdownIt({
    breaks: true,
    html: false,
    linkify: true
  }).use(markdownItEmoji)

  configureRedditAutolinks(renderer)
  configureRedditSuperscript(renderer)

  if (options?.nested) {
    renderer
      .disable("blockquote")
      .disable("code")
      .disable("fence")
      .disable("heading")
      .disable("hr")
      .disable("lheading")
      .disable("list")
      .disable("table")
  }

  return renderer
}

function createTextPost(selftext?: string) {
  if (!selftext) return null
  const decoded = decodeRedditText(selftext)
  if (!decoded) return null

  const normalized = normalizeRedditMarkdown(decoded)
  const env: Record<string, unknown> = {}
  REDDIT_REFERENCE_MARKDOWN.parse(normalized, env)

  markdownItRedditSpoiler.env = env
  markdownItRedditSpoiler.openTag = REDDIT_SPOILER_OPEN_TAG
  markdownItRedditSpoiler.closeTag = REDDIT_SPOILER_CLOSE_TAG
  markdownItRedditSpoiler.nestedRenderer = () => createRedditMarkdownRenderer({ nested: true })

  const rendered = createRedditMarkdownRenderer()
    .use(markdownItRedditSpoiler.spoiler)
    .use(markdownItRedditSpoiler.blockquote)
    .render(normalized, env)
    .trim()
  if (!rendered) return null

  const sanitized = sanitizeHtml(rendered, REDDIT_HTML_SANITIZE_OPTIONS).trim()
  return sanitized || null
}

export function renderRedditSelftext(selftext?: string) {
  return createTextPost(selftext)
}

function createExcerpt(text: string | undefined) {
  if (!text) return null
  const post = createTextPost(text)
  if (!post) return null

  const plainText = sanitizeHtml(post, REDDIT_TEXT_SANITIZE_OPTIONS)
    .replace(WHITESPACE_RE, " ")
    .trim()

  if (!plainText) return null
  return truncateText(plainText, REDDIT_EXCERPT_MAX_LENGTH)
}

function extractYouTubeVideo(url?: string | null): {
  videoId: string | null
  videoProvider: PostVideoProvider | null
} {
  if (!url) return { videoId: null, videoProvider: null }

  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch {
    return { videoId: null, videoProvider: null }
  }

  if (!YOUTUBE_HOSTS.has(parsedUrl.hostname)) {
    return { videoId: null, videoProvider: null }
  }

  if (parsedUrl.hostname === "youtu.be") {
    const videoId = parsedUrl.pathname.slice(1) || null
    return { videoId, videoProvider: videoId ? "youtube" : null }
  }

  if (parsedUrl.pathname === "/watch") {
    const videoId = parsedUrl.searchParams.get("v")
    return { videoId, videoProvider: videoId ? "youtube" : null }
  }

  const pathParts = parsedUrl.pathname.split("/").filter(Boolean)
  const embeddedVideoId =
    ["embed", "shorts"].includes(pathParts[0] ?? "") && pathParts[1]
      ? pathParts[1]
      : null

  return {
    videoId: embeddedVideoId,
    videoProvider: embeddedVideoId ? "youtube" : null
  }
}

function extractRedditVideo(post: RedditPost) {
  const redditVideo =
    post.secure_media?.reddit_video ??
    post.media?.reddit_video ??
    post.preview?.reddit_video_preview

  if (!redditVideo) {
    return {
      videoDashUrl: null,
      videoDuration: null,
      videoHeight: null,
      videoHlsUrl: null,
      videoUrl: null,
      videoWidth: null
    }
  }

  return {
    videoDashUrl: decodeRedditUrl(redditVideo.dash_url),
    videoDuration: redditVideo.duration ?? null,
    videoHeight: redditVideo.height ?? null,
    videoHlsUrl: decodeRedditUrl(redditVideo.hls_url),
    videoUrl: decodeRedditUrl(redditVideo.fallback_url),
    videoWidth: redditVideo.width ?? null
  }
}

function shouldPersistRedditPost(item: Post) {
  return (
    item.score >= REDDIT_FEED_MIN_SCORE &&
    item.num_comments >= REDDIT_FEED_MIN_COMMENTS
  )
}

function dedupePosts(items: Post[]) {
  const byId = new Map<string, Post>()

  for (const item of items) {
    byId.set(`${item.source}:${item.source_id}`, item)
  }

  return [...byId.values()].sort((a, b) =>
    a.source_created_at < b.source_created_at ? 1 : -1,
  )
}

function parsePositiveInteger(
  value: string | null,
  fallback: number,
  maxValue?: number,
) {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }

  if (typeof maxValue === "number") {
    return Math.min(parsed, maxValue)
  }

  return parsed
}

function parseBooleanQuery(value: string | null) {
  if (!value) {
    return undefined
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === "true" || normalized === "1") {
    return true
  }

  if (normalized === "false" || normalized === "0") {
    return false
  }

  return undefined
}

function getUserAgent(env: Env) {
  return env.REDDIT_USER_AGENT ?? "postal-worker/1.0 (+https://github.com)"
}
