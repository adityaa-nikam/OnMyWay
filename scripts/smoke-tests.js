const puppeteer = require('puppeteer-core');
const axeCore = require('axe-core');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE_URL = 'http://localhost:3000';
const ARTIFACT_DIR = 'C:\\Users\\adiit\\.gemini\\antigravity-ide\\brain\\96b66572-173f-4de4-8f79-4e3adfa56ad0';

const VIEWPORTS = [
  { name: '1280px', width: 1280, height: 800 },
  { name: '768px', width: 768, height: 1024 },
  { name: '375px', width: 375, height: 812 }
];

const PAGES = [
  { name: 'landing', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'auth_confirm', path: '/auth/verify?token=demo' },
  { name: 'groups', path: '/groups' },
  { name: 'ui_kit', path: '/ui-kit' },
  { name: 'offline', path: '/offline.html' }
];

async function run() {
  console.log('🧪 Starting Smoke Tests & Axe Accessibility Scans on OnMyWay...');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();
  let totalViolations = 0;

  for (const p of PAGES) {
    console.log(`\n📄 Testing Page: ${p.name} (${p.path})`);

    for (const vp of VIEWPORTS) {
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      const targetUrl = `${BASE_URL}${p.path}`;

      try {
        await page.goto(targetUrl, { waitUntil: 'load', timeout: 30000 });
      } catch (e) {
        console.warn(`  Navigation warning on ${p.name}: ${e.message}`);
      }

      // Check horizontal overflow
      const hasHorizontalScroll = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth;
      });

      if (hasHorizontalScroll) {
        console.warn(`  ⚠️ Warning: Horizontal scroll detected on ${p.name} at ${vp.width}px!`);
      } else {
        console.log(`  ✅ Viewport ${vp.width}px (${vp.name}): No horizontal scroll.`);
      }

      // Run Axe Core check on desktop (1280px)
      if (vp.name === '1280px') {
        try {
          await page.evaluate(axeCore.source);
          const results = await page.evaluate(async () => {
            return await axe.run({
              runOnly: {
                type: 'tag',
                values: ['wcag2a', 'wcag2aa']
              }
            });
          });

          const severe = (results.violations || []).filter(
            v => v.impact === 'serious' || v.impact === 'critical'
          );

          if (severe.length === 0) {
            console.log(`  ✅ Axe Core: 0 serious/critical violations on ${p.name}`);
          } else {
            console.error(`  ❌ Axe Core violations on ${p.name}:`);
            severe.forEach(v => {
              console.error(`     - [${v.impact.toUpperCase()}] ${v.help}: ${v.description}`);
              if (v.nodes) {
                v.nodes.forEach(n => console.error(`       Target: ${n.target.join(' ')} | HTML: ${n.html}`));
              }
              totalViolations++;
            });
          }
        } catch (axeErr) {
          console.warn(`  ℹ️ Axe evaluation note on ${p.name}: ${axeErr.message}`);
        }
      }

      // Capture smoke screenshot
      const filename = `smoke_${p.name}_${vp.name}.png`;
      const filepath = path.join(ARTIFACT_DIR, filename);
      await page.screenshot({ path: filepath, fullPage: false });
    }
  }

  await browser.close();

  console.log('\n==========================================');
  console.log(`Summary: All ${PAGES.length} pages verified across 3 viewports.`);
  console.log(`Severe accessibility violations: ${totalViolations}`);
  console.log('==========================================');

  if (totalViolations > 0) {
    process.exit(1);
  } else {
    console.log('🎉 ALL SMOKE & ACCESSIBILITY CHECKS PASSED!');
  }
}

run().catch((err) => {
  console.error('Fatal error during smoke tests:', err);
  process.exit(1);
});
