-- unisites-base: the project's sign-in tables (unisites ADR 0021, 0022), as better-auth
-- makes them for SQLite. Written by `npm run migrations`; do not edit by hand.
create table "_base_user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "role" text, "banned" integer, "banReason" text, "banExpires" date, "twoFactorEnabled" integer, "phoneNumber" text unique, "phoneNumberVerified" integer);
create table "_base_session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "_base_user" ("id") on delete cascade, "impersonatedBy" text);
create table "_base_account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "_base_user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);
create table "_base_verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);
create table "_base_sign_in" ("id" text not null primary key, "at" date not null, "ip" text, "method" text, "userAgent" text, "userId" text not null references "_base_user" ("id") on delete cascade);
create table "_base_two_factor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "_base_user" ("id") on delete cascade, "verified" integer, "failedVerificationCount" integer, "lockedUntil" date);
create table "_base_rate_limit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
create index "_base_session_userId_idx" on "_base_session" ("userId");
create index "_base_account_userId_idx" on "_base_account" ("userId");
create index "_base_verification_identifier_idx" on "_base_verification" ("identifier");
create index "_base_sign_in_userId_idx" on "_base_sign_in" ("userId");
create index "_base_two_factor_secret_idx" on "_base_two_factor" ("secret");
create index "_base_two_factor_userId_idx" on "_base_two_factor" ("userId");
