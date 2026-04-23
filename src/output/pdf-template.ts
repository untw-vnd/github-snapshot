import { marked } from "marked";
import Mustache from "mustache";

import type { IssueSnapshot } from "../github/types.js";
import pdfStyles from "./pdf.css";
import pdfTemplate from "./pdf-template.html";

export interface IssueHtml {
  /** Full <html> document for the PDF body. */
  mainHtml: string;
  /** Small HTML fragment shown as the repeating page header. */
  headerHtml: string;
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

/** Build the {label, value} rows for the metadata table. */
function metadataRows(
  snapshot: IssueSnapshot,
): Array<{ label: string; value: string }> {
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

  for (const [name, value] of Object.entries(snapshot.fields)) {
    if (value !== null && value !== "") rows.push([name, String(value)]);
  }

  rows.push(["URL", snapshot.url]);

  return rows.map(([label, value]) => ({ label, value }));
}

/** Inline CSS string for the repeating PDF page header. Not a stylesheet
 * because Cloudflare's PDF API runs the header in its own CSS scope. */
const HEADER_INLINE_CSS =
  "font-size: 8pt; font-family: -apple-system, BlinkMacSystemFont, sans-serif; " +
  "color: #59636e; width: 100%; padding: 0 0.5cm; display: flex; " +
  "justify-content: space-between; -webkit-print-color-adjust: exact;";

/**
 * Build the HTML pieces needed to generate a PDF for the given issue.
 *
 * Returns both the main document body and a small fragment to use as the
 * repeating page header. The PDF builder wires these together.
 */
export function buildIssueHtml(snapshot: IssueSnapshot): IssueHtml {
  const repoSlug = `${snapshot.owner}/${snapshot.repo}`;

  const view = {
    styleTag: `<style>${pdfStyles}</style>`,
    repoSlug,
    number: snapshot.number,
    title: snapshot.title,
    metadataRows: metadataRows(snapshot),
    bodyHtml: snapshot.bodyMarkdown.trim()
      ? md(snapshot.bodyMarkdown)
      : "<p><em>(no description)</em></p>",
    hasComments: snapshot.comments.length > 0,
    commentCount: snapshot.comments.length,
    comments: snapshot.comments.map((c) => ({
      author: c.author ?? "(deleted user)",
      timestamp: formatTimestamp(c.createdAt),
      bodyHtml: md(c.bodyMarkdown),
    })),
  };

  const mainHtml = Mustache.render(pdfTemplate, view);

  // The header template uses Cloudflare's special spans (.pageNumber,
  // .totalPages) which the renderer fills in at PDF generation time.
  const headerHtml = `
		<div style="${HEADER_INLINE_CSS}">
			<span>${Mustache.escape(repoSlug)} #${snapshot.number}</span>
			<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
		</div>
	`;

  return { mainHtml, headerHtml };
}
