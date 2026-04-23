import { marked } from "marked";

import type { IssueSnapshot } from "../github/types.ts";
import pdfStyles from "./pdf.css";

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
	<style>${pdfStyles}</style>
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
