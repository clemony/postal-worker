# D1 Reddit Plan

This file sketches the recommended move from KV-only storage to D1-backed Reddit post storage in `postal-worker`.
The goal is to support larger result sets, offset pagination, and database-backed filtering while keeping KV as a fast cache layer for the main app homepage feed.

## Recommendation

Use D1 as the source of truth for Reddit posts.
Keep KV for one small, precomputed "hot posts" response that serves the main page quickly.

This split fits the product shape well:

- D1 handles storage, filtering, sorting, and pagination.
- KV handles the one feed shape that is read most often and changes on a refresh cadence rather than per request.

## Why Move Reddit Posts To D1

KV is working as a cache, but it is the wrong long-term shape for queryable content.
Right now the worker reads a single JSON payload from KV, filters it in memory, and slices it after filtering.

That works for a small curated feed, but it gets awkward when the app needs:

- larger result sets
- offset pagination
- flair filters
- spoiler and NSFW filters
- score and comment count filters
- future query expansion without reading the whole dataset on every request

D1 is a better fit once the feed behaves more like a searchable collection than a fixed blob.

## Minimal Scope

This plan keeps the scope intentionally small.
It does not redesign the patch or PBE metadata path.

### D1 scope

- store normalized Reddit posts in `reddit_posts`
- store derived keywords in `reddit_post_keywords`
- query D1 for paginated and filtered Reddit feed requests

### KV scope

- keep a cached "hot posts" payload for the main page
- keep `meta:pbe:latest`
- keep `meta:patch:latest`

### KV writes to remove

If patch and PBE only need latest data, remove per-patch historical KV writes such as:

- `meta:patch:${patch.patch}`

That keeps KV focused on current cached reads instead of history.

## Proposed Schema

See [0001_reddit_posts.sql](../migrations/0001_reddit_posts.sql).

### `reddit_posts`

This table stores the normalized post payload that the app already expects.
Most current `Post` fields map directly to columns, and the common metadata filters are flattened into queryable scalar columns.

Notable design choices:

- `source_id` is the primary key because the source is currently Reddit only.
- `keywords_json` is kept for easy row reconstruction.
- common filter fields such as `spoiler`, `over18`, `flair`, `score`, and `num_comments` are stored as top-level columns for cheap filtering.
- booleans are stored as `INTEGER` values because this is SQLite/D1.

### `reddit_post_keywords`

This table stores one row per derived keyword.
It keeps keyword filtering simple without introducing FTS on day one.

It is enough for the current keyword model:

- exact keyword filters
- stable derived tags from flair, subreddit, and title heuristics

If full-text search becomes important later, add an FTS5 table as a separate step.

## Read Strategy

### Homepage hot feed

Serve the default main-page feed from KV.

Recommended key:

- `reddit:leagueoflegends:hot:v1`

Recommended shape:

- `{ generatedAt, items, total }`

Recommended size:

- cache the first 12 to 25 items depending on the app layout

### Queryable feed

For any request that uses pagination or filters, query D1 directly.

Examples:

- `GET /api/feed/reddit?limit=50&offset=0`
- `GET /api/feed/reddit?keywords=patch`
- `GET /api/feed/reddit?subreddit=leagueoflegends&limit=100&offset=100`
- `GET /api/feed/reddit?keyword=skins`

The worker should only fall back to KV for the one default hot feed path.

## Write Strategy

On refresh:

1. Fetch Reddit listings.
2. Normalize and dedupe posts.
3. Upsert rows into `reddit_posts`.
4. Replace keyword rows in `reddit_post_keywords` for touched posts.
5. Query the hot feed from D1.
6. Write the hot feed response to KV.

This keeps D1 authoritative and KV disposable.

## Upsert Shape

Recommended behavior for each normalized post:

- `INSERT ... ON CONFLICT(source_id) DO UPDATE`
- always update mutable fields such as score, comments, preview URLs, and fetched timestamp
- preserve the latest normalized representation as the canonical row

Recommended keyword behavior:

- delete keyword rows for touched `source_id`
- insert the new keyword set

This is simple and safe at the expected scale.

## Suggested Query Model

Default sort:

- `source_created_at DESC`

Optional alternate sort later:

- `score DESC, source_created_at DESC`
- `num_comments DESC, source_created_at DESC`

Recommended first-pass filters:

- `subreddit`
- `keyword` / `keywords`
- `flair`
- `spoiler`
- `over18`

Recommended first-pass pagination:

- `LIMIT ? OFFSET ?`

## Migration Order

1. Add D1 binding to `wrangler.jsonc`.
2. Create the database and run `0001_reddit_posts.sql`.
3. Add D1 helper functions for upsert and query paths.
4. Move Reddit refresh writes from KV to D1.
5. Keep KV write for the hot homepage feed only.
6. Switch `GET /api/feed/reddit` to:
   - serve KV for the default hot path
   - query D1 for everything else
7. Remove now-unused KV-only Reddit storage code.

## Suggested Binding

Use a dedicated binding name such as:

- `DB`

And keep the existing KV binding:

- `POSTS`

That yields a clean split:

- `env.DB` for authoritative Reddit storage
- `env.POSTS` for cached feed and latest metadata blobs

## Notes

- This is intentionally a minimal relational model, not a general content platform schema.
- It optimizes for your current app shape first.
- If the post feed later expands beyond Reddit, the next step would be to generalize `reddit_posts` into a broader `posts` table with a `source` column.
