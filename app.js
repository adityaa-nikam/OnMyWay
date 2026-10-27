// Express + Socket.IO server with Room Isolation, Identity Protection & Rate Limiting
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');
const { RoomManager, RateLimiter, validateCoordinates, validateMessage } = require('./roomManager');
const { repo } = require('./db');
const { sessionMiddleware, socketAuthMiddleware, verifyCsrf } = require('./middleware/auth');
const authRouter = require('./routes/auth');
const groupsRouter = require('./routes/groups');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6 // 1MB payload ceiling to prevent memory exhaustion
});

// Room registry & rate limiters
const roomManager = new RoomManager();
const chatRateLimiter = new RateLimiter(5, 2000); // Max 5 chat messages per 2s per socket
const locationRateLimiter = new RateLimiter(4, 1000); // Max 4 location updates per 1s per socket

// Express setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(sessionMiddleware);
app.use(verifyCsrf);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Mount Auth and Groups routers
app.use(authRouter);
app.use(groupsRouter);

// ---------- HTTP ROUTES ----------

// Home page
app.get('/', (req, res) => {
  res.render('index');
});

// Create a private room
app.post('/api/rooms', (req, res) => {
  const room = roomManager.createRoom();
  const host = req.get('host') || 'localhost:3000';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  res.status(201).json({
    success: true,
    roomId: room.roomId,
    token: room.token,
    expiresAt: room.expiresAt,
    inviteUrl: `${baseUrl}/room?roomId=${room.roomId}&token=${room.token}`,
    roomUrl: `${baseUrl}/room?roomId=${room.roomId}&token=${room.token}`,
    chatUrl: `${baseUrl}/chat?roomId=${room.roomId}&token=${room.token}`,
    locationUrl: `${baseUrl}/location?roomId=${room.roomId}&token=${room.token}`
  });
});

// Validate room invitation token
app.get('/api/rooms/:roomId/validate', (req, res) => {
  const { roomId } = req.params;
  const token = req.query.token;

  const result = roomManager.validateInvite(roomId, token);
  if (!result.valid) {
    return res.status(400).json({ valid: false, error: result.error });
  }

  res.json({ valid: true, roomId, expiresAt: result.room.expiresAt });
});

// Render Unified Workspace (Chat + Live Map)
app.get('/room', (req, res) => {
  res.render('room');
});

