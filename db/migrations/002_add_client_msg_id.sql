-- Migration 002: Add client_msg_id to messages for idempotence and offline outbox
ALTER TABLE messages ADD COLUMN client_msg_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_group_client_msg ON messages(group_id, client_msg_id) WHERE client_msg_id IS NOT NULL;
