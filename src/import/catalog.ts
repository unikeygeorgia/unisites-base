/**
 * What `import-supabase --report` reads from a Supabase project (unisites ADR 0030, step 4): one
 * SELECT, of Postgres' own catalog only, that answers with one JSON document. It reads no row of
 * the project's data, only counts and sizes, and it changes nothing. It can be run in Supabase's
 * SQL editor too (`npx unisites-base import-supabase --sql` prints it), and its answer saved as
 * catalog.json for `--catalog`.
 */
export const CATALOG_SQL = `
with
roles as (select array_agg(rolname) as names from pg_roles where rolname in ('anon', 'authenticated')),
tbl as (
  select c.oid, c.relname, c.relrowsecurity, c.reltuples, c.relreplident
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
)
select json_build_object(
  'version', current_setting('server_version'),
  'roles', (select names from roles),
  'tables', coalesce((select json_agg(json_build_object(
    'name', t.relname,
    'rls', t.relrowsecurity,
    'rows', greatest(t.reltuples, 0)::bigint,
    'bytes', pg_total_relation_size(t.oid),
    'replica', t.relreplident,
    'privileges', json_build_object(
      'anon', case when exists (select 1 from pg_roles where rolname = 'anon') then json_build_object(
        'select', has_table_privilege('anon', t.oid, 'SELECT'), 'insert', has_table_privilege('anon', t.oid, 'INSERT'),
        'update', has_table_privilege('anon', t.oid, 'UPDATE'), 'delete', has_table_privilege('anon', t.oid, 'DELETE')) end,
      'authenticated', case when exists (select 1 from pg_roles where rolname = 'authenticated') then json_build_object(
        'select', has_table_privilege('authenticated', t.oid, 'SELECT'), 'insert', has_table_privilege('authenticated', t.oid, 'INSERT'),
        'update', has_table_privilege('authenticated', t.oid, 'UPDATE'), 'delete', has_table_privilege('authenticated', t.oid, 'DELETE')) end),
    'columns', (
      select json_agg(json_build_object(
        'name', a.attname,
        'type', format_type(a.atttypid, a.atttypmod),
        'udt', ty.typname,
        'category', ty.typcategory,
        'notnull', a.attnotnull,
        'default', pg_get_expr(d.adbin, d.adrelid),
        'identity', nullif(a.attidentity, ''),
        'generated', nullif(a.attgenerated, ''),
        'enum', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = coalesce(nullif(ty.typelem, 0), ty.oid)),
        'grants', json_build_object(
          'anon', case when exists (select 1 from pg_roles where rolname = 'anon') then json_build_object(
            'select', has_column_privilege('anon', t.oid, a.attnum, 'SELECT'),
            'insert', has_column_privilege('anon', t.oid, a.attnum, 'INSERT'),
            'update', has_column_privilege('anon', t.oid, a.attnum, 'UPDATE')) end,
          'authenticated', case when exists (select 1 from pg_roles where rolname = 'authenticated') then json_build_object(
            'select', has_column_privilege('authenticated', t.oid, a.attnum, 'SELECT'),
            'insert', has_column_privilege('authenticated', t.oid, a.attnum, 'INSERT'),
            'update', has_column_privilege('authenticated', t.oid, a.attnum, 'UPDATE')) end)
      ) order by a.attnum)
      from pg_attribute a
      join pg_type ty on ty.oid = a.atttypid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
    ),
    'constraints', (
      select json_agg(json_build_object(
        'name', k.conname,
        'type', k.contype,
        'columns', (select json_agg(a.attname order by x.i) from unnest(k.conkey) with ordinality x(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n),
        'references', case when k.contype = 'f' then json_build_object(
          'schema', fn.nspname,
          'table', fc.relname,
          'columns', (select json_agg(a.attname order by x.i) from unnest(k.confkey) with ordinality x(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n),
          'delete', k.confdeltype,
          'update', k.confupdtype) end,
        'definition', pg_get_constraintdef(k.oid)
      ) order by k.contype, k.conname)
      from pg_constraint k
      left join pg_class fc on fc.oid = k.confrelid
      left join pg_namespace fn on fn.oid = fc.relnamespace
      where k.conrelid = t.oid and k.contype in ('p', 'u', 'f', 'c')
    ),
    'indexes', (
      select json_agg(json_build_object('name', ic.relname, 'unique', i.indisunique, 'definition', pg_get_indexdef(i.indexrelid)) order by ic.relname)
      from pg_index i join pg_class ic on ic.oid = i.indexrelid
      where i.indrelid = t.oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)
    ),
    'triggers', (
      select json_agg(json_build_object('name', g.tgname, 'definition', pg_get_triggerdef(g.oid), 'function', p.proname, 'source', p.prosrc) order by g.tgname)
      from pg_trigger g join pg_proc p on p.oid = g.tgfoid
      where g.tgrelid = t.oid and not g.tgisinternal
    )
  ) order by t.relname) from tbl t), '[]'::json),
  'views', coalesce((select json_agg(json_build_object('name', viewname, 'definition', definition) order by viewname) from pg_views where schemaname = 'public'), '[]'::json),
  'policies', coalesce((select json_agg(json_build_object(
    'schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive,
    'roles', roles, 'command', cmd, 'using', qual, 'check', with_check
  ) order by schemaname, tablename, policyname) from pg_policies where schemaname in ('public', 'storage')), '[]'::json),
  'functions', coalesce((select json_agg(json_build_object(
    'name', p.proname,
    'arguments', pg_get_function_arguments(p.oid),
    'argnames', p.proargnames,
    'result', pg_get_function_result(p.oid),
    'set', p.proretset,
    'language', l.lanname,
    'definer', p.prosecdef,
    'volatility', p.provolatile,
    'source', p.prosrc
  ) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.prokind = 'f'
      and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e')), '[]'::json),
  'realtime', coalesce((select json_agg(tablename order by tablename) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'), '[]'::json),
  'extensions', coalesce((select json_agg(extname order by extname) from pg_extension), '[]'::json),
  'buckets', coalesce((select json_agg(json_build_object(
    'id', b.id, 'public', b.public, 'size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types,
    'objects', (select count(*) from storage.objects o where o.bucket_id = b.id),
    'bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = b.id)
  ) order by b.id) from storage.buckets b), '[]'::json),
  'auth', json_build_object(
    'users', (select count(*) from auth.users),
    'passwords', (select count(*) from auth.users where coalesce(encrypted_password, '') <> ''),
    'bcrypt', (select count(*) from auth.users where encrypted_password like '$2%'),
    'confirmed', (select count(*) from auth.users where email_confirmed_at is not null or phone_confirmed_at is not null),
    'phones', (select count(*) from auth.users where coalesce(phone, '') <> ''),
    'banned', (select count(*) from auth.users where banned_until > now()),
    'providers', (select json_object_agg(provider, n) from (select provider, count(*) as n from auth.identities group by provider) x),
    'factors', (select json_object_agg(factor_type, n) from (select factor_type::text, count(*) as n from auth.mfa_factors group by factor_type) x)
  )
) as catalog
`;

