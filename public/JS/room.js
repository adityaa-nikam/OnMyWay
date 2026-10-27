// ==========================================================================
// OnMyWay (OMW) — Unified Workspace Room Controller
// Tagline: "Share until you arrive."
// Voice: "sharing" and "following", never "tracking".
// ==========================================================================

const socket = io();

// State
let localDisplayName = "You";
let currentRoomId = null;
let currentToken = null;
let isSharing = false;
let isGhostMode = false;
let isSettingMeetupMode = false;
let isSosActive = false;
let watchId = null;
let userMarker = null;
let userGhostCircle = null;
let lastKnownLat = null;
let lastKnownLng = null;
let hasCenteredOnce = false;

// Shared Rendezvous Point state
let currentRendezvous = null;
let rendezvousMarker = null;
const rendezvousLines = new Map(); // socketId -> L.polyline

// Proximity following state
const alertedPeers = new Set();

// Active locations cache: socketId -> { id, name, latitude, longitude, updatedAt, isGhost }
const activeLocations = new Map();

// Markers registry: socketId -> Leaflet marker
const markers = new Map();
const ghostCircles = new Map();

// UI Elements
const headerRoomId = document.getElementById("header-room-id");
const copyBtn = document.getElementById("copy-invite-btn");
const connStatus = document.getElementById("connection-status");
const connText = document.getElementById("connection-text");
const participantListEl = document.getElementById("participant-list");
const sidebarMemberCount = document.getElementById("sidebar-member-count");
const mobileMemberCount = document.getElementById("mobile-member-count");
const mobileSharerCount = document.getElementById("mobile-sharer-count");
const chatMessagesEl = document.getElementById("chat-messages");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const joinModal = document.getElementById("join-modal");
const joinErrorMsg = document.getElementById("join-error-msg");
const displayNameInput = document.getElementById("display-name-input");
const invalidModal = document.getElementById("invalid-room-modal");
const geoBanner = document.getElementById("geo-error-banner");
const geoErrorText = document.getElementById("geo-error-text");
const sharingPill = document.getElementById("sharing-pill");
const liveStatusText = document.getElementById("live-status-text");
const btnStartLocation = document.getElementById("btn-start-location");
const btnStopLocation = document.getElementById("btn-stop-location");
const btnGhostToggle = document.getElementById("btn-ghost-toggle");
const btnSetMeetup = document.getElementById("btn-set-meetup");
const btnSos = document.getElementById("btn-sos");
const btnTileToggle = document.getElementById("btn-tile-toggle");
const rendezvousBanner = document.getElementById("rendezvous-banner");
const rendezvousLabelEl = document.getElementById("rendezvous-label");
const rendezvousDistEl = document.getElementById("rendezvous-distance");
const sosBanner = document.getElementById("sos-alert-banner");
const sosAlertText = document.getElementById("sos-alert-text");
const proximityToast = document.getElementById("proximity-toast");
const proximityToastText = document.getElementById("proximity-toast-text");
const workspace = document.querySelector(".workspace-container");

// Audio alert
const pingSound = new Audio("/ting.mp3");

// Parse room credentials from URL or window.__OMW_CONFIG__
const omwConfig = window.__OMW_CONFIG__;
if (omwConfig && omwConfig.isPersistentGroup && omwConfig.groupId) {
  currentRoomId = omwConfig.groupId;
  currentToken = "persistent_group_session";
  localDisplayName = omwConfig.currentUser ? omwConfig.currentUser.displayName : "Member";
  if (headerRoomId) headerRoomId.textContent = omwConfig.groupName || currentRoomId;
  initSession();
} else {
  const urlParams = new URLSearchParams(window.location.search);
  currentRoomId = urlParams.get("roomId");
  currentToken = urlParams.get("token");

  if (!currentRoomId || !currentToken) {
    if (invalidModal) {
      invalidModal.classList.remove("hidden");
    }
  } else {
    if (headerRoomId) headerRoomId.textContent = currentRoomId;
    initSession();
  }
}

// --------------------------------------------------------------------------
// Map Initialization & Dark Tile Layer
// --------------------------------------------------------------------------
const map = L.map("map", { zoomControl: true }).setView([20, 0], 2);

// High-performance dark map layer using OpenStreetMap + CSS filter (zero API key required)
const darkTileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
  className: "leaflet-dark-tiles"
});

// Standard OpenStreetMap (Light theme fallback)
const osmTileLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors"
});

let isDarkMap = true;
darkTileLayer.addTo(map);

function toggleMapTiles() {
  if (isDarkMap) {
    map.removeLayer(darkTileLayer);
    osmTileLayer.addTo(map);
    isDarkMap = false;
    btnTileToggle.textContent = "🌙 Dark Map";
  } else {
    map.removeLayer(osmTileLayer);
    darkTileLayer.addTo(map);
    isDarkMap = true;
    btnTileToggle.textContent = "☀️ Light Map";
  }
}
window.toggleMapTiles = toggleMapTiles;

// Set default mobile tab
if (workspace) {
  workspace.classList.add("tab-map");
}

// Map Click Listener for "Meet Here" Dropping
map.on("click", (e) => {
  if (!isSettingMeetupMode) return;
  const { lat, lng } = e.latlng;
  const label = prompt("Enter a label for this shared meeting point:", "Meet Here") || "Meeting Point";
  socket.emit("set-rendezvous", { latitude: lat, longitude: lng, label });
  isSettingMeetupMode = false;
  btnSetMeetup.classList.remove("active");
  btnSetMeetup.textContent = "🎯 Meet Here";
});

// --------------------------------------------------------------------------
// Distance & Proximity Helpers
// --------------------------------------------------------------------------
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in metres
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

function formatDistance(meters) {
  if (meters < 1000) return `${meters}m`;
  return `${(meters / 1000).toFixed(1)}km`;
}

// Check proximity between self and peer
function checkProximity(peerId, peerName, peerLat, peerLng) {
  if (!isSharing || lastKnownLat === null || lastKnownLng === null) return;
  const dist = calculateDistanceMeters(lastKnownLat, lastKnownLng, peerLat, peerLng);

  if (dist <= 50 && !alertedPeers.has(peerId)) {
    alertedPeers.add(peerId);
    showProximityToast(`🎉 You and ${peerName} are close (~${dist}m)!`);
    pingSound.currentTime = 0;
    pingSound.play().catch(() => {});
  } else if (dist > 75) {
    // Reset alert if they move apart
    alertedPeers.delete(peerId);
  }
}

function showProximityToast(text) {
  if (!proximityToast || !proximityToastText) return;
  proximityToastText.textContent = text;
  proximityToast.classList.remove("hidden");
  setTimeout(() => {
    proximityToast.classList.add("hidden");
  }, 5000);
}

