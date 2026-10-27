const express = require('express');
const { repo } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { locationSharingService } = require('../services/locationSharing');

const router = express.Router();

// Sliding-window cooldown for SOS (60 seconds per user)
const sosCooldowns = new Map(); // userId -> lastSosTimestamp

/**
 * Get active location share session for current user
 */
router.get('/api/location/active-share', requireAuth, (req, res) => {
  const active = repo.getActiveLocationShare(req.user.id);
  if (!active) {
    return res.json({ success: true, activeShare: null });
  }

  if (active.expires_at && Date.now() > active.expires_at) {
    locationSharingService.expireShare(req.user.id, active.id);
    return res.json({ success: true, activeShare: null });
  }

  res.json({ success: true, activeShare: active });
});

/**
 * Start a time-boxed location sharing session
 */
router.post('/api/location/start', requireAuth, (req, res) => {
  const {
    durationType = '15m',
    targetGroupIds = [],
    destinationLat,
    destinationLng,
    destinationName
  } = req.body;

  const validDurations = ['15m', '1h', '8h', 'until_arrive', 'until_stop'];
  if (!validDurations.includes(durationType)) {
    return res.status(400).json({ success: false, error: 'Invalid duration type.' });
  }

  // Ensure target groups are an array and user is a member of each
  if (!Array.isArray(targetGroupIds) || targetGroupIds.length === 0) {
    return res.status(400).json({ success: false, error: 'Select at least one group to share location with.' });
  }

  for (const gid of targetGroupIds) {
    const member = repo.getGroupMember(gid, req.user.id);
    if (!member) {
      return res.status(403).json({ success: false, error: `You are not a member of group ${gid}.` });
    }
  }

  const share = locationSharingService.startShare({
    userId: req.user.id,
    userName: req.user.displayName,
    durationType,
    targetGroupIds,
    destinationLat: typeof destinationLat === 'number' ? destinationLat : null,
    destinationLng: typeof destinationLng === 'number' ? destinationLng : null,
    destinationName: typeof destinationName === 'string' ? destinationName.slice(0, 50) : null
  });

  res.json({ success: true, share });
});

/**
 * Extend active location sharing session (+15m by default)
 */
router.post('/api/location/extend', requireAuth, (req, res) => {
  const { additionalMinutes = 15 } = req.body;
  const safeMinutes = Math.min(Math.max(parseInt(additionalMinutes, 10) || 15, 5), 120);

  const updated = locationSharingService.extendShare(req.user.id, safeMinutes);
  if (!updated) {
    return res.status(400).json({ success: false, error: 'No active location share session to extend.' });
  }

  res.json({ success: true, share: updated });
});

/**
 * Stop active location sharing session
 */
router.post('/api/location/stop', requireAuth, (req, res) => {
  const stopped = locationSharingService.stopShare(req.user.id, 'stopped');
  res.json({ success: true, stopped: Boolean(stopped) });
});

/**
 * Get location share log for transparency
 */
router.get('/api/location/share-log', requireAuth, (req, res) => {
  const logs = repo.getUserLocationShareLogs(req.user.id, 50);
  res.json({ success: true, logs });
});

/**
 * Trigger Emergency SOS Beacon
 */
router.post('/api/groups/:groupId/sos', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'You must be a group member to trigger an SOS.' });
  }

  // 60-second cooldown enforcement
  const lastSos = sosCooldowns.get(req.user.id) || 0;
  const now = Date.now();
  if (now - lastSos < 60 * 1000) {
    const remaining = Math.ceil((60 * 1000 - (now - lastSos)) / 1000);
    return res.status(429).json({
      success: false,
      error: `SOS cooldown active. Please wait ${remaining} seconds before re-triggering.`
    });
  }
  sosCooldowns.set(req.user.id, now);

  const { latitude, longitude } = req.body;
  const hasCoords = typeof latitude === 'number' && typeof longitude === 'number' &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;

  const sosEvent = repo.createSosEvent({
    groupId,
    userId: req.user.id,
    senderName: req.user.displayName,
    lat: hasCoords ? latitude : null,
    lng: hasCoords ? longitude : null
  });

  // Broadcast to group
  if (locationSharingService.io) {
    locationSharingService.io.to(groupId).emit('sos-broadcast', {
      id: sosEvent.id,
      userId: req.user.id,
      name: req.user.displayName,
      latitude: sosEvent.lat,
      longitude: sosEvent.lng,
      timestamp: sosEvent.created_at
    });

    locationSharingService.io.to(groupId).emit('receive', {
      id: sosEvent.id,
      name: '🚨 SOS BEACON',
      message: `⚠️ EMERGENCY: ${req.user.displayName} triggered an SOS Beacon!`,
      timestamp: sosEvent.created_at,
      isSos: true,
      sosId: sosEvent.id
    });
  }

  res.json({ success: true, sosEvent });
});

/**
 * Respond to an active SOS ("I'm on it")
 */
router.post('/api/sos/:sosId/respond', requireAuth, (req, res) => {
  const { sosId } = req.params;
  const event = repo.getSosEvent(sosId);
  if (!event || event.status !== 'active') {
    return res.status(404).json({ success: false, error: 'Active SOS event not found.' });
  }

  const membership = repo.getGroupMember(event.group_id, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'Forbidden.' });
  }

  const updated = repo.addSosResponder(sosId, {
    userId: req.user.id,
    name: req.user.displayName
  });

  if (locationSharingService.io) {
    locationSharingService.io.to(event.group_id).emit('sos-updated', updated);
    locationSharingService.io.to(event.group_id).emit('receive', {
      id: 'system',
      name: 'System',
      message: `🛡️ ${req.user.displayName} is responding to the SOS!`,
      timestamp: Date.now(),
      isSystem: true
    });
  }

  res.json({ success: true, sosEvent: updated });
});

/**
 * Cancel SOS Beacon as "False alarm" (sender only)
 */
router.post('/api/sos/:sosId/cancel', requireAuth, (req, res) => {
  const { sosId } = req.params;
  const event = repo.getSosEvent(sosId);
  if (!event) {
    return res.status(404).json({ success: false, error: 'SOS event not found.' });
  }

  if (event.user_id !== req.user.id) {
    return res.status(403).json({ success: false, error: 'Only the SOS sender can cancel it.' });
  }

  const cancelled = repo.cancelSosEvent(sosId, req.user.id);

  if (locationSharingService.io) {
    locationSharingService.io.to(event.group_id).emit('sos-cancelled', {
      sosId,
      cancelledBy: req.user.displayName
    });
    locationSharingService.io.to(event.group_id).emit('receive', {
      id: 'system',
      name: 'System',
      message: `✅ False alarm: SOS beacon cancelled by ${req.user.displayName}.`,
      timestamp: Date.now(),
      isSystem: true
    });
  }

  res.json({ success: true, sosEvent: cancelled });
});

/**
 * Get active status pins for a group
 */
router.get('/api/groups/:groupId/status-pins', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'Forbidden.' });
  }

  const pins = repo.getStatusPinsForGroup(groupId);
  res.json({ success: true, pins });
});

module.exports = router;
