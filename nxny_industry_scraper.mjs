// nxny.com industry research reports scraper
// Uses playwright-core via CDP since MCP Playwright is not connecting
import { chromium } from 'playwright-core';

const TARGET_URLS = [
  'https://www.nxny.com/stype_hy/',
  'https://www.nxny.com/stype_hy_p2/',
  'https://www.nxny.com/stype_hy_p3/',
];

async function main() {
  const browser = await chromium.connectOverCDP('http://localhost:9222');
  const contexts = browser.contexts();
  const context = contexts[0] || await browser.newContext();
  const page = await context.newPage();

  const allReports = [];

  for (const url of TARGET_URLS) {
    console.log(`\n=== Navigating to ${url} ===`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Get report list items
      const reports = await page.evaluate(() => {
        const items = [];
        // nxny.com typically has report list items with title links and dates
        const links = document.querySelectorAll('a[href*="/report/view_"]');
        links.forEach(link => {
          const title = (link.textContent || '').trim().replace(/\s+/g, ' ');
          const href = link.getAttribute('href') || '';
          // Find closest date - look for adjacent text
          const parent = link.closest('li, tr, div');
          const dateText = parent ? parent.textContent : '';
          const dateMatch = dateText.match(/(\d{2})-(\d{2})/);

          if (title.length > 10 && href) {
            items.push({
              title: title.substring(0, 200),
              url: href.startsWith('http') ? href : 'https://www.nxny.com' + href,
              date: dateMatch ? '2026-' + dateMatch[1] + '-' + dateMatch[2] : '',
            });
          }
        });
        return items;
      });

      console.log(`Found ${reports.length} reports on ${url}`);
      for (const r of reports.slice(0, 30)) {
        console.log(`  [${r.date}] ${r.title.substring(0, 80)}`);
      }
      allReports.push(...reports);
    } catch (err) {
      console.error(`Error on ${url}:`, err.message);
    }
  }

  // Deduplicate by URL
  const seen = new Set();
  const deduped = allReports.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  console.log(`\n=== TOTAL UNIQUE REPORTS: ${deduped.length} ===`);

  // Output as JSON
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(deduped, null, 2));

  await page.close();
  await browser.close(); // disconnect only
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
