# Contributing

## Local development

```bash
npm install
npm run dev
npx @biomejs/biome check --write .
npm run typecheck
```

Local dev uses your deployed secrets and bindings, so you'll need to have run `npx wrangler secret put GITHUB_TOKEN` at least once.

## Project structure

```
src/
├── index.ts              — routing and request handling
├── github/
│   ├── client.ts         — Octokit factory
│   ├── queries.ts        — GraphQL queries and pagination
│   └── types.ts          — typed shapes for projects and issues
├── export/
│   └── xlsx.ts           — workbook builder (SheetJS)
└── render/
    ├── template.ts       — HTML template for issue PDFs
    └── pdf.ts            — Browser Rendering integration
scripts/
└── write-build-info.mjs  — generates src/build-info.ts at build time
```

## External integrations

- **GitHub GraphQL API** for fetching projects and issues. Auth via the `GITHUB_TOKEN` secret. Uses the `issue_fields` and `issue_types` GraphQL preview headers.
- **Cloudflare Browser Rendering** for HTML → PDF. Auth via the `BROWSER` binding (no credentials needed; Cloudflare authenticates internally).

## Adding a new field

If you add a project or issue field that GitHub exposes via GraphQL:

1. Add the field to the relevant query in `src/github/queries.ts`
2. Add it to the `Raw*` interface and the corresponding domain type in `src/github/types.ts`
3. Map it in the `to*` function or `fetch*` body
4. Add it to the xlsx columns (`src/export/xlsx.ts`) or the PDF metadata table (`src/render/template.ts`) as appropriate

## Adding a new beta GraphQL feature

GitHub's beta features usually require a header like `GraphQL-Features: feature_name`. Add the feature name to the comma-separated list in `src/github/client.ts`. The header is harmless on requests that don't use the feature.

If you don't know the exact field shape, add a temporary `/_schema` endpoint that runs an introspection query (`__type(name: "TypeName") { ... }`) and inspect the response. Remove it once the real query works.
