CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`exchange` text NOT NULL,
	`data` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
