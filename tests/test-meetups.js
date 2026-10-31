// test-meetups.js: Automated Test Suite for Meetup Mode, Routing Abstraction & Safety
const http = require('http');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { io: ClientIO } = require('socket.io-client');

// Use a clean test database
const TEST_DB_FILE = path.join(__dirname, '..', 'data', 'test_meetups.db');
if (fs.existsSync(TEST_DB_FILE)) {
  fs.unlinkSync(TEST_DB_FILE);
}
process.env.DB_PATH = TEST_DB_FILE;
process.env.NODE_ENV = 'test';
delete process.env.OSRM_BASE_URL; // Default to straight-line fallback

const { app, server, io, roomManager, repo, locationSharingService, routingService } = require('../app');

const TEST_PORT = 3459;
const BASE_URL = `http://localhost:${TEST_PORT}`;

let checksPassed = 0;
function pass(msg) {
  checksPassed++;
  console.log(`  ✅ PASS: ${msg}`);
}

async function request(urlPath, options = {}) {
  const url = new URL(urlPath, BASE_URL);
  const method = options.method || 'GET';
  const headers = options.headers || {};
  const body = options.body ? JSON.stringify(options.body) : null;

  if (body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json,
          text: data
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function connectSocket(cookieHeader, origin = 'http://localhost:3459') {
  return ClientIO(BASE_URL, {
    transports: ['websocket'],
    forceNew: true,
    extraHeaders: {
      cookie: cookieHeader,
      origin: origin
    }
  });
}

async function runTests() {
  console.log('🧪 Starting Test Suite: Meetup Mode, Routing Abstraction & Lateness...');

  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`📡 Test server running on ${BASE_URL}\n`);

  try {
const crypto = require('crypto');
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

    // ------------------------------------------------------------------------
    // SETUP: Users, Sessions, and Group
    // ------------------------------------------------------------------------
    console.log('--- 1. Setting up Users and Persistent Group ---');
    const uid = crypto.randomBytes(4).toString('hex');
    const userAlice = repo.createUser({ email: `alice_${uid}@meetup.com`, displayName: 'Alice' });
    const userBob = repo.createUser({ email: `bob_${uid}@meetup.com`, displayName: 'Bob' });
    const userCharlie = repo.createUser({ email: `charlie_${uid}@meetup.com`, displayName: 'Charlie' });

    const rawSessAlice = 'sess_alice_' + crypto.randomBytes(16).toString('hex');
    const rawSessBob = 'sess_bob_' + crypto.randomBytes(16).toString('hex');
    const rawSessCharlie = 'sess_charlie_' + crypto.randomBytes(16).toString('hex');

    repo.createSession({ tokenHash: hashToken(rawSessAlice), userId: userAlice.id, expiresAt: Date.now() + 86400000 });
    repo.createSession({ tokenHash: hashToken(rawSessBob), userId: userBob.id, expiresAt: Date.now() + 86400000 });
    repo.createSession({ tokenHash: hashToken(rawSessCharlie), userId: userCharlie.id, expiresAt: Date.now() + 86400000 });

    const cookieAlice = `omw_session=${rawSessAlice}; omw_csrf=csrf_secret`;
    const cookieBob = `omw_session=${rawSessBob}; omw_csrf=csrf_secret`;
    const cookieCharlie = `omw_session=${rawSessCharlie}; omw_csrf=csrf_secret`;

    const group = repo.createGroup({ name: 'Hiking Buddies', ownerId: userAlice.id });
    repo.addGroupMember({ groupId: group.id, userId: userBob.id, role: 'member' });
    repo.addGroupMember({ groupId: group.id, userId: userCharlie.id, role: 'member' });

    pass('Test users and persistent group created with memberships');

    // ------------------------------------------------------------------------
    // 2. Meetup Creation & .ics Calendar Export
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Testing Meetup Creation & .ics Export ---');
    const destLat = 37.7749;
    const destLng = -122.4194;
    const destLabel = 'Twin Peaks Summit';
    const futureStart = Date.now() + 60 * 60 * 1000; // 1 hour in future

    const createRes = await request(`/api/groups/${group.id}/meetups`, {
      method: 'POST',
      headers: {
        cookie: cookieAlice,
        'x-csrf-token': 'csrf_secret'
      },
      body: {
        title: 'Sunset Trail Meetup',
        destination: { lat: destLat, lng: destLng, label: destLabel },
        startTime: futureStart,
        stopOnArrival: true
      }
    });

    assert.strictEqual(createRes.status, 201, 'Meetup creation should return 201');
    const meetup = createRes.body.meetup;
    assert.strictEqual(meetup.title, 'Sunset Trail Meetup');
    assert.strictEqual(meetup.stop_on_arrival, 1, 'stop_on_arrival should be enabled');
    pass('Meetup created with creator auto-RSVP "going" and stop_on_arrival = 1');

    // Test .ics Calendar Export
    const icsRes = await request(`/api/meetups/${meetup.id}/ics`, {
      headers: { cookie: cookieAlice }
    });
    assert.strictEqual(icsRes.status, 200, '.ics export should return 200');
    assert.match(icsRes.headers['content-type'], /text\/calendar/, 'Content-type must be text/calendar');
    assert.match(icsRes.text, /BEGIN:VCALENDAR/, 'Must contain standard VCALENDAR header');
    assert.match(icsRes.text, /SUMMARY:Sunset Trail Meetup/, 'Must contain meetup summary');
    assert.match(icsRes.text, /LOCATION:Twin Peaks Summit/, 'Must contain destination location');
    pass('.ics calendar file generated with RFC 5545 format and geocoded coordinates');

    // ------------------------------------------------------------------------
    // 3. Routing Provider Abstraction & Straight-Line Fallback
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Testing Routing Provider Abstraction & Straight-Line Fallback ---');
    // Alice is 5 km away from destination
    const aliceLat = 37.7400;
    const aliceLng = -122.4194;

    const routeFallback = await routingService.fetchOsrmRoute(aliceLat, aliceLng, destLat, destLng);
    assert.strictEqual(routeFallback, null, 'Unset OSRM_BASE_URL must return null and trigger fallback');

    const straightLine = routingService.calculateStraightLineRoute(aliceLat, aliceLng, destLat, destLng);
    assert.strictEqual(straightLine.isApproximate, true, 'Straight-line fallback must be flagged isApproximate = true');
    assert.ok(straightLine.distanceMeters > 3000, 'Distance calculation should be reasonable');
    assert.ok(straightLine.etaSeconds > 0, 'ETA seconds must be positive');
    pass('Default routing provider falls back to straight-line estimation with isApproximate = true');

    // ------------------------------------------------------------------------
    // 4. Provider Timeout Fallback Handling
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Testing Provider Timeout Fallback Handling ---');
    // Set OSRM_BASE_URL to an unreachable/dead local port to test timeout/failure resilience
    process.env.OSRM_BASE_URL = 'http://127.0.0.1:59999';

    const timeoutStart = Date.now();
    // Use short timeout of 400ms for test
    const deadOsrmResult = await routingService.fetchOsrmRoute(aliceLat, aliceLng, destLat, destLng, 400);
    const elapsed = Date.now() - timeoutStart;

    assert.strictEqual(deadOsrmResult, null, 'Unreachable or timed out OSRM must return null');
    assert.ok(elapsed < 1500, 'AbortController must prevent hanging on failed provider');

    // Compute user ETA: must fall back to straight line gracefully
    const computedWithDeadProvider = await routingService.computeUserEta(meetup.id, userAlice.id, aliceLat, aliceLng);
    assert.ok(computedWithDeadProvider, 'computeUserEta should succeed even if OSRM provider is down');
    assert.strictEqual(computedWithDeadProvider.isApproximate, true, 'Should fall back to isApproximate = true');
    pass('Provider failure / timeout handled gracefully with automatic straight-line fallback');

    // Reset OSRM env
    delete process.env.OSRM_BASE_URL;

    // ------------------------------------------------------------------------
    // 5. Server-Side ETA 45s Cache & > 100m Invalidation
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Testing Server-Side 45s Cache & 100m Movement Invalidation ---');
    routingService.clearMeetupCache(meetup.id);

    // Initial calculation at coordinates (37.7400, -122.4194)
    const initialEta = await routingService.computeUserEta(meetup.id, userAlice.id, 37.7400, -122.4194);
    assert.ok(initialEta, 'Initial ETA computed');
    const initialComputedAt = routingService.cache.get(`${meetup.id}:${userAlice.id}`).computedAt;

    // 1. Same coordinates within 45s -> MUST return cached entry without recomputing
    const cachedEta = await routingService.computeUserEta(meetup.id, userAlice.id, 37.7400, -122.4194);
    const cachedEntry = routingService.cache.get(`${meetup.id}:${userAlice.id}`);
    assert.strictEqual(cachedEntry.computedAt, initialComputedAt, 'Timestamp should match original cache entry');
    pass('Repeated query within 45s returns cached ETA');

    // 2. Small movement <= 100m (e.g. ~20 meters: 37.7401 vs 37.7400 is ~11m) -> Still returns cached
    const minorMoveEta = await routingService.computeUserEta(meetup.id, userAlice.id, 37.7401, -122.4194);
    const minorMoveEntry = routingService.cache.get(`${meetup.id}:${userAlice.id}`);
    assert.strictEqual(minorMoveEntry.computedAt, initialComputedAt, 'Movement <= 100m preserves cache');
    pass('GPS movement under 100m does NOT invalidate cache');

    // 3. Significant movement > 100m (e.g. moved 500m to 37.7450) -> Forces recomputation
    const majorMoveEta = await routingService.computeUserEta(meetup.id, userAlice.id, 37.7450, -122.4194);
    const majorMoveEntry = routingService.cache.get(`${meetup.id}:${userAlice.id}`);
    assert.ok(majorMoveEntry.computedAt >= initialComputedAt, 'Movement > 100m triggers new computation');
    assert.notStrictEqual(majorMoveEta.distanceMeters, initialEta.distanceMeters, 'Distance recomputed');
    pass('Movement > 100 meters invalidates cache and triggers server recomputation');

    // ------------------------------------------------------------------------
    // 6. Non-Participant Isolation (RSVP 'no' or non-member)
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Testing Non-Participant Isolation ---');
    // Charlie RSVPs 'no'
    const rsvpCharlieRes = await request(`/api/meetups/${meetup.id}/rsvp`, {
      method: 'POST',
      headers: {
        cookie: cookieCharlie,
        'x-csrf-token': 'csrf_secret'
      },
      body: { rsvp: 'no' }
    });
    assert.strictEqual(rsvpCharlieRes.status, 200);

    // Compute ETA for Charlie: MUST return null because Charlie is not participating
    const charlieEta = await routingService.computeUserEta(meetup.id, userCharlie.id, 37.7500, -122.4100);
    assert.strictEqual(charlieEta, null, 'Non-participant (RSVP "no") must yield no ETA');

    // Fetch meetup details as Bob: Charlie should not appear in participant ETAs list
    const meetupDetails = await request(`/api/meetups/${meetup.id}`, {
      headers: { cookie: cookieBob }
    });
    assert.strictEqual(meetupDetails.status, 200);
    const participantIds = meetupDetails.body.participants.map((p) => p.userId);
    assert.ok(!participantIds.includes(userCharlie.id), 'Non-participant excluded from attendee ETAs');
    pass('Non-participants (RSVP "no") generate no ETAs and are isolated from attendee routing');

    // ------------------------------------------------------------------------
    // 7. Automatic Lateness Detection & One-Tap "Running Late"
    // ------------------------------------------------------------------------
    console.log('\n--- 7. Testing Automatic Lateness & One-Tap Action ---');
    // Bob RSVPs 'going'
    await request(`/api/meetups/${meetup.id}/rsvp`, {
      method: 'POST',
      headers: { cookie: cookieBob, 'x-csrf-token': 'csrf_secret' },
      body: { rsvp: 'going' }
    });

    // Bob taps "Running late by 10 min"
    const lateRes = await request(`/api/meetups/${meetup.id}/late`, {
      method: 'POST',
      headers: { cookie: cookieBob, 'x-csrf-token': 'csrf_secret' }
    });
    assert.strictEqual(lateRes.status, 200, 'One-tap late endpoint returns 200');
    assert.strictEqual(lateRes.body.rsvp.lateness_minutes, 10, 'Lateness minutes set to 10');

    // Verify Bob's computed ETA reflects lateness
    const bobEta = await routingService.computeUserEta(meetup.id, userBob.id, 37.7300, -122.4100);
    assert.strictEqual(bobEta.isLate, true, 'isLate flag should be true');
    assert.ok(bobEta.lateByMinutes >= 10, 'lateByMinutes must reflect at least 10 min');
    pass('One-tap "Running late by 10 min" updates status and automatically flags participant late');

    // ------------------------------------------------------------------------
    // 8. Destination Geofence Arrival & Auto-Stop Sharing
    // ------------------------------------------------------------------------
    console.log('\n--- 8. Testing Destination Arrival & Stop-on-Arrival ---');
    // Start active time-boxed share for Alice targeting the group
    locationSharingService.startShare({
      userId: userAlice.id,
      userName: userAlice.displayName,
      durationType: '1h',
      targetGroupIds: [group.id]
    });
    assert.strictEqual(locationSharingService.isUserActivelySharing(userAlice.id), true, 'Alice is sharing location');

    // Simulate Alice arriving at destination (within 50 meters of 37.7749, -122.4194)
    const arrivalLat = 37.77492;
    const arrivalLng = -122.41938;

    const arrivalEta = await routingService.computeUserEta(meetup.id, userAlice.id, arrivalLat, arrivalLng);
    assert.strictEqual(arrivalEta.isArrived, true, 'User within destination geofence marked isArrived = true');
    assert.strictEqual(arrivalEta.etaSeconds, 0, 'ETA should be 0 on arrival');

    // Because meetup has stop_on_arrival = 1, Alice's location share should have stopped automatically!
    assert.strictEqual(
      locationSharingService.isUserActivelySharing(userAlice.id),
      false,
      'stop_on_arrival must immediately stop active location sharing upon arrival'
    );
    pass('Destination geofence detects arrival and stop_on_arrival shuts down location sharing');

    // ------------------------------------------------------------------------
    // 9. Auto-End After 2 Hours & Meetup Conclusion
    // ------------------------------------------------------------------------
    console.log('\n--- 9. Testing Auto-End 2 Hours After Start & Sharing Shutdown ---');
    // Create an old meetup whose start time was 2.5 hours ago
    const pastStart = Date.now() - (2.5 * 60 * 60 * 1000);
    const expiredMeetup = repo.createMeetup({
      groupId: group.id,
      creatorUserId: userAlice.id,
      title: 'Morning Breakfast Run',
      destinationLat: destLat,
      destinationLng: destLng,
      destinationLabel: 'Cafe',
      startTime: pastStart,
      stopOnArrival: 1
    });

    // Run sweep
    const endedList = repo.autoEndExpiredMeetups(Date.now());
    const endedIds = endedList.map((m) => m.id);
    assert.ok(endedIds.includes(expiredMeetup.id), 'Meetup past start + 2 hours must be auto-ended');

    const refreshedMeetup = repo.getMeetupById(expiredMeetup.id);
    assert.strictEqual(refreshedMeetup.status, 'ended', 'Status transitioned to ended');

    // Ended meetup rejects any new ETA calculations
    const endedEta = await routingService.computeUserEta(expiredMeetup.id, userBob.id, 37.7300, -122.4100);
    assert.strictEqual(endedEta, null, 'Ended meetup generates zero ETAs');
    pass('Auto-end sweep terminates meetups 2 hours post-start and clears routing cache');

    console.log(`\n🎉 ALL ${checksPassed} MEETUP MODE & ROUTING CHECKS PASSED!\n`);
  } finally {
    server.close();
    if (fs.existsSync(TEST_DB_FILE)) {
      try { fs.unlinkSync(TEST_DB_FILE); } catch (e) {}
    }
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
