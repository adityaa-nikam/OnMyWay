// scripts/characterization-test.js
// Playwright characterization test for OnMyWay (OMW) room controller.
// Verifies: join room, chat exchange, location sharing (start/stop), SOS trigger/respond/cancel,
// socket event sequence and DOM state transitions between two browser contexts.

const { chromium } = require('playwright');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

async function getBaseUrl() {
  const { server } = require('../app');
  const port = 3460;
  await new Promise((resolve) => server.listen(port, resolve));
  return { baseUrl: `http://localhost:${port}`, serverToClose: server };
}

async function runCharacterization() {
  console.log('🧪 Starting OnMyWay Client Characterization Test (Playwright Dual-Context)...');

  const { baseUrl, serverToClose } = await getBaseUrl();
  console.log(`📡 Testing against server at ${baseUrl}`);

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });

    // 1. Create Room via API
    const roomRes = await fetch(`${baseUrl}/api/rooms`, { method: 'POST' });
    const roomData = await roomRes.json();
    if (!roomData.success) {
      throw new Error(`Failed to create test room: ${JSON.stringify(roomData)}`);
    }
    const { roomId, token } = roomData;
    const roomUrl = `${baseUrl}/room?roomId=${roomId}&token=${token}`;
    console.log(`  ✅ Created test room ${roomId}`);

    // Tracer script to record all socket.io events
    const tracerScript = `
      window.__socketEvents = [];
      let _io = undefined;
      Object.defineProperty(window, 'io', {
        configurable: true,
        get() { return _io; },
        set(fn) {
          _io = function(...args) {
            const socket = fn.apply(this, args);
            window.__socket = socket;
            if (socket.onAnyOutgoing) {
              socket.onAnyOutgoing((event) => {
                window.__socketEvents.push({ dir: 'OUT', event, time: Date.now() });
              });
            }
            if (socket.onAny) {
              socket.onAny((event) => {
                window.__socketEvents.push({ dir: 'IN', event, time: Date.now() });
              });
            }
            return socket;
          };
        }
      });
    `;

    // 2. Setup Context A (Alice)
    const contextA = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['geolocation'],
      geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 15 }
    });
    await contextA.addInitScript(tracerScript);
    const pageA = await contextA.newPage();

    // 3. Setup Context B (Bob)
    const contextB = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: ['geolocation'],
      geolocation: { latitude: 37.7755, longitude: -122.4180, accuracy: 20 }
    });
    await contextB.addInitScript(tracerScript);
    const pageB = await contextB.newPage();

    // 4. Join Alice
    console.log('\n--- 1. Testing Room Join & Handshake ---');
    await pageA.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await pageA.waitForSelector('#display-name-input', { timeout: 15000 });
    await pageA.fill('#display-name-input', 'Alice');
    await pageA.click('#btn-submit-join');
    await pageA.waitForSelector('#join-modal', { state: 'hidden', timeout: 10000 });
    console.log('  ✅ Alice joined room');

    // 5. Join Bob
    await pageB.goto(roomUrl, { waitUntil: 'domcontentloaded' });
    await pageB.waitForSelector('#display-name-input', { timeout: 15000 });
    await pageB.fill('#display-name-input', 'Bob');
    await pageB.click('#btn-submit-join');
    await pageB.waitForSelector('#join-modal', { state: 'hidden', timeout: 10000 });
    console.log('  ✅ Bob joined room');

    // Verify participants list on both sides
    await pageA.waitForFunction(() => {
      const items = Array.from(document.querySelectorAll('#participant-list .participant-name'));
      return items.some(el => el.textContent.includes('Alice')) && items.some(el => el.textContent.includes('Bob'));
    }, { timeout: 10000 });

    await pageB.waitForFunction(() => {
      const items = Array.from(document.querySelectorAll('#participant-list .participant-name'));
      return items.some(el => el.textContent.includes('Alice')) && items.some(el => el.textContent.includes('Bob'));
    }, { timeout: 10000 });
    console.log('  ✅ Presence list synchronized across Alice and Bob');

    // 6. Test Chat Exchange
    console.log('\n--- 2. Testing Chat Exchange ---');
    await pageA.fill('#chat-input', 'Hello Bob from Alice!');
    await pageA.press('#chat-input', 'Enter');

    // Bob receives Alice's message
    await pageB.waitForFunction(() => {
      const msgs = Array.from(document.querySelectorAll('#chat-messages .msg-bubble.peer .msg-text'));
      return msgs.some(m => m.textContent.includes('Hello Bob from Alice!'));
    }, { timeout: 10000 });
    console.log('  ✅ Bob received Alice\'s chat message');

    // Bob replies
    await pageB.fill('#chat-input', 'Hey Alice! Ready to share location.');
    await pageB.press('#chat-input', 'Enter');

    // Alice receives Bob's reply
    await pageA.waitForFunction(() => {
      const msgs = Array.from(document.querySelectorAll('#chat-messages .msg-bubble.peer .msg-text'));
      return msgs.some(m => m.textContent.includes('Hey Alice! Ready to share location.'));
    }, { timeout: 10000 });
    console.log('  ✅ Alice received Bob\'s chat reply');

    // 7. Test Location Sharing (Start & Stop)
    console.log('\n--- 3. Testing Location Sharing Start & Stop ---');
    // Alice starts location sharing
    await pageA.evaluate(() => {
      window.startLocationSharing();
    });

    // Check Alice DOM state: sharing pill visible, stop button visible
    await pageA.waitForSelector('#sharing-pill:not(.hidden)', { timeout: 10000 });
    await pageA.waitForSelector('#btn-stop-location:not(.hidden)', { timeout: 10000 });
    console.log('  ✅ Alice DOM updated: sharing pill and stop button active');

    // Bob sees Alice's active location marker or live badge in participant list
    await pageB.waitForFunction(() => {
      const liveBadges = document.querySelectorAll('#participant-list .live-badge');
      return liveBadges.length > 0;
    }, { timeout: 10000 });

    // Verify Bob's map has a marker with Alice's name
    const aliceMarkerInBobMap = await pageB.evaluate(() => {
      const markerTags = Array.from(document.querySelectorAll('.omw-marker-tag .omw-tag-label'));
      return markerTags.some(tag => tag.textContent.includes('Alice'));
    });
    if (!aliceMarkerInBobMap) {
      throw new Error('Alice marker was not found on Bob\'s map DOM');
    }
    console.log('  ✅ Bob\'s map rendered Alice\'s Zenly-style live marker');

    // Alice stops sharing location
    await pageA.evaluate(() => {
      window.stopLocationSharing();
    });
    await pageA.waitForSelector('#sharing-pill', { state: 'hidden', timeout: 10000 });
    await pageA.waitForSelector('#btn-start-location:not(.hidden)', { timeout: 10000 });
    console.log('  ✅ Alice stopped sharing, DOM updated');

    // Bob receives location-stopped notification in chat and live badge removed
    await pageB.waitForFunction(() => {
      const msgs = Array.from(document.querySelectorAll('#chat-messages .msg-bubble.system'));
      return msgs.some(m => m.textContent.includes('Alice stopped sharing location'));
    }, { timeout: 10000 });
    console.log('  ✅ Bob received location-stopped notification');

    // 8. Test SOS Trigger, Response, and Cancel
    console.log('\n--- 4. Testing SOS Emergency Beacon ---');
    // Bob triggers SOS beacon
    await pageB.evaluate(() => {
      window.triggerSosBeacon();
    });

    // Bob DOM: SOS banner visible
    await pageB.waitForSelector('#sos-alert-banner:not(.hidden)', { timeout: 10000 });
    console.log('  ✅ Bob triggered SOS, SOS banner visible for Bob');

    // Alice DOM: SOS alert banner visible with Bob's name
    await pageA.waitForSelector('#sos-alert-banner:not(.hidden)', { timeout: 10000 });
    const sosBannerText = await pageA.$eval('#sos-alert-text', el => el.textContent);
    if (!sosBannerText.includes('Bob')) {
      throw new Error(`Expected SOS banner text to include 'Bob', got: ${sosBannerText}`);
    }
    console.log(`  ✅ Alice received emergency alert: "${sosBannerText}"`);

    // Alice clicks respond ("I'm on it")
    await pageA.click('#btn-sos-respond');
    await pageA.waitForFunction(() => {
      const btn = document.getElementById('btn-sos-respond');
      return btn && btn.textContent.includes('Responded');
    }, { timeout: 10000 });
    console.log('  ✅ Alice responded to SOS beacon');

    // Bob cancels SOS
    await pageB.evaluate(() => {
      window.cancelActiveSos();
    });

    // Both banners dismiss
    await pageB.waitForSelector('#sos-alert-banner', { state: 'hidden', timeout: 10000 });
    await pageA.waitForSelector('#sos-alert-banner', { state: 'hidden', timeout: 10000 });
    console.log('  ✅ Bob cancelled SOS beacon, banners dismissed on both clients');

    // 9. Inspect Socket Event Sequences
    console.log('\n--- 5. Recording Socket Event Sequences ---');
    const eventsA = await pageA.evaluate(() => window.__socketEvents || []);
    const eventsB = await pageB.evaluate(() => window.__socketEvents || []);

    const outEventsA = eventsA.filter(e => e.dir === 'OUT').map(e => e.event);
    const inEventsA = eventsA.filter(e => e.dir === 'IN').map(e => e.event);

    console.log('  Alice OUT events:', [...new Set(outEventsA)].join(', '));
    console.log('  Alice IN events :', [...new Set(inEventsA)].join(', '));

    const outEventsB = eventsB.filter(e => e.dir === 'OUT').map(e => e.event);
    const inEventsB = eventsB.filter(e => e.dir === 'IN').map(e => e.event);
    console.log('  Bob OUT events  :', [...new Set(outEventsB)].join(', '));
    console.log('  Bob IN events   :', [...new Set(inEventsB)].join(', '));

    // Verify key expected events were captured
    const requiredOutA = ['join-room', 'send', 'send-location', 'stop-location'];
    for (const req of requiredOutA) {
      if (!outEventsA.includes(req)) {
        throw new Error(`Missing expected event ${req} from Alice`);
      }
    }

    const requiredInA = ['participants-updated', 'receive', 'sos-broadcast', 'sos-cancelled'];
    for (const req of requiredInA) {
      if (!inEventsA.includes(req)) {
        throw new Error(`Missing expected event ${req} on Alice`);
      }
    }
    console.log('  ✅ All expected socket event sequences verified');

    console.log('\n🎉 ALL CLIENT CHARACTERIZATION CHECKS PASSED!');

    await contextA.close();
    await contextB.close();
    return true;
  } finally {
    if (browser) await browser.close();
    if (serverToClose) {
      await new Promise(resolve => serverToClose.close(resolve));
    }
  }
}

if (require.main === module) {
  runCharacterization().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error('\n❌ Characterization Test Failed:', err);
    process.exit(1);
  });
}

module.exports = { runCharacterization };
