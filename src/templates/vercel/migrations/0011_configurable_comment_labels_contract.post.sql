LOCK TABLE comment_messages IN SHARE ROW EXCLUSIVE MODE;

SELECT singleton FROM comment_label_registry_state WHERE singleton = true FOR UPDATE;

UPDATE comment_messages SET kind = NULL WHERE kind IS DISTINCT FROM 'resolution';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM comment_messages message
    LEFT JOIN comment_labels label ON label.key = message.kind
    WHERE message.kind IS NOT NULL AND label.key IS NULL
  ) THEN
    RAISE EXCEPTION 'non-null comment kind has no comment label';
  END IF;
END
$$;

ALTER TABLE comment_messages
  ADD CONSTRAINT comment_messages_kind_comment_labels_fk
  FOREIGN KEY (kind) REFERENCES comment_labels(key)
  ON UPDATE RESTRICT ON DELETE RESTRICT
  DEFERRABLE INITIALLY IMMEDIATE NOT VALID;

ALTER TABLE comment_messages VALIDATE CONSTRAINT comment_messages_kind_comment_labels_fk;

UPDATE comment_label_registry_state
SET contract_ready = true, revision = revision + 1
WHERE singleton = true AND contract_ready = false;
