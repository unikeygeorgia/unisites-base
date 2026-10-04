-- unisites-base 0.4: every SMS and letter base sent, or tried to: when, to whom, which
-- template, and whether it went out (the error if not). Never the code or the text.
-- Kept 90 days. Unisites' "Mail" page shows it.
create table "_base_message_log" ("id" integer primary key autoincrement, "at" text not null, "channel" text not null, "kind" text not null, "purpose" text, "to" text not null, "status" text not null, "error" text);
create index "_base_message_log_at_idx" on "_base_message_log" ("at");
