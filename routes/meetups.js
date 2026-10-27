const express = require('express');
const { repo } = require('../db');
const { routingService } = require('../services/routingService');
const { validateCoordinates } = require('../roomManager');

const router = express.Router();

/**
 * Format Date to iCalendar UTC string format: YYYYMMDDTHHMMSSZ
 */
function formatIcsDate(timestamp) {
  const date = new Date(timestamp);
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Middleware ensuring user is authenticated
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    if (req.accepts('html')) {
      return res.redirect(`/login?returnUrl=${encodeURIComponent(req.originalUrl)}`);
    }
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

/**
 * Middleware checking group membership
 */
function requireGroupMembership(req, res, next) {
  const groupId = req.params.groupId || (req.meetup && req.meetup.group_id);
  if (!groupId) {
    return res.status(400).json({ error: 'Group ID is required' });
  }

  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ error: 'Forbidden: You are not a member of this group' });
  }

  req.groupMembership = membership;
  next();
}

/**
 * Parameter resolver for :meetupId
 */
router.param('meetupId', (req, res, next, id) => {
  const meetup = repo.getMeetupById(id);
  if (!meetup) {
    return res.status(404).json({ error: 'Meetup not found' });
  }
  req.meetup = meetup;
  next();
});

// ---------- WEB UI: MEETUP DETAIL & WORKSPACE ----------
router.get('/meetups/:meetupId', requireAuth, (req, res) => {
  const membership = repo.getGroupMember(req.meetup.group_id, req.user.id);
  if (!membership) {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You must be a member of this group to view this meetup.'
    });
  }

  const group = repo.getGroupById(req.meetup.group_id);
  res.render('meetup', {
    user: req.user,
    meetup: req.meetup,
    group
  });
});

// ---------- .ICS CALENDAR EXPORT ----------
function generateIcsResponse(req, res) {
  const meetup = req.meetup;
  const startTime = meetup.start_time;
  const endTime = startTime + (2 * 60 * 60 * 1000); // 2 hours duration
  const now = Date.now();

  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const meetupUrl = `${protocol}://${host}/meetups/${meetup.id}`;

  const cleanTitle = (meetup.title || 'Meetup').replace(/[\r\n]/g, ' ');
  const cleanLabel = (meetup.destination_label || 'Destination').replace(/[\r\n]/g, ' ');

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//OnMyWay//OMW Meetups//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:meetup-${meetup.id}@onmyway.app`,
    `DTSTAMP:${formatIcsDate(now)}`,
    `DTSTART:${formatIcsDate(startTime)}`,
    `DTEND:${formatIcsDate(endTime)}`,
    `SUMMARY:${cleanTitle}`,
    `DESCRIPTION:${cleanTitle} on OnMyWay. Share until you arrive: ${meetupUrl}`,
    `LOCATION:${cleanLabel}`,
    `GEO:${meetup.destination_lat};${meetup.destination_lng}`,
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR'
  ];

  const icsContent = icsLines.join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="meetup-${meetup.id}.ics"`);
  res.status(200).send(icsContent);
}

router.get('/meetups/:meetupId/ics', requireAuth, requireGroupMembership, generateIcsResponse);
router.get('/api/meetups/:meetupId/ics', requireAuth, requireGroupMembership, generateIcsResponse);

// ---------- API: CREATE MEETUP ----------
router.post('/api/groups/:groupId/meetups', requireAuth, requireGroupMembership, (req, res) => {
  const { groupId } = req.params;
  const { title, destination, startTime, stopOnArrival } = req.body;

  if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 100) {
    return res.status(400).json({ error: 'Title is required and must be under 100 characters' });
  }

  if (!destination || typeof destination !== 'object') {
    return res.status(400).json({ error: 'Destination object { lat, lng, label } is required' });
  }

  const { lat, lng, label } = destination;
  if (!validateCoordinates(lat, lng)) {
    return res.status(400).json({ error: 'Invalid destination coordinates' });
  }

  const parsedStartTime = parseInt(startTime, 10);
  if (isNaN(parsedStartTime) || parsedStartTime <= 0) {
    return res.status(400).json({ error: 'Valid future start time is required' });
  }

  const safeLabel = (typeof label === 'string' && label.trim().length > 0)
    ? label.trim().slice(0, 150)
    : `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;

  const meetup = repo.createMeetup({
    groupId,
    creatorUserId: req.user.id,
    title: title.trim(),
    destinationLat: Number(lat),
    destinationLng: Number(lng),
    destinationLabel: safeLabel,
    startTime: parsedStartTime,
    stopOnArrival: Boolean(stopOnArrival) ? 1 : 0
  });

  // Notify group members via Socket.IO
  const io = req.app.get('io');
  if (io) {
    io.to(groupId).emit('meetup:created', {
      meetup,
      creatorName: req.user.displayName
    });
  }

  res.status(201).json({ success: true, meetup });
});

