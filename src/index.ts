/**
 * github-snapshot Worker entry point.
 *
 * Routes:
 *   GET /                 — landing page with two URL inputs
 *   GET /export?url=...   — project URL → xlsx
 *   GET /pdf?url=...      — issue URL → pdf
 */

import { BUILD_INFO } from "./build-info.js";
import { buildWorkbook, workbookFilename } from "./export/xlsx.js";
import { makeClient } from "./github/client.js";
import { fetchIssue, fetchProject } from "./github/queries.js";
import type { IssueSnapshot, ProjectSnapshot } from "./github/types.js";
import { pdfFilename, renderPdf } from "./render/pdf.js";

type ProjectRef = {
  kind: "project";
  ownerType: "orgs" | "users";
  owner: string;
  number: number;
};

type IssueRef = {
  kind: "issue";
  owner: string;
  repo: string;
  number: number;
};

type GitHubRef = ProjectRef | IssueRef;

/**
 * Parse a GitHub URL into a structured reference, or null if it doesn't match
 * a shape we handle.
 */
function parseGitHubUrl(input: string): GitHubRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }

  if (url.hostname !== "github.com") return null;

  const segments = url.pathname.replace(/^\/|\/$/g, "").split("/");

  if (segments.length === 4 && segments[2] === "projects") {
    const [ownerType, owner, , numberStr] = segments;
    if (ownerType !== "orgs" && ownerType !== "users") return null;
    const number = Number(numberStr);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind: "project", ownerType, owner: owner!, number };
  }

  if (segments.length === 4 && segments[2] === "issues") {
    const [owner, repo, , numberStr] = segments;
    const number = Number(numberStr);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { kind: "issue", owner: owner!, repo: repo!, number };
  }

  return null;
}

function landingPage(env: Env): Response {
  const versionId = env.CF_VERSION_METADATA.id;
  const versionTag = env.CF_VERSION_METADATA.tag || "(no tag)";
  const { commit, branch } = BUILD_INFO;

  const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>github-snapshot</title>
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<style>
		body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; }
		h1 { margin-bottom: 0.25rem; }
		p.tagline { color: #666; margin-top: 0; }
		form { margin: 2rem 0; }
		label { display: block; font-weight: 600; margin-bottom: 0.5rem; }
		input[type=url] { width: 100%; padding: 0.5rem; font-size: 1rem; box-sizing: border-box; }
		button { margin-top: 0.5rem; padding: 0.5rem 1rem; font-size: 1rem; cursor: pointer; }
		footer { margin-top: 4rem; padding-top: 1rem; border-top: 1px solid #eee; color: #888; font-size: 0.85rem; font-family: ui-monospace, monospace; }
		footer dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 1rem; margin: 0; }
		footer dt { font-weight: 600; }
		footer dd { margin: 0; word-break: break-all; }
	</style>
</head>
<body>
	<h1>github-snapshot</h1>
	<p class="tagline">Paste a GitHub Project or Issue URL.</p>

	<form action="/export" method="get">
		<label for="project-url">Project URL → Excel</label>
		<input type="url" id="project-url" name="url" required
			placeholder="https://github.com/orgs/acme/projects/3">
		<button type="submit">Export</button>
	</form>

	<form action="/pdf" method="get">
		<label for="issue-url">Issue URL → PDF</label>
		<input type="url" id="issue-url" name="url" required
			placeholder="https://github.com/acme/widgets/issues/42">
		<button type="submit">Render</button>
	</form>

	<footer>
		<dl>
			<dt>Commit</dt><dd>${escapeHtml(commit)} (${escapeHtml(branch)})</dd>
			<dt>Version</dt><dd>${escapeHtml(versionId)}</dd>
			<dt>Tag</dt><dd>${escapeHtml(versionTag)}</dd>
		</dl>
	</footer>
</body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function badRequest(reason: string): Response {
  return new Response(`Bad request: ${reason}\n`, {
    status: 400,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** TEMP: introspect the IssueFieldValue union to figure out its actual shape. */
async function handleSchema(env: Env): Promise<Response> {
  const client = makeClient(env.GITHUB_TOKEN);
  const data = await client(
    `query {
			__type(name: "IssueFieldValue") {
				name
				kind
				possibleTypes {
					name
					fields {
						name
						type {
							name
							kind
							ofType {
								name
								kind
							}
						}
					}
				}
			}
		}`,
    {},
  );
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** Minimal HTML escape for safe substitution into the landing page footer. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Map an exception thrown during a GitHub fetch to a user-facing Response.
 *
 * GitHub's GraphQL API returns "Could not resolve to a..." errors for both
 * genuinely missing resources and resources the token can't see. We treat
 * both as 404 with a message that acknowledges the ambiguity, rather than
 * leaking the raw error or pretending we can tell them apart.
 */
function fetchErrorResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Could not resolve")) {
    return new Response(
      "Not found, or not accessible with this Worker's GitHub token.\n",
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  console.error("GitHub fetch failed:", message);
  return new Response("Failed to fetch from GitHub. See Worker logs.\n", {
    status: 502,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

async function handleExport(url: URL, env: Env): Promise<Response> {
  const target = url.searchParams.get("url");
  if (!target) return badRequest("missing ?url= parameter");

  const ref = parseGitHubUrl(target);
  if (ref?.kind !== "project") {
    return badRequest(
      "URL must be a GitHub Project (e.g. https://github.com/orgs/acme/projects/3)",
    );
  }

  const client = makeClient(env.GITHUB_TOKEN);

  let snapshot: ProjectSnapshot | null;
  try {
    snapshot = await fetchProject(client, ref.ownerType, ref.owner, ref.number);
  } catch (err) {
    return fetchErrorResponse(err);
  }

  if (!snapshot) {
    return new Response("Project not found or not accessible.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const bytes = buildWorkbook(snapshot);
  const filename = workbookFilename(snapshot);

  return new Response(bytes, {
    headers: {
      "content-type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

async function handlePdf(url: URL, env: Env): Promise<Response> {
  const target = url.searchParams.get("url");
  if (!target) return badRequest("missing ?url= parameter");

  const ref = parseGitHubUrl(target);
  if (ref?.kind !== "issue") {
    return badRequest(
      "URL must be a GitHub Issue (e.g. https://github.com/acme/widgets/issues/42)",
    );
  }

  const client = makeClient(env.GITHUB_TOKEN);

  let snapshot: IssueSnapshot | null;
  try {
    snapshot = await fetchIssue(client, ref.owner, ref.repo, ref.number);
  } catch (err) {
    return fetchErrorResponse(err);
  }

  if (!snapshot) {
    return new Response("Issue not found or not accessible.\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const bytes = await renderPdf(snapshot, env.BROWSER);
  const filename = pdfFilename(snapshot);

  return new Response(bytes, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return landingPage(env);
      case "/export":
        return handleExport(url, env);
      case "/pdf":
        return handlePdf(url, env);
      case "/_schema":
        return handleSchema(env);
      default:
        return new Response("Not found\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
  },
} satisfies ExportedHandler<Env>;
