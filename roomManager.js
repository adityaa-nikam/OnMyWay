const crypto = require('crypto');

/**
 * In-memory Room Registry and Access Control Manager
 */
class RoomManager {
  constructor() {
    this.rooms = new Map(); // roomId -> { id, token, createdAt, expiresAt, members: Map<socketId, { name, namespace, joinedAt }> }
    this.DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    this.MAX_MEMBERS_PER_ROOM = 50;

    // Periodic cleanup of expired rooms every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredRooms();
    }, 5 * 60 * 1000);

    // Prevent interval from blocking process termination
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Create a new private room with crypto-secure ID and invitation token
   */
  createRoom(ttlMs = this.DEFAULT_TTL_MS) {
    const id = crypto.randomBytes(6).toString('hex'); // 12-char hex string
    const token = crypto.randomBytes(16).toString('hex'); // 32-char hex token
    const now = Date.now();

    const room = {
      id,
      token,
      createdAt: now,
      expiresAt: now + ttlMs,
      members: new Map(), // socketId -> member info
      locations: new Map(), // socketId -> { id, name, latitude, longitude, updatedAt, isGhost }
      rendezvous: null // { latitude, longitude, label, createdBy, createdAt }
    };

    this.rooms.set(id, room);
    return {
      roomId: id,
      token,
      expiresAt: room.expiresAt
    };
  }

  /**
   * Update or register an active location for a participant in a room
   */
  updateLocation(roomId, socketId, latitude, longitude, isGhost = false) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const member = room.members.get(socketId);
    if (!member) return null;

    const updatedAt = Date.now();
    const locData = {
      id: socketId,
      name: member.name,
      latitude,
      longitude,
      updatedAt,
      isGhost: Boolean(isGhost)
    };

    room.locations.set(socketId, locData);
    return locData;
  }

  /**
   * Set shared rendezvous / meeting point for a room
   */
  setRendezvous(roomId, latitude, longitude, label, createdBy) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    room.rendezvous = {
      latitude,
      longitude,
      label: (typeof label === 'string' && label.trim().slice(0, 50)) || 'Meeting Point',
      createdBy: createdBy || 'Participant',
      createdAt: Date.now()
    };
    return room.rendezvous;
  }

  /**
   * Clear meeting point
   */
  clearRendezvous(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.rendezvous = null;
    return true;
  }

  /**
   * Get meeting point
   */
  getRendezvous(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.rendezvous || null;
  }

  /**
   * Remove a participant's active location when they stop sharing
   */
  stopLocation(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const loc = room.locations.get(socketId);
    if (loc) {
      room.locations.delete(socketId);
      return { removed: true, id: socketId, name: loc.name };
    }
    return { removed: false };
  }

  /**
   * Get snapshot of currently active locations for a room
   */
  getLocationSnapshot(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.locations.values());
  }

  /**
   * Get list of room participants and their location-sharing status
   */
  getParticipantList(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    const list = [];
    for (const [socketId, member] of room.members.entries()) {
      list.push({
        id: socketId,
        name: member.name,
        joinedAt: member.joinedAt,
        isSharingLocation: room.locations.has(socketId)
      });
    }
    return list;
  }

  /**
   * Validate if a room exists, has not expired, and invitation token matches using timing-safe comparison
   */
  validateInvite(roomId, token) {
    if (!roomId || !token || typeof roomId !== 'string' || typeof token !== 'string') {
      return { valid: false, error: 'Room ID and invitation token are required' };
    }

    const room = this.rooms.get(roomId);
    if (!room) {
      return { valid: false, error: 'Room does not exist' };
    }

    if (Date.now() > room.expiresAt) {
      this.rooms.delete(roomId);
      return { valid: false, error: 'Room invitation has expired' };
    }

    // Timing-safe comparison of tokens to prevent timing attacks
    const tokenBuf = Buffer.from(token);
    const roomTokenBuf = Buffer.from(room.token);

    if (tokenBuf.length !== roomTokenBuf.length || !crypto.timingSafeEqual(tokenBuf, roomTokenBuf)) {
      return { valid: false, error: 'Invalid invitation token' };
    }

    return { valid: true, room };
  }

  /**
   * Sanitize and assign a unique display name within a room
   */
  assignDisplayName(room, rawName) {
    let baseName = 'Guest';
    if (typeof rawName === 'string') {
      const trimmed = rawName.trim().replace(/[\x00-\x1F\x7F]/g, '');
      if (trimmed.length > 0) {
        baseName = trimmed.slice(0, 30);
      }
    }

    // Collect existing names in this room
    const existingNames = new Set();
    for (const member of room.members.values()) {
      existingNames.add(member.name.toLowerCase());
    }

    let finalName = baseName;
    let counter = 2;
    while (existingNames.has(finalName.toLowerCase())) {
      finalName = `${baseName} (${counter})`;
      counter++;
    }

    return finalName;
  }

  /**
   * Register a socket into a room
   */
  joinRoom(roomId, token, socketId, rawName, namespace = 'chat') {
    const validation = this.validateInvite(roomId, token);
    if (!validation.valid) {
      return validation;
    }

    const room = validation.room;

    if (room.members.size >= this.MAX_MEMBERS_PER_ROOM) {
      return { valid: false, error: 'Room has reached maximum capacity' };
    }

    const displayName = this.assignDisplayName(room, rawName);

    room.members.set(socketId, {
      name: displayName,
      namespace,
      joinedAt: Date.now()
    });

    return {
      valid: true,
      room,
      displayName
    };
  }

  /**
   * Remove a socket from a room
   */
  leaveRoom(roomId, socketId) {
    if (!roomId) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;

    const member = room.members.get(socketId);
    if (member) {
      room.members.delete(socketId);
      const wasSharing = room.locations.delete(socketId);
      return Object.assign({}, member, { wasSharing });
    }
    return null;
  }

  /**
   * Check if a socket is a valid authorized member of a room
   */
  isMember(roomId, socketId) {
    if (!roomId || !socketId) return false;
    const room = this.rooms.get(roomId);
    if (!room) return false;
    if (Date.now() > room.expiresAt) {
      this.rooms.delete(roomId);
      return false;
    }
    return room.members.has(socketId);
  }

  /**
   * Get member info
   */
  getMember(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.members.get(socketId) || null;
  }

  /**
   * Periodically purge expired rooms
   */
  cleanupExpiredRooms() {
    const now = Date.now();
    for (const [id, room] of this.rooms.entries()) {
      if (now > room.expiresAt) {
        this.rooms.delete(id);
      }
    }
  }
}

/**
 * Lightweight per-socket sliding-window rate limiter
 */
class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map(); // socketId -> Array<timestamp>
  }

  consume(socketId) {
    const now = Date.now();
    let timestamps = this.hits.get(socketId);
    if (!timestamps) {
      timestamps = [];
      this.hits.set(socketId, timestamps);
    }

    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.limit) {
      return false; // Rate limit exceeded
    }

    timestamps.push(now);
    return true;
  }

  remove(socketId) {
    this.hits.delete(socketId);
  }
}

/**
 * Validation helpers
 */
function validateCoordinates(latitude, longitude) {
  if (typeof latitude !== 'number' || typeof longitude !== 'number') return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
}

function validateMessage(message) {
  if (typeof message !== 'string') return null;
  const trimmed = message.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;
  return trimmed;
}

module.exports = {
  RoomManager,
  RateLimiter,
  validateCoordinates,
  validateMessage
};