// ---------- API: LIST MEETUPS FOR GROUP ----------
router.get('/api/groups/:groupId/meetups', requireAuth, requireGroupMembership, (req, res) => {
  const { groupId } = req.params;
  repo.autoEndExpiredMeetups(Date.now());
  const meetups = repo.getMeetupsByGroup(groupId);

  // Attach RSVP counts and current user's RSVP
  const enriched = meetups.map((m) => {
    const rsvps = repo.getMeetupRsvps(m.id);
    const userRsvp = rsvps.find((r) => r.user_id === req.user.id);
    const counts = {
      going: rsvps.filter((r) => r.rsvp === 'going').length,
      maybe: rsvps.filter((r) => r.rsvp === 'maybe').length,
      no: rsvps.filter((r) => r.rsvp === 'no').length
    };
    return {
      ...m,
      rsvpCounts: counts,
      userRsvp: userRsvp ? userRsvp.rsvp : null
    };
  });

  res.json({ success: true, meetups: enriched });
});

// ---------- API: GET MEETUP DETAILS & PARTICIPANT ETAS ----------
router.get('/api/meetups/:meetupId', requireAuth, requireGroupMembership, async (req, res) => {
  const meetup = req.meetup;
  const now = Date.now();

  // Check auto-end condition (2 hours after start)
  if (meetup.status !== 'ended' && now >= (meetup.start_time + 2 * 60 * 60 * 1000)) {
    repo.updateMeetupStatus(meetup.id, 'ended');
    meetup.status = 'ended';
  }

  const rsvps = repo.getMeetupRsvps(meetup.id);
  const userRsvp = rsvps.find((r) => r.user_id === req.user.id);

  // Collect live location sharers in the group
  const roomManager = req.app.get('roomManager');
  const participants = [];

  for (const rsvp of rsvps) {
    // Non-participants receiving and generating no ETAs
    if (rsvp.rsvp === 'no') {
      continue;
    }

    let userLat = null;
    let userLng = null;

    if (roomManager) {
      const room = roomManager.rooms.get(meetup.group_id);
      if (room) {
        for (const loc of room.locations.values()) {
          if (loc.userId === rsvp.user_id) {
            userLat = loc.latitude;
            userLng = loc.longitude;
            break;
          }
        }
      }
    }

    if (userLat != null && userLng != null) {
      const etaData = await routingService.computeUserEta(meetup.id, rsvp.user_id, userLat, userLng);
      if (etaData) {
        participants.push(etaData);
      }
    } else {
      // RSVP is going/maybe but no active location shared
      participants.push({
        meetupId: meetup.id,
        userId: rsvp.user_id,
        userName: rsvp.user_name || 'Participant',
        rsvp: rsvp.rsvp,
        distanceMeters: null,
        etaSeconds: null,
        etaTimestamp: null,
        isApproximate: null,
        isLate: Boolean(rsvp.lateness_minutes > 0),
        lateByMinutes: rsvp.lateness_minutes || 0,
        isArrived: Boolean(rsvp.arrived_at),
        arrivedAt: rsvp.arrived_at,
        polyline: null
      });
    }
  }

  // Sort participants by ETA (arrived first, then shortest ETA, then offline/no location)
  participants.sort((a, b) => {
    if (a.isArrived && !b.isArrived) return -1;
    if (!a.isArrived && b.isArrived) return 1;
    if (a.etaSeconds != null && b.etaSeconds != null) return a.etaSeconds - b.etaSeconds;
    if (a.etaSeconds != null && b.etaSeconds == null) return -1;
    if (a.etaSeconds == null && b.etaSeconds != null) return 1;
    return a.userName.localeCompare(b.userName);
  });

  res.json({
    success: true,
    meetup,
    rsvps,
    participants,
    userRsvp: userRsvp || null
  });
});

