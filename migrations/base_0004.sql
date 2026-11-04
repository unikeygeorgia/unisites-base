-- unisites-base 0.9: what a person keeps about themself (Supabase's user_metadata), for /auth/v1.
-- One JSON object a person; full_name and avatar_url are kept as _base_user's name and image.
create table "_base_user_metadata" (
  "userId" text not null primary key references "_base_user" ("id") on delete cascade,
  "data" text not null default '{}',
  "updatedAt" date not null
);
