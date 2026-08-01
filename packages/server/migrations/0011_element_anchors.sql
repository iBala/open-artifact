ALTER TABLE `comment_threads` ADD `anchor_element_id` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `anchor_element_path` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `anchor_element_tag` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `anchor_element_text` text;--> statement-breakpoint
ALTER TABLE `comment_threads` ADD `anchor_drifted` integer DEFAULT 0 NOT NULL;