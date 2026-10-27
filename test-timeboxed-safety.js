const http = require('http');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');
const { app, server, repo, locationSharingService } = require('./app');
const { hashToken } = require('./middleware/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTimeboxedSafetyTests() {
  console.log('🧪 Starting Test Suite: Time-Boxed Sharing, Audience Control & Safety Actions...\n');

  const TEST_PORT = 3458;
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  const baseUrl = `http://localhost:${TEST_PORT}`;
  console.log(`📡 Test server running on ${baseUrl}`);

  let totalTests = 0;
  let passedTests = 0;

  function assert(condition, testName) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  const runId = crypto.randomBytes(4).toString('hex');
  const userA = repo.createUser({ email: `usera_${runId}@onmyway.local`, displayName: 'UserA' });
  const userB = repo.createUser({ email: `userb_${runId}@onmyway.local`, displayName: 'UserB' });
  const userC = repo.createUser({ email: `userc_${runId}@onmyway.local`, displayName: 'UserC' });

  const sessionRawA = 'sess_a_' + crypto.randomBytes(16).toString('hex');
  const sessionRawB = 'sess_b_' + crypto.randomBytes(16).toString('hex');
  const sessionRawC = 'sess_c_' + crypto.randomBytes(16).toString('hex');

  repo.createSession({ tokenHash: hashToken(sessionRawA), userId: userA.id, expiresAt: Date.now() + 86400000 });
  repo.createSession({ tokenHash: hashToken(sessionRawB), userId: userB.id, expiresAt: Date.now() + 86400000 });
  repo.createSession({ tokenHash: hashToken(sessionRawC), userId: userC.id, expiresAt: Date.now() + 86400000 });

  const csrfToken = 'test_csrf_' + crypto.randomBytes(8).toString('hex');
  const authHeadersA = {
    'Content-Type': 'application/json',
    Cookie: `omw_session=${sessionRawA}; omw_csrf=${csrfToken}`,
    'x-csrf-token': csrfToken
  };

  try {
    // Setup Groups:
    // Group 1: Members = UserA, UserB
    // Group 2: Members = UserA, UserC
    const group1 = repo.createGroup({ name: 'Group 1 (A + B)', ownerId: userA.id });
    const group2 = repo.createGroup({ name: 'Group 2 (A + C)', ownerId: userA.id });

    repo.addGroupMember({ groupId: group1.id, userId: userB.id, role: 'member' });
    repo.addGroupMember({ groupId: group2.id, userId: userC.id, role: 'member' });

    // -------------------------------------------------------------------------
    // TEST 1: Time-Boxed Sharing Expiration at Exact Boundary
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Testing Exact Boundary Expiration & Update Rejection ---');

    // Start share with duration 600ms
    const shortShare = locationSharingService.startShare({
      userId: userA.id,
      userName: userA.displayName,
      durationType: '15m',
      targetGroupIds: [group1.id]
    });

    // Manually set expiry to 400ms from now to test exact boundary
    const nearExpiry = Date.now() + 400;
    repo.updateLocationShareExpiry(shortShare.id, nearExpiry);
    locationSharingService.armExactTimer(userA.id, shortShare.id, nearExpiry);

    assert(locationSharingService.isUserActivelySharing(userA.id) === true, 'Location share initially active before boundary');

    // Connect socket for UserA
    const socketA = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: {
        Origin: baseUrl,
        Cookie: `omw_session=${sessionRawA}`
      }
    });
    await new Promise((res) => socketA.on('connect', res));

    await new Promise((res) => {
      socketA.emit('join-room', { groupId: group1.id, isPersistent: true }, res);
    });

    // Update before boundary should succeed
    const preExpiryUpdate = await new Promise((res) => {
      socketA.emit('send-location', { latitude: 37.7749, longitude: -122.4194 }, res);
      setTimeout(() => res({ success: false }), 200);
    });
    assert(preExpiryUpdate.success === true, 'Coordinate update before boundary accepted');

    // Wait 500ms to cross boundary
    await sleep(500);

    assert(locationSharingService.isUserActivelySharing(userA.id) === false, 'Location share is now inactive after boundary');

    // Update after boundary must be rejected with EXPIRED code
    let postExpiryError = null;
    socketA.on('error-notice', (err) => { postExpiryError = err; });

    const postExpiryUpdate = await new Promise((res) => {
      socketA.emit('send-location', { latitude: 37.7750, longitude: -122.4195 }, res);
      setTimeout(() => res({ success: false }), 200);
    });
    assert(postExpiryUpdate.success === false, 'Coordinate update after boundary rejected');
    assert(postExpiryError && postExpiryError.code === 'EXPIRED', 'EXPIRED error notice emitted to client');

    socketA.disconnect();

    // -------------------------------------------------------------------------
    // TEST 2: Active Share Persistence Across Server Restart & Rehydration
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing Active Share Persistence Across Reboot ---');

    // Start 1-hour share
    const oneHourShare = locationSharingService.startShare({
      userId: userA.id,
      userName: userA.displayName,
      durationType: '1h',
      targetGroupIds: [group1.id]
    });
    assert(oneHourShare.is_active === 1, '1-hour share persisted in SQLite location_shares table');

    // Simulate server reboot
    console.log('  🔄 Simulating server reboot...');
    await new Promise((res) => server.close(res));
    await new Promise((res) => server.listen(TEST_PORT, res));

    // Rehydrate active shares
    locationSharingService.rehydrateActiveShares();
    const activeAfterReboot = repo.getActiveLocationShare(userA.id);
    assert(activeAfterReboot !== null && activeAfterReboot.id === oneHourShare.id, 'Active share survived complete server reboot');
    assert(locationSharingService.isUserActivelySharing(userA.id) === true, 'Rehydrated share remains active with re-armed timer');

    // Stop share
    locationSharingService.stopShare(userA.id, 'stopped');
    assert(locationSharingService.isUserActivelySharing(userA.id) === false, 'Share stopped explicitly');

    // -------------------------------------------------------------------------
    // TEST 3: Audience Control (Multi-Group Isolation)
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Audience Control & Selective Group Broadcasts ---');

    // UserA shares strictly with Group 1 (NOT Group 2)
    locationSharingService.startShare({
      userId: userA.id,
      userName: userA.displayName,
      durationType: '1h',
      targetGroupIds: [group1.id]
    });

    const targetGroups = locationSharingService.getUserTargetGroups(userA.id);
    assert(targetGroups.includes(group1.id) && !targetGroups.includes(group2.id), 'Audience strictly limited to Group 1');

    // Connect UserB in Group 1 and UserC in Group 2
    const socketB = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: { Origin: baseUrl, Cookie: `omw_session=${sessionRawB}` }
    });
    const socketC = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: { Origin: baseUrl, Cookie: `omw_session=${sessionRawC}` }
    });

    await Promise.all([
      new Promise((res) => socketB.on('connect', res)),
      new Promise((res) => socketC.on('connect', res))
    ]);

    await Promise.all([
      new Promise((res) => socketB.emit('join-room', { groupId: group1.id, isPersistent: true }, res)),
      new Promise((res) => socketC.emit('join-room', { groupId: group2.id, isPersistent: true }, res))
    ]);

    // Connect UserA to Group 1
    const socketA2 = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: { Origin: baseUrl, Cookie: `omw_session=${sessionRawA}` }
    });
    await new Promise((res) => socketA2.on('connect', res));
    await new Promise((res) => socketA2.emit('join-room', { groupId: group1.id, isPersistent: true }, res));

    let userBReceivedCoords = false;
    let userCReceivedCoords = false;

    socketB.on('receive-location', () => { userBReceivedCoords = true; });
    socketC.on('receive-location', () => { userCReceivedCoords = true; });

    // UserA emits location update with Battery status
    await new Promise((res) => {
      socketA2.emit('send-location', {
        latitude: 45.9237,
        longitude: 6.8694,
        battery: { level: 82, charging: true }
      }, res);
    });

    await sleep(250);

    assert(userBReceivedCoords === true, 'Audience member in Group 1 received location update');
    assert(userCReceivedCoords === false, 'Non-audience member in Group 2 DID NOT receive location update (Audience Isolation verified)');

    socketA2.disconnect();
    socketB.disconnect();
    socketC.disconnect();

    // -------------------------------------------------------------------------
    // TEST 4: Transparency & In-App Share Log
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Transparency & Share Log API ---');

    // Extend share by 15 mins via REST API
    const extendRes = await fetch(`${baseUrl}/api/location/extend`, {
      method: 'POST',
      headers: authHeadersA,
      body: JSON.stringify({ additionalMinutes: 15 })
    });
    const extendData = await extendRes.json();
    assert(extendRes.status === 200 && extendData.success === true, 'Location share extended via REST API');

    // Stop share via REST API
    const stopRes = await fetch(`${baseUrl}/api/location/stop`, {
      method: 'POST',
      headers: authHeadersA
    });
    const stopData = await stopRes.json();
    assert(stopRes.status === 200 && stopData.success === true, 'Location share stopped via REST API');

    // Query Share Log
    const logRes = await fetch(`${baseUrl}/api/location/share-log`, {
      headers: authHeadersA
    });
    const logData = await logRes.json();
    assert(logRes.status === 200 && logData.success === true, 'Share log fetched via REST API');
    const actions = logData.logs.map((l) => l.action);
    assert(actions.includes('started') && actions.includes('extended') && actions.includes('stopped'), 'Chronological share log captures started, extended, and stopped actions');

    // -------------------------------------------------------------------------
    // TEST 5: Status Chips & Opt-In Location Pins
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Status Chips & 24h Retained Location Pins ---');

    // Connect UserA to test status chips over Socket.IO
    const socketA3 = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: { Origin: baseUrl, Cookie: `omw_session=${sessionRawA}` }
    });
    await new Promise((res) => socketA3.on('connect', res));
    await new Promise((res) => socketA3.emit('join-room', { groupId: group1.id, isPersistent: true }, res));

    // 5A: Status chip without location attachment
    const chipNoLoc = await new Promise((res) => {
      socketA3.emit('send', {
        message: 'On my way',
        isChip: true,
        chipType: 'on_my_way',
        attachLocation: false
      }, res);
    });
    assert(chipNoLoc.success === true && chipNoLoc.location === null, 'Status chip without location accepted without coordinates');

    // 5B: Status chip with opt-in location pin attached
    const chipWithLoc = await new Promise((res) => {
      socketA3.emit('send', {
        message: 'Reached safe',
        isChip: true,
        chipType: 'reached_safe',
        attachLocation: true,
        latitude: 45.9231,
        longitude: 6.8689
      }, res);
    });
    assert(chipWithLoc.success === true && chipWithLoc.location !== null, 'Status chip with location attached single pin');

    // Verify pin stored in status_pins table
    const storedPins = repo.getStatusPinsForGroup(group1.id);
    assert(storedPins.length >= 1 && storedPins[0].chip_type === 'reached_safe', 'Opt-in location pin saved in status_pins table');

    // Retention prune test
    const prunedPins = repo.pruneOldStatusPins(24);
    assert(typeof prunedPins === 'number', 'Status pin retention pruning executes cleanly');

    socketA3.disconnect();

    // -------------------------------------------------------------------------
    // TEST 6: Emergency SOS Beacon & Responder Lifecycle
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing Emergency SOS Beacon, Cooldown & Response ---');

    // 6A: Trigger SOS
    const sosRes = await fetch(`${baseUrl}/api/groups/${group1.id}/sos`, {
      method: 'POST',
      headers: authHeadersA,
      body: JSON.stringify({ latitude: 45.9235, longitude: 6.8690 })
    });
    const sosData = await sosRes.json();
    assert(sosRes.status === 200 && sosData.success === true, 'SOS Beacon triggered successfully');
    const sosId = sosData.sosEvent.id;

    // 6B: 60-Second Cooldown & Rate Limit Enforcement
    const rapidSosRes = await fetch(`${baseUrl}/api/groups/${group1.id}/sos`, {
      method: 'POST',
      headers: authHeadersA,
      body: JSON.stringify({ latitude: 45.9235, longitude: 6.8690 })
    });
    const rapidSosData = await rapidSosRes.json();
    assert(rapidSosRes.status === 429 && rapidSosData.success === false, 'Immediate second SOS rejected by 60-second cooldown rate limit');

    // 6C: Member taps "I'm on it"
    const respondRes = await fetch(`${baseUrl}/api/sos/${sosId}/respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `omw_session=${sessionRawB}; omw_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken
      }
    });
    const respondData = await respondRes.json();
    assert(respondRes.status === 200 && respondData.success === true, 'Member response ("I\'m on it") recorded in SOS event');
    assert(respondData.sosEvent.responders.some((r) => r.userId === userB.id), 'Responder list updated with user identity');

    // 6D: Non-sender attempts to cancel SOS -> 403 Forbidden
    const evilCancelRes = await fetch(`${baseUrl}/api/sos/${sosId}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `omw_session=${sessionRawB}; omw_csrf=${csrfToken}`,
        'x-csrf-token': csrfToken
      }
    });
    assert(evilCancelRes.status === 403, 'Non-sender cancel attempt rejected with 403 Forbidden');

    // 6E: Sender cancels SOS with "False alarm"
    const cancelRes = await fetch(`${baseUrl}/api/sos/${sosId}/cancel`, {
      method: 'POST',
      headers: authHeadersA
    });
    const cancelData = await cancelRes.json();
    assert(cancelRes.status === 200 && cancelData.sosEvent.status === 'cancelled', 'SOS sender cancelled beacon as "False alarm"');

    console.log(`\n🎉 ALL ${totalTests} TIME-BOXED SHARING & SAFETY ACTION CHECKS PASSED!\n`);
  } finally {
    server.close();
  }
}

runTimeboxedSafetyTests().catch((err) => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
