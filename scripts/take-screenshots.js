const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const ARTIFACTS_DIR = 'C:\\Users\\adiit\\.gemini\\antigravity-ide\\brain\\96b66572-173f-4de4-8f79-4e3adfa56ad0';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function capture() {
  console.log('Launching Chrome via puppeteer-core...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const page = await browser.newPage();

  const viewports = [
    { name: '1280px', width: 1280, height: 900 },
    { name: '768px', width: 768, height: 1024 },
    { name: '375px', width: 375, height: 812 }
  ];

  for (const vp of viewports) {
    console.log(`Setting viewport to ${vp.width}x${vp.height} (${vp.name})...`);
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 2 });
    await page.goto('http://localhost:3000/ui-kit', { waitUntil: 'networkidle0' });

    const outputPath = path.join(ARTIFACTS_DIR, `uikit_${vp.name}.png`);
    await page.screenshot({ path: outputPath, fullPage: false });
    console.log(`Saved screenshot: ${outputPath}`);
  }

  await browser.close();
  console.log('🎉 All responsive screenshots captured successfully!');
}

capture().catch((err) => {
  console.error('Screenshot capture failed:', err);
  process.exit(1);
});
