-- unisites-base 0.2: the admin's switches for the ways in, and what the
-- project's code can do, set and read from Unisites' "Sign-in methods" page.
-- Keys: switch.signUp, switch.phone, switch.passwords, switch.emailCode,
-- switch.google, switch.facebook ("true"/"false"); capabilities (JSON).
create table "_base_settings" ("key" text not null primary key, "value" text not null, "updatedAt" text not null);
