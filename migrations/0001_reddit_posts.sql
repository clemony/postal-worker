PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reddit_posts (
  source_id TEXT PRIMARY KEY,
  subreddit TEXT NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  permalink TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  excerpt TEXT,
  text_html TEXT,
  flair TEXT,
  preview_image_url TEXT,
  thumbnail_url TEXT,
  video_provider TEXT,
  video_id TEXT,
  video_url TEXT,
  video_hls_url TEXT,
  video_dash_url TEXT,
  video_width INTEGER,
  video_height INTEGER,
  video_duration INTEGER,
  score INTEGER NOT NULL DEFAULT 0,
  num_comments INTEGER NOT NULL DEFAULT 0,
  source_created_at TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  author_is_blocked INTEGER NOT NULL DEFAULT 0,
  domain TEXT,
  is_self INTEGER NOT NULL DEFAULT 0,
  is_video INTEGER NOT NULL DEFAULT 0,
  link_flair_text TEXT,
  over18 INTEGER NOT NULL DEFAULT 0,
  post_hint TEXT,
  spoiler INTEGER NOT NULL DEFAULT 0,
  stickied INTEGER NOT NULL DEFAULT 0,
  keywords_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS reddit_post_keywords (
  source_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  PRIMARY KEY (source_id, keyword),
  FOREIGN KEY (source_id) REFERENCES reddit_posts(source_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_created
  ON reddit_posts (subreddit, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_score_created
  ON reddit_posts (subreddit, score DESC, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_comments_created
  ON reddit_posts (subreddit, num_comments DESC, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_flair
  ON reddit_posts (subreddit, flair);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_spoiler
  ON reddit_posts (subreddit, spoiler, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_posts_subreddit_over18
  ON reddit_posts (subreddit, over18, source_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reddit_post_keywords_keyword
  ON reddit_post_keywords (keyword, source_id);
