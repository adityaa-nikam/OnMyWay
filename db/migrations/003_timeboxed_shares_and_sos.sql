-- Migration 003: Time-boxed location sharing sessions, share logs, SOS events, and status pins

CREATE TABLE IF NOT EXISTS location_shares (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  duration_type TEXT NOT NULL, -- '15m', '1h', '8h', 'until_arrive', 'until_stop'
  expires_at INTEGER, -- Timestamp ms (or NULL / 24h max for until_stop)
  destination_lat REAL,
  destination_lng REAL,
  destination_name TEXT,
  target_group_ids TEXT NOT NULL, -- JSON array of group IDs: '["g_123"]'
  is_active INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_location_shares_user_active ON location_shares(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_location_shares_expires ON location_shares(is_active, expires_at);

CREATE TABLE IF NOT EXISTS location_share_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL, -- 'started', 'stopped', 'extended', 'expired'
  target_groups TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_location_share_logs_user ON location_share_logs(user_id, timestamp);

CREATE TABLE IF NOT EXISTS sos_events (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- 'active', 'resolved', 'cancelled'
  lat REAL,
  lng REAL,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  responders TEXT DEFAULT '[]' -- JSON array of { userId, name, timestamp }
);

CREATE INDEX IF NOT EXISTS idx_sos_events_group ON sos_events(group_id, status);

CREATE TABLE IF NOT EXISTS status_pins (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  chip_type TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_status_pins_created ON status_pins(created_at);
