-- Artifacts get an owner.
--
-- Hand-written, because SQLite will not do what Drizzle generated here. Two
-- limits of ALTER TABLE ADD COLUMN are in the way: a NOT NULL column must have a
-- non-null default, and a column carrying a REFERENCES clause must default to
-- NULL. Both cannot hold at once. Rebuilding the table is not an option either,
-- because artifact_versions has a foreign key pointing at it.
--
-- So the column is added with a default and no REFERENCES clause, and the
-- cascade it would have given us is restored by the trigger at the bottom.
-- Deleting a person still takes their artifacts, and their versions with them.

-- Artifacts published before this point were created with a shared development
-- token and belong to nobody. Rather than delete someone's data during an
-- upgrade, they are parked on one placeholder account that cannot be signed in
-- to: unverified, on a domain that can never receive mail.
INSERT INTO users (id, email, display_name, email_verified, created_at, updated_at)
SELECT
  'usr_unclaimed',
  'unclaimed@invalid',
  'Unclaimed artifacts',
  0,
  '1970-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z'
WHERE EXISTS (SELECT 1 FROM artifacts);
--> statement-breakpoint
ALTER TABLE `artifacts` ADD `owner_id` text NOT NULL DEFAULT 'usr_unclaimed';
--> statement-breakpoint
CREATE INDEX `artifacts_owner_idx` ON `artifacts` (`owner_id`);
--> statement-breakpoint
CREATE TRIGGER `artifacts_follow_owner_deletion`
AFTER DELETE ON `users`
FOR EACH ROW
BEGIN
  DELETE FROM `artifacts` WHERE `owner_id` = OLD.`id`;
END;
