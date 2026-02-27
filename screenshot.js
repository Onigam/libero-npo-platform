const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const MOCKUPS_DIR = path.join(__dirname, 'mockups');
const OUT_DIR = path.join(MOCKUPS_DIR, 'screenshots');

const SCREENS = [
  { file: 'moodboard.html',           name: 'moodboard' },
  { file: 'design-system.html',       name: 'design-system' },
  { file: 'auth/login.html',          name: 'auth-login' },
  { file: 'auth/onboarding-1.html',   name: 'auth-onboarding-1' },
  { file: 'auth/onboarding-2.html',   name: 'auth-onboarding-2' },
  { file: 'auth/onboarding-3.html',   name: 'auth-onboarding-3' },
  { file: 'auth/onboarding-4.html',   name: 'auth-onboarding-4' },
  { file: 'auth/onboarding-5.html',   name: 'auth-onboarding-5' },
  { file: 'dashboard.html',           name: 'dashboard' },
  { file: 'constituents/list.html',   name: 'constituents-list' },
  { file: 'constituents/detail.html', name: 'constituents-detail' },
  { file: 'donations/list.html',      name: 'donations-list' },
  { file: 'donations/new.html',       name: 'donations-new' },
  { file: 'campaigns/list.html',      name: 'campaigns-list' },
  { file: 'grants/kanban.html',       name: 'grants-kanban' },
];

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const screen of SCREENS) {
    const filePath = `file://${MOCKUPS_DIR}/${screen.file}`;
    console.log(`📸 ${screen.name}...`);
    try {
      await page.goto(filePath, { waitUntil: 'networkidle', timeout: 10000 });
      await page.screenshot({ path: `${OUT_DIR}/${screen.name}.png`, fullPage: true });
      console.log(`   ✓ saved`);
    } catch (e) {
      console.log(`   ✗ error: ${e.message}`);
    }
  }

  await browser.close();
  console.log(`\nDone! Screenshots in mockups/screenshots/`);
})();
