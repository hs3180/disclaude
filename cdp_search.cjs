const WebSocket = require('ws');

async function main() {
    const url = process.argv[2] || 'https://www.tianyancha.com';
    const ws = new WebSocket('ws://localhost:9222/devtools/browser/243cef11-0339-47f3-bf8f-0081ab48135d', {
        headers: { 'Origin': 'http://localhost:9222' }
    });
    
    let id = 1;
    const pending = new Map();
    
    function send(method, params = {}, sessionId = null) {
        return new Promise((resolve, reject) => {
            const msg = { id: ++id, method, params };
            if (sessionId) msg.sessionId = sessionId;
            pending.set(id, { resolve, reject });
            ws.send(JSON.stringify(msg));
            setTimeout(() => { pending.delete(id); reject(new Error('Timeout')); }, 15000);
        });
    }
    
    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id).resolve(msg);
            pending.delete(msg.id);
        }
    });
    
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
        setTimeout(() => reject(new Error('Connection timeout')), 10000);
    });
    
    console.log('Connected to CDP');
    
    // Get existing targets
    const targets = await send('Target.getTargets');
    const pageTargets = targets.result.targetInfos.filter(t => t.type === 'page');
    console.log(`Found ${pageTargets.length} pages`);
    
    // Use existing or create new target
    let targetId = pageTargets[0]?.targetId;
    
    // Attach to target
    const attachResult = await send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attachResult.result.sessionId;
    console.log(`Attached to ${targetId}, session: ${sessionId}`);
    
    // Enable Page events
    await send('Page.enable', {}, sessionId);
    
    // Navigate
    console.log(`Navigating to: ${url}`);
    await send('Page.navigate', { url }, sessionId);
    
    // Wait for load
    await new Promise(r => setTimeout(r, 5000));
    
    // Get page title
    const titleResult = await send('Runtime.evaluate', {
        expression: 'document.title'
    }, sessionId);
    console.log(`Title: ${titleResult.result?.result?.value}`);
    
    // Get page text content
    const textResult = await send('Runtime.evaluate', {
        expression: 'document.body.innerText.substring(0, 5000)'
    }, sessionId);
    console.log('\n--- Page Content ---');
    console.log(textResult.result?.result?.value || 'No content');
    
    ws.close();
}

main().catch(e => { console.error(e.message); process.exit(1); });
