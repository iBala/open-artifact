CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_connections_user_idx` ON `mcp_connections` (`user_id`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `kind` text DEFAULT 'cli' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `connection_id` text REFERENCES mcp_connections(id);--> statement-breakpoint
ALTER TABLE `artifacts` ADD `connection_id` text REFERENCES mcp_connections(id);