CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`client_name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`resource` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_codes_code_hash_unique` ON `oauth_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `oauth_codes_connection_idx` ON `oauth_codes` (`connection_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`connection_id` text NOT NULL,
	`client_id` text NOT NULL,
	`resource` text,
	`created_at` text NOT NULL,
	`used_at` text,
	`revoked_at` text,
	FOREIGN KEY (`connection_id`) REFERENCES `mcp_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_tokens_token_hash_unique` ON `oauth_refresh_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_tokens_connection_idx` ON `oauth_refresh_tokens` (`connection_id`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `resource` text;