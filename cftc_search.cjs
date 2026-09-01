const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  console.log("=== STEP 19: Click FINRA Speech Link ===");
  await page.goto("https://www.cftc.gov/PressRoom/SpeechesTestimony/index.htm", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(3000);
  
  // Try clicking the FINRA link
  const finraLink = await page.$("a:has-text('FINRA')");
  if (finraLink) {
    console.log("Found FINRA link, clicking...");
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      finraLink.click()
    ]);
    await page.waitForTimeout(2000);
    const text = await page.evaluate(() => document.body.innerText.substring(0, 25000));
    console.log(text);
    console.log("\nURL:", page.url());
  } else {
    console.log("FINRA link not found in DOM");
    
    // Get all links from main content
    const contentLinks = await page.evaluate(() => {
      const main = document.querySelector("#main-content") || document.body;
      return Array.from(main.querySelectorAll("a")).map(a => ({ href: a.href, text: a.textContent.trim() })).filter(a => a.href && a.href.indexOf("#") === -1);
    });
    console.log("Content links:", JSON.stringify(contentLinks.slice(0, 30), null, 2));
  }
  
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