// Join route redirect
app.get('/join', (req, res) => {
  const { roomId, token } = req.query;
  if (roomId && token) {
    return res.redirect(`/room?roomId=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);
  }
  res.redirect('/');
});

// Render legacy Chat page
app.get('/chat', (req, res) => {
  res.render('chat');
});

// Render legacy Location page
app.get('/location', (req, res) => {
  res.render('location');
});

// ---------- CHAT NAMESPACE ----------
const chat = io.of('/chat');
chat.use(socketAuthMiddleware);

chat.on('connection', (socket) => {
  // Join a private room
  const handleJoin = (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      const err = { message: 'Invalid payload. Must provide roomId, token, and name.', code: 'INVALID_PAYLOAD' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const { roomId, token, name } = payload;
    const joinResult = roomManager.joinRoom(roomId, token, socket.id, name, 'chat');

    if (!joinResult.valid) {
      const err = { message: joinResult.error, code: 'JOIN_FAILED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Set server-controlled authorization and identity
    socket.data.authorized = true;
    socket.data.roomId = roomId;
    socket.data.name = joinResult.displayName;

    socket.join(roomId);

    // Notify only members of this room
    socket.to(roomId).emit('user-joined', joinResult.displayName);
    console.log(`💬 [Room ${roomId}] ${joinResult.displayName} joined (${socket.id})`);

    if (typeof callback === 'function') {
      callback({ success: true, displayName: joinResult.displayName, roomId });
    }
  };

  // Support both 'join-room' and 'new-user-joined'
  socket.on('join-room', handleJoin);
  socket.on('new-user-joined', handleJoin);

  // Send message
  socket.on('send', (payload, callback) => {
    const roomId = socket.data.roomId;

    // Reject messages from sockets that have not joined a room
    if (!socket.data.authorized || !roomId || !roomManager.isMember(roomId, socket.id)) {
      const err = { message: 'Unauthorized. You must join a room first.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Rate limiting
    if (!chatRateLimiter.consume(socket.id)) {
      const err = { message: 'Rate limit exceeded. Please slow down.', code: 'RATE_LIMIT' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Validate payload
    let rawMessage = '';
    if (typeof payload === 'string') {
      rawMessage = payload;
    } else if (payload && typeof payload === 'object') {
      rawMessage = payload.message || '';
    }

    const message = validateMessage(rawMessage);
    if (!message) {
      const err = { message: 'Message must be non-empty and under 2000 characters.', code: 'INVALID_MESSAGE' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Server-controlled authoritative identity (ignores any client-supplied name)
    const senderName = socket.data.name;
    const timestamp = Date.now();

    // Broadcast ONLY to members of this room
    socket.to(roomId).emit('receive', {
      name: senderName,
      message,
      timestamp
    });

    if (typeof callback === 'function') {
      callback({ success: true, timestamp });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    chatRateLimiter.remove(socket.id);
    const roomId = socket.data.roomId;
    if (roomId) {
      const member = roomManager.leaveRoom(roomId, socket.id);
      if (member) {
        socket.to(roomId).emit('left', member.name);
        console.log(`🔴 [Room ${roomId}] ${member.name} left`);
      }
    }
  });
});

// ---------- LOCATION NAMESPACE ----------
const location = io.of('/location');
location.use(socketAuthMiddleware);

location.on('connection', (socket) => {
  // Join a location room
  const handleJoin = (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      const err = { message: 'Invalid payload. Must provide roomId, token, and name.', code: 'INVALID_PAYLOAD' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const { roomId, token, name } = payload;
    const joinResult = roomManager.joinRoom(roomId, token, socket.id, name, 'location');

    if (!joinResult.valid) {
      const err = { message: joinResult.error, code: 'JOIN_FAILED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    socket.data.authorized = true;
    socket.data.roomId = roomId;
    socket.data.name = joinResult.displayName;

    socket.join(roomId);

    // Provide initial snapshot of active location sharers in this room
    const snapshot = roomManager.getLocationSnapshot(roomId);
    socket.emit('location-snapshot', snapshot);

    console.log(`📍 [Location Room ${roomId}] ${joinResult.displayName} joined (${socket.id}) - ${snapshot.length} active sharers`);

    if (typeof callback === 'function') {
      callback({ success: true, displayName: joinResult.displayName, roomId, snapshot });
    }
  };

  socket.on('join-room', handleJoin);
  socket.on('new-user-joined', handleJoin);

  // Send location update
  socket.on('send-location', (payload, callback) => {
    const roomId = socket.data.roomId;

    // Verify membership
    if (!socket.data.authorized || !roomId || !roomManager.isMember(roomId, socket.id)) {
      const err = { message: 'Unauthorized. You must join a room first.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Rate limiting
    if (!locationRateLimiter.consume(socket.id)) {
      const err = { message: 'Location rate limit exceeded. Please slow down.', code: 'RATE_LIMIT' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      const err = { message: 'Invalid location payload.', code: 'INVALID_PAYLOAD' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const { latitude, longitude } = payload;
    if (!validateCoordinates(latitude, longitude)) {
      const err = { message: 'Invalid coordinates. Latitude [-90, 90] and longitude [-180, 180] must be finite numbers.', code: 'INVALID_COORDINATES' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Store in room manager and generate server timestamp
    const locData = roomManager.updateLocation(roomId, socket.id, latitude, longitude);
    if (!locData) {
      const err = { message: 'Failed to update location in room state.', code: 'STATE_ERROR' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // Broadcast update to other participants in this room
    socket.to(roomId).emit('receive-location', locData);

    if (typeof callback === 'function') {
      callback({ success: true, updatedAt: locData.updatedAt });
    }
  });

  // Explicit stop location sharing
  socket.on('stop-location', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!socket.data.authorized || !roomId || !roomManager.isMember(roomId, socket.id)) {
      const err = { message: 'Unauthorized. You must join a room first.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const result = roomManager.stopLocation(roomId, socket.id);
    if (result && result.removed) {
      socket.to(roomId).emit('location-stopped', { id: socket.id, name: socket.data.name });
      console.log(`⏹ [Location Room ${roomId}] ${socket.data.name} stopped sharing location`);
    }

    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  socket.on('stop-sharing-location', (payload, callback) => {
    // Alias to stop-location
    const roomId = socket.data.roomId;
    if (socket.data.authorized && roomId && roomManager.isMember(roomId, socket.id)) {
      const result = roomManager.stopLocation(roomId, socket.id);
      if (result && result.removed) {
        socket.to(roomId).emit('location-stopped', { id: socket.id, name: socket.data.name });
        console.log(`⏹ [Location Room ${roomId}] ${socket.data.name} stopped sharing location`);
      }
    }
    if (typeof callback === 'function') callback({ success: true });
  });

  // Disconnect
  socket.on('disconnect', () => {
    locationRateLimiter.remove(socket.id);
    const roomId = socket.data.roomId;
    if (roomId) {
      const member = roomManager.leaveRoom(roomId, socket.id);
      if (member) {
        if (member.wasSharing) {
          socket.to(roomId).emit('location-stopped', { id: socket.id, name: member.name });
        }
        socket.to(roomId).emit('user-disconnected', socket.id);
        console.log(`🔴 [Location Room ${roomId}] user ${socket.id} (${member.name}) disconnected`);
      }
    }
  });
});

// ---------- UNIFIED WORKSPACE (ROOT NAMESPACE: CHAT + MAP) ----------
io.use(socketAuthMiddleware);

function checkSocketAuthorized(socket) {
  const roomId = socket.data.roomId;
  if (!socket.data.authorized || !roomId) return false;
  if (socket.data.isPersistent) {
    return Boolean(repo.getGroupMember(socket.data.groupId, socket.data.userId));
  }
  return roomManager.isMember(roomId, socket.id);
}

io.on('connection', (socket) => {
  // Join room (supports persistent groups and ephemeral guest rooms)
  socket.on('join-room', (payload, callback) => {
    if (!payload || typeof payload !== 'object') {
      const err = { message: 'Invalid payload.', code: 'INVALID_PAYLOAD' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    // --- Persistent Group Join ---
    if (payload.isPersistent || payload.groupId) {
      const groupId = payload.groupId || payload.roomId;
      const user = socket.data.user;

      if (!user) {
        const err = { message: 'Authentication required to join persistent group.', code: 'UNAUTHORIZED' };
        socket.emit('error-notice', err);
        if (typeof callback === 'function') callback({ success: false, error: err.message });
        return;
      }

      const membership = repo.getGroupMember(groupId, user.id);
      if (!membership) {
        const err = { message: 'Forbidden. You are not a member of this group.', code: 'FORBIDDEN' };
        socket.emit('error-notice', err);
        if (typeof callback === 'function') callback({ success: false, error: err.message });
        return;
      }

      // Check or create in-memory group session for real-time presence & live map coordinates
      let room = roomManager.rooms.get(groupId);
      if (!room) {
        room = {
          id: groupId,
          token: 'persistent_token',
          createdAt: Date.now(),
          expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
          members: new Map(),
          locations: new Map(),
          rendezvous: null
        };
        roomManager.rooms.set(groupId, room);
      }

      room.members.set(socket.id, {
        name: user.displayName,
        namespace: 'unified',
        userId: user.id,
        joinedAt: Date.now()
      });

      socket.data.authorized = true;
      socket.data.isPersistent = true;
      socket.data.groupId = groupId;
      socket.data.roomId = groupId;
      socket.data.userId = user.id;
      socket.data.name = user.displayName;

      socket.join(groupId);

      // Load latest 50 messages from DB
      const history = repo.getGroupMessages(groupId, { limit: 50 });
      const participants = roomManager.getParticipantList(groupId);
      const locations = roomManager.getLocationSnapshot(groupId);
      const rendezvous = roomManager.getRendezvous(groupId);

      socket.to(groupId).emit('user-joined', user.displayName);
      io.to(groupId).emit('participants-updated', participants);

      console.log(`⚡ [Persistent Group ${groupId}] ${user.displayName} joined (${socket.id})`);

      if (typeof callback === 'function') {
        callback({
          success: true,
          displayName: user.displayName,
          roomId: groupId,
          participants,
          locations,
          rendezvous,
          history
        });
      }
      return;
    }

    // --- Ephemeral Guest Room Join (Unchanged, 0 DB storage) ---
    const { roomId, token, name } = payload;
    const joinResult = roomManager.joinRoom(roomId, token, socket.id, name, 'unified');

    if (!joinResult.valid) {
      const err = { message: joinResult.error, code: 'JOIN_FAILED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    socket.data.authorized = true;
    socket.data.isPersistent = false;
    socket.data.roomId = roomId;
    socket.data.name = joinResult.displayName;

    socket.join(roomId);

    const participants = roomManager.getParticipantList(roomId);
    const locations = roomManager.getLocationSnapshot(roomId);
    const rendezvous = roomManager.getRendezvous(roomId);

    socket.to(roomId).emit('user-joined', joinResult.displayName);
    io.to(roomId).emit('participants-updated', participants);

    console.log(`⚡ [Unified Room ${roomId}] ${joinResult.displayName} joined (${socket.id})`);

    if (typeof callback === 'function') {
      callback({
        success: true,
        displayName: joinResult.displayName,
        roomId,
        participants,
        locations,
        rendezvous
      });
    }
  });

  // Chat message
  socket.on('send', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      const err = { message: 'Unauthorized. You must join a room first.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    if (!chatRateLimiter.consume(socket.id)) {
      const err = { message: 'Rate limit exceeded. Please slow down.', code: 'RATE_LIMIT' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    let rawMessage = '';
    let isChip = false;
    if (typeof payload === 'string') {
      rawMessage = payload;
    } else if (payload && typeof payload === 'object') {
      rawMessage = payload.message || '';
      isChip = Boolean(payload.isChip);
    }

    const message = validateMessage(rawMessage);
    if (!message) {
      const err = { message: 'Message must be non-empty and under 2000 characters.', code: 'INVALID_MESSAGE' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const senderName = socket.data.name;
    let messageId = socket.id;
    let timestamp = Date.now();

    let replyToId = null;
    let clientMsgId = null;
    if (payload && typeof payload === 'object') {
      if (typeof payload.replyToId === 'string' && payload.replyToId.trim()) {
        replyToId = payload.replyToId.trim();
      }
      if (typeof payload.clientMsgId === 'string' && payload.clientMsgId.trim()) {
        clientMsgId = payload.clientMsgId.trim();
      }
    }

    if (socket.data.isPersistent) {
      const saved = repo.createMessage({
        groupId: socket.data.groupId,
        userId: socket.data.userId,
        body: message,
        replyToId,
        clientMsgId
      });
      messageId = saved.id;
      timestamp = saved.created_at;
    }

    // Broadcast to room (peers)
    socket.to(roomId).emit('receive', {
      id: messageId,
      name: senderName,
      message,
      timestamp,
      isChip,
      replyToId,
      clientMsgId
    });

    if (typeof callback === 'function') {
      callback({ success: true, timestamp, displayName: senderName, id: messageId, clientMsgId });
    }
  });

  // Location update (supports precise or ghost mode)
  socket.on('send-location', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      const err = { message: 'Unauthorized. You must join a room first.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    if (!locationRateLimiter.consume(socket.id)) {
      const err = { message: 'Location rate limit exceeded. Please slow down.', code: 'RATE_LIMIT' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    if (!payload || typeof payload !== 'object') {
      const err = { message: 'Invalid location payload.', code: 'INVALID_PAYLOAD' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const { latitude, longitude, isGhost } = payload;
    if (!validateCoordinates(latitude, longitude)) {
      const err = { message: 'Invalid coordinates.', code: 'INVALID_COORDINATES' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const locData = roomManager.updateLocation(roomId, socket.id, latitude, longitude, isGhost);
    if (!locData) {
      const err = { message: 'Failed to update location.', code: 'STATE_ERROR' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    socket.to(roomId).emit('receive-location', locData);
    io.to(roomId).emit('participants-updated', roomManager.getParticipantList(roomId));

    if (typeof callback === 'function') {
      callback({ success: true, updatedAt: locData.updatedAt });
    }
  });

  // Set shared rendezvous / meeting point
  socket.on('set-rendezvous', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      const err = { message: 'Unauthorized.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const { latitude, longitude, label } = payload || {};
    if (!validateCoordinates(latitude, longitude)) {
      const err = { message: 'Invalid meeting coordinates.', code: 'INVALID_COORDINATES' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const rendezvous = roomManager.setRendezvous(roomId, latitude, longitude, label, socket.data.name);
    io.to(roomId).emit('rendezvous-updated', rendezvous);

    // Notify in chat
    io.to(roomId).emit('receive', {
      id: 'system',
      name: 'System',
      message: `🎯 ${socket.data.name} set a meeting point: "${rendezvous.label}"`,
      timestamp: Date.now(),
      isSystem: true
    });

    if (typeof callback === 'function') callback({ success: true, rendezvous });
  });

  // Clear meeting point
  socket.on('clear-rendezvous', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      return;
    }

    roomManager.clearRendezvous(roomId);
    io.to(roomId).emit('rendezvous-cleared', { clearedBy: socket.data.name });
    io.to(roomId).emit('receive', {
      id: 'system',
      name: 'System',
      message: `🎯 ${socket.data.name} cleared the meeting point`,
      timestamp: Date.now(),
      isSystem: true
    });

    if (typeof callback === 'function') callback({ success: true });
  });

  // Emergency / SOS Beacon
  socket.on('sos-alert', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      return;
    }

    const { latitude, longitude } = payload || {};
    const hasCoords = validateCoordinates(latitude, longitude);

    const alertData = {
      id: socket.id,
      name: socket.data.name,
      latitude: hasCoords ? latitude : null,
      longitude: hasCoords ? longitude : null,
      timestamp: Date.now()
    };

    io.to(roomId).emit('sos-broadcast', alertData);

    io.to(roomId).emit('receive', {
      id: 'system',
      name: '🚨 SOS ALERT',
      message: `⚠️ EMERGENCY: ${socket.data.name} triggered an SOS Beacon!`,
      timestamp: Date.now(),
      isSos: true
    });

    if (typeof callback === 'function') callback({ success: true });
  });

  // Stop location
  socket.on('stop-location', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (!checkSocketAuthorized(socket)) {
      const err = { message: 'Unauthorized.', code: 'UNAUTHORIZED' };
      socket.emit('error-notice', err);
      if (typeof callback === 'function') callback({ success: false, error: err.message });
      return;
    }

    const result = roomManager.stopLocation(roomId, socket.id);
    if (result && result.removed) {
      socket.to(roomId).emit('location-stopped', { id: socket.id, name: socket.data.name });
      io.to(roomId).emit('participants-updated', roomManager.getParticipantList(roomId));
      console.log(`⏹ [Room ${roomId}] ${socket.data.name} stopped sharing location`);
    }

    if (typeof callback === 'function') {
      callback({ success: true });
    }
  });

  // Leave room explicitly
  socket.on('leave-room', (payload, callback) => {
    const roomId = socket.data.roomId;
    if (roomId) {
      const member = roomManager.leaveRoom(roomId, socket.id);
      if (member) {
        if (member.wasSharing) {
          socket.to(roomId).emit('location-stopped', { id: socket.id, name: member.name });
        }
        socket.to(roomId).emit('left', member.name);
        io.to(roomId).emit('participants-updated', roomManager.getParticipantList(roomId));
        console.log(`🔴 [Room ${roomId}] ${member.name} left explicitly`);
      }
      socket.leave(roomId);
      socket.data.authorized = false;
      socket.data.roomId = null;
    }
    if (typeof callback === 'function') callback({ success: true });
  });

  // Disconnect
  socket.on('disconnect', () => {
    chatRateLimiter.remove(socket.id);
    locationRateLimiter.remove(socket.id);
    const roomId = socket.data.roomId;
    if (roomId) {
      const member = roomManager.leaveRoom(roomId, socket.id);
      if (member) {
        if (member.wasSharing) {
          socket.to(roomId).emit('location-stopped', { id: socket.id, name: member.name });
        }
        socket.to(roomId).emit('left', member.name);
        io.to(roomId).emit('participants-updated', roomManager.getParticipantList(roomId));
        console.log(`🔴 [Room ${roomId}] ${member.name} disconnected`);
      }
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  server.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));
}

module.exports = { app, server, roomManager, chatRateLimiter, locationRateLimiter, repo };
