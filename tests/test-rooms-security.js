const { io: ioClient } = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { RoomManager, RateLimiter, validateCoordinates, validateMessage } = require('../roomManager');

// Helper to wait for ms
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTests() {
  console.log('🧪 Starting Backend Security & Room Isolation Test Suite...\n');

  // Set up test server on dynamic port
  const { app, server, roomManager } = require('../app');
  const TEST_PORT = 3456;
  
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  console.log(`📡 Test server running on http://localhost:${TEST_PORT}`);

  const baseUrl = `http://localhost:${TEST_PORT}`;
  let passedTests = 0;
  let totalTests = 0;

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

  try {
    // TEST 1: Room Creation & Token Validation
    console.log('\n--- 1. Testing Room Token Validation & Expiration ---');
    const room1 = roomManager.createRoom(60000); // 60s ttl
    const room2 = roomManager.createRoom(60000);
    const expiredRoom = roomManager.createRoom(-1000); // Already expired

    assert(roomManager.validateInvite(room1.roomId, room1.token).valid === true, 'Valid room and token accepted');
    assert(roomManager.validateInvite(room1.roomId, 'wrong-token-abc').valid === false, 'Invalid token rejected');
    assert(roomManager.validateInvite('nonexistent-id', room1.token).valid === false, 'Unknown roomId rejected');
    assert(roomManager.validateInvite(expiredRoom.roomId, expiredRoom.token).valid === false, 'Expired room rejected');

    // TEST 2: Two different rooms cannot receive one another's messages
    console.log('\n--- 2. Testing Chat Room Isolation ---');
    const clientA = ioClient(`${baseUrl}/chat`, { forceNew: true });
    const clientB = ioClient(`${baseUrl}/chat`, { forceNew: true });
    const clientC = ioClient(`${baseUrl}/chat`, { forceNew: true });

    // Join A & B into Room 1, C into Room 2
    const joinA = await new Promise((res) => clientA.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'Alice' }, res));
    const joinB = await new Promise((res) => clientB.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'Bob' }, res));
    const joinC = await new Promise((res) => clientC.emit('join-room', { roomId: room2.roomId, token: room2.token, name: 'Charlie' }, res));

    assert(joinA.success && joinA.displayName === 'Alice', 'Client A joined Room 1 as Alice');
    assert(joinB.success && joinB.displayName === 'Bob', 'Client B joined Room 1 as Bob');
    assert(joinC.success && joinC.displayName === 'Charlie', 'Client C joined Room 2 as Charlie');

    let clientBReceived = null;
    let clientCReceived = null;

    clientB.on('receive', (msg) => { clientBReceived = msg; });
    clientC.on('receive', (msg) => { clientCReceived = msg; });

    // Client A sends message in Room 1
    await new Promise((res) => clientA.emit('send', { message: 'Secret message for Room 1' }, res));
    await sleep(150);

    assert(clientBReceived !== null && clientBReceived.message === 'Secret message for Room 1', 'Client B in Room 1 received message');
    assert(clientCReceived === null, 'Client C in Room 2 DID NOT receive message from Room 1 (Room Isolation verified)');

    // TEST 3: Identity Spoofing Prevention
    console.log('\n--- 3. Testing Identity Spoofing Prevention ---');
    clientBReceived = null;
    // Client A tries to spoof name as "ElonMusk" in payload
    await new Promise((res) => clientA.emit('send', { name: 'ElonMusk', message: 'I am Elon' }, res));
    await sleep(150);

    assert(clientBReceived !== null && clientBReceived.name === 'Alice', 'Sender identity strictly derived from server session (name spoofing prevented)');

    // Test duplicate nickname handling within a room
    const clientA2 = ioClient(`${baseUrl}/chat`, { forceNew: true });
    const joinA2 = await new Promise((res) => clientA2.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'Alice' }, res));
    assert(joinA2.success && joinA2.displayName === 'Alice (2)', 'Duplicate nickname handled gracefully with suffix');
    clientA2.disconnect();

    // TEST 4: Unauthorized Socket Message Rejection
    console.log('\n--- 4. Testing Non-Member Message Rejection ---');
    const unauthorizedClient = ioClient(`${baseUrl}/chat`, { forceNew: true });
    await sleep(100);

    let unauthError = null;
    unauthorizedClient.on('error-notice', (err) => { unauthError = err; });

    const sendRes = await new Promise((res) => unauthorizedClient.emit('send', { message: 'Hacker message' }, res));
    await sleep(150);

    assert(sendRes.success === false, 'Non-member message rejected in callback');
    assert(unauthError && unauthError.code === 'UNAUTHORIZED', 'UNAUTHORIZED error emitted to rogue socket');
    unauthorizedClient.disconnect();

    // TEST 5: Location Room Isolation
    console.log('\n--- 5. Testing Location Room Isolation ---');
    const locClientA = ioClient(`${baseUrl}/location`, { forceNew: true });
    const locClientB = ioClient(`${baseUrl}/location`, { forceNew: true });
    const locClientC = ioClient(`${baseUrl}/location`, { forceNew: true });

    await new Promise((res) => locClientA.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'LocAlice' }, res));
    await new Promise((res) => locClientB.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'LocBob' }, res));
    await new Promise((res) => locClientC.emit('join-room', { roomId: room2.roomId, token: room2.token, name: 'LocCharlie' }, res));

    let locBReceived = null;
    let locCReceived = null;

    locClientB.on('receive-location', (data) => { locBReceived = data; });
    locClientC.on('receive-location', (data) => { locCReceived = data; });

    // LocClientA emits coordinates
    await new Promise((res) => locClientA.emit('send-location', { latitude: 37.7749, longitude: -122.4194 }, res));
    await sleep(150);

    assert(locBReceived !== null && locBReceived.latitude === 37.7749, 'Location peer B in Room 1 received coordinates');
    assert(locBReceived.name === 'LocAlice', 'Location identity derived authoritatively from server session');
    assert(locCReceived === null, 'Location peer C in Room 2 DID NOT receive coordinates from Room 1');

    // TEST 6: Invalid Coordinate Validation
    console.log('\n--- 6. Testing Coordinate Validation & Bounds ---');
    let coordError = null;
    locClientA.on('error-notice', (err) => { coordError = err; });

    // Out of bounds latitude (> 90)
    const badCoordRes = await new Promise((res) => locClientA.emit('send-location', { latitude: 120.5, longitude: 45.0 }, res));
    assert(badCoordRes.success === false, 'Invalid latitude (>90) rejected by server');

    // NaN / string coords
    const nanCoordRes = await new Promise((res) => locClientA.emit('send-location', { latitude: 'invalid', longitude: null }, res));
    assert(nanCoordRes.success === false, 'Non-numeric coordinates rejected by server');

    // TEST 7: Rate Limiting Enforcement
    console.log('\n--- 7. Testing Rate Limiting ---');
    let rateLimitHit = false;
    // Rapidly send 10 messages (limit is 5 per 2s)
    for (let i = 0; i < 10; i++) {
      const res = await new Promise((r) => clientA.emit('send', { message: `Flood ${i}` }, r));
      if (res && res.success === false) {
        rateLimitHit = true;
      }
    }
    assert(rateLimitHit === true, 'Rate limiter actively throttled excessive message flood');

    // TEST 8: Disconnect & Membership Cleanup
    console.log('\n--- 8. Testing Disconnect Cleanup ---');
    let peerLeftNotified = false;
    clientB.on('left', (name) => {
      if (name === 'Alice') peerLeftNotified = true;
    });

    clientA.disconnect();
    await sleep(200);

    assert(peerLeftNotified === true, 'Remaining room members notified on peer disconnect');
    const activeRoom1 = roomManager.rooms.get(room1.roomId);
    assert(activeRoom1 && activeRoom1.members.has(clientA.id) === false, 'Disconnected socket removed from room registry');

    // TEST 9: Prompt 2 - Location Snapshot & Late Joiner State
    console.log('\n--- 9. Testing Location Snapshot & Active Sharer State ---');
    // locClientA is sharing location in Room 1. Let's send an update.
    await new Promise((res) => locClientA.emit('send-location', { latitude: 37.7749, longitude: -122.4194 }, res));
    await sleep(100);

    // Now a late participant (locClientD) joins Room 1
    const locClientD = ioClient(`${baseUrl}/location`, { forceNew: true });
    let snapshotReceived = null;
    locClientD.on('location-snapshot', (snap) => { snapshotReceived = snap; });

    const joinD = await new Promise((res) => locClientD.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'LocDave' }, res));
    await sleep(150);

    assert(joinD.success === true, 'Late joiner Dave joined Room 1');
    assert(Array.isArray(snapshotReceived) && snapshotReceived.length >= 1, 'Late joiner received location snapshot');
    const sharerA = snapshotReceived.find((s) => s.id === locClientA.id);
    assert(sharerA && sharerA.latitude === 37.7749 && sharerA.name === 'LocAlice', 'Snapshot contains active sharer Alice with correct coordinates');
    assert(typeof sharerA.updatedAt === 'number', 'Snapshot contains server-generated updatedAt timestamp');

    // TEST 10: Explicit Stop Location Sharing
    console.log('\n--- 10. Testing Explicit Stop Location Sharing ---');
    let stopEventReceived = null;
    locClientD.on('location-stopped', (ev) => { stopEventReceived = ev; });

    // Alice explicitly stops sharing
    const stopRes = await new Promise((res) => locClientA.emit('stop-location', {}, res));
    await sleep(150);

    assert(stopRes && stopRes.success === true, 'Stop location acknowledged by server');
    assert(stopEventReceived !== null && stopEventReceived.id === locClientA.id, 'Peers received location-stopped event for Alice');

    // Verify room state no longer holds Alice's location
    const room1Obj = roomManager.rooms.get(room1.roomId);
    assert(room1Obj.locations.has(locClientA.id) === false, 'Alice removed from room active locations map');

    // A new joiner now should get an empty snapshot
    const locClientE = ioClient(`${baseUrl}/location`, { forceNew: true });
    let snapE = null;
    locClientE.on('location-snapshot', (s) => { snapE = s; });
    await new Promise((res) => locClientE.emit('join-room', { roomId: room1.roomId, token: room1.token, name: 'LocEve' }, res));
    await sleep(150);
    assert(Array.isArray(snapE) && snapE.length === 0, 'New joiner receives empty snapshot after sharer stopped');

    locClientD.disconnect();
    locClientE.disconnect();

    // TEST 11: Prompt 3 - Unified Workspace on Root Namespace
    console.log('\n--- 11. Testing Unified Workspace (Chat + Map on Root Namespace) ---');
    const uRoom1 = roomManager.createRoom(60000);
    const uRoom2 = roomManager.createRoom(60000);

    const uClientA = ioClient(baseUrl, { forceNew: true });
    const uClientB = ioClient(baseUrl, { forceNew: true });
    const uClientC = ioClient(baseUrl, { forceNew: true });

    let uParticipantsB = null;
    uClientB.on('participants-updated', (p) => { uParticipantsB = p; });

    const uJoinA = await new Promise((res) => uClientA.emit('join-room', { roomId: uRoom1.roomId, token: uRoom1.token, name: 'UnifiedAlice' }, res));
    const uJoinB = await new Promise((res) => uClientB.emit('join-room', { roomId: uRoom1.roomId, token: uRoom1.token, name: 'UnifiedBob' }, res));
    const uJoinC = await new Promise((res) => uClientC.emit('join-room', { roomId: uRoom2.roomId, token: uRoom2.token, name: 'UnifiedCharlie' }, res));

    assert(uJoinA.success === true && uJoinA.displayName === 'UnifiedAlice', 'Unified Client A joined Room 1');
    assert(uJoinB.success === true && uJoinB.displayName === 'UnifiedBob', 'Unified Client B joined Room 1');
    assert(uJoinC.success === true && uJoinC.displayName === 'UnifiedCharlie', 'Unified Client C joined Room 2');

    await sleep(150);
    assert(Array.isArray(uParticipantsB) && uParticipantsB.length === 2, 'Unified Client B received participants list with 2 members');

    // Test Unified Chat Isolation
    let uMsgB = null;
    let uMsgC = null;
    uClientB.on('receive', (msg) => { uMsgB = msg; });
    uClientC.on('receive', (msg) => { uMsgC = msg; });

    await new Promise((res) => uClientA.emit('send', { message: 'Hello from Unified Alice' }, res));
    await sleep(150);

    assert(uMsgB !== null && uMsgB.message === 'Hello from Unified Alice', 'Unified Client B received chat message in Room 1');
    assert(uMsgB.name === 'UnifiedAlice', 'Sender name authoritatively enforced');
    assert(typeof uMsgB.timestamp === 'number', 'Server timestamp present in chat');
    assert(uMsgC === null, 'Unified Client C in Room 2 DID NOT receive chat from Room 1');

    // Test Unified Location Sharing & Presence Sync
    let uLocB = null;
    let uLocC = null;
    uClientB.on('receive-location', (loc) => { uLocB = loc; });
    uClientC.on('receive-location', (loc) => { uLocC = loc; });

    await new Promise((res) => uClientA.emit('send-location', { latitude: 51.5074, longitude: -0.1278 }, res));
    await sleep(150);

    assert(uLocB !== null && uLocB.latitude === 51.5074, 'Unified Client B received location update');
    assert(uLocB.name === 'UnifiedAlice', 'Authoritative name attached to location update');
    assert(uLocC === null, 'Unified Client C in Room 2 DID NOT receive location from Room 1');

    // Verify participants list reflects location sharing
    const aliceInList = uParticipantsB.find((p) => p.name === 'UnifiedAlice');
    assert(aliceInList && aliceInList.isSharingLocation === true, 'Presence list shows Alice is actively sharing location');

    // Test Unified Stop Location
    let uLocStoppedB = null;
    uClientB.on('location-stopped', (ev) => { uLocStoppedB = ev; });

    await new Promise((res) => uClientA.emit('stop-location', {}, res));
    await sleep(150);

    assert(uLocStoppedB !== null && uLocStoppedB.id === uClientA.id, 'Unified Client B received location-stopped event');
    const aliceAfterStop = uParticipantsB.find((p) => p.name === 'UnifiedAlice');
    assert(aliceAfterStop && aliceAfterStop.isSharingLocation === false, 'Presence list updated to show Alice stopped sharing');

    // TEST 12: Shared Rendezvous Point ("Meet Here")
    console.log('\n--- 12. Testing Shared Rendezvous Point ("Meet Here") ---');
    let uRendezvousB = null;
    let uRendezvousC = null;
    uClientB.on('rendezvous-updated', (r) => { uRendezvousB = r; });
    uClientC.on('rendezvous-updated', (r) => { uRendezvousC = r; });

    const setRes = await new Promise((res) => uClientA.emit('set-rendezvous', { latitude: 18.5204, longitude: 73.8567, label: 'Food Court Gate 2' }, res));
    await sleep(150);

    assert(setRes && setRes.success === true, 'Set rendezvous acknowledged by server');
    assert(uRendezvousB !== null && uRendezvousB.label === 'Food Court Gate 2', 'Unified Client B in Room 1 received rendezvous update');
    assert(uRendezvousC === null, 'Unified Client C in Room 2 DID NOT receive rendezvous from Room 1');

    // Test Clear Rendezvous
    let uClearedB = false;
    uClientB.on('rendezvous-cleared', () => { uClearedB = true; });
    await new Promise((res) => uClientA.emit('clear-rendezvous', {}, res));
    await sleep(150);
    assert(uClearedB === true, 'Unified Client B received rendezvous-cleared event');

    // TEST 13: Emergency SOS Beacon & Ghost Mode
    console.log('\n--- 13. Testing Ghost Mode & Emergency SOS Beacon ---');
    // Test Ghost Mode Location Emission
    let uGhostLocB = null;
    uClientB.on('receive-location', (loc) => { uGhostLocB = loc; });
    await new Promise((res) => uClientA.emit('send-location', { latitude: 18.5204, longitude: 73.8567, isGhost: true }, res));
    await sleep(150);
    assert(uGhostLocB !== null && uGhostLocB.isGhost === true, 'Unified Client B received location update with Ghost Mode flag');

    // Test Emergency SOS Alert
    let uSosAlertB = null;
    let uSosAlertC = null;
    uClientB.on('sos-broadcast', (alert) => { uSosAlertB = alert; });
    uClientC.on('sos-broadcast', (alert) => { uSosAlertC = alert; });

    await new Promise((res) => uClientA.emit('sos-alert', { latitude: 18.5204, longitude: 73.8567 }, res));
    await sleep(150);

    assert(uSosAlertB !== null && uSosAlertB.name === 'UnifiedAlice', 'Unified Client B received SOS broadcast for Alice');
    assert(uSosAlertC === null, 'Unified Client C in Room 2 DID NOT receive SOS broadcast from Room 1');

    // Test Leave Room
    let uLeftB = null;
    uClientB.on('left', (name) => { uLeftB = name; });

    await new Promise((res) => uClientA.emit('leave-room', {}, res));
    await sleep(150);

    assert(uLeftB === 'UnifiedAlice', 'Unified Client B notified of Alice leaving room');
    assert(uParticipantsB.length === 1 && uParticipantsB[0].name === 'UnifiedBob', 'Presence list updated after member left');

    uClientA.disconnect();
    uClientB.disconnect();
    uClientC.disconnect();

    // Cleanup remaining sockets
    clientB.disconnect();
    clientC.disconnect();
    locClientA.disconnect();
    locClientB.disconnect();
    locClientC.disconnect();

    console.log(`\n🎉 ALL ${totalTests} SECURITY & ARCHITECTURE CHECKS PASSED!\n`);
  } finally {
    server.close();
  }
}

runTests().catch((err) => {
  console.error('\n❌ Test Suite Failed with Error:', err);
  process.exit(1);
});
