/**
 * scrape-warn.ts
 *
 * Pulls NY DOL WARN notices from the public Tableau dashboard, filters
 * them down to the Western NY and Capital Region counties we care about,
 * and writes the result to data/warn.json so the GitHub Action can commit
 * it back to the repo.
 *
 * Why we go through Playwright + the Tableau JS Embedding API:
 * Tableau Public migrated to a thin-client SPA in 2025; the legacy
 * "fetch /views/.../WARN and parse the tsConfigContainer textarea"
 * trick no longer works (textarea is empty until JS populates it),
 * and this dashboard is server-rendered (renderMode = "render-mode-
 * server") so the browser never even sees the underlying data — only
 * pre-rendered PNG tiles. The only reliable extraction path is to
 * embed the viz via tableau-2.min.js and call getSummaryDataAsync()
 * on each worksheet, which is exactly what this script does.
 */
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TABLEAU_URL =
  'https://public.tableau.com/views/' +
  'WorkerAdjustmentRetrainingNotificationWARN/WARN';

const TARGET_COUNTIES = [
  // Western NY
  'Erie', 'Niagara', 'Genesee', 'Chautauqua',
  'Cattaraugus', 'Wyoming', 'Orleans', 'Allegany',
  // Capital Region (Albany area)
  'Albany', 'Rensselaer', 'Schenectady', 'Saratoga',
  'Columbia', 'Greene', 'Warren', 'Washington',
];

// Window (in days) for the `recentRecords` rollup in the output JSON.
// Based on "Date Posted" (the date NY DOL published the notice), not the
// notice date or layoff start date.
const RECENT_WINDOW_DAYS = 7;

// The dashboard exposes several views; "WARN List" contains the full
// 700+ row master table with one row per WARN notice. Its underlying
// worksheet is named "A_Excel_Table___" (yes, three trailing underscores).
const PRIMARY_DASHBOARD = 'WARN List';
const PRIMARY_WORKSHEET = 'A_Excel_Table___';

const OUTPUT_PATH = 'data/warn.json';

// HTML wrapper served to the headless browser. Embeds the viz via the
// public Tableau JS API and exposes pullWarnList() globally so the
// Node side can drive it via page.evaluate().
const WRAPPER_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>WARN scraper wrapper</title>
  <script src="https://public.tableau.com/javascripts/api/tableau-2.min.js"></script>
</head>
<body>
  <div id="vizContainer" style="width:1400px; height:1100px;"></div>
  <script>
    let viz = null;
    let vizReadyResolve = null;
    const vizReady = new Promise(function (r) { vizReadyResolve = r; });
    vizReady.then(function () { window.__VIZ_READY__ = true; });

    function initViz(url) {
      const container = document.getElementById('vizContainer');
      const options = {
        hideTabs: false,
        hideToolbar: true,
        width: '1400px',
        height: '1100px',
        onFirstInteractive: function () { vizReadyResolve(true); }
      };
      viz = new tableau.Viz(container, url, options);
    }

    async function pullWarnList(dashboardName, worksheetName) {
      await vizReady;
      const workbook = viz.getWorkbook();
      await workbook.activateSheetAsync(dashboardName);
      const active = workbook.getActiveSheet();
      if (active.getSheetType() !== 'dashboard') {
        throw new Error('Expected dashboard, got ' + active.getSheetType());
      }
      const worksheets = active.getWorksheets();
      let target = null;
      for (const ws of worksheets) {
        if (ws.getName() === worksheetName) { target = ws; break; }
      }
      if (!target) {
        throw new Error(
          'Worksheet not found: ' + worksheetName +
          '. Available: ' + worksheets.map(function (w) { return w.getName(); }).join(', ')
        );
      }
      const dt = await target.getSummaryDataAsync({
        ignoreSelection: true,
        ignoreAliases: false
      });
      const cols = dt.getColumns().map(function (c) { return c.getFieldName(); });
      const rows = dt.getData().map(function (row) {
        return row.map(function (c) { return c.formattedValue; });
      });
      return { columns: cols, rows: rows };
    }
  </script>
