-- Deploy: schema
-- made with <3 @ constructive.io

CREATE SCHEMA IF NOT EXISTS test_schema;

GRANT USAGE ON SCHEMA test_schema TO authenticated;
GRANT USAGE ON SCHEMA test_schema TO anonymous;

CREATE TABLE test_schema.todos (
  id serial PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  owner_id uuid DEFAULT (current_setting('request.jwt.claims', true)::json->>'sub')::uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE test_schema.todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "todos_select_policy" ON test_schema.todos
  FOR SELECT
  USING (owner_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid);

CREATE POLICY "todos_insert_policy" ON test_schema.todos
  FOR INSERT
  WITH CHECK (owner_id = (current_setting('request.jwt.claims', true)::json->>'sub')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON test_schema.todos TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE test_schema.todos_id_seq TO authenticated;

CREATE INDEX idx_todos_title_bm25 ON test_schema.todos
  USING bm25 (title)
  WITH (text_config = 'english');

-- Metaschema-like registry: tracks managed tables and triggers DDL on changes
CREATE TABLE test_schema.managed_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_name text NOT NULL DEFAULT 'test_schema',
  table_name text NOT NULL UNIQUE,
  current_name text NOT NULL
);

CREATE TABLE test_schema.managed_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_table_id uuid NOT NULL REFERENCES test_schema.managed_tables(id),
  field_name text NOT NULL,
  field_type text NOT NULL DEFAULT 'text'
);

CREATE TABLE test_schema.managed_indexes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  managed_table_id uuid NOT NULL REFERENCES test_schema.managed_tables(id),
  index_name text NOT NULL,
  index_type text NOT NULL DEFAULT 'btree',
  field_name text NOT NULL
);

-- Trigger: when managed_tables.current_name is updated, rename the actual table
CREATE OR REPLACE FUNCTION test_schema.on_table_rename()
RETURNS trigger AS $$
BEGIN
  IF OLD.current_name IS DISTINCT FROM NEW.current_name THEN
    EXECUTE format(
      'ALTER TABLE %I.%I RENAME TO %I',
      NEW.schema_name, OLD.current_name, NEW.current_name
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_table_rename
  BEFORE UPDATE ON test_schema.managed_tables
  FOR EACH ROW EXECUTE FUNCTION test_schema.on_table_rename();

-- Trigger: when a managed_field is inserted, add the column to the actual table
CREATE OR REPLACE FUNCTION test_schema.on_field_insert()
RETURNS trigger AS $$
DECLARE
  v_schema text;
  v_table text;
BEGIN
  SELECT schema_name, current_name INTO v_schema, v_table
    FROM test_schema.managed_tables WHERE id = NEW.managed_table_id;
  EXECUTE format(
    'ALTER TABLE %I.%I ADD COLUMN %I %s',
    v_schema, v_table, NEW.field_name, NEW.field_type
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_field_insert
  AFTER INSERT ON test_schema.managed_fields
  FOR EACH ROW EXECUTE FUNCTION test_schema.on_field_insert();

-- Trigger: when a managed_field is deleted, drop the column
CREATE OR REPLACE FUNCTION test_schema.on_field_delete()
RETURNS trigger AS $$
DECLARE
  v_schema text;
  v_table text;
BEGIN
  SELECT schema_name, current_name INTO v_schema, v_table
    FROM test_schema.managed_tables WHERE id = OLD.managed_table_id;
  EXECUTE format(
    'ALTER TABLE %I.%I DROP COLUMN %I',
    v_schema, v_table, OLD.field_name
  );
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_field_delete
  AFTER DELETE ON test_schema.managed_fields
  FOR EACH ROW EXECUTE FUNCTION test_schema.on_field_delete();

-- Trigger: when a managed_index is inserted, create the index (supports bm25)
CREATE OR REPLACE FUNCTION test_schema.on_index_insert()
RETURNS trigger AS $$
DECLARE
  v_schema text;
  v_table text;
BEGIN
  SELECT schema_name, current_name INTO v_schema, v_table
    FROM test_schema.managed_tables WHERE id = NEW.managed_table_id;

  IF NEW.index_type = 'bm25' THEN
    EXECUTE format(
      'CREATE INDEX %I ON %I.%I USING bm25 (%I) WITH (text_config = ''english'')',
      NEW.index_name, v_schema, v_table, NEW.field_name
    );
  ELSE
    EXECUTE format(
      'CREATE INDEX %I ON %I.%I (%I)',
      NEW.index_name, v_schema, v_table, NEW.field_name
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_index_insert
  AFTER INSERT ON test_schema.managed_indexes
  FOR EACH ROW EXECUTE FUNCTION test_schema.on_index_insert();

GRANT SELECT, INSERT, UPDATE, DELETE ON test_schema.managed_tables TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON test_schema.managed_fields TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON test_schema.managed_indexes TO authenticated;
