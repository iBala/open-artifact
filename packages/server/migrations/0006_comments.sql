CREATE TABLE `comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`artifact_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`anchor_kind` text DEFAULT 'document' NOT NULL,
	`anchor_heading_id` text,
	`anchor_snippet` text,
	`anchor_occurrence` integer,
	`anchor_lost` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`created_by_user_id` text,
	`resolved_at` text,
	`resolved_by_user_id` text,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`resolved_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comment_threads_artifact_idx` ON `comment_threads` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `comment_threads_status_idx` ON `comment_threads` (`artifact_id`,`status`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	`edited_at` text,
	`deleted_at` text,
	FOREIGN KEY (`thread_id`) REFERENCES `comment_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `comments_thread_idx` ON `comments` (`thread_id`,`created_at`);