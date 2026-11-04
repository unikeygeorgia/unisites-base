/**
 * What `import-supabase --report` reads from a Supabase project (unisites ADR 0030, step 4): one
 * SELECT, of Postgres' own catalog only, that answers with one JSON document. It reads no row of
 * the project's data, only counts and sizes, and it changes nothing. It can be run in Supabase's
 * SQL editor too (`npx unisites-base import-supabase --sql` prints it), and its answer saved as
 * catalog.json for `--catalog`.
 */
export declare const CATALOG_SQL = "\nwith\nroles as (select array_agg(rolname) as names from pg_roles where rolname in ('anon', 'authenticated')),\ntbl as (\n  select c.oid, c.relname, c.relrowsecurity, c.reltuples, c.relreplident\n  from pg_class c join pg_namespace n on n.oid = c.relnamespace\n  where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition\n)\nselect json_build_object(\n  'version', current_setting('server_version'),\n  'roles', (select names from roles),\n  'tables', coalesce((select json_agg(json_build_object(\n    'name', t.relname,\n    'rls', t.relrowsecurity,\n    'rows', greatest(t.reltuples, 0)::bigint,\n    'bytes', pg_total_relation_size(t.oid),\n    'replica', t.relreplident,\n    'privileges', json_build_object(\n      'anon', case when exists (select 1 from pg_roles where rolname = 'anon') then json_build_object(\n        'select', has_table_privilege('anon', t.oid, 'SELECT'), 'insert', has_table_privilege('anon', t.oid, 'INSERT'),\n        'update', has_table_privilege('anon', t.oid, 'UPDATE'), 'delete', has_table_privilege('anon', t.oid, 'DELETE')) end,\n      'authenticated', case when exists (select 1 from pg_roles where rolname = 'authenticated') then json_build_object(\n        'select', has_table_privilege('authenticated', t.oid, 'SELECT'), 'insert', has_table_privilege('authenticated', t.oid, 'INSERT'),\n        'update', has_table_privilege('authenticated', t.oid, 'UPDATE'), 'delete', has_table_privilege('authenticated', t.oid, 'DELETE')) end),\n    'columns', (\n      select json_agg(json_build_object(\n        'name', a.attname,\n        'type', format_type(a.atttypid, a.atttypmod),\n        'udt', ty.typname,\n        'category', ty.typcategory,\n        'notnull', a.attnotnull,\n        'default', pg_get_expr(d.adbin, d.adrelid),\n        'identity', nullif(a.attidentity, ''),\n        'generated', nullif(a.attgenerated, ''),\n        'enum', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = coalesce(nullif(ty.typelem, 0), ty.oid)),\n        'grants', json_build_object(\n          'anon', case when exists (select 1 from pg_roles where rolname = 'anon') then json_build_object(\n            'select', has_column_privilege('anon', t.oid, a.attnum, 'SELECT'),\n            'insert', has_column_privilege('anon', t.oid, a.attnum, 'INSERT'),\n            'update', has_column_privilege('anon', t.oid, a.attnum, 'UPDATE')) end,\n          'authenticated', case when exists (select 1 from pg_roles where rolname = 'authenticated') then json_build_object(\n            'select', has_column_privilege('authenticated', t.oid, a.attnum, 'SELECT'),\n            'insert', has_column_privilege('authenticated', t.oid, a.attnum, 'INSERT'),\n            'update', has_column_privilege('authenticated', t.oid, a.attnum, 'UPDATE')) end)\n      ) order by a.attnum)\n      from pg_attribute a\n      join pg_type ty on ty.oid = a.atttypid\n      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum\n      where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped\n    ),\n    'constraints', (\n      select json_agg(json_build_object(\n        'name', k.conname,\n        'type', k.contype,\n        'columns', (select json_agg(a.attname order by x.i) from unnest(k.conkey) with ordinality x(n, i) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n),\n        'references', case when k.contype = 'f' then json_build_object(\n          'schema', fn.nspname,\n          'table', fc.relname,\n          'columns', (select json_agg(a.attname order by x.i) from unnest(k.confkey) with ordinality x(n, i) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n),\n          'delete', k.confdeltype,\n          'update', k.confupdtype) end,\n        'definition', pg_get_constraintdef(k.oid)\n      ) order by k.contype, k.conname)\n      from pg_constraint k\n      left join pg_class fc on fc.oid = k.confrelid\n      left join pg_namespace fn on fn.oid = fc.relnamespace\n      where k.conrelid = t.oid and k.contype in ('p', 'u', 'f', 'c')\n    ),\n    'indexes', (\n      select json_agg(json_build_object('name', ic.relname, 'unique', i.indisunique, 'definition', pg_get_indexdef(i.indexrelid)) order by ic.relname)\n      from pg_index i join pg_class ic on ic.oid = i.indexrelid\n      where i.indrelid = t.oid and not exists (select 1 from pg_constraint k where k.conindid = i.indexrelid)\n    ),\n    'triggers', (\n      select json_agg(json_build_object('name', g.tgname, 'definition', pg_get_triggerdef(g.oid), 'function', p.proname, 'source', p.prosrc) order by g.tgname)\n      from pg_trigger g join pg_proc p on p.oid = g.tgfoid\n      where g.tgrelid = t.oid and not g.tgisinternal\n    )\n  ) order by t.relname) from tbl t), '[]'::json),\n  'views', coalesce((select json_agg(json_build_object('name', viewname, 'definition', definition) order by viewname) from pg_views where schemaname = 'public'), '[]'::json),\n  'policies', coalesce((select json_agg(json_build_object(\n    'schema', schemaname, 'table', tablename, 'name', policyname, 'permissive', permissive,\n    'roles', roles, 'command', cmd, 'using', qual, 'check', with_check\n  ) order by schemaname, tablename, policyname) from pg_policies where schemaname in ('public', 'storage')), '[]'::json),\n  'functions', coalesce((select json_agg(json_build_object(\n    'name', p.proname,\n    'arguments', pg_get_function_arguments(p.oid),\n    'argnames', p.proargnames,\n    'result', pg_get_function_result(p.oid),\n    'set', p.proretset,\n    'language', l.lanname,\n    'definer', p.prosecdef,\n    'volatility', p.provolatile,\n    'source', p.prosrc\n  ) order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang\n    where n.nspname = 'public' and p.prokind = 'f'\n      and not exists (select 1 from pg_depend dp where dp.objid = p.oid and dp.deptype = 'e')), '[]'::json),\n  'realtime', coalesce((select json_agg(tablename order by tablename) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'), '[]'::json),\n  'extensions', coalesce((select json_agg(extname order by extname) from pg_extension), '[]'::json),\n  'buckets', coalesce((select json_agg(json_build_object(\n    'id', b.id, 'public', b.public, 'size_limit', b.file_size_limit, 'mime_types', b.allowed_mime_types,\n    'objects', (select count(*) from storage.objects o where o.bucket_id = b.id),\n    'bytes', (select coalesce(sum((o.metadata->>'size')::bigint), 0) from storage.objects o where o.bucket_id = b.id)\n  ) order by b.id) from storage.buckets b), '[]'::json),\n  'auth', json_build_object(\n    'users', (select count(*) from auth.users),\n    'passwords', (select count(*) from auth.users where coalesce(encrypted_password, '') <> ''),\n    'bcrypt', (select count(*) from auth.users where encrypted_password like '$2%'),\n    'confirmed', (select count(*) from auth.users where email_confirmed_at is not null or phone_confirmed_at is not null),\n    'phones', (select count(*) from auth.users where coalesce(phone, '') <> ''),\n    'banned', (select count(*) from auth.users where banned_until > now()),\n    'providers', (select json_object_agg(provider, n) from (select provider, count(*) as n from auth.identities group by provider) x),\n    'factors', (select json_object_agg(factor_type, n) from (select factor_type::text, count(*) as n from auth.mfa_factors group by factor_type) x)\n  )\n) as catalog\n";
export type Grants = {
    select: boolean;
    insert: boolean;
    update: boolean;
} | null;
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
    grants: {
        anon: Grants;
        authenticated: Grants;
    };
};
export type Constraint = {
    name: string;
    type: "p" | "u" | "f" | "c";
    columns: string[] | null;
    references: {
        schema: string;
        table: string;
        columns: string[];
        delete: string;
        update: string;
    } | null;
    definition: string;
};
export type Privileges = {
    select: boolean;
    insert: boolean;
    update: boolean;
    delete: boolean;
} | null;
export type Table = {
    name: string;
    rls: boolean;
    /** The table's own grants to the browser's roles (a column grant may add to them). */
    privileges: {
        anon: Privileges;
        authenticated: Privileges;
    };
    rows: number;
    bytes: number;
    replica: string;
    columns: Column[];
    constraints: Constraint[] | null;
    indexes: {
        name: string;
        unique: boolean;
        definition: string;
    }[] | null;
    triggers: {
        name: string;
        definition: string;
        function: string;
        source: string;
    }[] | null;
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
    views: {
        name: string;
        definition: string;
    }[];
    policies: Policy[];
    functions: PgFunction[];
    realtime: string[];
    extensions: string[];
    buckets: {
        id: string;
        public: boolean;
        size_limit: number | null;
        mime_types: string[] | null;
        objects: number;
        bytes: number;
    }[];
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
    edgeFunctions?: {
        slug: string;
        name: string;
    }[];
};
