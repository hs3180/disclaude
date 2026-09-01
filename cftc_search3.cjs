const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // Step 21: Check Federal Register page
  console.log("=== STEP 21: Federal Register ===");
  await page.goto("https://www.cftc.gov/LawRegulation/FederalRegister", { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());
  
  const is404 = await page.evaluate(() => document.body.innerText.includes("404 Page Not Found"));
  if (is404 == false) {
    const text = await page.evaluate(() => document.body.innerText.substring(0, 10000));
    console.log(text);
  } else {
    console.log("-> 404");
  }
  
  console.log("\n\n=== STEP 22: Innovation Task Force Press Release ===");
  await page.goto("https://www.cftc.gov/PressRoom/PressReleases/9210-26", { waitUntil: "networkidle", timeout: 30000 });
  console.log("URL:", page.url());
  const text2 = await page.evaluate(() => document.body.innerText.substring(0, 10000));
  console.log(text2);
  
  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
