import { marked } from "marked";

import type { IssueSnapshot } from "../github/types.ts";

export interface IssueHtml {
  /** Full <html> document for the PDF body. */
  mainHtml: string;
  /** Small HTML fragment shown as the repeating page header. */
  headerHtml: string;
}

/** Escape a string for safe insertion into HTML text content or attributes. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format an ISO timestamp as "2026-04-22 14:30 UTC" for display. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const date = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 16);
  return `${date} ${time} UTC`;
}

/** Render Markdown to HTML synchronously. marked.parse() is sync by default. */
function md(source: string): string {
  return marked.parse(source, { async: false, gfm: true }) as string;
}

/** Render a single comment block. */
function commentBlock(c: IssueSnapshot["comments"][number]): string {
  const author = escapeHtml(c.author ?? "(deleted user)");
  const ts = escapeHtml(formatTimestamp(c.createdAt));
  const body = md(c.bodyMarkdown);
  return `
		<section class="comment">
			<header class="comment-meta">
				<strong>${author}</strong>
				<span class="ts">${ts}</span>
			</header>
			<div class="comment-body">${body}</div>
		</section>
	`;
}

/** Render the metadata table that sits above the issue body. */
function metadataTable(snapshot: IssueSnapshot): string {
  const rows: Array<[string, string]> = [
    ["State", snapshot.state],
    ["Author", snapshot.author ?? "(deleted user)"],
    ["Created", formatTimestamp(snapshot.createdAt)],
    ["Updated", formatTimestamp(snapshot.updatedAt)],
  ];

  if (snapshot.closedAt)
    rows.push(["Closed", formatTimestamp(snapshot.closedAt)]);
  if (snapshot.assignees.length > 0)
    rows.push(["Assignees", snapshot.assignees.join(", ")]);
  if (snapshot.labels.length > 0)
    rows.push(["Labels", snapshot.labels.join(", ")]);
  if (snapshot.milestone) rows.push(["Milestone", snapshot.milestone]);
  if (snapshot.issueType) rows.push(["Type", snapshot.issueType]);
  if (snapshot.parentIssue) rows.push(["Parent", snapshot.parentIssue]);

  // Issue-level custom fields appear after the built-ins, before the URL.
  for (const [name, value] of Object.entries(snapshot.fields)) {
    if (value !== null && value !== "") rows.push([name, String(value)]);
  }

  rows.push(["URL", snapshot.url]);

  const cells = rows
    .map(
      ([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  return `<table class="metadata">${cells}</table>`;
}

const STYLES = `
	body {
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
		font-size: 11pt;
		line-height: 1.5;
		color: #1f2328;
		margin: 0;
	}
	h1.issue-title {
		font-size: 20pt;
		margin: 0 0 0.25em 0;
		font-weight: 600;
	}
	.issue-number {
		color: #59636e;
		font-weight: 400;
	}
	table.metadata {
		border-collapse: collapse;
		margin: 1.5em 0;
		font-size: 10pt;
		width: 100%;
	}
	table.metadata th, table.metadata td {
		text-align: left;
		padding: 0.35em 0.75em;
		border: 1px solid #d1d9e0;
		vertical-align: top;
	}
	table.metadata th {
		background: #f6f8fa;
		font-weight: 600;
		width: 8em;
		white-space: nowrap;
	}
	.body, .comment-body {
		font-size: 11pt;
	}
	.body p, .comment-body p { margin: 0.5em 0; }
	.body pre, .comment-body pre {
		background: #f6f8fa;
		padding: 0.75em;
		border-radius: 4px;
		overflow-x: auto;
		font-size: 9.5pt;
	}
	.body code, .comment-body code {
		background: #f6f8fa;
		padding: 0.1em 0.3em;
		border-radius: 3px;
		font-size: 9.5pt;
	}
	.body pre code, .comment-body pre code {
		background: none;
		padding: 0;
	}
	.body blockquote, .comment-body blockquote {
		border-left: 3px solid #d1d9e0;
		margin: 0.5em 0;
		padding-left: 1em;
		color: #59636e;
	}
	hr.body-divider {
		border: none;
		border-top: 1px solid #d1d9e0;
		margin: 2em 0 1.5em 0;
	}
	h2.comments-heading {
		font-size: 13pt;
		margin: 1.5em 0 0.75em 0;
		font-weight: 600;
	}
	section.comment {
		border: 1px solid #d1d9e0;
		border-radius: 4px;
		margin: 0.75em 0;
		page-break-inside: avoid;
	}
	.comment-meta {
		background: #f6f8fa;
		padding: 0.4em 0.75em;
		border-bottom: 1px solid #d1d9e0;
		font-size: 9.5pt;
	}
	.comment-meta .ts {
		color: #59636e;
		margin-left: 0.5em;
	}
	.comment-body {
		padding: 0.75em;
	}
`;

const HEADER_STYLES = `
	font-size: 8pt;
	font-family: -apple-system, BlinkMacSystemFont, sans-serif;
	color: #59636e;
	width: 100%;
	padding: 0 0.5cm;
	display: flex;
	justify-content: space-between;
	-webkit-print-color-adjust: exact;
`;

/**
 * Build the HTML pieces needed to generate a PDF for the given issue.
 *
 * Returns both the main document body and a small fragment to use as the
 * repeating page header. The PDF builder wires these together.
 */
export function buildIssueHtml(snapshot: IssueSnapshot): IssueHtml {
  const title = escapeHtml(snapshot.title);
  const repoSlug = escapeHtml(`${snapshot.owner}/${snapshot.repo}`);
  const issueNum = `#${snapshot.number}`;

  const body = snapshot.bodyMarkdown.trim()
    ? md(snapshot.bodyMarkdown)
    : "<p><em>(no description)</em></p>";

  const commentsBlock =
    snapshot.comments.length === 0
      ? ""
      : `
				<h2 class="comments-heading">Comments (${snapshot.comments.length})</h2>
				${snapshot.comments.map(commentBlock).join("")}
			`;

  const mainHtml = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${repoSlug} ${issueNum}: ${title}</title>
	<style>${STYLES}</style>
</head>
<body>
	<h1 class="issue-title">${title} <span class="issue-number">${issueNum}</span></h1>
	${metadataTable(snapshot)}
	<div class="body">${body}</div>
	<hr class="body-divider">
	${commentsBlock}
</body>
</html>`;

  // Cloudflare's headerTemplate gets its own CSS scope and supports a few
  // special spans like .pageNumber and .totalPages that the renderer fills in.
  const headerHtml = `
		<div style="${HEADER_STYLES}">
			<span>${repoSlug} ${issueNum}</span>
			<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
		</div>
	`;

  return { mainHtml, headerHtml };
}
