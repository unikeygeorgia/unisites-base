-- unisites-base 0.9: a project's files (unisites-base/storage, /storage/v1). The bytes are in R2 under
-- "<bucket>/<name>"; each file is a row here, so the project's access rules (access.json's
-- "storage_objects") say who may read, add, change and remove it, as Supabase's storage policies did.
-- folder1..3 are the path's first folders (storage.foldername(name)[1..3]), for the rules to name.
create table "storage_objects" (
  "id" text not null primary key,
  "bucket_id" text not null,
  "name" text not null,
  "owner" text,
  "folder1" text,
  "folder2" text,
  "folder3" text,
  "size" integer,
  "mime_type" text,
  "cache_control" text,
  "created_at" text not null,
  "updated_at" text not null,
  unique ("bucket_id", "name")
);
create index "storage_objects_folders" on "storage_objects" ("bucket_id", "folder1", "folder2");
