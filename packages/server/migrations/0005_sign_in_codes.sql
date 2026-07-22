-- Sign-in links become sign-in codes.
--
-- The product no longer emails a link to click. It emails six digits, which the
-- person types back into the tab they were already in. Mail clients open links in
-- their own in-app browser, where there is no session and no way to get back, so
-- a link was landing people somewhere they did not ask to be.
--
-- Hand-written, because what drizzle-kit generates for this is a question it
-- cannot answer on its own: it sees a table disappear and another appear, and asks
-- whether that is a rename. Answering "rename" would keep rows whose code_hash is
-- the hash of a long link token, which no six digits can ever match. They would
-- sit there forever, unusable and confusing. So the old table goes.
--
-- The cost of dropping it: anybody holding an unopened sign-in email at the moment
-- an instance upgrades has to ask for a new code. These live fifteen minutes at
-- most, so the window is small and the recovery is one button.
DROP TABLE `magic_links`;
--> statement-breakpoint
CREATE TABLE `sign_in_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`redirect_to` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text
);
--> statement-breakpoint
-- Deliberately not unique, unlike the token hash it replaces. Six digits is a
-- small space: two people can hold the same code at the same time, and a unique
-- index would turn that coincidence into a failed sign-in request. Every lookup
-- is by email address anyway.
CREATE INDEX `sign_in_codes_email_idx` ON `sign_in_codes` (`email`);