export type Grants = { select: boolean; insert: boolean; update: boolean } | null;

export type Column = {
  name: string;
  type: string;
  udt: string;
  category: string;
  notnull: boolean;
  default: string | null;
  identity: string | null;
  generated: string | null;
  enum: string[] | null;
  grants: { anon: Grants; authenticated: Grants };
};

export type Constraint = {
  name: string;
  type: "p" | "u" | "f" | "c";
  columns: string[] | null;
  references: { schema: string; table: string; columns: string[]; delete: string; update: string } | null;
  definition: string;
};

export type Privileges = { select: boolean; insert: boolean; update: boolean; delete: boolean } | null;

export type Table = {
  name: string;
  rls: boolean;
  /** The table's own grants to the browser's roles (a column grant may add to them). */
  privileges: { anon: Privileges; authenticated: Privileges };
  rows: number;
  bytes: number;
  replica: string;
  columns: Column[];
  constraints: Constraint[] | null;
  indexes: { name: string; unique: boolean; definition: string }[] | null;
  triggers: { name: string; definition: string; function: string; source: string }[] | null;
};

export type Policy = {
  schema: string;
  table: string;
  name: string;
  permissive: "PERMISSIVE" | "RESTRICTIVE";
  roles: string[];
  command: "SELECT" | "INSERT" | "UPDATE" | "DELETE" | "ALL";
  using: string | null;
  check: string | null;
};

export type PgFunction = {
  name: string;
  arguments: string;
  argnames: string[] | null;
  result: string;
  set: boolean;
  language: string;
  definer: boolean;
  volatility: string;
  source: string;
};

export type Catalog = {
  version: string;
  roles: string[] | null;
  tables: Table[];
  views: { name: string; definition: string }[];
  policies: Policy[];
  functions: PgFunction[];
  realtime: string[];
  extensions: string[];
  buckets: { id: string; public: boolean; size_limit: number | null; mime_types: string[] | null; objects: number; bytes: number }[];
  auth: {
    users: number;
    passwords: number;
    bcrypt: number;
    confirmed: number;
    phones: number;
    banned: number;
    providers: Record<string, number> | null;
    factors: Record<string, number> | null;
  };
  /** Edge Functions, when read through the Management API. */
  edgeFunctions?: { slug: string; name: string }[];
};