</body>
</html>
`;

interface ScrapeResult {
  columns: string[];
  rows: string[][];
}

async function main(): Promise<void> {
  console.log('Launching headless Chromium...');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1400, height: 1100 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(180_000);
    page.on('pageerror', (err) => console.error('  [pageerror]', err));

    console.log('Loading wrapper and embedding viz...');
    await page.setContent(WRAPPER_HTML, { waitUntil: 'domcontentloaded' });
    await page.evaluate(`initViz(${JSON.stringify(TABLEAU_URL)})`);

    console.log('Waiting for onFirstInteractive...');
    await page.waitForFunction(
      'window.__VIZ_READY__ === true'
    );
    console.log('  viz is interactive');

    console.log(`Pulling '${PRIMARY_DASHBOARD}' :: '${PRIMARY_WORKSHEET}'...`);
    const table = (await page.evaluate(
      ([d, w]) => (window as unknown as {
        pullWarnList: (a: string, b: string) => Promise<ScrapeResult>;
      }).pullWarnList(d, w),
      [PRIMARY_DASHBOARD, PRIMARY_WORKSHEET] as const
    )) as ScrapeResult;

    const { columns, rows } = table;
    console.log(`  pulled ${rows.length} rows, ${columns.length} columns`);

    const countyIdx = columns.indexOf('Impacted Site County');
    if (countyIdx < 0) {
      throw new Error(
        "'Impacted Site County' column not found in WARN List. " +
        'Tableau dashboard schema may have changed. ' +
        `Columns were: ${columns.join(', ')}`
      );
    }

    const targetSet = new Set(TARGET_COUNTIES.map((c) => c.toLowerCase()));
    const filteredRows = rows.filter((r) =>
      targetSet.has(String(r[countyIdx]).trim().toLowerCase())
    );

    const records = filteredRows.map((r) => {
      const obj: Record<string, string> = {};
      columns.forEach((col, i) => {
        obj[col] = r[i];
      });
      return obj;
    });

    const countyCounts: Record<string, number> = {};
    for (const rec of records) {
      const c = rec['Impacted Site County'] || '';
      countyCounts[c] = (countyCounts[c] || 0) + 1;
    }

    const cutoff = new Date();
    cutoff.setUTCHours(0, 0, 0, 0);
    cutoff.setUTCDate(cutoff.getUTCDate() - RECENT_WINDOW_DAYS);
    const recentRecords = records.filter((rec) => {
      const posted = rec['Date Posted'];
      if (!posted) return false;
      const d = new Date(posted);
      return !isNaN(d.getTime()) && d >= cutoff;
    });

    const summaryParts = [
      `Found ${records.length} WARN notices for target counties ` +
      `(out of ${rows.length} statewide).`,
      `  ${recentRecords.length} posted in the last ${RECENT_WINDOW_DAYS} days ` +
      `(since ${cutoff.toISOString().slice(0, 10)}).`,
    ];
    Object.entries(countyCounts)
      .sort((a, b) => b[1] - a[1])
      .forEach(([c, n]) => summaryParts.push(`  - ${c}: ${n} notices`));
    const summary = summaryParts.join('\n');
    console.log(summary);

    const output = {
      scrapedAt: new Date().toISOString(),
      source: TABLEAU_URL,
      totalRows: rows.length,
      filteredRows: records.length,
      recentWindowDays: RECENT_WINDOW_DAYS,
      recentCutoff: cutoff.toISOString().slice(0, 10),
      recentCount: recentRecords.length,
      targetCounties: TARGET_COUNTIES,
      columns,
      records,
      recentRecords,
      countyCounts,
      summary,
    };

    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + '\n');
    console.log(`Wrote ${OUTPUT_PATH}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