// --------------------------------------------------------------------------
// Custom Zenly-Style Glowing Avatar Markers
// --------------------------------------------------------------------------
function createZenlyMarkerIcon(displayName, isSelf, isSos) {
  const initial = (displayName || "U").trim().charAt(0).toUpperCase();
  const classes = `zenly-avatar-marker ${isSelf ? "self" : ""} ${isSos ? "sos" : ""}`;
  const html = `
    <div class="${classes}">
      <div class="zenly-pulse"></div>
      <div class="zenly-disc">${initial}</div>
    </div>
  `;
  return L.divIcon({
    className: "zenly-custom-icon",
    html,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20]
  });
}

function createRendezvousIcon() {
  return L.divIcon({
    className: "rendezvous-custom-icon",
    html: `<div class="rendezvous-marker-icon">🎯</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -20]
  });
}

// --------------------------------------------------------------------------
// Connection & Presence
// --------------------------------------------------------------------------
socket.on("connect", () => {
  setConnectionStatus("connected", "Connected");
});

socket.on("disconnect", () => {
  setConnectionStatus("disconnected", "Disconnected");
});

socket.on("connect_error", () => {
  setConnectionStatus("connecting", "Reconnecting...");
});

function setConnectionStatus(status, text) {
  if (!connStatus || !connText) return;
  connStatus.className = `status-pill status-${status}`;
  connText.textContent = text;
}

// Session Initializer
function initSession() {
  if (omwConfig && omwConfig.isPersistentGroup) {
    attemptJoin(localDisplayName);
    return;
  }
  const savedName = sessionStorage.getItem("rth_display_name");
  if (savedName) {
    attemptJoin(savedName);
  } else {
    joinModal.classList.remove("hidden");
    if (displayNameInput) displayNameInput.focus();
  }
}

function handleJoinModalSubmit(e) {
  e.preventDefault();
  const rawName = displayNameInput.value.trim();
  if (!rawName) return;
  attemptJoin(rawName);
}
window.handleJoinModalSubmit = handleJoinModalSubmit;

function attemptJoin(name) {
  const isPersistent = Boolean(omwConfig && omwConfig.isPersistentGroup);
  const payload = isPersistent
    ? { groupId: currentRoomId, isPersistent: true }
    : { roomId: currentRoomId, token: currentToken, name };

  socket.emit("join-room", payload, (res) => {
    if (res && res.success) {
      localDisplayName = res.displayName || localDisplayName;
      sessionStorage.setItem("rth_display_name", localDisplayName);
      if (joinModal) joinModal.classList.add("hidden");
      if (headerRoomId) headerRoomId.textContent = omwConfig?.groupName || res.roomId;

      // Populate presence & initial location snapshot
      if (Array.isArray(res.participants)) {
        renderParticipantList(res.participants);
      }
      if (Array.isArray(res.locations)) {
        populateLocationSnapshot(res.locations);
      }
      if (res.rendezvous) {
        renderRendezvous(res.rendezvous);
      }
      if (Array.isArray(res.history)) {
        res.history.forEach((msg) => {
          const isSelf = Boolean(omwConfig?.currentUser && msg.user_id === omwConfig.currentUser.id);
          appendChatMessage(msg.sender_name || msg.name, msg.body || msg.message, msg.created_at || msg.timestamp, isSelf ? "self" : "peer", false);
        });
      }

      appendSystemMessage(`You joined as "${localDisplayName}"`);
    } else {
      const errMsg = res && res.error ? res.error : "Failed to join room";
      if (joinModal.classList.contains("hidden")) {
        joinModal.classList.remove("hidden");
      }
      if (joinErrorMsg) {
        joinErrorMsg.textContent = errMsg;
        joinErrorMsg.classList.remove("hidden");
      }
    }
  });
}

// Persistent Group Invite Modal Handlers
function openInviteModal() {
  const modal = document.getElementById("invite-modal");
  if (modal) modal.classList.remove("hidden");
}
window.openInviteModal = openInviteModal;

function closeInviteModal() {
  const modal = document.getElementById("invite-modal");
  if (modal) modal.classList.add("hidden");
}
window.closeInviteModal = closeInviteModal;

async function handleCreateInvite() {
  const hours = document.getElementById("invite-hours-select").value;
  const maxUsesVal = document.getElementById("invite-max-uses").value;
  const cfg = window.__OMW_CONFIG__;
  if (!cfg || !cfg.groupId) return;

  try {
    const res = await fetch(`/api/groups/${cfg.groupId}/invites`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": cfg.csrfToken
      },
      body: JSON.stringify({
        expiresInHours: hours,
        maxUses: maxUsesVal ? parseInt(maxUsesVal, 10) : null
      })
    });
    const data = await res.json();
    if (data.success) {
      document.getElementById("generated-invite-input").value = data.inviteUrl;
      document.getElementById("generated-invite-box").classList.remove("hidden");
    } else {
      alert(data.error || "Failed to create invite link");
    }
  } catch (err) {
    alert("Network error creating invite link");
  }
}
window.handleCreateInvite = handleCreateInvite;

function copyGeneratedInvite() {
  const input = document.getElementById("generated-invite-input");
  input.select();
  navigator.clipboard.writeText(input.value);
  const btn = document.getElementById("copy-generated-invite-btn");
  btn.textContent = "Copied!";
  setTimeout(() => { btn.textContent = "Copy"; }, 2000);
}
window.copyGeneratedInvite = copyGeneratedInvite;

// --------------------------------------------------------------------------
// Presence: Dynamic Participant List & Distance Badges
// --------------------------------------------------------------------------
socket.on("participants-updated", (participants) => {
  if (Array.isArray(participants)) {
    renderParticipantList(participants);
  }
});

function renderParticipantList(list) {
  if (!participantListEl) return;
  participantListEl.innerHTML = "";

  const totalMembers = list.length;
  let activeSharers = 0;

  list.forEach((p) => {
    if (p.isSharingLocation) activeSharers++;

    const li = document.createElement("li");
    li.className = "participant-item";

    const wrap = document.createElement("div");
    wrap.className = "participant-name-wrap";

    const dot = document.createElement("span");
    dot.className = `avatar-dot ${p.isSharingLocation ? "active-sharer" : ""}`;
    wrap.appendChild(dot);

    const nameSpan = document.createElement("span");
    nameSpan.className = "participant-name";
    nameSpan.textContent = p.name; // Safe textContent
    wrap.appendChild(nameSpan);

    if (p.id === socket.id) {
      const selfTag = document.createElement("span");
      selfTag.className = "self-tag";
      selfTag.textContent = "(You)";
      wrap.appendChild(selfTag);
    }

    li.appendChild(wrap);

    // Live Distance Badge if location is active
    if (p.isSharingLocation) {
      const badgeBtn = document.createElement("button");
      badgeBtn.className = "live-badge";

      // If user has location, show live relative distance
      let distText = "📍 View";
      if (lastKnownLat !== null && lastKnownLng !== null && activeLocations.has(p.id) && p.id !== socket.id) {
        const peerLoc = activeLocations.get(p.id);
        const dist = calculateDistanceMeters(lastKnownLat, lastKnownLng, peerLoc.latitude, peerLoc.longitude);
        distText = `📍 ${formatDistance(dist)}`;
      }

      badgeBtn.textContent = distText;
      badgeBtn.title = "Center map on this user";
      badgeBtn.onclick = () => focusParticipant(p.id);
      li.appendChild(badgeBtn);
    }

    participantListEl.appendChild(li);
  });

  if (sidebarMemberCount) sidebarMemberCount.textContent = totalMembers;
  if (mobileMemberCount) mobileMemberCount.textContent = totalMembers;
  if (mobileSharerCount) mobileSharerCount.textContent = activeSharers;
}

function focusParticipant(id) {
  if (id === socket.id && lastKnownLat !== null) {
    map.setView([lastKnownLat, lastKnownLng], 16);
    if (userMarker) userMarker.openPopup();
  } else if (markers.has(id)) {
    const m = markers.get(id);
    map.setView(m.getLatLng(), 16);
    m.openPopup();
  }
  switchMobileTab("map");
}

// --------------------------------------------------------------------------
// Chat Feed & Quick Action Chips
// --------------------------------------------------------------------------
socket.on("user-joined", (name) => {
  appendSystemMessage(`${name} joined the room`);
});

socket.on("left", (name) => {
  appendSystemMessage(`${name} left the room`);
});

socket.on("receive", (data) => {
  if (!data || typeof data !== "object") return;
  if (data.isSystem) {
    appendSystemMessage(data.message);
  } else if (data.isSos) {
    appendSosNotice(data.name, data.message);
  } else {
    appendChatMessage(data.name, data.message, data.timestamp, "peer", data.isChip);
  }
});

function handleSendMessage(e) {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;

  chatInput.value = "";
  appendChatMessage(localDisplayName, text, Date.now(), "self", false);

  socket.emit("send", { message: text, isChip: false }, (ack) => {
    if (ack && !ack.success) {
      appendSystemMessage(`Message rejected: ${ack.error || "Rate limit exceeded"}`);
    }
  });
}
window.handleSendMessage = handleSendMessage;

// Quick Action Status Chips Trigger (Calm voice, opt-in location pin)
function sendStatusChip(chipText, chipType) {
  const attachToggle = document.getElementById("attach-location-toggle");
  const attachLocation = Boolean(attachToggle && attachToggle.checked && lastKnownLat !== null && lastKnownLng !== null);

  appendChatMessage(localDisplayName, chipText, Date.now(), "self", true);
  socket.emit("send", {
    message: chipText,
    isChip: true,
    chipType: chipType || 'status',
    attachLocation,
    latitude: attachLocation ? lastKnownLat : null,
    longitude: attachLocation ? lastKnownLng : null
  });
}
window.sendStatusChip = sendStatusChip;
window.sendActionChip = sendStatusChip; // Backwards-compatible alias

function appendChatMessage(sender, text, timestamp, type, isChip) {
  if (!chatMessagesEl) return;

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble ${type} ${isChip ? "chip" : ""}`;

  if (type === "peer") {
    const senderEl = document.createElement("div");
    senderEl.className = "msg-sender";
    senderEl.textContent = sender;
    bubble.appendChild(senderEl);
  }

  const textEl = document.createElement("div");
  textEl.className = "msg-text";
  textEl.textContent = text;
  bubble.appendChild(textEl);

  const timeEl = document.createElement("div");
  timeEl.className = "msg-time";
  timeEl.textContent = formatTime(timestamp);
  bubble.appendChild(timeEl);

  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;

  if (type === "peer") {
    pingSound.currentTime = 0;
    pingSound.play().catch(() => {});
  }
}

function appendSystemMessage(text) {
  if (!chatMessagesEl) return;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble system";
  bubble.textContent = text;
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function appendSosNotice(sender, text) {
  if (!chatMessagesEl) return;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble system sos-chip";
  bubble.style.border = "1px solid #ef4444";
  bubble.style.color = "#f87171";
  bubble.style.fontWeight = "700";
  bubble.textContent = text;
  chatMessagesEl.appendChild(bubble);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// --------------------------------------------------------------------------
// Location & Map (Privacy-First User Lifecycle & Zenly Markers)
// --------------------------------------------------------------------------
function formatTime(ts) {
  if (!ts) return "Just now";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// XSS-Safe Popup Builder
function createSafePopup(name, isSelf, updatedAt, isGhost) {
  const wrap = document.createElement("div");
  wrap.className = "leaflet-safe-popup";

  const title = document.createElement("div");
  title.style.fontWeight = "700";
  title.style.fontSize = "0.92rem";
  title.style.color = isSelf ? "#10b981" : "#38bdf8";
  title.textContent = isSelf ? `📍 You (${name})` : `👤 ${name}`;
  wrap.appendChild(title);

  if (isGhost) {
    const ghostTag = document.createElement("div");
    ghostTag.style.fontSize = "0.72rem";
    ghostTag.style.color = "#a5b4fc";
    ghostTag.textContent = "👻 Ghost Mode (~300m fuzzy)";
    wrap.appendChild(ghostTag);
  }

  const meta = document.createElement("div");
  meta.style.fontSize = "0.75rem";
  meta.style.color = "#94a3b8";
  meta.style.marginTop = "3px";
  meta.textContent = `Updated: ${formatTime(updatedAt)}`;
  wrap.appendChild(meta);

  return wrap;
}

function populateLocationSnapshot(locations) {
  locations.forEach((loc) => {
    if (!loc || !loc.id || loc.id === socket.id) return;
    activeLocations.set(loc.id, loc);
    updateOrAddMarker(loc.id, loc.name, loc.latitude, loc.longitude, loc.updatedAt, loc.isGhost);
  });
  updateRendezvousLines();
}

function updateOrAddMarker(id, name, lat, lng, updatedAt, isGhost) {
  if (typeof lat !== "number" || typeof lng !== "number") return;

  activeLocations.set(id, { id, name, latitude: lat, longitude: lng, updatedAt, isGhost });

  // Check proximity to peer
  checkProximity(id, name, lat, lng);

  if (markers.has(id)) {
    const marker = markers.get(id);
    marker.setLatLng([lat, lng]);
    marker.setPopupContent(createSafePopup(name, false, updatedAt, isGhost));
  } else {
    const marker = L.marker([lat, lng], {
      icon: createZenlyMarkerIcon(name, false, false)
    }).addTo(map);
    marker.bindPopup(createSafePopup(name, false, updatedAt, isGhost));
    markers.set(id, marker);
  }

  // Draw or update ghost mode radius circle
  if (isGhost) {
    if (ghostCircles.has(id)) {
      ghostCircles.get(id).setLatLng([lat, lng]);
    } else {
      const circle = L.circle([lat, lng], {
        radius: 300,
        color: "#818cf8",
        fillColor: "#6366f1",
        fillOpacity: 0.15,
        weight: 1,
        dashArray: "4, 6"
      }).addTo(map);
      ghostCircles.set(id, circle);
    }
  } else if (ghostCircles.has(id)) {
    map.removeLayer(ghostCircles.get(id));
    ghostCircles.delete(id);
  }

  updateRendezvousLines();
}

function removeMarker(id) {
  if (markers.has(id)) {
    map.removeLayer(markers.get(id));
    markers.delete(id);
  }
  if (ghostCircles.has(id)) {
    map.removeLayer(ghostCircles.get(id));
    ghostCircles.delete(id);
  }
  if (rendezvousLines.has(id)) {
    map.removeLayer(rendezvousLines.get(id));
    rendezvousLines.delete(id);
  }
  activeLocations.delete(id);
}

socket.on("receive-location", (data) => {
  if (!data || !data.id || data.id === socket.id) return;
  updateOrAddMarker(data.id, data.name, data.latitude, data.longitude, data.updatedAt, data.isGhost);
});

socket.on("location-stopped", (data) => {
  if (!data || !data.id) return;
  removeMarker(data.id);
  appendSystemMessage(`${data.name || "A participant"} stopped sharing location`);
});

// Ghost Mode Toggle
function toggleGhostMode() {
  isGhostMode = !isGhostMode;
  if (isGhostMode) {
    btnGhostToggle.classList.add("active");
    btnGhostToggle.textContent = "👻 Ghost: ON (~300m)";
    if (liveStatusText) liveStatusText.textContent = "Ghost Mode Active (~300m)";
  } else {
    btnGhostToggle.classList.remove("active");
    btnGhostToggle.textContent = "👻 Ghost: OFF";
    if (liveStatusText) liveStatusText.textContent = "Live GPS Active";
  }

  // If already sharing, re-emit with new mode
  if (isSharing && lastKnownLat !== null) {
    emitLocationUpdate(lastKnownLat, lastKnownLng);
  }
}
window.toggleGhostMode = toggleGhostMode;

// Explicit Start Location Sharing
function startLocationSharing() {
  if (isSharing || watchId !== null) return;
  dismissGeoError();

  if (!navigator.geolocation) {
    showGeoError("Geolocation is not supported by your browser.");
    return;
  }

  if (!window.isSecureContext && window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
    showGeoError("Live location sharing requires HTTPS or localhost.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    onLocationUpdate,
    onLocationError,
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
  );

  isSharing = true;

  btnStartLocation.classList.add("hidden");
  btnStopLocation.classList.remove("hidden");
  sharingPill.classList.remove("hidden");

  appendSystemMessage("You started sharing your live location");
}
window.startLocationSharing = startLocationSharing;

let lastEmittedLat = null;
let lastEmittedLng = null;
let lastEmittedTime = 0;
const MIN_DISTANCE_DELTA = 0.00005; // ~5m
const MIN_TIME_INTERVAL_MS = 1500; // 1.5s throttling

function onLocationUpdate(position) {
  if (!isSharing) return;

  const { latitude, longitude } = position.coords;
  lastKnownLat = latitude;
  lastKnownLng = longitude;
  const now = Date.now();

  // Update own Zenly-style marker
  if (!userMarker) {
    userMarker = L.marker([latitude, longitude], {
      icon: createZenlyMarkerIcon(localDisplayName, true, isSosActive)
    }).addTo(map);
    userMarker.bindPopup(createSafePopup(localDisplayName, true, now, isGhostMode));
    userMarker.openPopup();
  } else {
    userMarker.setLatLng([latitude, longitude]);
    userMarker.setPopupContent(createSafePopup(localDisplayName, true, now, isGhostMode));
  }

  // Update own ghost circle
  if (isGhostMode) {
    if (userGhostCircle) {
      userGhostCircle.setLatLng([latitude, longitude]);
    } else {
      userGhostCircle = L.circle([latitude, longitude], {
        radius: 300,
        color: "#10b981",
        fillColor: "#059669",
        fillOpacity: 0.15,
        weight: 1,
        dashArray: "4, 6"
      }).addTo(map);
    }
  } else if (userGhostCircle) {
    map.removeLayer(userGhostCircle);
    userGhostCircle = null;
  }

  if (!hasCenteredOnce) {
    map.setView([latitude, longitude], 15);
    hasCenteredOnce = true;
  }

  // Update distance to rendezvous point if exists
  updateRendezvousDistance();
  updateRendezvousLines();

  const distDelta =
    lastEmittedLat !== null
      ? Math.abs(latitude - lastEmittedLat) + Math.abs(longitude - lastEmittedLng)
      : Infinity;

  if (distDelta >= MIN_DISTANCE_DELTA || now - lastEmittedTime >= MIN_TIME_INTERVAL_MS) {
    emitLocationUpdate(latitude, longitude);
  }
}

async function getBatteryInfo() {
  if (typeof navigator !== "undefined" && "getBattery" in navigator) {
    try {
      const b = await navigator.getBattery();
      return {
        level: Math.round(b.level * 100),
        charging: b.charging
      };
    } catch (e) {
      return null;
    }
  }
  return null;
}

async function emitLocationUpdate(lat, lng) {
  let emitLat = lat;
  let emitLng = lng;

  // If Ghost mode, fuzz coordinates by ~250m
  if (isGhostMode) {
    emitLat = lat + 0.0022;
    emitLng = lng + 0.0022;
  }

  lastEmittedLat = lat;
  lastEmittedLng = lng;
  lastEmittedTime = Date.now();

  const battery = await getBatteryInfo();

  socket.emit("send-location", {
    latitude: emitLat,
    longitude: emitLng,
    isGhost: isGhostMode,
    battery
  }, (ack) => {
    if (ack && ack.code === 'EXPIRED') {
      stopLocationSharing(false);
      appendSystemMessage("Your location sharing time expired.");
    }
  });
}

function onLocationError(err) {
  let msg = "Could not retrieve GPS coordinates.";
  if (err.code === err.PERMISSION_DENIED) {
    msg = "Location permission was denied in your browser settings.";
  } else if (err.code === err.POSITION_UNAVAILABLE) {
    msg = "GPS/Position is currently unavailable on this device.";
  } else if (err.code === err.TIMEOUT) {
    msg = "GPS location request timed out. Retrying...";
  }

  showGeoError(msg);
  if (err.code === err.PERMISSION_DENIED || err.code === err.POSITION_UNAVAILABLE) {
    stopLocationSharing(true);
  }
}

function stopLocationSharing(notifyServer = true) {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  isSharing = false;

  if (userMarker) {
    map.removeLayer(userMarker);
    userMarker = null;
  }
  if (userGhostCircle) {
    map.removeLayer(userGhostCircle);
    userGhostCircle = null;
  }

  lastEmittedLat = null;
  lastEmittedLng = null;

  btnStartLocation.classList.remove("hidden");
  btnStopLocation.classList.add("hidden");
  sharingPill.classList.add("hidden");

  if (notifyServer && socket.connected) {
    socket.emit("stop-location");
  }

  appendSystemMessage("You stopped sharing your live location");
}
window.stopLocationSharing = stopLocationSharing;

function recenterMap() {
  if (lastKnownLat !== null && lastKnownLng !== null) {
    map.setView([lastKnownLat, lastKnownLng], 16);
    if (userMarker) userMarker.openPopup();
  } else if (markers.size > 0) {
    const group = new L.featureGroup(Array.from(markers.values()));
    map.fitBounds(group.getBounds().pad(0.15));
  } else {
    showGeoError("You are not sharing location yet. Click 'Share My Location' first.");
  }
}
window.recenterMap = recenterMap;

function showGeoError(msg) {
  if (geoErrorText && geoBanner) {
    geoErrorText.textContent = msg;
    geoBanner.classList.remove("hidden");
  }
}

function dismissGeoError() {
  if (geoBanner) geoBanner.classList.add("hidden");
}
window.dismissGeoError = dismissGeoError;

// --------------------------------------------------------------------------
// Shared Rendezvous Point ("Meet Here") Feature
// --------------------------------------------------------------------------
function toggleMeetingPointMode() {
  isSettingMeetupMode = !isSettingMeetupMode;
  if (isSettingMeetupMode) {
    btnSetMeetup.classList.add("active");
    btnSetMeetup.textContent = "📍 Click Map to Place";
    alert("Click anywhere on the map to place the shared Rendezvous / Meetup Flag!");
  } else {
    btnSetMeetup.classList.remove("active");
    btnSetMeetup.textContent = "🎯 Meet Here";
  }
}
window.toggleMeetingPointMode = toggleMeetingPointMode;

socket.on("rendezvous-updated", (rendezvous) => {
  renderRendezvous(rendezvous);
});

socket.on("rendezvous-cleared", () => {
  clearRendezvousUI();
});

function renderRendezvous(r) {
  if (!r) return;
  currentRendezvous = r;

  // Create or move marker
  if (!rendezvousMarker) {
    rendezvousMarker = L.marker([r.latitude, r.longitude], {
      icon: createRendezvousIcon()
    }).addTo(map);
    rendezvousMarker.bindPopup(`<b>🎯 Meeting Point</b><br>${r.label}<br><span style="font-size:0.75rem;color:#666;">Set by ${r.createdBy}</span>`);
  } else {
    rendezvousMarker.setLatLng([r.latitude, r.longitude]);
    rendezvousMarker.setPopupContent(`<b>🎯 Meeting Point</b><br>${r.label}<br><span style="font-size:0.75rem;color:#666;">Set by ${r.createdBy}</span>`);
  }

  // Show banner
  if (rendezvousBanner && rendezvousLabelEl) {
    rendezvousLabelEl.textContent = `Meet at: ${r.label}`;
    rendezvousBanner.classList.remove("hidden");
  }

  updateRendezvousDistance();
  updateRendezvousLines();
}

function updateRendezvousDistance() {
  if (!currentRendezvous || !rendezvousDistEl) return;
  if (lastKnownLat !== null && lastKnownLng !== null) {
    const d = calculateDistanceMeters(lastKnownLat, lastKnownLng, currentRendezvous.latitude, currentRendezvous.longitude);
    rendezvousDistEl.textContent = `You are ~${formatDistance(d)} away`;
  } else {
    rendezvousDistEl.textContent = "Share your location to see distance";
  }
}

// Draw dashed line from each active member to the rendezvous spot
function updateRendezvousLines() {
  if (!currentRendezvous) {
    rendezvousLines.forEach((line) => map.removeLayer(line));
    rendezvousLines.clear();
    return;
  }

  const target = [currentRendezvous.latitude, currentRendezvous.longitude];

  // Self line
  if (isSharing && lastKnownLat !== null) {
    if (rendezvousLines.has("self")) {
      rendezvousLines.get("self").setLatLngs([[lastKnownLat, lastKnownLng], target]);
    } else {
      const line = L.polyline([[lastKnownLat, lastKnownLng], target], {
        dashArray: "5, 8",
        color: "#10b981",
        weight: 2,
        opacity: 0.7
      }).addTo(map);
      rendezvousLines.set("self", line);
    }
  }

  // Peer lines
  activeLocations.forEach((loc, id) => {
    if (rendezvousLines.has(id)) {
      rendezvousLines.get(id).setLatLngs([[loc.latitude, loc.longitude], target]);
    } else {
      const line = L.polyline([[loc.latitude, loc.longitude], target], {
        dashArray: "5, 8",
        color: "#38bdf8",
        weight: 2,
        opacity: 0.7
      }).addTo(map);
      rendezvousLines.set(id, line);
    }
  });
}

function focusRendezvous() {
  if (currentRendezvous) {
    map.setView([currentRendezvous.latitude, currentRendezvous.longitude], 16);
    if (rendezvousMarker) rendezvousMarker.openPopup();
  }
}
window.focusRendezvous = focusRendezvous;

function clearMeetingPoint() {
  if (confirm("Clear the shared meeting point for everyone?")) {
    socket.emit("clear-rendezvous");
    clearRendezvousUI();
  }
}
window.clearMeetingPoint = clearMeetingPoint;

function clearRendezvousUI() {
  currentRendezvous = null;
  if (rendezvousMarker) {
    map.removeLayer(rendezvousMarker);
    rendezvousMarker = null;
  }
  if (rendezvousBanner) {
    rendezvousBanner.classList.add("hidden");
  }
  rendezvousLines.forEach((line) => map.removeLayer(line));
  rendezvousLines.clear();
}

// --------------------------------------------------------------------------
// Emergency / SOS Beacon Feature (3-Second Radial Hold-to-Confirm)
// --------------------------------------------------------------------------
let sosHoldStart = 0;
let sosHoldAnimFrame = null;
const SOS_HOLD_DURATION_MS = 3000;
let currentActiveSosId = null;

function initSosHoldButton() {
  const btn = document.getElementById("btn-sos");
  const progressPath = document.getElementById("sos-radial-progress");
  if (!btn || !progressPath) return;

  function startHold(e) {
    if (e.type === "mousedown" && e.button !== 0) return;
    e.preventDefault();
    sosHoldStart = Date.now();

    function updateProgress() {
      const elapsed = Date.now() - sosHoldStart;
      const pct = Math.min((elapsed / SOS_HOLD_DURATION_MS) * 100, 100);
      progressPath.setAttribute("stroke-dasharray", `${pct}, 100`);

      if (elapsed >= SOS_HOLD_DURATION_MS) {
        completeHold();
      } else {
        sosHoldAnimFrame = requestAnimationFrame(updateProgress);
      }
    }

    sosHoldAnimFrame = requestAnimationFrame(updateProgress);
  }

  function cancelHold() {
    if (sosHoldAnimFrame) {
      cancelAnimationFrame(sosHoldAnimFrame);
      sosHoldAnimFrame = null;
    }
    if (progressPath) {
      progressPath.setAttribute("stroke-dasharray", "0, 100");
    }
  }

  function completeHold() {
    cancelHold();
    triggerSosBeacon();
  }

  btn.addEventListener("mousedown", startHold);
  btn.addEventListener("touchstart", startHold, { passive: false });

  btn.addEventListener("mouseup", cancelHold);
  btn.addEventListener("mouseleave", cancelHold);
  btn.addEventListener("touchend", cancelHold);
  btn.addEventListener("touchcancel", cancelHold);
}

function triggerSosBeacon() {
  if (isSosActive) return;

  isSosActive = true;
  const btnSos = document.getElementById("btn-sos");
  if (btnSos) {
    btnSos.classList.add("active");
  }

  if (!isSharing) {
    startLocationSharing();
  }

  socket.emit("sos-alert", {
    latitude: lastKnownLat,
    longitude: lastKnownLng
  }, (ack) => {
    if (ack && ack.sosId) {
      currentActiveSosId = ack.sosId;
      showActiveSosBanner(true, localDisplayName, ack.sosId);
    }
  });

  if (userMarker) {
    userMarker.setIcon(createZenlyMarkerIcon(localDisplayName, true, true));
  }
}
window.triggerSosBeacon = triggerSosBeacon;

async function respondToActiveSos() {
  if (!currentActiveSosId) return;
  socket.emit("sos-respond", { sosId: currentActiveSosId });
  try {
    await fetch(`/api/sos/${currentActiveSosId}/respond`, {
      method: "POST",
      headers: { "x-csrf-token": getCsrfToken() }
    });
  } catch (e) {}
  const respondBtn = document.getElementById("btn-sos-respond");
  if (respondBtn) {
    respondBtn.textContent = "✅ Responded";
    respondBtn.disabled = true;
  }
}
window.respondToActiveSos = respondToActiveSos;

async function cancelActiveSos() {
  if (!currentActiveSosId) return;
  socket.emit("sos-cancel", { sosId: currentActiveSosId });
  try {
    await fetch(`/api/sos/${currentActiveSosId}/cancel`, {
      method: "POST",
      headers: { "x-csrf-token": getCsrfToken() }
    });
  } catch (e) {}
  dismissSosBanner();
  isSosActive = false;
  const btnSos = document.getElementById("btn-sos");
  if (btnSos) btnSos.classList.remove("active");
  if (userMarker) userMarker.setIcon(createZenlyMarkerIcon(localDisplayName, true, false));
}
window.cancelActiveSos = cancelActiveSos;

function showActiveSosBanner(isSender, senderName, sosId) {
  currentActiveSosId = sosId;
  const banner = document.getElementById("sos-alert-banner");
  const alertText = document.getElementById("sos-alert-text");
  const respondBtn = document.getElementById("btn-sos-respond");
  const cancelBtn = document.getElementById("btn-sos-cancel");

  if (!banner || !alertText) return;

  alertText.textContent = `🚨 EMERGENCY ALERT: ${senderName} triggered an SOS Beacon!`;
  banner.classList.remove("hidden");

  if (isSender) {
    if (respondBtn) respondBtn.classList.add("hidden");
    if (cancelBtn) cancelBtn.classList.remove("hidden");
  } else {
    if (respondBtn) {
      respondBtn.classList.remove("hidden");
      respondBtn.textContent = "🛡️ I'm on it";
      respondBtn.disabled = false;
    }
    if (cancelBtn) cancelBtn.classList.add("hidden");
  }
}

// Incoming SOS Alert Broadcast
socket.on("sos-broadcast", (alertData) => {
  if (!alertData) return;

  // Play high priority sound
  pingSound.currentTime = 0;
  pingSound.play().catch(() => {});

  const isMe = alertData.name === localDisplayName;
  showActiveSosBanner(isMe, alertData.name, alertData.sosId || alertData.id);

  // Update peer marker to SOS pulse
  if (alertData.id && markers.has(alertData.id)) {
    const marker = markers.get(alertData.id);
    marker.setIcon(createZenlyMarkerIcon(alertData.name, false, true));
    if (alertData.latitude && alertData.longitude) {
      map.setView([alertData.latitude, alertData.longitude], 17);
      marker.openPopup();
    }
  }
});

socket.on("sos-updated", (event) => {
  if (!event) return;
  const listEl = document.getElementById("sos-responders-list");
  if (listEl && event.responders && event.responders.length > 0) {
    const names = event.responders.map((r) => r.name).join(", ");
    listEl.textContent = `Responders: ${names}`;
  }
});

socket.on("sos-cancelled", () => {
  dismissSosBanner();
  if (userMarker) userMarker.setIcon(createZenlyMarkerIcon(localDisplayName, true, false));
  markers.forEach((m, id) => {
    const loc = activeLocations.get(id);
    if (loc) m.setIcon(createZenlyMarkerIcon(loc.name, false, false));
  });
});

function dismissSosBanner() {
  const banner = document.getElementById("sos-alert-banner");
  if (banner) banner.classList.add("hidden");
}
window.dismissSosBanner = dismissSosBanner;

// --------------------------------------------------------------------------
// Time-Boxed Sharing Dialogs & Transparency Log
// --------------------------------------------------------------------------
let activeShareExpiresAt = null;
let shareCountdownInterval = null;

function startShareCountdown(expiresAt) {
  activeShareExpiresAt = expiresAt;
  if (shareCountdownInterval) clearInterval(shareCountdownInterval);

  updateCountdownDisplay();
  shareCountdownInterval = setInterval(updateCountdownDisplay, 1000);
}

function updateCountdownDisplay() {
  const cdEl = document.getElementById("share-countdown");
  const liveTextEl = document.getElementById("live-status-text");
  if (!cdEl || !activeShareExpiresAt) return;

  const remainingMs = Math.max(activeShareExpiresAt - Date.now(), 0);
  if (remainingMs <= 0) {
    cdEl.textContent = "00:00";
    if (shareCountdownInterval) clearInterval(shareCountdownInterval);
    stopLocationSharing(true);
    appendSystemMessage("Your location sharing time expired.");
    return;
  }

  const totalSecs = Math.floor(remainingMs / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  cdEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;

  if (liveTextEl) {
    const expiryDate = new Date(activeShareExpiresAt);
    const hhmm = expiryDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const peopleCount = Math.max((document.querySelectorAll("#participant-list li").length || 1) - 1, 1);
    liveTextEl.textContent = `Sharing with ${peopleCount} ${peopleCount === 1 ? 'person' : 'people'} until ${hhmm}`;
  }
}

function stopShareCountdown() {
  if (shareCountdownInterval) {
    clearInterval(shareCountdownInterval);
    shareCountdownInterval = null;
  }
  activeShareExpiresAt = null;
}

function getCsrfToken() {
  const match = document.cookie.match(/omw_csrf=([^;]+)/);
  return match ? match[1] : '';
}

async function openShareSetupModal() {
  if (!window.__OMW_CONFIG__ || !window.__OMW_CONFIG__.isPersistent) {
    // Guest mode: 15m default
    startLocationSharing();
    startShareCountdown(Date.now() + 15 * 60 * 1000);
    return;
  }

  const modal = document.getElementById("share-setup-modal");
  const audienceEl = document.getElementById("share-audience-list");
  if (!modal || !audienceEl) return;

  audienceEl.innerHTML = "<span class='text-xs text-slate-400'>Loading your groups...</span>";
  modal.classList.remove("hidden");

  try {
    const res = await fetch("/api/groups");
    const data = await res.json();
    if (data.success && data.groups) {
      audienceEl.innerHTML = "";
      const currentGid = window.__OMW_CONFIG__.groupId;
      data.groups.forEach((g) => {
        const item = document.createElement("label");
        item.className = "audience-item";
        const isChecked = g.id === currentGid ? "checked" : "";
        item.innerHTML = `<input type="checkbox" name="audience-group" value="${g.id}" ${isChecked} /> <span>${g.name} (${g.member_count} members)</span>`;
        audienceEl.appendChild(item);
      });
    }
  } catch (err) {
    audienceEl.innerHTML = "<span class='text-xs text-rose-400'>Error loading groups</span>";
  }
}
window.openShareSetupModal = openShareSetupModal;

function closeShareSetupModal() {
  const modal = document.getElementById("share-setup-modal");
  if (modal) modal.classList.add("hidden");
}
window.closeShareSetupModal = closeShareSetupModal;

function handleDurationChange(val) {
  const destGroup = document.getElementById("destination-input-group");
  if (destGroup) {
    if (val === "until_arrive") {
      destGroup.classList.remove("hidden");
    } else {
      destGroup.classList.add("hidden");
    }
  }
}
window.handleDurationChange = handleDurationChange;

async function confirmStartSharing() {
  const durationInput = document.querySelector('input[name="share-duration"]:checked');
  const durationType = durationInput ? durationInput.value : "15m";

  const checkedBoxes = document.querySelectorAll('input[name="audience-group"]:checked');
  const targetGroupIds = Array.from(checkedBoxes).map((cb) => cb.value);

  if (targetGroupIds.length === 0 && window.__OMW_CONFIG__ && window.__OMW_CONFIG__.groupId) {
    targetGroupIds.push(window.__OMW_CONFIG__.groupId);
  }

  const destNameInput = document.getElementById("destination-name-input");
  const destinationName = destNameInput ? destNameInput.value.trim() : null;

  try {
    const res = await fetch("/api/location/start", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": getCsrfToken()
      },
      body: JSON.stringify({
        durationType,
        targetGroupIds,
        destinationName,
        destinationLat: lastKnownLat,
        destinationLng: lastKnownLng
      })
    });
    const data = await res.json();
    if (data.success && data.share) {
      closeShareSetupModal();
      startLocationSharing();
      if (data.share.expires_at) {
        startShareCountdown(data.share.expires_at);
      }
    } else {
      alert(data.error || "Could not start sharing");
    }
  } catch (err) {
    closeShareSetupModal();
    startLocationSharing();
    startShareCountdown(Date.now() + 15 * 60 * 1000);
  }
}
window.confirmStartSharing = confirmStartSharing;

async function extendActiveShare() {
  try {
    const res = await fetch("/api/location/extend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-csrf-token": getCsrfToken()
      },
      body: JSON.stringify({ additionalMinutes: 15 })
    });
    const data = await res.json();
    if (data.success && data.share && data.share.expires_at) {
      startShareCountdown(data.share.expires_at);
      appendSystemMessage("Extended location sharing by 15 minutes");
    }
  } catch (err) {
    if (activeShareExpiresAt) {
      startShareCountdown(activeShareExpiresAt + 15 * 60 * 1000);
      appendSystemMessage("Extended location sharing by 15 minutes");
    }
  }
}
window.extendActiveShare = extendActiveShare;

async function openShareLogModal() {
  const modal = document.getElementById("share-log-modal");
  const listEl = document.getElementById("share-log-list");
  if (!modal || !listEl) return;

  listEl.innerHTML = "<span class='text-xs text-slate-400'>Loading activity log...</span>";
  modal.classList.remove("hidden");

  try {
    const res = await fetch("/api/location/share-log");
    const data = await res.json();
    if (data.success && data.logs) {
      listEl.innerHTML = "";
      if (data.logs.length === 0) {
        listEl.innerHTML = "<span class='text-xs text-slate-400'>No recent location share records</span>";
      } else {
        data.logs.forEach((log) => {
          const item = document.createElement("div");
          item.className = "share-log-item";
          const actionIcons = { started: "🟢 Started", extended: "⏳ Extended", stopped: "⏹ Stopped", expired: "⏱ Expired" };
          const actionText = actionIcons[log.action] || log.action;
          const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          item.innerHTML = `<div><b>${actionText}</b><div class='text-xs text-slate-400'>Groups: ${log.target_groups}</div></div><span class='text-xs text-slate-500'>${timeStr}</span>`;
          listEl.appendChild(item);
        });
      }
    }
  } catch (err) {
    listEl.innerHTML = "<span class='text-xs text-rose-400'>Error loading share log</span>";
  }
}
window.openShareLogModal = openShareLogModal;

function closeShareLogModal() {
  const modal = document.getElementById("share-log-modal");
  if (modal) modal.classList.add("hidden");
}
window.closeShareLogModal = closeShareLogModal;

// Check Stale Markers every 15 seconds (>2 minutes without updates)
function checkStaleMarkers() {
  const now = Date.now();
  const STALE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  activeLocations.forEach((loc, id) => {
    if (markers.has(id)) {
      const marker = markers.get(id);
      const isStale = (now - loc.updatedAt) > STALE_THRESHOLD_MS;
      const markerEl = marker.getElement();
      if (markerEl) {
        if (isStale) {
          markerEl.classList.add("stale-marker");
        } else {
          markerEl.classList.remove("stale-marker");
        }
      }
    }
  });
}
setInterval(checkStaleMarkers, 15000);

// Initialize SOS hold button on page load
document.addEventListener("DOMContentLoaded", () => {
  initSosHoldButton();
});
setTimeout(initSosHoldButton, 500);

// --------------------------------------------------------------------------
// Navigation & Utilities
// --------------------------------------------------------------------------
function copyInviteLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const originalText = copyBtn.innerHTML;
    copyBtn.innerHTML = "✅ <span class='btn-text'>Copied!</span>";
    setTimeout(() => { copyBtn.innerHTML = originalText; }, 2000);
  }).catch(() => {
    alert(`Copy this invite link:\n${url}`);
  });
}
window.copyInviteLink = copyInviteLink;

