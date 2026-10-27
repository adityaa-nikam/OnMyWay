const socket = io("/chat");

const form = document.getElementById("send-container");
const messageInput = document.getElementById("messageInp");
const messageContainer = document.querySelector(".container");
const roomBadge = document.getElementById("room-header-badge");

// Audio alert
const audio = new Audio("/ting.mp3");

// Helper: format timestamp as HH:MM
function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date();
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Append a structured message to chat container
function appendMessage(opts) {
  const { name, message, position = 'left', system = false, error = false, timestamp } = opts || {};
  const messageElement = document.createElement('div');
  messageElement.classList.add('message', position);

  if (system) {
    messageElement.classList.add('system');
    if (error) {
      messageElement.style.background = '#fee2e2';
      messageElement.style.color = '#991b1b';
      messageElement.style.border = '1px solid #f87171';
    }
    messageElement.textContent = message;
  } else {
    // Name element (sanitized via textContent)
    if (name) {
      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = name;
      messageElement.appendChild(nameEl);
    }

    // Message text element (sanitized via textContent)
    const textEl = document.createElement('div');
    textEl.className = 'text';
    textEl.textContent = message;
    messageElement.appendChild(textEl);

    // Timestamp
    const timeEl = document.createElement('span');
    timeEl.className = 'time';
    timeEl.textContent = formatTime(timestamp);
    messageElement.appendChild(timeEl);
  }

  messageContainer.appendChild(messageElement);

  // Play sound for incoming chat messages
  if (position === 'left' && !system) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }

  // Auto scroll
  messageContainer.scrollTop = messageContainer.scrollHeight;
}

// Parse room credentials from URL
const urlParams = new URLSearchParams(window.location.search);
const roomId = urlParams.get('roomId');
const token = urlParams.get('token');

if (!roomId || !token) {
  appendMessage({
    message: "❌ Missing room credentials. Please create or join a room from the home page.",
    position: 'left',
    system: true,
    error: true
  });
  if (roomBadge) {
    roomBadge.textContent = "No Room Selected";
    roomBadge.style.color = "#ef4444";
  }
} else {
  if (roomBadge) {
    roomBadge.textContent = `Room #${roomId}`;
  }

  // Prompt user for nickname
  let enteredName = prompt("Enter your display name (max 30 chars):") || "Guest";

  // Request room membership from server
  socket.emit("join-room", { roomId, token, name: enteredName }, (response) => {
    if (response && response.success) {
      if (roomBadge) {
        roomBadge.textContent = `Room #${roomId} (${response.displayName})`;
        roomBadge.style.color = "#059669";
      }
      appendMessage({
        message: `Connected to private room as "${response.displayName}"`,
        position: 'left',
        system: true
      });
    } else {
      const errMsg = (response && response.error) ? response.error : 'Unauthorized access';
      if (roomBadge) {
        roomBadge.textContent = `Error: ${errMsg}`;
        roomBadge.style.color = "#dc2626";
      }
      appendMessage({
        message: `❌ Access Denied: ${errMsg}`,
        position: 'left',
        system: true,
        error: true
      });
      alert(`Access Denied: ${errMsg}`);
      window.location.href = `/?roomId=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
    }
  });
}

// User joins notification from server
socket.on('user-joined', (name) => {
  appendMessage({ message: `${name} joined the room`, position: 'left', system: true });
});

// Incoming message from authorized peer
socket.on('receive', (data) => {
  if (data && typeof data === 'object') {
    appendMessage({
      name: data.name,
      message: data.message,
      timestamp: data.timestamp,
      position: 'left'
    });
  }
});

// User left notification
socket.on('left', (name) => {
  appendMessage({ message: `${name} left the room`, position: 'left', system: true });
});

// Server-side error notice (rate limiting, validation failure)
socket.on('error-notice', (err) => {
  appendMessage({
    message: `⚠️ ${err.message || 'Action rejected by server'}`,
    position: 'left',
    system: true,
    error: true
  });
});

// Send message handler
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const message = messageInput.value.trim();

  if (!message) return;

  // Optimistically display own message
  appendMessage({ name: 'You', message, position: 'right' });
  messageInput.value = "";

  // SENDER IDENTITY IS ENFORCED BY SERVER - only message payload is sent
  socket.emit('send', { message }, (ack) => {
    if (ack && !ack.success) {
      appendMessage({
        message: `Failed to deliver: ${ack.error || 'Server rejected message'}`,
        position: 'left',
        system: true,
        error: true
      });
    }
  });
});
