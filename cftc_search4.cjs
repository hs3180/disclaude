const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Step 23: Check the Innovation Task Force Formation PR
  console.log("=== STEP 23: ITF Formation Press Release ===");
  await page.goto("https://www.cftc.gov/PressRoom/PressReleases/9201-26", { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());
  const text1 = await page.evaluate(() => document.body.innerText.substring(0, 10000));
  console.log(text1);
  
  // Step 24: Check Prediction Markets ANPRM
  console.log("\n\n=== STEP 24: Prediction Markets ANPRM ===");
  await page.goto("https://www.cftc.gov/PressRoom/PressReleases/9194-26", { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());
  const text2 = await page.evaluate(() => document.body.innerText.substring(0, 10000));
  console.log(text2);
  
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
