const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Step 25: Check DCM Products search page
  console.log("=== STEP 25: DCM Products Search ===");
  
  // Try the industry filings products page
  const urls = [
    "https://www.cftc.gov/IndustryOversight/IndustryFilings/Products",
    "https://www.cftc.gov/IndustryOversight/IndustryFilings/Products/index.htm",
    "https://portal.cftc.gov",
  ];
  
  for (const url of urls) {
    console.log("\n--- Trying:", url, "---");
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      const is404 = await page.evaluate(() => document.body.innerText.includes("404 Page Not Found"));
      if (is404 == false) {
        const text = await page.evaluate(() => document.body.innerText.substring(0, 8000));
        console.log(text.substring(0, 5000));
        break;
      } else {
        console.log("-> 404");
      }
    } catch(e) {
      console.log("Error:", e.message.substring(0, 150));
    }
  }
  
  // Step 26: Search CFTC site using Yahoo
  console.log("\n\n=== STEP 26: Yahoo Site Search ===");
  await page.goto("https://search.yahoo.com/search?p=site%3Acftc.gov+%22compute%22+OR+%22GPU%22+OR+%22silicon+data%22", { waitUntil: "networkidle", timeout: 30000 });
  const yahooText = await page.evaluate(() => document.body.innerText.substring(0, 10000));
  console.log(yahooText);
  
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
