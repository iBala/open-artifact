CREATE TABLE `artifact_stars` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_stars_user_artifact_idx` ON `artifact_stars` (`user_id`,`artifact_id`);--> statement-breakpoint
CREATE INDEX `artifact_stars_user_idx` ON `artifact_stars` (`user_id`);