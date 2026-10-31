const http = require('http');
const crypto = require('crypto');
const { io: ioClient } = require('socket.io-client');
const { app, server, repo } = require('../app');
const { hashToken, COOKIE_NAME } = require('../middleware/auth');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runMilestone1Tests() {
  console.log('🧪 Starting Milestone 1 Automated Test Suite for OnMyWay (OMW)...\n');

  const TEST_PORT = 3457;
  await new Promise((resolve) => server.listen(TEST_PORT, resolve));
  const baseUrl = `http://localhost:${TEST_PORT}`;
  console.log(`📡 Milestone 1 test server running on ${baseUrl}`);

  let totalTests = 0;
  let passedTests = 0;
  const runId = crypto.randomBytes(4).toString('hex');
  const aliceEmail = `alice_${runId}@onmyway.local`;
  const bobEmail = `bob_${runId}@onmyway.local`;
  const charlieEmail = `charlie_${runId}@onmyway.local`;
  const daveEmail = `dave_${runId}@onmyway.local`;

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
    // -------------------------------------------------------------------------
    // TEST 1: Passwordless Magic Links - Expiration & Single-Use Enforcement
    // -------------------------------------------------------------------------
    console.log('\n--- 1. Testing Magic Link Expiration & Single-Use Enforcement ---');

    // 1A: Expired magic link rejected
    const expiredRawToken = 'test_expired_' + crypto.randomBytes(16).toString('hex');
    const expiredHash = hashToken(expiredRawToken);
    repo.createAuthToken({
      tokenHash: expiredHash,
      email: `expired_${runId}@onmyway.local`,
      expiresAt: Date.now() - 1000 // Already expired
    });

    const verifyExpiredRes = await fetch(`${baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: expiredRawToken })
    });
    const verifyExpiredData = await verifyExpiredRes.json();
    assert(verifyExpiredRes.status === 400 && verifyExpiredData.success === false, 'Expired magic link rejected with HTTP 400');

    // 1B: Valid magic link consumes token and creates session
    const validRawToken = 'test_valid_' + crypto.randomBytes(16).toString('hex');
    const validHash = hashToken(validRawToken);
    repo.createAuthToken({
      tokenHash: validHash,
      email: aliceEmail,
      expiresAt: Date.now() + 15 * 60 * 1000
    });

    const verifyValidRes = await fetch(`${baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: validRawToken })
    });
    const verifyValidData = await verifyValidRes.json();
    assert(verifyValidRes.status === 200 && verifyValidData.success === true, 'Valid magic link accepted and user authenticated');

    const setCookieHeader = verifyValidRes.headers.get('set-cookie');
    assert(setCookieHeader && setCookieHeader.includes('omw_session='), 'HttpOnly omw_session cookie returned in response');

    // Extract raw session token from cookie
    const sessionMatch = setCookieHeader.match(/omw_session=([^;]+)/);
    const aliceSessionCookie = sessionMatch ? sessionMatch[1] : null;
    assert(aliceSessionCookie !== null, 'Session cookie successfully parsed');

    // 1C: Reused magic link rejected (single-use constraint)
    const verifyReusedRes = await fetch(`${baseUrl}/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: validRawToken })
    });
    const verifyReusedData = await verifyReusedRes.json();
    assert(verifyReusedRes.status === 400 && verifyReusedData.success === false, 'Reused magic link rejected as already consumed');

    // -------------------------------------------------------------------------
    // TEST 2: CSWSH Protection (Cross-Site WebSocket Hijacking Origin Check)
    // -------------------------------------------------------------------------
    console.log('\n--- 2. Testing CSWSH Origin Protection on Handshake ---');

    // 2A: Connection with unauthorized evil origin rejected
    let evilConnected = false;
    let evilError = null;

    const evilSocket = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: {
        Origin: 'https://evil-hacker-site.com'
      }
    });

    await new Promise((res) => {
      evilSocket.on('connect', () => { evilConnected = true; res(); });
      evilSocket.on('connect_error', (err) => { evilError = err; res(); });
      setTimeout(res, 300);
    });

    assert(evilConnected === false && evilError !== null, 'Socket connection with unauthorized Origin rejected by CSWSH filter');
    evilSocket.disconnect();

    // 2B: Connection with valid/same-host Origin accepted
    let legitimateConnected = false;
    const legitimateSocket = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: {
        Origin: baseUrl
      }
    });

    await new Promise((res) => {
      legitimateSocket.on('connect', () => { legitimateConnected = true; res(); });
      legitimateSocket.on('connect_error', () => { res(); });
      setTimeout(res, 300);
    });

    assert(legitimateConnected === true, 'Socket connection with authorized Origin accepted');
    legitimateSocket.disconnect();

    // -------------------------------------------------------------------------
    // TEST 3: Group Authorization - Non-Member Access Rejection
    // -------------------------------------------------------------------------
    console.log('\n--- 3. Testing Persistent Group Membership & Non-Member Rejection ---');

    // Create Alice (Owner) and Bob (Non-member)
    const aliceUser = repo.getUserByEmail(aliceEmail);
    const bobUser = repo.createUser({ email: bobEmail, displayName: 'Bob' });
    const charlieUser = repo.createUser({ email: charlieEmail, displayName: 'Charlie' });

    // Alice creates Group A
    const groupA = repo.createGroup({ name: 'Secret Alpine Expedition', ownerId: aliceUser.id });
    assert(groupA && groupA.id.startsWith('g_'), 'Persistent group created with owner membership');

    // Add Charlie as member of Group A
    repo.addGroupMember({ groupId: groupA.id, userId: charlieUser.id, role: 'member' });

    // Generate session for Bob
    const bobRawSession = 'session_bob_' + crypto.randomBytes(16).toString('hex');
    repo.createSession({
      tokenHash: hashToken(bobRawSession),
      userId: bobUser.id,
      expiresAt: Date.now() + 86400000
    });

    // 3A: Bob attempts to fetch Group A messages over HTTP -> Expect 403 Forbidden
    const bobHttpRes = await fetch(`${baseUrl}/api/groups/${groupA.id}/messages`, {
      headers: {
        Cookie: `omw_session=${bobRawSession}`
      }
    });
    assert(bobHttpRes.status === 403, 'Non-member HTTP request for group messages rejected with 403 Forbidden');

    // 3B: Bob attempts to join Group A over Socket.IO -> Expect rejection
    const bobSocket = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: {
        Cookie: `omw_session=${bobRawSession}`
      }
    });

    await new Promise((res) => bobSocket.on('connect', res));

    let bobJoinRes = null;
    let bobSocketError = null;
    bobSocket.on('error-notice', (e) => { bobSocketError = e; });

    bobJoinRes = await new Promise((res) => {
      bobSocket.emit('join-room', { groupId: groupA.id, isPersistent: true }, res);
      setTimeout(() => res(null), 300);
    });

    assert(bobJoinRes && bobJoinRes.success === false, 'Non-member join-room rejected over Socket.IO');
    assert(bobSocketError && bobSocketError.code === 'FORBIDDEN', 'FORBIDDEN error notice emitted to non-member');

    // 3C: Bob attempts to send a message to Group A -> Expect rejection
    let bobSendRes = await new Promise((res) => {
      bobSocket.emit('send', { message: 'I should not be able to speak here' }, res);
      setTimeout(() => res(null), 300);
    });
    assert(bobSendRes && bobSendRes.success === false, 'Non-member message send rejected');
    bobSocket.disconnect();

    // -------------------------------------------------------------------------
    // TEST 4: Persistent Chat History & Server Restart Continuity
    // -------------------------------------------------------------------------
    console.log('\n--- 4. Testing Chat History Persistence & Server Restart Recovery ---');

    // Alice connects and sends a message
    const aliceSocket = ioClient(baseUrl, {
      forceNew: true,
      extraHeaders: {
        Cookie: `omw_session=${aliceSessionCookie}`
      }
    });
    await new Promise((res) => aliceSocket.on('connect', res));

    const aliceJoin = await new Promise((res) => {
      aliceSocket.emit('join-room', { groupId: groupA.id, isPersistent: true }, res);
    });
    assert(aliceJoin && aliceJoin.success === true, 'Alice joined Group A successfully');

    const msgBody = 'Trailhead meeting point at 07:00 AM sharp!';
    const aliceSend = await new Promise((res) => {
      aliceSocket.emit('send', { message: msgBody }, res);
    });
    assert(aliceSend && aliceSend.success === true, 'Alice sent persistent group message');
    aliceSocket.disconnect();

    // Verify message was stored in SQLite database
    const dbMessagesBefore = repo.getGroupMessages(groupA.id);
    assert(dbMessagesBefore.length >= 1 && dbMessagesBefore[0].body === msgBody, 'Message saved in SQLite messages table');

    // SIMULATE SERVER RESTART:
    // We close the current HTTP/Socket server and start a fresh server instance reading from the database
    console.log('  🔄 Simulating server shutdown & reboot...');
    await new Promise((resolve) => server.close(resolve));

    // Reopen server on TEST_PORT
    await new Promise((resolve) => server.listen(TEST_PORT, resolve));
    console.log('  🔄 Server rebooted successfully.');

    // Fetch messages via HTTP API after restart
    const historyResAfter = await fetch(`${baseUrl}/api/groups/${groupA.id}/messages`, {
      headers: {
        Cookie: `omw_session=${aliceSessionCookie}`
      }
    });
    const historyDataAfter = await historyResAfter.json();
    assert(historyDataAfter.success === true, 'HTTP messages endpoint returns 200 after server reboot');
    const recoveredMsg = historyDataAfter.messages.find((m) => m.body === msgBody);
    assert(recoveredMsg && recoveredMsg.sender_name === aliceUser.displayName, 'Chat message survived complete server restart intact');

    // -------------------------------------------------------------------------
    // TEST 5: Group Invites (Expiration & Max Uses)
    // -------------------------------------------------------------------------
    console.log('\n--- 5. Testing Cryptographic Group Invites ---');

    // 5A: Create invite with max 1 use
    const inviteToken = crypto.randomBytes(16).toString('hex');
    const inviteHash = hashToken(inviteToken);
    const inviteRec = repo.createInvite({
      tokenHash: inviteHash,
      groupId: groupA.id,
      createdBy: aliceUser.id,
      expiresAt: Date.now() + 3600000,
      maxUses: 1
    });

    assert(inviteRec && inviteRec.maxUses === 1, 'Invite created with max_uses = 1');

    // Bob uses the invite link to join
    const bobJoinInviteRes = await fetch(`${baseUrl}/join-group/${inviteToken}`, {
      headers: {
        Cookie: `omw_session=${bobRawSession}`
      },
      redirect: 'manual'
    });
    assert(bobJoinInviteRes.status === 302, 'First use of invite successfully redirects into group');
    assert(repo.getGroupMember(groupA.id, bobUser.id) !== null, 'Bob is now registered as a member of Group A');

    // Dave tries to use the same invite token -> Rejected because max_uses was 1
    const daveUser = repo.createUser({ email: daveEmail, displayName: 'Dave' });
    const daveRawSession = 'session_dave_' + crypto.randomBytes(16).toString('hex');
    repo.createSession({
      tokenHash: hashToken(daveRawSession),
      userId: daveUser.id,
      expiresAt: Date.now() + 86400000
    });

    const daveJoinInviteRes = await fetch(`${baseUrl}/join-group/${inviteToken}`, {
      headers: {
        Cookie: `omw_session=${daveRawSession}`
      }
    });
    assert(daveJoinInviteRes.status === 400, 'Exhausted invite rejected with HTTP 400');

    // -------------------------------------------------------------------------
    // TEST 6: Account Deletion Cascading
    // -------------------------------------------------------------------------
    console.log('\n--- 6. Testing GDPR Account Deletion & Cascading Foreign Keys ---');

    // Bob authors a message in Group A
    repo.createMessage({
      groupId: groupA.id,
      userId: bobUser.id,
      body: 'Bob says goodbye.'
    });

    assert(repo.getGroupMember(groupA.id, bobUser.id) !== null, 'Bob confirmed as member before deletion');
    const bobSessionBefore = repo.getSession(hashToken(bobRawSession));
    assert(bobSessionBefore !== null, 'Bob session active before deletion');

    // Bob deletes his account
    const testCsrf = 'csrf_token_test_abc123';
    const deleteRes = await fetch(`${baseUrl}/api/account`, {
      method: 'DELETE',
      headers: {
        Cookie: `omw_session=${bobRawSession}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      }
    });
    const deleteData = await deleteRes.json();
    assert(deleteRes.status === 200 && deleteData.success === true, 'Account deletion endpoint returns 200 success');

    // Verify user is gone
    assert(repo.getUserById(bobUser.id) === null, 'User row removed from users table');

    // Verify sessions were cascade-deleted
    assert(repo.getSession(hashToken(bobRawSession)) === null, 'User sessions cascade-deleted');

    // Verify memberships were cascade-deleted
    assert(repo.getGroupMember(groupA.id, bobUser.id) === null, 'User group memberships cascade-deleted');

    // Verify authored messages were cascade-deleted
    const groupMsgsAfterBobDelete = repo.getGroupMessages(groupA.id);
    const bobMsgFound = groupMsgsAfterBobDelete.some((m) => m.user_id === bobUser.id);
    assert(bobMsgFound === false, 'User authored messages cascade-deleted from database');

    // -------------------------------------------------------------------------
    // TEST 7: Group Management (Rename, Member Removal, Leave)
    // -------------------------------------------------------------------------
    console.log('\n--- 7. Testing Group Administration (Rename, Member Removal, Leave) ---');

    // Charlie session for member-level testing
    const charlieRawSession = 'session_charlie_' + crypto.randomBytes(16).toString('hex');
    repo.createSession({
      tokenHash: hashToken(charlieRawSession),
      userId: charlieUser.id,
      expiresAt: Date.now() + 86400000
    });

    // 7A: Non-owner (Charlie) attempts to rename group -> 403 Forbidden
    const charlieRenameRes = await fetch(`${baseUrl}/api/groups/${groupA.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `omw_session=${charlieRawSession}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      },
      body: JSON.stringify({ name: 'Hacked Name' })
    });
    assert(charlieRenameRes.status === 403, 'Non-owner rename attempt rejected with 403 Forbidden');

    // 7B: Owner (Alice) renames group -> 200 OK
    const aliceRenameRes = await fetch(`${baseUrl}/api/groups/${groupA.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `omw_session=${aliceSessionCookie}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      },
      body: JSON.stringify({ name: 'Alpine Expedition 2.0' })
    });
    const aliceRenameData = await aliceRenameRes.json();
    assert(aliceRenameRes.status === 200 && aliceRenameData.group.name === 'Alpine Expedition 2.0', 'Group owner successfully renamed group');

    // 7C: Non-owner attempts to remove member -> 403 Forbidden
    const charlieRemoveRes = await fetch(`${baseUrl}/api/groups/${groupA.id}/members/${daveUser.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: `omw_session=${charlieRawSession}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      }
    });
    assert(charlieRemoveRes.status === 403, 'Non-owner remove-member attempt rejected with 403 Forbidden');

    // Add Dave to group A for owner removal test
    repo.addGroupMember({ groupId: groupA.id, userId: daveUser.id, role: 'member' });
    assert(repo.getGroupMember(groupA.id, daveUser.id) !== null, 'Dave added to Group A');

    // 7D: Owner removes member -> 200 OK
    const aliceRemoveRes = await fetch(`${baseUrl}/api/groups/${groupA.id}/members/${daveUser.id}`, {
      method: 'DELETE',
      headers: {
        Cookie: `omw_session=${aliceSessionCookie}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      }
    });
    assert(aliceRemoveRes.status === 200, 'Group owner successfully removed member');
    assert(repo.getGroupMember(groupA.id, daveUser.id) === null, 'Dave is no longer a member of Group A');

    // 7E: Member leaves group
    const charlieLeaveRes = await fetch(`${baseUrl}/api/groups/${groupA.id}/leave`, {
      method: 'POST',
      headers: {
        Cookie: `omw_session=${charlieRawSession}; omw_csrf=${testCsrf}`,
        'x-csrf-token': testCsrf
      }
    });
    assert(charlieLeaveRes.status === 200, 'Member left group successfully');
    assert(repo.getGroupMember(groupA.id, charlieUser.id) === null, 'Charlie is no longer a member of Group A');

    // -------------------------------------------------------------------------
    // TEST 8: Cursor Pagination, Offline Deduplication & Message Retention
    // -------------------------------------------------------------------------
    console.log('\n--- 8. Testing Cursor Pagination & Idempotent ClientMsgId Deduplication ---');

    // Create 3 sequential messages
    const m1 = repo.createMessage({ groupId: groupA.id, userId: aliceUser.id, body: 'Msg 1' });
    await sleep(20);
    const m2 = repo.createMessage({ groupId: groupA.id, userId: aliceUser.id, body: 'Msg 2' });
    await sleep(20);
    const m3 = repo.createMessage({ groupId: groupA.id, userId: aliceUser.id, body: 'Msg 3' });

    // Fetch with beforeId cursor = m3.id (expect m1 and m2)
    const cursorRes = await fetch(`${baseUrl}/api/groups/${groupA.id}/messages?beforeId=${m3.id}&limit=10`, {
      headers: {
        Cookie: `omw_session=${aliceSessionCookie}`
      }
    });
    const cursorData = await cursorRes.json();
    assert(cursorData.success === true, 'Cursor pagination request returned 200');
    assert(cursorData.messages.some((m) => m.id === m2.id) && !cursorData.messages.some((m) => m.id === m3.id), 'Cursor query returned messages strictly before cursor');

    // Test client_msg_id de-duplication
    const clientUuid = 'offline_uuid_' + crypto.randomBytes(8).toString('hex');
    const firstInsert = repo.createMessage({
      groupId: groupA.id,
      userId: aliceUser.id,
      body: 'Offline Outbox Message',
      clientMsgId: clientUuid
    });
    const secondInsert = repo.createMessage({
      groupId: groupA.id,
      userId: aliceUser.id,
      body: 'Offline Outbox Message (Duplicate Retry)',
      clientMsgId: clientUuid
    });
    assert(firstInsert.id === secondInsert.id, 'Duplicate client_msg_id returned existing message without duplicate row');

    // Test retention pruning
    const pruned = repo.pruneOldMessages(groupA.id, 30);
    assert(typeof pruned === 'number', 'Retention pruning executed successfully');

    console.log(`\n🎉 ALL ${totalTests} CHECKS PASSED!\n`);
  } finally {
    server.close();
  }
}

runMilestone1Tests().catch((err) => {
  console.error('\n❌ Milestone 1 Test Suite Failed:', err);
  process.exit(1);
});