function switchMobileTab(tab) {
  if (!workspace) return;
  workspace.classList.remove("tab-map", "tab-chat", "tab-members");
  workspace.classList.add(`tab-${tab}`);

  document.querySelectorAll(".tab-btn").forEach((btn) => btn.classList.remove("active"));
  const activeBtn = document.getElementById(`tab-btn-${tab}`);
  if (activeBtn) activeBtn.classList.add("active");

  if (tab === "map") {
    setTimeout(() => { map.invalidateSize(); }, 50);
  }
}
window.switchMobileTab = switchMobileTab;

function leaveRoom() {
  if (confirm("Are you sure you want to leave this room?")) {
    stopLocationSharing(false);
    socket.emit("leave-room", {}, () => {
      sessionStorage.removeItem("rth_display_name");
      window.location.href = "/";
    });
  }
}
window.leaveRoom = leaveRoom;

// --------------------------------------------------------------------------
// Group Meetups & ETAs Modal
// --------------------------------------------------------------------------
function openMeetupsModal() {
  const modal = document.getElementById("meetups-modal");
  if (!modal) return;
  modal.classList.remove("hidden");

  // Pre-fill default coordinates from current position or map center
  const latInput = document.getElementById("meetup-lat-input");
  const lngInput = document.getElementById("meetup-lng-input");
  if (latInput && lngInput) {
    if (lastKnownLat !== null && lastKnownLng !== null) {
      latInput.value = lastKnownLat.toFixed(5);
      lngInput.value = lastKnownLng.toFixed(5);
    } else if (map) {
      const center = map.getCenter();
      latInput.value = center.lat.toFixed(5);
      lngInput.value = center.lng.toFixed(5);
    }
  }

  // Pre-fill default start time (1 hour from now)
  const startInput = document.getElementById("meetup-start-input");
  if (startInput) {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    startInput.value = future.toISOString().slice(0, 16);
  }

  loadGroupMeetups();
}
window.openMeetupsModal = openMeetupsModal;

