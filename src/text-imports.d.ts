/**
 * Wrangler is configured (via "rules" in wrangler.jsonc) to bundle .css and
 * .html files as text strings. These declarations tell TypeScript what those
 * imports look like at type-check time.
 */

declare module "*.css" {
  const content: string;
  export default content;
}

declare module "*.html" {
  const content: string;
  export default content;
}
