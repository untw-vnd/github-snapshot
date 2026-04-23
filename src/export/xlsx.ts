import * as XLSX from "xlsx";

import type {
  FieldValue,
  ProjectItem,
  ProjectSnapshot,
} from "../github/types.js";

/** Fixed columns we always include, in the order they appear in the workbook. */
const BASE_COLUMNS = [
  "Number",
  "Title",
  "State",
  "URL",
  "Repository",
  "Assignees",
  "Labels",
  "Milestone",
  "Issue Type",
  "Parent Issue",
  "Created At",
  "Updated At",
  "Closed At",
] as const;

type Row = Record<string, string | number | null>;

/** Render a list of strings as a single comma-separated cell. */
function joinList(items: string[]): string | null {
  return items.length === 0 ? null : items.join(", ");
}

/** Coerce a project field value to something xlsx can store cleanly. */
function fieldToCell(value: FieldValue): string | number | null {
  return value;
}

function itemToRow(item: ProjectItem, fieldNames: string[]): Row {
  const row: Row = {
    Number: item.number,
    Title: item.title,
    State: item.state,
    URL: item.url,
    Repository: item.repository,
    Assignees: joinList(item.assignees),
    Labels: joinList(item.labels),
    Milestone: item.milestone,
    "Issue Type": item.issueType,
    "Parent Issue": item.parentIssue,
    "Created At": item.createdAt || null,
    "Updated At": item.updatedAt || null,
    "Closed At": item.closedAt,
  };

  for (const name of fieldNames) {
    row[name] = fieldToCell(item.fields[name] ?? null);
  }

  return row;
}

/**
 * Build an .xlsx workbook from a project snapshot and return its bytes.
 *
 * The workbook has one sheet, with fixed issue-metadata columns followed by
 * one column per project custom field. Empty values render as blank cells.
 */
export function buildWorkbook(snapshot: ProjectSnapshot): Uint8Array {
  const headers = [...BASE_COLUMNS, ...snapshot.fieldNames];
  const rows = snapshot.items.map((item) =>
    itemToRow(item, snapshot.fieldNames),
  );

  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers });
  const workbook = XLSX.utils.book_new();

  // Sheet name has a 31-char limit and forbids a few characters; truncate
  // defensively. The project number disambiguates if titles collide.
  const safeName =
    snapshot.title.replace(/[\\/?*[\]:]/g, "").slice(0, 31) ||
    `Project ${snapshot.number}`;
  XLSX.utils.book_append_sheet(workbook, sheet, safeName);

  const buffer: ArrayBuffer = XLSX.write(workbook, {
    type: "array",
    bookType: "xlsx",
  });
  return new Uint8Array(buffer);
}

/** Suggest a filename for the downloaded workbook. */
export function workbookFilename(snapshot: ProjectSnapshot): string {
  const slug = snapshot.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const date = new Date().toISOString().slice(0, 10);
  return `${slug || "project"}-${snapshot.number}-${date}.xlsx`;
}
