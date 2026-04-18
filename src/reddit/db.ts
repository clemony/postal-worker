import type { Post, PostListQuery } from "../types"

interface RedditPostRow {
  author: string | null
  author_is_blocked: number
  domain: string | null
  excerpt: string | null
  fetched_at: string
  flair: string | null
  is_self: number
  is_video: number
  keywords_json: string
  link_flair_text: string | null
  num_comments: number
  over18: number
  permalink: string
  post_hint: string | null
  preview_image_url: string | null
  score: number
  source_created_at: string
  source_id: string
  spoiler: number
  stickied: number
  subreddit: string
  text_html: string | null
  thumbnail_url: string | null
  title: string
  url: string
  video_dash_url: string | null
  video_duration: number | null
  video_height: number | null
  video_hls_url: string | null
  video_id: string | null
  video_provider: string | null
  video_url: string | null
  video_width: number | null
}

interface QueryParts {
  args: unknown[]
  whereSql: string
}

export async function listRedditPosts(
  db: D1Database,
  query: PostListQuery,
) {
  const limit = query.limit ?? 25
  const offset = query.offset ?? 0
  const parts = buildQueryParts(query)

  const itemsStmt = db.prepare(`
    SELECT
      source_id,
      subreddit,
      title,
      author,
      permalink,
      url,
      excerpt,
      text_html,
      flair,
      preview_image_url,
      thumbnail_url,
      video_provider,
      video_id,
      video_url,
      video_hls_url,
      video_dash_url,
      video_width,
      video_height,
      video_duration,
      score,
      num_comments,
      source_created_at,
      fetched_at,
      author_is_blocked,
      domain,
      is_self,
      is_video,
      link_flair_text,
      over18,
      post_hint,
      spoiler,
      stickied,
      keywords_json
    FROM reddit_posts
    ${parts.whereSql}
    ORDER BY source_created_at DESC
    LIMIT ? OFFSET ?
  `).bind(...parts.args, limit, offset)

  const totalStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM reddit_posts
    ${parts.whereSql}
  `).bind(...parts.args)

  const [itemsResult, totalResult] = await Promise.all([
    itemsStmt.run<RedditPostRow>(),
    totalStmt.first<{ total: number }>(),
  ])

  return {
    items: (itemsResult.results ?? []).map(mapRowToPost),
    total: totalResult?.total ?? 0,
  }
}

export async function upsertRedditPosts(db: D1Database, items: Post[]) {
  for (const item of items) {
    await db.prepare(`
      INSERT INTO reddit_posts (
        source_id,
        subreddit,
        title,
        author,
        permalink,
        url,
        excerpt,
        text_html,
        flair,
        preview_image_url,
        thumbnail_url,
        video_provider,
        video_id,
        video_url,
        video_hls_url,
        video_dash_url,
        video_width,
        video_height,
        video_duration,
        score,
        num_comments,
        source_created_at,
        fetched_at,
        author_is_blocked,
        domain,
        is_self,
        is_video,
        link_flair_text,
        over18,
        post_hint,
        spoiler,
        stickied,
        keywords_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        subreddit = excluded.subreddit,
        title = excluded.title,
        author = excluded.author,
        permalink = excluded.permalink,
        url = excluded.url,
        excerpt = excluded.excerpt,
        text_html = excluded.text_html,
        flair = excluded.flair,
        preview_image_url = excluded.preview_image_url,
        thumbnail_url = excluded.thumbnail_url,
        video_provider = excluded.video_provider,
        video_id = excluded.video_id,
        video_url = excluded.video_url,
        video_hls_url = excluded.video_hls_url,
        video_dash_url = excluded.video_dash_url,
        video_width = excluded.video_width,
        video_height = excluded.video_height,
        video_duration = excluded.video_duration,
        score = excluded.score,
        num_comments = excluded.num_comments,
        source_created_at = excluded.source_created_at,
        fetched_at = excluded.fetched_at,
        author_is_blocked = excluded.author_is_blocked,
        domain = excluded.domain,
        is_self = excluded.is_self,
        is_video = excluded.is_video,
        link_flair_text = excluded.link_flair_text,
        over18 = excluded.over18,
        post_hint = excluded.post_hint,
        spoiler = excluded.spoiler,
        stickied = excluded.stickied,
        keywords_json = excluded.keywords_json
    `).bind(
      item.source_id,
      item.subreddit,
      item.title,
      item.author,
      item.permalink,
      item.url,
      item.excerpt,
      item.text,
      item.flair,
      item.preview_image_url,
      item.thumbnail_url,
      item.video_provider ?? null,
      item.video_id ?? null,
      item.video_url ?? null,
      item.video_hls_url ?? null,
      item.video_dash_url ?? null,
      item.video_width ?? null,
      item.video_height ?? null,
      item.video_duration ?? null,
      item.score,
      item.num_comments,
      item.source_created_at,
      item.fetched_at,
      toSqliteBool(item.metadata.authorIsBlocked),
      item.metadata.domain ?? null,
      toSqliteBool(item.metadata.isSelf),
      toSqliteBool(item.metadata.isVideo),
      item.metadata.linkFlairText ?? null,
      toSqliteBool(item.metadata.over18),
      item.metadata.postHint ?? null,
      toSqliteBool(item.metadata.spoiler),
      toSqliteBool(item.metadata.stickied),
      JSON.stringify(item.keywords),
    ).run()

    await db.prepare(`
      DELETE FROM reddit_post_keywords
      WHERE source_id = ?
    `).bind(item.source_id).run()

    for (const keyword of item.keywords) {
      await db.prepare(`
        INSERT INTO reddit_post_keywords (source_id, keyword)
        VALUES (?, ?)
        ON CONFLICT(source_id, keyword) DO NOTHING
      `).bind(item.source_id, keyword).run()
    }
  }
}

function buildQueryParts(query: PostListQuery): QueryParts {
  const args: unknown[] = []
  const clauses: string[] = []
  const subreddit = query.subreddit ?? "leagueoflegends"

  clauses.push("subreddit = ?")
  args.push(subreddit)

  if (query.flair) {
    clauses.push("flair = ?")
    args.push(query.flair)
  }

  if (typeof query.spoiler === "boolean") {
    clauses.push("spoiler = ?")
    args.push(toSqliteBool(query.spoiler))
  }

  const keywordFilters = [
    ...(query.keyword ? [query.keyword] : []),
    ...(query.keywords ?? []),
  ]

  if (keywordFilters.length > 0) {
    const placeholders = keywordFilters.map(() => "?").join(", ")
    clauses.push(`
      EXISTS (
        SELECT 1
        FROM reddit_post_keywords
        WHERE reddit_post_keywords.source_id = reddit_posts.source_id
          AND reddit_post_keywords.keyword IN (${placeholders})
      )
    `)
    args.push(...keywordFilters)
  }

  return {
    args,
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
  }
}

function mapRowToPost(row: RedditPostRow): Post {
  return {
    author: row.author,
    excerpt: row.excerpt,
    text: row.text_html,
    fetched_at: row.fetched_at,
    flair: row.flair,
    keywords: parseKeywords(row.keywords_json),
    metadata: {
      authorIsBlocked: fromSqliteBool(row.author_is_blocked),
      domain: row.domain,
      isSelf: fromSqliteBool(row.is_self),
      isVideo: fromSqliteBool(row.is_video),
      linkFlairText: row.link_flair_text,
      over18: fromSqliteBool(row.over18),
      postHint: row.post_hint,
      spoiler: fromSqliteBool(row.spoiler),
      stickied: fromSqliteBool(row.stickied),
    },
    num_comments: row.num_comments,
    permalink: row.permalink,
    preview_image_url: row.preview_image_url,
    score: row.score,
    source: "reddit",
    source_created_at: row.source_created_at,
    source_id: row.source_id,
    subreddit: row.subreddit,
    thumbnail_url: row.thumbnail_url,
    title: row.title,
    url: row.url,
    video_dash_url: row.video_dash_url,
    video_duration: row.video_duration,
    video_height: row.video_height,
    video_hls_url: row.video_hls_url,
    video_id: row.video_id,
    video_provider: (row.video_provider as Post["video_provider"]) ?? null,
    video_url: row.video_url,
    video_width: row.video_width,
  }
}

function parseKeywords(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  }
  catch {
    return []
  }
}

function fromSqliteBool(value: number) {
  return value === 1
}

function toSqliteBool(value?: boolean) {
  return value ? 1 : 0
}
