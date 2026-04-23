/**
 * github-snapshot Worker entry point.
 *
 * Routes:
 *   GET /                 — landing page with two URL inputs
 *   GET /export?url=...   — project URL → xlsx
 *   GET /pdf?url=...      — issue URL → pdf
 *   GET /_debug?url=...   — TEMP: dump the raw fetch as JSON
 */

import { buildWorkbook, workbookFilename } from "./export/xlsx.js";
import { makeClient } from "./github/client.js";
import { fetchIssue, fetchProject } from "./github/queries.js";
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

function landingPage(): Response {
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
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
  const snapshot = await fetchProject(
    client,
    ref.ownerType,
    ref.owner,
    ref.number,
  );
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
  const snapshot = await fetchIssue(client, ref.owner, ref.repo, ref.number);
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

/** TEMP: dump the raw fetch result as JSON. Remove once xlsx + pdf work. */
async function handleDebug(url: URL, env: Env): Promise<Response> {
  const target = url.searchParams.get("url");
  if (!target) return badRequest("missing ?url= parameter");

  const ref = parseGitHubUrl(target);
  if (!ref) return badRequest("unrecognized GitHub URL shape");

  const client = makeClient(env.GITHUB_TOKEN);

  try {
    const result =
      ref.kind === "project"
        ? await fetchProject(client, ref.ownerType, ref.owner, ref.number)
        : await fetchIssue(client, ref.owner, ref.repo, ref.number);

    if (!result) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(result);
  } catch (err) {
    return jsonResponse(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/":
        return landingPage();
      case "/export":
        return handleExport(url, env);
      case "/pdf":
        return handlePdf(url, env);
      case "/_debug":
        return handleDebug(url, env);
      default:
        return new Response("Not found\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
  },
} satisfies ExportedHandler<Env>;