// ---------- API: UPDATE RSVP ----------
router.post('/api/meetups/:meetupId/rsvp', requireAuth, requireGroupMembership, (req, res) => {
  const { rsvp, latenessMinutes } = req.body;
  const meetup = req.meetup;

  const validRsvp = ['going', 'maybe', 'no'].includes(rsvp) ? rsvp : 'going';
  const updatedRsvp = repo.setMeetupRsvp({
    meetupId: meetup.id,
    userId: req.user.id,
    rsvp: validRsvp,
    latenessMinutes: parseInt(latenessMinutes, 10) || 0
  });

  // Clear routing cache on RSVP change
  routingService.clearUserCache(meetup.id, req.user.id);

  const io = req.app.get('io');
  if (io) {
    io.to(meetup.group_id).emit('meetup:rsvp-updated', {
      meetupId: meetup.id,
      userId: req.user.id,
      userName: req.user.displayName,
      rsvp: validRsvp,
      latenessMinutes: updatedRsvp.lateness_minutes
    });
  }

  res.json({ success: true, rsvp: updatedRsvp });
});

// ---------- API: ONE-TAP "RUNNING LATE BY 10 MIN" ----------
router.post('/api/meetups/:meetupId/late', requireAuth, requireGroupMembership, (req, res) => {
  const meetup = req.meetup;
  const latenessMinutes = 10;

  const updatedRsvp = repo.setMeetupRsvp({
    meetupId: meetup.id,
    userId: req.user.id,
    rsvp: 'going',
    latenessMinutes
  });

  // Invalidate cache so new lateness calculation applies immediately
  routingService.clearUserCache(meetup.id, req.user.id);

  // Post system chat message into the group
  const messageBody = `⏱️ ${req.user.displayName} is running late by 10 min to "${meetup.title}"`;
  const msg = repo.createMessage({
    groupId: meetup.group_id,
    userId: req.user.id,
    body: messageBody,
    clientMsgId: `late_${Date.now()}_${req.user.id}`
  });

  const io = req.app.get('io');
  if (io) {
    // Broadcast RSVP update
    io.to(meetup.group_id).emit('meetup:rsvp-updated', {
      meetupId: meetup.id,
      userId: req.user.id,
      userName: req.user.displayName,
      rsvp: 'going',
      latenessMinutes
    });

    // Broadcast system message
    io.to(meetup.group_id).emit('receive', {
      id: msg.id,
      name: 'System',
      message: messageBody,
      timestamp: msg.created_at,
      groupId: meetup.group_id
    });
  }

  res.json({ success: true, rsvp: updatedRsvp, message: messageBody });
});

// ---------- API: UPDATE STATUS (ACTIVE/ENDED) ----------
router.post('/api/meetups/:meetupId/status', requireAuth, requireGroupMembership, (req, res) => {
  const { status } = req.body;
  const meetup = req.meetup;

  // Only group owner or meetup creator can end/change status
  const isOwner = req.groupMembership.role === 'owner';
  const isCreator = meetup.creator_user_id === req.user.id;

  if (!isOwner && !isCreator) {
    return res.status(403).json({ error: 'Only the creator or group owner can update meetup status' });
  }

  if (!['planned', 'active', 'ended'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const updated = repo.updateMeetupStatus(meetup.id, status);
  if (status === 'ended') {
    routingService.clearMeetupCache(meetup.id);
  }

  const io = req.app.get('io');
  if (io) {
    io.to(meetup.group_id).emit('meetup:status-changed', {
      meetupId: meetup.id,
      status,
      updatedBy: req.user.displayName
    });
  }

  res.json({ success: true, meetup: updated });
});

module.exports = router;
