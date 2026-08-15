// Allow importing .sql migration files as raw text strings. The actual bundling
// is handled by the wrangler `[[rules]] type = "Text"` config in wrangler.toml.
declare module "*.sql" {
  const content: string;
  export default content;
}
