/**
 * Wrangler is configured (via "rules" in wrangler.tsonc) to bundle .css files
 * as text strings. This declaration tells TypeScript what those imports look
 * like at type-check time.
 */
declare module "*.css" {
  const content: string;
  export default content;
}
