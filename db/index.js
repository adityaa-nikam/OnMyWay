const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const { runMigrations } = require('./migrate');

// Configure database file location
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

let dbInstance = null;

function getDb(customPath = null) {
  if (!dbInstance || customPath) {
    const dbPath = customPath || process.env.DATABASE_PATH || path.join(DATA_DIR, 'onmyway.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    if (!customPath) {
      dbInstance = db;
    } else {
      return db;
    }
  }
  return dbInstance;
}

// -----------------------------------------------------------------------------
// Thin Repository Layer (Swappable for PostgreSQL in the future)
// -----------------------------------------------------------------------------
class Repository {
  constructor(db) {
    this.db = db || getDb();
  }

  // --- Users ---
  createUser({ email, displayName, avatarUrl = null }) {
    const id = 'u_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO users (id, email, display_name, avatar_url, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, email.toLowerCase().trim(), displayName.trim(), avatarUrl, now, now);
    return this.getUserById(id);
  }

  _formatUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name,
      display_name: row.display_name,
      avatarUrl: row.avatar_url,
      avatar_url: row.avatar_url,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  getUserById(id) {
    return this._formatUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  getUserByEmail(email) {
    return this._formatUser(this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()));
  }

  updateUser(id, { displayName, avatarUrl }) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE users SET display_name = COALESCE(?, display_name),
                       avatar_url = COALESCE(?, avatar_url),
                       updated_at = ?
      WHERE id = ?
    `).run(displayName, avatarUrl, now, id);
    return this.getUserById(id);
  }

  deleteUser(id) {
    const info = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // --- Auth Tokens (Passwordless Magic Links) ---
  createAuthToken({ tokenHash, email, expiresAt }) {
    const id = 'tok_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO auth_tokens (id, token_hash, email, expires_at, used_at, created_at)
      VALUES (?, ?, ?, ?, NULL, ?)
    `).run(id, tokenHash, email.toLowerCase().trim(), expiresAt, now);
    return { id, tokenHash, email, expiresAt };
  }

  getAuthToken(tokenHash) {
    const row = this.db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      tokenHash: row.token_hash,
      token_hash: row.token_hash,
      email: row.email,
      expiresAt: row.expires_at,
      expires_at: row.expires_at,
      usedAt: row.used_at,
      used_at: row.used_at,
      createdAt: row.created_at,
      created_at: row.created_at
    };
  }

  markAuthTokenUsed(tokenHash) {
    const now = Date.now();
    const info = this.db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL')
      .run(now, tokenHash);
    return info.changes > 0;
  }

  // --- Sessions ---
  createSession({ tokenHash, userId, expiresAt }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
      VALUES (?, ?, ?, ?)
    `).run(tokenHash, userId, expiresAt, now);
    return { tokenHash, userId, expiresAt };
  }

  getSession(tokenHash) {
    const row = this.db.prepare(`
      SELECT s.token_hash, s.user_id, s.expires_at, s.created_at,
             u.email, u.display_name, u.avatar_url
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(tokenHash, Date.now());
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      expiresAt: row.expires_at,
      user: {
        id: row.user_id,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url
      }
    };
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  cleanupExpiredSessions() {
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
  }

  // --- Groups ---
  createGroup({ name, ownerId, messageRetentionDays = 30 }) {
    const id = 'g_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();

    const createTx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO groups (id, name, owner_id, message_retention_days, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, name.trim(), ownerId, messageRetentionDays, now, now);

      this.db.prepare(`
        INSERT INTO group_members (group_id, user_id, role, joined_at, last_read_message_id)
        VALUES (?, ?, 'owner', ?, NULL)
      `).run(id, ownerId, now);
    });

    createTx();
    return this.getGroupById(id);
  }

  getGroupById(id) {
    return this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) || null;
  }

  getUserGroups(userId) {
    return this.db.prepare(`
      SELECT g.*, gm.role, gm.joined_at, gm.last_read_message_id,
             (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) AS member_count,
             (SELECT COUNT(*) FROM messages WHERE group_id = g.id) AS total_messages
      FROM groups g
      JOIN group_members gm ON g.id = gm.group_id
      WHERE gm.user_id = ?
      ORDER BY g.updated_at DESC
    `).all(userId);
  }

  updateGroup(id, { name, messageRetentionDays }) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE groups SET name = COALESCE(?, name),
                        message_retention_days = COALESCE(?, message_retention_days),
                        updated_at = ?
      WHERE id = ?
    `).run(name ? name.trim() : null, messageRetentionDays, now, id);
    return this.getGroupById(id);
  }

  deleteGroup(id) {
    const info = this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // --- Group Members ---
  addGroupMember({ groupId, userId, role = 'member' }) {
    const now = Date.now();
    this.db.prepare(`
      INSERT OR IGNORE INTO group_members (group_id, user_id, role, joined_at, last_read_message_id)
      VALUES (?, ?, ?, ?, NULL)
    `).run(groupId, userId, role, now);
    return this.getGroupMember(groupId, userId);
  }

  removeGroupMember(groupId, userId) {
    const info = this.db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    return info.changes > 0;
  }

  getGroupMember(groupId, userId) {
    return this.db.prepare(`
      SELECT gm.*, u.email, u.display_name, u.avatar_url
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ? AND gm.user_id = ?
    `).get(groupId, userId) || null;
  }

  getGroupMembers(groupId) {
    return this.db.prepare(`
      SELECT gm.*, u.email, u.display_name, u.avatar_url
      FROM group_members gm
      JOIN users u ON gm.user_id = u.id
      WHERE gm.group_id = ?
      ORDER BY CASE gm.role WHEN 'owner' THEN 1 ELSE 2 END, gm.joined_at ASC
    `).all(groupId);
  }

  updateLastReadMessage(groupId, userId, messageId) {
    this.db.prepare(`
      UPDATE group_members SET last_read_message_id = ?
      WHERE group_id = ? AND user_id = ?
    `).run(messageId, groupId, userId);
  }

  // --- Invites ---
  createInvite({ tokenHash, groupId, createdBy, expiresAt, maxUses = null }) {
    const id = 'inv_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO invites (id, token_hash, group_id, created_by, expires_at, max_uses, uses, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)
    `).run(id, tokenHash, groupId, createdBy, expiresAt, maxUses, now);
    return { id, tokenHash, groupId, createdBy, expiresAt, maxUses, uses: 0 };
  }

  getInviteByHash(tokenHash) {
    return this.db.prepare(`
      SELECT i.*, g.name AS group_name
      FROM invites i
      JOIN groups g ON i.group_id = g.id
      WHERE i.token_hash = ?
    `).get(tokenHash) || null;
  }

  incrementInviteUses(inviteId) {
    const info = this.db.prepare(`
      UPDATE invites SET uses = uses + 1
      WHERE id = ? AND (max_uses IS NULL OR uses < max_uses) AND expires_at > ?
    `).run(inviteId, Date.now());
    return info.changes > 0;
  }

  deleteInvite(inviteId) {
    const info = this.db.prepare('DELETE FROM invites WHERE id = ?').run(inviteId);
    return info.changes > 0;
  }

  getGroupInvites(groupId) {
    return this.db.prepare('SELECT * FROM invites WHERE group_id = ? AND expires_at > ? ORDER BY created_at DESC')
      .all(groupId, Date.now());
  }

  // --- Messages & Cursor Pagination ---
  createMessage({ groupId, userId, body, replyToId = null, clientMsgId = null }) {
    if (clientMsgId) {
      const existing = this.db.prepare('SELECT id FROM messages WHERE group_id = ? AND client_msg_id = ?').get(groupId, clientMsgId);
      if (existing) {
        return this.getMessageById(existing.id);
      }
    }
    const id = 'm_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO messages (id, group_id, user_id, body, reply_to_id, client_msg_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, groupId, userId, body.trim(), replyToId, clientMsgId, now);

    // Update group updated_at
    this.db.prepare('UPDATE groups SET updated_at = ? WHERE id = ?').run(now, groupId);

    return this.getMessageById(id);
  }

  getMessageById(id) {
    return this.db.prepare(`
      SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `).get(id) || null;
  }

  getGroupMessages(groupId, { limit = 50, beforeId = null } = {}) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);

    if (beforeId) {
      const cursor = this.db.prepare('SELECT created_at FROM messages WHERE id = ? AND group_id = ?').get(beforeId, groupId);
      if (cursor) {
        return this.db.prepare(`
          SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
          FROM messages m
          JOIN users u ON m.user_id = u.id
          WHERE m.group_id = ? AND m.created_at < ?
          ORDER BY m.created_at DESC
          LIMIT ?
        `).all(groupId, cursor.created_at, safeLimit).reverse();
      }
    }

    return this.db.prepare(`
      SELECT m.*, u.display_name AS sender_name, u.avatar_url AS sender_avatar
      FROM messages m
      JOIN users u ON m.user_id = u.id
      WHERE m.group_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(groupId, safeLimit).reverse();
  }

  pruneOldMessages(groupId, retentionDays) {
    if (!retentionDays || retentionDays <= 0) return 0;
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const info = this.db.prepare('DELETE FROM messages WHERE group_id = ? AND created_at < ?').run(groupId, cutoff);
    return info.changes;
  }

  // --- Time-Boxed Location Shares ---
  createLocationShare({ userId, durationType, expiresAt, destinationLat = null, destinationLng = null, destinationName = null, targetGroupIds = [] }) {
    // End any existing active share for this user first
    const now = Date.now();
    this.stopActiveLocationShares(userId, 'superseded');

    const id = 'ls_' + crypto.randomBytes(8).toString('hex');
    const groupIdsJson = JSON.stringify(targetGroupIds);
    this.db.prepare(`
      INSERT INTO location_shares (
        id, user_id, duration_type, expires_at,
        destination_lat, destination_lng, destination_name,
        target_group_ids, is_active, started_at, stopped_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)
    `).run(id, userId, durationType, expiresAt, destinationLat, destinationLng, destinationName, groupIdsJson, now);

    this.addLocationShareLog({
      userId,
      action: 'started',
      targetGroups: groupIdsJson
    });

    return this.getLocationShareById(id);
  }

  getLocationShareById(id) {
    const row = this.db.prepare('SELECT * FROM location_shares WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      target_group_ids: JSON.parse(row.target_group_ids || '[]')
    };
  }

  getActiveLocationShare(userId) {
    const row = this.db.prepare('SELECT * FROM location_shares WHERE user_id = ? AND is_active = 1').get(userId);
    if (!row) return null;
    return {
      ...row,
      target_group_ids: JSON.parse(row.target_group_ids || '[]')
    };
  }

  getAllActiveLocationShares() {
    const rows = this.db.prepare('SELECT * FROM location_shares WHERE is_active = 1').all();
    return rows.map((r) => ({
      ...r,
      target_group_ids: JSON.parse(r.target_group_ids || '[]')
    }));
  }

  updateLocationShareExpiry(shareId, newExpiresAt) {
    this.db.prepare('UPDATE location_shares SET expires_at = ? WHERE id = ? AND is_active = 1').run(newExpiresAt, shareId);
    const updated = this.getLocationShareById(shareId);
    if (updated) {
      this.addLocationShareLog({
        userId: updated.user_id,
        action: 'extended',
        targetGroups: JSON.stringify(updated.target_group_ids)
      });
    }
    return updated;
  }

  stopLocationShare(shareId, action = 'stopped') {
    const now = Date.now();
    const share = this.getLocationShareById(shareId);
    if (!share || !share.is_active) return null;

    this.db.prepare('UPDATE location_shares SET is_active = 0, stopped_at = ? WHERE id = ?').run(now, shareId);
    this.addLocationShareLog({
      userId: share.user_id,
      action,
      targetGroups: JSON.stringify(share.target_group_ids)
    });
    return { ...share, is_active: 0, stopped_at: now };
  }

  stopActiveLocationShares(userId, action = 'stopped') {
    const active = this.getActiveLocationShare(userId);
    if (active) {
      return this.stopLocationShare(active.id, action);
    }
    return null;
  }

  getExpiredActiveShares(now = Date.now()) {
    const rows = this.db.prepare('SELECT * FROM location_shares WHERE is_active = 1 AND expires_at IS NOT NULL AND expires_at <= ?').all(now);
    return rows.map((r) => ({
      ...r,
      target_group_ids: JSON.parse(r.target_group_ids || '[]')
    }));
  }

  // --- Location Share Logs ---
  addLocationShareLog({ userId, action, targetGroups }) {
    const id = 'log_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO location_share_logs (id, user_id, action, target_groups, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, userId, action, typeof targetGroups === 'string' ? targetGroups : JSON.stringify(targetGroups), now);
  }

  getUserLocationShareLogs(userId, limit = 50) {
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100);
    return this.db.prepare(`
      SELECT * FROM location_share_logs WHERE user_id = ? ORDER BY timestamp DESC LIMIT ?
    `).all(userId, safeLimit);
  }

  // --- Emergency SOS Events ---
  createSosEvent({ groupId, userId, senderName, lat = null, lng = null }) {
    const id = 'sos_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sos_events (id, group_id, user_id, sender_name, status, lat, lng, created_at, resolved_at, responders)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, NULL, '[]')
    `).run(id, groupId, userId, senderName, lat, lng, now);
    return this.getSosEvent(id);
  }

  getSosEvent(id) {
    const row = this.db.prepare('SELECT * FROM sos_events WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      responders: JSON.parse(row.responders || '[]')
    };
  }

  getActiveGroupSos(groupId) {
    const row = this.db.prepare("SELECT * FROM sos_events WHERE group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1").get(groupId);
    if (!row) return null;
    return {
      ...row,
      responders: JSON.parse(row.responders || '[]')
    };
  }

  addSosResponder(sosId, { userId, name }) {
    const event = this.getSosEvent(sosId);
    if (!event || event.status !== 'active') return null;

    const responders = event.responders || [];
    if (!responders.some((r) => r.userId === userId)) {
      responders.push({ userId, name, timestamp: Date.now() });
      this.db.prepare('UPDATE sos_events SET responders = ? WHERE id = ?').run(JSON.stringify(responders), sosId);
    }
    return this.getSosEvent(sosId);
  }

  cancelSosEvent(sosId, userId) {
    const event = this.getSosEvent(sosId);
    if (!event) return null;
    if (event.user_id !== userId) return null; // Only sender can cancel as false alarm

    const now = Date.now();
    this.db.prepare("UPDATE sos_events SET status = 'cancelled', resolved_at = ? WHERE id = ?").run(now, sosId);
    return this.getSosEvent(sosId);
  }

  // --- Status Pins (Opt-in single location pin with 24-hour auto-purge) ---
  createStatusPin({ groupId, userId, messageId = null, chipType, lat, lng }) {
    const id = 'pin_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO status_pins (id, group_id, user_id, message_id, chip_type, lat, lng, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, groupId, userId, messageId, chipType, lat, lng, now);
    return { id, groupId, userId, messageId, chipType, lat, lng, createdAt: now };
  }

  getStatusPinsForGroup(groupId) {
    return this.db.prepare(`
      SELECT sp.*, u.display_name AS sender_name
      FROM status_pins sp
      JOIN users u ON sp.user_id = u.id
      WHERE sp.group_id = ?
      ORDER BY sp.created_at DESC
    `).all(groupId);
  }

  pruneOldStatusPins(retentionHours = 24) {
    const cutoff = Date.now() - (retentionHours * 60 * 60 * 1000);
    const info = this.db.prepare('DELETE FROM status_pins WHERE created_at < ?').run(cutoff);
    return info.changes;
  }

  // --- Meetups & RSVPs ---
  createMeetup({ groupId, creatorUserId, title, destinationLat, destinationLng, destinationLabel, startTime, stopOnArrival = 0 }) {
    const id = 'meet_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const safeStopOnArrival = stopOnArrival ? 1 : 0;

    this.db.prepare(`
      INSERT INTO meetups (id, group_id, creator_user_id, title, destination_lat, destination_lng, destination_label, start_time, status, stop_on_arrival, created_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, NULL)
    `).run(id, groupId, creatorUserId, title, destinationLat, destinationLng, destinationLabel, startTime, safeStopOnArrival, now);

    // Default creator RSVP to 'going'
    const rsvpId = 'rsvp_' + crypto.randomBytes(8).toString('hex');
    this.db.prepare(`
      INSERT INTO meetup_rsvps (id, meetup_id, user_id, rsvp, lateness_minutes, arrived_at, updated_at)
      VALUES (?, ?, ?, 'going', 0, NULL, ?)
    `).run(rsvpId, id, creatorUserId, now);

    return this.getMeetupById(id);
  }

  getMeetupById(id) {
    const row = this.db.prepare('SELECT * FROM meetups WHERE id = ?').get(id);
    if (!row) return null;
    return {
      ...row,
      destination: {
        lat: row.destination_lat,
        lng: row.destination_lng,
        label: row.destination_label
      }
    };
  }

  getMeetupsByGroup(groupId) {
    const rows = this.db.prepare('SELECT * FROM meetups WHERE group_id = ? ORDER BY start_time ASC').all(groupId);
    return rows.map((row) => ({
      ...row,
      destination: {
        lat: row.destination_lat,
        lng: row.destination_lng,
        label: row.destination_label
      }
    }));
  }

  updateMeetupStatus(id, status) {
    const now = Date.now();
    const endedAt = status === 'ended' ? now : null;
    this.db.prepare(`
      UPDATE meetups SET status = ?, ended_at = CASE WHEN ? = 'ended' THEN ? ELSE ended_at END WHERE id = ?
    `).run(status, status, endedAt, id);
    return this.getMeetupById(id);
  }

  setMeetupRsvp({ meetupId, userId, rsvp = 'going', latenessMinutes = 0 }) {
    const id = 'rsvp_' + crypto.randomBytes(8).toString('hex');
    const now = Date.now();
    const safeRsvp = ['going', 'maybe', 'no'].includes(rsvp) ? rsvp : 'going';
    const safeLate = parseInt(latenessMinutes, 10) || 0;

    this.db.prepare(`
      INSERT INTO meetup_rsvps (id, meetup_id, user_id, rsvp, lateness_minutes, arrived_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(meetup_id, user_id) DO UPDATE SET
        rsvp = excluded.rsvp,
        lateness_minutes = excluded.lateness_minutes,
        updated_at = excluded.updated_at
    `).run(id, meetupId, userId, safeRsvp, safeLate, now);

    return this.getMeetupRsvp(meetupId, userId);
  }

  getMeetupRsvp(meetupId, userId) {
    return this.db.prepare(`
      SELECT r.*, u.display_name AS user_name, u.email
      FROM meetup_rsvps r
      JOIN users u ON r.user_id = u.id
      WHERE r.meetup_id = ? AND r.user_id = ?
    `).get(meetupId, userId);
  }

  getMeetupRsvps(meetupId) {
    return this.db.prepare(`
      SELECT r.*, u.display_name AS user_name, u.email
      FROM meetup_rsvps r
      JOIN users u ON r.user_id = u.id
      WHERE r.meetup_id = ?
      ORDER BY r.updated_at ASC
    `).all(meetupId);
  }

  markMeetupArrived(meetupId, userId, arrivedAt = Date.now()) {
    this.db.prepare(`
      UPDATE meetup_rsvps SET arrived_at = ?, updated_at = ? WHERE meetup_id = ? AND user_id = ?
    `).run(arrivedAt, arrivedAt, meetupId, userId);
    return this.getMeetupRsvp(meetupId, userId);
  }

  autoEndExpiredMeetups(now = Date.now()) {
    // Auto-end 2 hours after start_time: start_time + 2 * 60 * 60 * 1000 <= now
    const cutoff = now - (2 * 60 * 60 * 1000);
    const expired = this.db.prepare(`
      SELECT id, group_id, title FROM meetups WHERE status != 'ended' AND start_time <= ?
    `).all(cutoff);

    if (expired.length > 0) {
      this.db.prepare(`
        UPDATE meetups SET status = 'ended', ended_at = ? WHERE status != 'ended' AND start_time <= ?
      `).run(now, cutoff);
    }
    return expired;
  }
}

const defaultRepo = new Repository();

module.exports = {
  Repository,
  getDb,
  repo: defaultRepo
};
