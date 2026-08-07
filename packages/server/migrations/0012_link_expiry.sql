-- Link expiry. Null means the link never expires.
--
-- Every artifact that already exists gets null, which grandfathers every link
-- already in circulation as permanent. Backfilling the new defaults here would
-- have been more consistent and would also have taken every public link on the
-- instance dark a week after this deploy, without warning anybody. The defaults
-- apply to sharing done from here on.
ALTER TABLE `artifacts` ADD `expires_at` text;