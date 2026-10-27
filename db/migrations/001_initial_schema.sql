-- Migration 001: Initial Schema for OnMyWay (OMW) Persistent Groups & Auth
PRAGMA foreign_keys = ON;

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Active user sessions (stores SHA-256 hash of token, httpOnly cookie)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Persistent Groups
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_retention_days INTEGER DEFAULT 30,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Group Memberships and Roles
CREATE TABLE IF NOT EXISTS group_members (
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner', 'member')),
  joined_at INTEGER NOT NULL,
  last_read_message_id TEXT,
  PRIMARY KEY (group_id, user_id)
);

-- Group Invitation Links (time-boxed & max uses)
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  max_uses INTEGER, -- NULL means unlimited
  uses INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Group Chat Messages
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  reply_to_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- Passwordless Magic Link Auth Tokens (single use, 15 min expiry)
CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Indices for rapid lookups and constraints
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_group ON invites(group_id);
CREATE INDEX IF NOT EXISTS idx_invites_hash ON invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_messages_group_time ON messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash);
