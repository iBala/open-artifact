CREATE TABLE `artifact_domain_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifact_domain_shares_artifact_idx` ON `artifact_domain_shares` (`artifact_id`);--> statement-breakpoint
CREATE TABLE `artifact_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	`notified_at` text,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `artifact_shares_artifact_idx` ON `artifact_shares` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `artifact_shares_email_idx` ON `artifact_shares` (`email`);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `is_public` integer DEFAULT 0 NOT NULL;