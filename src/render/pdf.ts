import puppeteer from "@cloudflare/puppeteer";

import type { IssueSnapshot } from "../github/types.js";
import { renderIssue } from "./template.js";

/**
 * Render an issue snapshot to PDF bytes using the Browser Rendering binding.
 *
 * The function launches a fresh browser per call, sets the page content,
 * generates the PDF with our custom page header, and closes the browser.
 *
 * For low-traffic personal use this is fine; if usage grew we'd want to
 * keep the browser alive in a Durable Object and reuse it across requests.
 */
export async function renderPdf(
  snapshot: IssueSnapshot,
  browserBinding: Fetcher,
): Promise<Uint8Array> {
  const { mainHtml, headerHtml } = renderIssue(snapshot);

  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setContent(mainHtml, { waitUntil: "networkidle0" });

    const pdf = await page.pdf({
      format: "letter",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: headerHtml,
      footerTemplate: "<span></span>",
      margin: {
        top: "1.5cm",
        bottom: "1cm",
        left: "1.5cm",
        right: "1.5cm",
      },
    });

    return new Uint8Array(pdf);
  } finally {
    await browser.close();
  }
}

/** Suggest a filename for the rendered PDF. */
export function pdfFilename(snapshot: IssueSnapshot): string {
  const slug = snapshot.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${snapshot.owner}-${snapshot.repo}-${snapshot.number}-${slug || "issue"}.pdf`;
}
