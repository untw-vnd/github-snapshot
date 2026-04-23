# Deployment

This Worker is designed to be forked and deployed to your own Cloudflare account. Each deployment is independent — credentials and access live on your account, not anywhere shared.

## Prerequisites

- A Cloudflare account on the Workers Paid plan (the free plan works for a while but Browser Rendering has tighter limits)
- Node.js 20 or newer
- A GitHub Personal Access Token with the right scopes (see below)
- Optional: a Cloudflare Zero Trust subscription if you want SSO in front of the Worker

## Setup

1. Fork this repo to your GitHub account.
2. Clone your fork and install dependencies:
   ```bash
   git clone https://github.com/YOUR_NAME/github-snapshot.git
   cd github-snapshot
   npm install
   ```
3. Authenticate Wrangler against your Cloudflare account:
   ```bash
   npx wrangler login
   ```
   In a Codespace or other headless environment, use a Cloudflare API token instead. Create one at https://dash.cloudflare.com/profile/api-tokens with the "Edit Cloudflare Workers" template, then export it:
   ```bash
   export CLOUDFLARE_API_TOKEN=your_token_here
   ```
4. Set your GitHub PAT as a Worker secret (see "GitHub PAT scopes" below):
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   ```
5. Deploy:
   ```bash
   npm run deploy
   ```
   Wrangler will print the URL of your deployed Worker, something like `github-snapshot.YOUR-SUBDOMAIN.workers.dev`.

## GitHub PAT scopes

Use a fine-grained PAT, scoped to the org (or user) whose projects you want to export.

- **Repository access:** "All repositories" or "Only select repositories" — must include every repo whose issues appear on any project you'll export. For a public-data-only deployment (like the demo), use "All public repositories" instead.
- **Repository permissions:**
  - Issues: Read
  - Pull requests: Read (only if any project items are PRs; harmless to include)
  - Metadata: Read (required by GitHub for any fine-grained PAT)
- **Organization permissions:**
  - Projects: Read
  - Issue fields: Read (only needed if you use the issue-fields beta — without this, custom fields on issues won't appear in the PDF)

Classic PATs also work with `repo` and `read:project` scopes, but fine-grained is preferred.

## Optional: Cloudflare Zero Trust

If you want to put SSO in front of the Worker so only you (or your team) can access it:

1. In the Cloudflare dashboard, go to **Zero Trust → Access → Applications**.
2. Add a new self-hosted application with your Worker's domain as the URL.
3. Configure the identity provider (GitHub SSO works well here) and policies (e.g. "only members of a specific GitHub org").

The Worker code itself doesn't need to know about Zero Trust — it just trusts that whoever reaches it is authorized.

## Continuous deployment

Connect the repo to Cloudflare Workers Builds for automatic deploys on every push.

In the Workers dashboard for your deployed Worker, go to **Settings → Build → Connect repository**. Set:

- **Build command:** `npm run build`
- **Deploy command:** `npx wrangler deploy` (the default)

Workers Builds injects `WORKERS_CI_COMMIT_SHA` and `WORKERS_CI_BRANCH` automatically; the build script reads those to bake commit info into the deployed bundle.

## Updating from upstream

You can pull updates from upstream through GitHub's "Sync fork" button on your fork's main page, or from the command line:

```bash
git remote add upstream https://github.com/shenanigansd/github-snapshot.git
git fetch upstream
git merge upstream/main
```