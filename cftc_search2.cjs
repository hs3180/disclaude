const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Step 20: Read ISDA speech
  console.log("=== STEP 20: ISDA 40th Annual General Meeting Speech ===");
  await page.goto("https://www.cftc.gov/PressRoom/SpeechesTestimony/index.htm", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);
  
  const isdaLink = await page.$("a:has-text('ISDA')");
  if (isdaLink) {
    console.log("Found ISDA link, clicking...");
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      isdaLink.click()
    ]);
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText.substring(0, 25000));
    console.log(text);
    console.log("\nURL:", page.url());
  } else {
    console.log("ISDA link not found");
  }
  
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