function closeMeetupsModal() {
  const modal = document.getElementById("meetups-modal");
  if (modal) modal.classList.add("hidden");
}
window.closeMeetupsModal = closeMeetupsModal;

async function loadGroupMeetups() {
  const container = document.getElementById("group-meetups-list");
  if (!container || !window.__OMW_CONFIG__ || !window.__OMW_CONFIG__.groupId) return;

  try {
    const res = await fetch(`/api/groups/${window.__OMW_CONFIG__.groupId}/meetups`);
    if (!res.ok) return;
    const data = await res.json();

    container.innerHTML = "";
    if (!data.meetups || data.meetups.length === 0) {
      container.innerHTML = '<span style="font-size: 0.8rem; color: #94a3b8;">No active meetups for this group yet.</span>';
      return;
    }

    data.meetups.forEach((m) => {
      const row = document.createElement("div");
      row.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 10px; background: rgba(0,0,0,0.25); border-radius: 8px; margin-bottom: 8px; border: 1px solid rgba(255,255,255,0.06);";

      const left = document.createElement("div");
      left.style.cssText = "display: flex; flex-direction: column; gap: 2px;";

      const title = document.createElement("a");
      title.href = `/meetups/${m.id}`;
      title.style.cssText = "font-size: 0.9rem; font-weight: bold; color: #38bdf8; text-decoration: none;";
      title.textContent = m.title;

      const meta = document.createElement("span");
      meta.style.cssText = "font-size: 0.75rem; color: #94a3b8;";
      const d = new Date(m.start_time);
      meta.textContent = `📍 ${m.destination.label} • ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

      left.appendChild(title);
      left.appendChild(meta);
      row.appendChild(left);

      const right = document.createElement("a");
      right.href = `/meetups/${m.id}`;
      right.className = "action-sm";
      right.style.cssText = "padding: 6px 12px; font-size: 0.75rem; background: #38bdf8; color: #0b1120; font-weight: bold; text-decoration: none; border-radius: 6px;";
      right.textContent = "Open →";
      row.appendChild(right);

      container.appendChild(row);
    });
  } catch (err) {
    console.error("Error loading group meetups:", err);
  }
}

async function submitCreateMeetup() {
  const titleInput = document.getElementById("meetup-title-input");
  const destLabelInput = document.getElementById("meetup-dest-label");
  const latInput = document.getElementById("meetup-lat-input");
  const lngInput = document.getElementById("meetup-lng-input");
  const startInput = document.getElementById("meetup-start-input");
  const stopOnArrival = document.getElementById("meetup-stop-on-arrival");
  const submitBtn = document.getElementById("btn-create-meetup-submit");

  const title = titleInput.value.trim();
  const label = destLabelInput.value.trim() || "Destination";
  const lat = parseFloat(latInput.value);
  const lng = parseFloat(lngInput.value);
  const startTime = new Date(startInput.value).getTime();

  if (!title) {
    alert("Please enter a meetup title.");
    return;
  }
  if (isNaN(lat) || isNaN(lng)) {
    alert("Please provide valid coordinates.");
    return;
  }
  if (isNaN(startTime) || startTime <= Date.now()) {
    alert("Please select a future start time.");
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = "Creating...";

  try {
    const res = await fetch(`/api/groups/${window.__OMW_CONFIG__.groupId}/meetups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        destination: { lat, lng, label },
        startTime,
        stopOnArrival: stopOnArrival ? stopOnArrival.checked : false
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      window.location.href = `/meetups/${data.meetup.id}`;
    } else {
      alert("Error creating meetup: " + (data.error || "Unknown error"));
      submitBtn.disabled = false;
      submitBtn.textContent = "Create Meetup";
    }
  } catch (err) {
    alert("Network error creating meetup.");
    submitBtn.disabled = false;
    submitBtn.textContent = "Create Meetup";
  }
}
window.submitCreateMeetup = submitCreateMeetup;

window.addEventListener("beforeunload", () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (isSharing && socket.connected) {
    socket.emit("stop-location");
  }
});
