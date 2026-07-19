CREATE TABLE comment_label_registry_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton = true),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  contract_ready BOOLEAN NOT NULL DEFAULT false
);

INSERT INTO comment_label_registry_state (singleton) VALUES (true);

CREATE TABLE comment_labels (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  label TEXT NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)),
  description TEXT NOT NULL CHECK (length(description) <= 240 AND description = btrim(description)),
  color TEXT NOT NULL CHECK (color ~ '^#[0-9A-F]{6}$'),
  enabled BOOLEAN NOT NULL,
  position INTEGER NOT NULL,
  CONSTRAINT comment_labels_resolution_shape CHECK (
    (key = 'resolution' AND label = 'Resolution' AND description = 'System-generated resolution note' AND color = '#667085' AND enabled = false AND position = 0)
    OR (key <> 'resolution' AND position > 0)
  ),
  CONSTRAINT comment_labels_position_unique UNIQUE (position) DEFERRABLE INITIALLY DEFERRED
);

INSERT INTO comment_labels (key, label, description, color, enabled, position)
VALUES ('resolution', 'Resolution', 'System-generated resolution note', '#667085', false, 0);

ALTER TABLE comment_messages DROP CONSTRAINT IF EXISTS comment_messages_kind_check;
ALTER TABLE comment_messages ALTER COLUMN kind DROP DEFAULT;
ALTER TABLE comment_messages ALTER COLUMN kind DROP NOT NULL;
