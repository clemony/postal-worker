declare module "markdown-it-reddit-spoiler" {
  import type MarkdownIt from "markdown-it"

  type MarkdownItPlugin = (md: MarkdownIt) => void

  interface RedditSpoilerPlugin {
    env: Record<string, unknown>
    nestedRenderer: () => MarkdownIt
    openTag: string
    closeTag: string
    spoiler: MarkdownItPlugin
    blockquote: MarkdownItPlugin
  }

  const plugin: RedditSpoilerPlugin
  export default plugin
}
