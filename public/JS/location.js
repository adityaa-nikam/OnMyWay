const socket = io("/location");

// UI Elements
const roomBadge = document.getElementById("room-status-badge");
const sharerCountBadge = document.getElementById("sharer-count-badge");
const errorBanner = document.getElementById("error-banner");
const errorMessage = document.getElementById("error-message");
const startShareBtn = document.getElementById("start-share-btn");
const stopShareBtn = document.getElementById("stop-share-btn");
const sharingIndicator = document.getElementById("sharing-indicator");

// Room Credentials
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
const token = urlParams.get('token');

if (!roomId || !token) {
  alert("Missing room credentials. Redirecting to home page to create or join a room.");
  window.location.href = "/";
}

// Map Initialization
const map = L.map("map");
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

// Default fallback world view
map.setView([20, 0], 2);

// Participant State
let localDisplayName = "You";
let isSharing = false;
let watchId = null;
let userMarker = null;
let lastKnownLat = null;
let lastKnownLng = null;
let firstLocUpdate = true;

// Registry of remote markers: participantId -> Leaflet Marker
const remoteMarkers = new Map();

// Helper: format timestamp safely
function formatTime(ts) {
  if (!ts) return "Just now";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// XSS-Safe Popup DOM Element Builder
function createSafePopup(displayName, isSelf, updatedAt) {
  const container = document.createElement("div");
  container.className = "leaflet-safe-popup";

  const titleRow = document.createElement("div");
  titleRow.style.fontWeight = "700";
  titleRow.style.fontSize = "0.92rem";
  titleRow.style.color = isSelf ? "#059669" : "#1f2937";
  titleRow.style.marginBottom = "3px";
  // Safely assign user-controlled text via textContent
  titleRow.textContent = isSelf ? `📍 You (${displayName})` : `👤 ${displayName}`;
  container.appendChild(titleRow);

  const metaRow = document.createElement("div");
  metaRow.style.fontSize = "0.78rem";
  metaRow.style.color = "#6b7280";
  metaRow.style.display = "flex";
  metaRow.style.alignItems = "center";
  metaRow.style.gap = "5px";

  const dot = document.createElement("span");
  dot.style.display = "inline-block";
  dot.style.width = "6px";
  dot.style.height = "6px";
  dot.style.borderRadius = "50%";
  dot.style.backgroundColor = "#10b981";
  metaRow.appendChild(dot);

  const timeLabel = document.createElement("span");
  timeLabel.textContent = `Updated: ${formatTime(updatedAt)}`;
  metaRow.appendChild(timeLabel);

  container.appendChild(metaRow);
  return container;
}

// Update Active Sharer Count Badge
function updateSharerCount() {
  const count = remoteMarkers.size + (isSharing ? 1 : 0);
  if (sharerCountBadge) {
    sharerCountBadge.textContent = `👥 ${count} sharing`;
  }
}

// Error Banner Utilities
function showError(msg) {
  if (errorMessage && errorBanner) {
    errorMessage.textContent = msg;
    errorBanner.classList.remove("hidden");
  }
}

function dismissError() {
  if (errorBanner) {
    errorBanner.classList.add("hidden");
  }
}
window.dismissError = dismissError;

// Join Room Handshake
const rawName = prompt("Enter your display name for location sharing (max 30 chars):") || "Guest";

socket.emit("join-room", { roomId, token, name: rawName }, (response) => {
  if (response && response.success) {
    localDisplayName = response.displayName;
    if (roomBadge) {
      roomBadge.textContent = `Room #${roomId} (${localDisplayName})`;
      roomBadge.style.color = "#059669";
    }

    // Process initial snapshot if provided in callback
    if (Array.isArray(response.snapshot)) {
      populateInitialSnapshot(response.snapshot);
    }
  } else {
    const errorMsg = (response && response.error) ? response.error : "Failed to join room";
    if (roomBadge) {
      roomBadge.textContent = `Error: ${errorMsg}`;
      roomBadge.style.color = "#dc2626";
    }
    alert(`Access Denied: ${errorMsg}`);
    window.location.href = `/?roomId=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
  }
});

// Initial Snapshot Handler from Server Event
socket.on("location-snapshot", (snapshot) => {
  if (Array.isArray(snapshot)) {
    populateInitialSnapshot(snapshot);
  }
});

function populateInitialSnapshot(participants) {
  participants.forEach((p) => {
    if (!p || !p.id || p.id === socket.id) return;
    updateOrAddRemoteMarker(p.id, p.name, p.latitude, p.longitude, p.updatedAt);
  });
  updateSharerCount();
}

// Add or Move Remote Marker
function updateOrAddRemoteMarker(id, name, lat, lng, updatedAt) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return;

  if (remoteMarkers.has(id)) {
    const marker = remoteMarkers.get(id);
    marker.setLatLng([lat, lng]);
    marker.setPopupContent(createSafePopup(name, false, updatedAt));
  } else {
    const marker = L.marker([lat, lng]).addTo(map);
    marker.bindPopup(createSafePopup(name, false, updatedAt));
    remoteMarkers.set(id, marker);
  }
}

// Remove Remote Marker
function removeRemoteMarker(id) {
  if (remoteMarkers.has(id)) {
    const marker = remoteMarkers.get(id);
    map.removeLayer(marker);
    remoteMarkers.delete(id);
  }
}

// Remote Peer Location Update Event
socket.on("receive-location", (data) => {
  if (!data || !data.id || data.id === socket.id) return;
  updateOrAddRemoteMarker(data.id, data.name, data.latitude, data.longitude, data.updatedAt);
  updateSharerCount();
});

// Remote Peer Stopped Sharing Event
socket.on("location-stopped", (data) => {
  if (!data || !data.id) return;
  removeRemoteMarker(data.id);
  updateSharerCount();
});

// Remote Peer Disconnected Event
socket.on("user-disconnected", (id) => {
  removeRemoteMarker(id);
  updateSharerCount();
});

// Server Error Notice Event
socket.on("error-notice", (err) => {
  console.warn("Server notice:", err);
  if (err && err.message) {
    showError(err.message);
  }
});

// ---------- USER-CONTROLLED LOCATION LIFECYCLE ----------

// Start Location Sharing (Invoked explicitly on user click)
function startLocationSharing() {
  if (isSharing || watchId !== null) return;
  dismissError();

  if (!navigator.geolocation) {
    showError("Geolocation is not supported by your browser.");
    return;
  }

  // Ensure secure context (HTTPS or localhost)
  if (!window.isSecureContext && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
    showError("Live location requires a secure origin (HTTPS).");
    return;
  }

  // Register watchPosition ONLY after explicit user action
  watchId = navigator.geolocation.watchPosition(
    onLocationSuccess,
    onLocationError,
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 10000 }
  );

  isSharing = true;

  // Toggle UI controls
  if (startShareBtn) startShareBtn.classList.add("hidden");
  if (stopShareBtn) stopShareBtn.classList.remove("hidden");
  if (sharingIndicator) sharingIndicator.classList.remove("hidden");

  updateSharerCount();
}
window.startLocationSharing = startLocationSharing;

// Location Success Callback
let lastEmittedLat = null;
let lastEmittedLng = null;
let lastEmittedTime = 0;
const MIN_DISTANCE_DELTA = 0.00005; // ~5 meters
const MIN_TIME_INTERVAL_MS = 1500; // 1.5s throttling

function onLocationSuccess(position) {
  if (!isSharing) return;

  const { latitude, longitude } = position.coords;
  lastKnownLat = latitude;
  lastKnownLng = longitude;
  const now = Date.now();

  // Update own marker safely
  if (!userMarker) {
    userMarker = L.marker([latitude, longitude]).addTo(map);
    userMarker.bindPopup(createSafePopup(localDisplayName, true, now));
    userMarker.openPopup();
  } else {
    userMarker.setLatLng([latitude, longitude]);
    userMarker.setPopupContent(createSafePopup(localDisplayName, true, now));
  }

  if (firstLocUpdate) {
    map.setView([latitude, longitude], 15);
    firstLocUpdate = false;
  }

  // Check throttling thresholds before emitting
  const distDelta = lastEmittedLat !== null
    ? Math.abs(latitude - lastEmittedLat) + Math.abs(longitude - lastEmittedLng)
    : Infinity;

  if (distDelta >= MIN_DISTANCE_DELTA || (now - lastEmittedTime) >= MIN_TIME_INTERVAL_MS) {
    lastEmittedLat = latitude;
    lastEmittedLng = longitude;
    lastEmittedTime = now;

    socket.emit("send-location", { latitude, longitude });
  }
}

// Location Error Callback
function onLocationError(error) {
  let message = "Unable to retrieve location.";

  switch (error.code) {
    case error.PERMISSION_DENIED:
      message = "Location access was denied. Please allow location permissions in your browser settings to share your live location.";
      break;
    case error.POSITION_UNAVAILABLE:
      message = "Location information is unavailable. Please verify that device GPS or network location is enabled.";
      break;
    case error.TIMEOUT:
      message = "Location request timed out. Retrying GPS acquisition...";
      break;
    default:
      message = error.message || "An unknown geolocation error occurred.";
      break;
  }

  showError(message);

  // If permission denied or unavailable, halt sharing state
  if (error.code === error.PERMISSION_DENIED || error.code === error.POSITION_UNAVAILABLE) {
    stopLocationSharing(true);
  }
}

// Stop Location Sharing (Invoked explicitly on user click)
function stopLocationSharing(notifyServer = true) {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  isSharing = false;

  // Remove local marker
  if (userMarker) {
    map.removeLayer(userMarker);
    userMarker = null;
  }

  // Reset throttling state
  lastEmittedLat = null;
  lastEmittedLng = null;

  // Toggle UI controls
  if (startShareBtn) startShareBtn.classList.remove("hidden");
  if (stopShareBtn) stopShareBtn.classList.add("hidden");
  if (sharingIndicator) sharingIndicator.classList.add("hidden");

  updateSharerCount();

  // Notify server to remove active location from room state
  if (notifyServer && socket.connected) {
    socket.emit("stop-location");
  }
}
window.stopLocationSharing = stopLocationSharing;

// Recenter Map Control
function recenterMap() {
  if (lastKnownLat !== null && lastKnownLng !== null) {
    map.setView([lastKnownLat, lastKnownLng], 16);
  } else if (remoteMarkers.size > 0) {
    const allMarkers = Array.from(remoteMarkers.values());
    const group = new L.featureGroup(allMarkers);
    map.fitBounds(group.getBounds().pad(0.15));
  } else {
    showError("No active locations to center on. Click 'Share my location' to start.");
  }
}
window.recenterMap = recenterMap;

// Clean up watches and timers on page exit
window.addEventListener("beforeunload", () => {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if (isSharing && socket.connected) {
    socket.emit("stop-location");
  }
});
