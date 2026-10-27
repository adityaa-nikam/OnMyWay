const { repo } = require('../db');

/**
 * Calculates great-circle distance between two points in meters using Haversine formula
 */
function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

class LocationSharingService {
  constructor() {
    this.io = null;
    this.roomManager = null;
    this.activeTimers = new Map(); // userId -> NodeJS.Timeout
    this.userSockets = new Map(); // userId -> Set<socketId>
    this.sweepInterval = null;
  }

  init(io, roomManager) {
    this.io = io;
    this.roomManager = roomManager;

    // 1. Rehydrate active shares from SQLite on server start
    this.rehydrateActiveShares();

    // 2. 30-second periodic sweep timer for expired shares
    this.sweepInterval = setInterval(() => {
      this.sweepExpiredShares();
    }, 30 * 1000);

    if (this.sweepInterval.unref) {
      this.sweepInterval.unref();
    }
  }

  registerSocket(userId, socketId) {
    if (!userId) return;
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId).add(socketId);
  }

  unregisterSocket(userId, socketId) {
    if (!userId) return;
    const sockets = this.userSockets.get(userId);
    if (sockets) {
      sockets.delete(socketId);
      if (sockets.size === 0) {
        this.userSockets.delete(userId);
      }
    }
  }

  /**
   * Rehydrate active shares from SQLite after a server restart
   */
  rehydrateActiveShares() {
    try {
      const activeShares = repo.getAllActiveLocationShares();
      const now = Date.now();

      for (const share of activeShares) {
        if (share.expires_at && share.expires_at <= now) {
          // Expired during server downtime
          repo.stopLocationShare(share.id, 'expired');
        } else {
          // Re-arm exact timer for remaining duration
          this.armExactTimer(share.user_id, share.id, share.expires_at);
        }
      }
    } catch (err) {
      console.error('[LocationSharingService] Error rehydrating active shares:', err);
    }
  }

  /**
   * Exact boundary timer for a share
   */
  armExactTimer(userId, shareId, expiresAt) {
    if (this.activeTimers.has(userId)) {
      clearTimeout(this.activeTimers.get(userId));
      this.activeTimers.delete(userId);
    }

    if (!expiresAt) return; // 'until_stop' without explicit expiry

    const delayMs = Math.max(expiresAt - Date.now(), 0);
    const timer = setTimeout(() => {
      this.expireShare(userId, shareId);
    }, delayMs);

    if (timer.unref) timer.unref();
    this.activeTimers.set(userId, timer);
  }

  /**
   * Start a new time-boxed location share
   */
  startShare({
    userId,
    userName,
    durationType, // '15m', '1h', '8h', 'until_arrive', 'until_stop'
    targetGroupIds,
    destinationLat = null,
    destinationLng = null,
    destinationName = null
  }) {
    const now = Date.now();
    let expiresAt = null;

    if (durationType === '15m') {
      expiresAt = now + 15 * 60 * 1000;
    } else if (durationType === '1h') {
      expiresAt = now + 60 * 60 * 1000;
    } else if (durationType === '8h') {
      expiresAt = now + 8 * 60 * 60 * 1000;
    } else if (durationType === 'until_arrive') {
      // Default safety bound: 4 hours if arrival not reached
      expiresAt = now + 4 * 60 * 60 * 1000;
    } else if (durationType === 'until_stop') {
      // Safe maximum upper bound: 24 hours
      expiresAt = now + 24 * 60 * 60 * 1000;
    }

    const share = repo.createLocationShare({
      userId,
      durationType,
      expiresAt,
      destinationLat,
      destinationLng,
      destinationName,
      targetGroupIds
    });

    // Arm exact expiry timer
    this.armExactTimer(userId, share.id, expiresAt);

    // Broadcast share started to authorized target groups
    if (this.io) {
      for (const groupId of targetGroupIds) {
        this.io.to(groupId).emit('location-share-started', {
          shareId: share.id,
          userId,
          userName,
          durationType,
          expiresAt,
          targetGroupIds
        });
      }
    }

    return share;
  }

  /**
   * Extend active share by additional minutes (default 15m)
   */
  extendShare(userId, additionalMinutes = 15) {
    const active = repo.getActiveLocationShare(userId);
    if (!active) return null;

    const currentExpiry = active.expires_at || Date.now();
    const newExpiresAt = Math.max(currentExpiry, Date.now()) + (additionalMinutes * 60 * 1000);

    const updated = repo.updateLocationShareExpiry(active.id, newExpiresAt);
    this.armExactTimer(userId, active.id, newExpiresAt);

    if (this.io && updated) {
      for (const groupId of updated.target_group_ids) {
        this.io.to(groupId).emit('location-share-extended', {
          shareId: updated.id,
          userId,
          newExpiresAt,
          targetGroupIds: updated.target_group_ids
        });
      }
    }

    return updated;
  }

  /**
   * Stop an active share explicitly
   */
  stopShare(userId, action = 'stopped') {
    const active = repo.getActiveLocationShare(userId);
    if (!active) return null;

    if (this.activeTimers.has(userId)) {
      clearTimeout(this.activeTimers.get(userId));
      this.activeTimers.delete(userId);
    }

    const stopped = repo.stopLocationShare(active.id, action);

    // Remove from in-memory room active locations and broadcast stopped
    this.broadcastStopped(userId, active.target_group_ids, action);

    return stopped;
  }

  /**
   * Expire an active share
   */
  expireShare(userId, shareId) {
    if (this.activeTimers.has(userId)) {
      clearTimeout(this.activeTimers.get(userId));
      this.activeTimers.delete(userId);
    }

    const active = repo.getLocationShareById(shareId);
    if (!active || !active.is_active) return;

    repo.stopLocationShare(shareId, 'expired');
    this.broadcastStopped(userId, active.target_group_ids, 'expired');
  }

  /**
   * Broadcast location-stopped event and update presence roster
   */
  broadcastStopped(userId, targetGroupIds, reason = 'stopped') {
    const user = repo.getUserById(userId);
    const userName = user ? user.displayName : 'Participant';

    for (const groupId of targetGroupIds) {
      if (this.roomManager) {
        const room = this.roomManager.rooms.get(groupId);
        if (room) {
          // Remove any locations belonging to this user in this room
          for (const [sockId, member] of room.members.entries()) {
            if (member.userId === userId) {
              this.roomManager.stopLocation(groupId, sockId);
            }
          }
        }
      }

      if (this.io) {
        this.io.to(groupId).emit('location-stopped', {
          userId,
          name: userName,
          reason
        });
        // Also emit location:stopped alias
        this.io.to(groupId).emit('location:stopped', {
          userId,
          name: userName,
          reason
        });

        if (this.roomManager) {
          this.io.to(groupId).emit('participants-updated', this.roomManager.getParticipantList(groupId));
        }
      }
    }
  }

  /**
   * Check if a location update should trigger arrival
   */
  checkArrival(userId, latitude, longitude) {
    const active = repo.getActiveLocationShare(userId);
    if (!active || active.duration_type !== 'until_arrive') return false;

    if (active.destination_lat != null && active.destination_lng != null) {
      const distance = haversineDistanceMeters(
        latitude,
        longitude,
        active.destination_lat,
        active.destination_lng
      );
      if (distance <= 100) {
        // Arrived at destination! Stop share automatically.
        this.stopShare(userId, 'arrived');
        return true;
      }
    }
    return false;
  }

  /**
   * 30-second sweep for any expired active shares
   */
  sweepExpiredShares() {
    try {
      const expiredShares = repo.getExpiredActiveShares(Date.now());
      for (const share of expiredShares) {
        this.expireShare(share.user_id, share.id);
      }
    } catch (err) {
      console.error('[LocationSharingService] Error in sweepExpiredShares:', err);
    }
  }

  /**
   * Verify if a user is permitted to send a location update right now
   */
  isUserActivelySharing(userId) {
    const active = repo.getActiveLocationShare(userId);
    if (!active) return false;
    if (active.expires_at && Date.now() > active.expires_at) {
      this.expireShare(userId, active.id);
      return false;
    }
    return true;
  }

  /**
   * Get authorized target groups for an active user
   */
  getUserTargetGroups(userId) {
    const active = repo.getActiveLocationShare(userId);
    if (!active || !this.isUserActivelySharing(userId)) return [];
    return active.target_group_ids || [];
  }
}

const locationSharingService = new LocationSharingService();

module.exports = {
  locationSharingService,
  LocationSharingService,
  haversineDistanceMeters
};
