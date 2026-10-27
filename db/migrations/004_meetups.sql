-- Migration 004: Meetups, RSVPs, and Arrival Tracking

CREATE TABLE IF NOT EXISTS meetups (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  destination_lat REAL NOT NULL,
  destination_lng REAL NOT NULL,
  destination_label TEXT NOT NULL,
  start_time INTEGER NOT NULL, -- Unix timestamp in milliseconds
  status TEXT NOT NULL DEFAULT 'planned', -- 'planned', 'active', 'ended'
  stop_on_arrival INTEGER NOT NULL DEFAULT 0, -- 1 = auto-stop location sharing upon arrival
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_meetups_group_status ON meetups(group_id, status);
CREATE INDEX IF NOT EXISTS idx_meetups_start_time ON meetups(start_time, status);

CREATE TABLE IF NOT EXISTS meetup_rsvps (
  id TEXT PRIMARY KEY,
  meetup_id TEXT NOT NULL REFERENCES meetups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rsvp TEXT NOT NULL DEFAULT 'going', -- 'going', 'maybe', 'no'
  lateness_minutes INTEGER NOT NULL DEFAULT 0,
  arrived_at INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE(meetup_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meetup_rsvps_meetup ON meetup_rsvps(meetup_id);
CREATE INDEX IF NOT EXISTS idx_meetup_rsvps_user ON meetup_rsvps(user_id);
