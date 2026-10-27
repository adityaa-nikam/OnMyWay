const express = require('express');
const crypto = require('crypto');
const { repo } = require('../db');
const { requireAuth, hashToken } = require('../middleware/auth');
const { RateLimiter, validateMessage } = require('../roomManager');

const router = express.Router();
const groupActionLimiter = new RateLimiter(30, 60 * 1000); // 30 actions per minute

// --- EJS View Routes ---

// Dashboard: My Groups
router.get('/groups', requireAuth, (req, res) => {
  const groups = repo.getUserGroups(req.user.id);
  res.render('groups', {
    user: req.user,
    groups,
    csrfToken: req.csrfToken
  });
});

// Group Workspace View (Reuses the rich Leaflet map + chat workspace)
router.get('/groups/:groupId', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);

  if (!membership) {
    return res.status(403).render('error', {
      title: 'Access Denied',
      message: 'You are not a member of this group. Request an invitation from the group owner.'
    });
  }

  const group = repo.getGroupById(groupId);
  if (!group) {
    return res.status(404).render('error', {
      title: 'Group Not Found',
      message: 'This group no longer exists.'
    });
  }

  res.render('room', {
    user: req.user,
    group,
    membership,
    isPersistentGroup: true,
    groupId: group.id,
    csrfToken: req.csrfToken
  });
});

// Account Settings View
router.get('/account', requireAuth, (req, res) => {
  const groups = repo.getUserGroups(req.user.id);
  res.render('account', {
    user: req.user,
    groupsCount: groups.length,
    csrfToken: req.csrfToken
  });
});

// --- REST API Endpoints ---

// List user's groups
router.get('/api/groups', requireAuth, (req, res) => {
  const groups = repo.getUserGroups(req.user.id);
  res.json({ success: true, groups });
});

// Create a new persistent group
router.post('/api/groups', requireAuth, (req, res) => {
  const { name, messageRetentionDays } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 50) {
    return res.status(400).json({ success: false, error: 'Group name must be between 1 and 50 characters.' });
  }

  const retention = parseInt(messageRetentionDays, 10) || 30;
  const group = repo.createGroup({
    name: name.trim(),
    ownerId: req.user.id,
    messageRetentionDays: retention
  });

  res.status(201).json({ success: true, group });
});

// Get group metadata and members
router.get('/api/groups/:groupId', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'You are not a member of this group.' });
  }

  const group = repo.getGroupById(groupId);
  const members = repo.getGroupMembers(groupId);
  res.json({ success: true, group, membership, members });
});

// Rename group (owner only)
router.patch('/api/groups/:groupId', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'Only the group owner can rename the group.' });
  }

  const { name } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 50) {
    return res.status(400).json({ success: false, error: 'Valid group name is required.' });
  }

  const updated = repo.updateGroup(groupId, { name: name.trim() });
  res.json({ success: true, group: updated });
});

// Leave group
router.post('/api/groups/:groupId/leave', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(400).json({ success: false, error: 'You are not a member of this group.' });
  }

  // If owner is leaving, check if other members exist
  if (membership.role === 'owner') {
    const allMembers = repo.getGroupMembers(groupId);
    if (allMembers.length <= 1) {
      // Last member was owner: delete group
      repo.deleteGroup(groupId);
      return res.json({ success: true, message: 'Group deleted as last owner left.' });
    } else {
      // Reassign ownership to next member
      const nextMember = allMembers.find((m) => m.user_id !== req.user.id);
      if (nextMember) {
        repo.addGroupMember({ groupId, userId: nextMember.user_id, role: 'owner' });
      }
    }
  }

  repo.removeGroupMember(groupId, req.user.id);
  res.json({ success: true, message: 'Left group successfully.' });
});

// Remove a member (owner only)
router.delete('/api/groups/:groupId/members/:targetUserId', requireAuth, (req, res) => {
  const { groupId, targetUserId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'Only the group owner can remove members.' });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ success: false, error: 'Use leave group endpoint to remove yourself.' });
  }

  const removed = repo.removeGroupMember(groupId, targetUserId);
  res.json({ success: removed, message: removed ? 'Member removed.' : 'Member not found.' });
});

// Create an invitation link
router.post('/api/groups/:groupId/invites', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'You must be a group member to create invites.' });
  }

  const { expiresInHours = 24, maxUses = null } = req.body;
  const hours = Math.min(Math.max(parseInt(expiresInHours, 10) || 24, 1), 720); // 1 hr to 30 days
  const expiresAt = Date.now() + (hours * 60 * 60 * 1000);
  const cleanMaxUses = maxUses ? Math.max(parseInt(maxUses, 10), 1) : null;

  const rawToken = crypto.randomBytes(16).toString('hex');
  const tokenHash = hashToken(rawToken);

  const invite = repo.createInvite({
    tokenHash,
    groupId,
    createdBy: req.user.id,
    expiresAt,
    maxUses: cleanMaxUses
  });

  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const inviteUrl = `${protocol}://${host}/join-group/${rawToken}`;

  res.status(201).json({
    success: true,
    inviteId: invite.id,
    inviteUrl,
    token: rawToken,
    expiresAt: invite.expiresAt,
    maxUses: invite.maxUses
  });
});

// Revoke invite link
router.delete('/api/groups/:groupId/invites/:inviteId', requireAuth, (req, res) => {
  const { groupId, inviteId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ success: false, error: 'Only the group owner can revoke invites.' });
  }

  const deleted = repo.deleteInvite(inviteId);
  res.json({ success: deleted });
});

// Join group via invite token
router.get('/join-group/:token', requireAuth, (req, res) => {
  const { token } = req.params;
  const tokenHash = hashToken(token);
  const invite = repo.getInviteByHash(tokenHash);

  if (!invite) {
    return res.status(400).render('error', {
      title: 'Invalid Invite Link',
      message: 'This invitation link does not exist or has been revoked.'
    });
  }

  if (Date.now() > invite.expires_at) {
    return res.status(400).render('error', {
      title: 'Expired Invite Link',
      message: 'This invitation link has expired. Please ask the group owner for a new invite.'
    });
  }

  if (invite.max_uses !== null && invite.uses >= invite.max_uses) {
    return res.status(400).render('error', {
      title: 'Invite Limit Reached',
      message: 'This invitation link has reached its maximum number of uses.'
    });
  }

  // Atomically increment use count
  const updated = repo.incrementInviteUses(invite.id);
  if (!updated) {
    return res.status(400).render('error', {
      title: 'Invite Exhausted',
      message: 'This invitation link has expired or reached maximum uses.'
    });
  }

  // Add member to group
  repo.addGroupMember({
    groupId: invite.group_id,
    userId: req.user.id,
    role: 'member'
  });

  res.redirect(`/groups/${invite.group_id}`);
});

// Chat history with cursor-based pagination
router.get('/api/groups/:groupId/messages', requireAuth, (req, res) => {
  const { groupId } = req.params;
  const membership = repo.getGroupMember(groupId, req.user.id);
  if (!membership) {
    return res.status(403).json({ success: false, error: 'You are not a member of this group.' });
  }

  const limit = req.query.limit || 50;
  const beforeId = req.query.beforeId || null;

  const messages = repo.getGroupMessages(groupId, { limit, beforeId });
  res.json({ success: true, messages });
});

module.exports = router;
