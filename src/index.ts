/**
 * github-snapshot Worker entry point.
 *
 * Routes:
 *   GET /                 — landing page with two URL inputs
 *   GET /export?url=...   — project URL → xlsx
 *   GET /pdf?url=...      — issue URL → pdf
 */

import Mustache from "mustache";
import { BUILD_INFO } from "./build-info.ts";
import { makeClient } from "./github/client.ts";
import { fetchIssue, fetchProject } from "./github/queries.ts";
import type { IssueSnapshot, ProjectSnapshot } from "./github/types.ts";
import landingStyles from "./landing.css";
import landingTemplate from "./landing.html";
import { buildPdf, pdfFilename } from "./output/pdf/index.ts";
import { buildWorkbook, workbookFilename } from "./output/xlsx/index.ts";

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
  const { commit, branch } = BUILD_INFO;
  const versionId = env.CF_VERSION_METADATA.id;
  const versionTimestamp = env.CF_VERSION_METADATA.timestamp;

  const html = Mustache.render(landingTemplate, {
    styles: landingStyles,
    commit,
    branch,
    versionId,
    versionTimestamp,
  });

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

  const bytes = await buildPdf(snapshot, env.BROWSER);
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
      default:
        return new Response("Not found\n", {
          status: 404,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
    }
  },
} satisfies ExportedHandler<Env>;
