/**
 * Strip the most common Markdown syntax so tokenisation works on prose,
 * not on `##`, `**`, `[]()`, etc.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/!\[.*?\]\(.*?\)/g, '')        // images
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → label only
    .replace(/^#{1,6}\s+/gm, '')             // headings
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // bold/italic
    .replace(/_{1,2}([^_]+)_{1,2}/g, '$1')   // underscores
    .replace(/`{1,3}[^`]*`{1,3}/g, '')       // inline code / code blocks
    .replace(/^[-*+]\s+/gm, '')              // list bullets
    .replace(/^\d+\.\s+/gm, '')              // numbered list
    .replace(/^>\s+/gm, '')                  // blockquotes
    .replace(/\n{3,}/g, '\n\n')              // collapse extra blank lines
    .trim()
}
