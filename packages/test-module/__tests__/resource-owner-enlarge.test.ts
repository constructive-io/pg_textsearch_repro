/**
 * Reproduction test for pg_textsearch ResourceOwnerEnlarge bug
 *
 * Bug: When pg_textsearch is loaded via shared_preload_libraries, any
 * transaction that (1) creates database objects via DDL, (2) encounters
 * an error, and (3) attempts ROLLBACK will fail with:
 *
 *   ERROR: ResourceOwnerEnlarge called after release started
 *
 * This is a PostgreSQL 17+ issue caused by pg_textsearch's object_access_hook
 * and/or transaction abort callbacks performing DSA/dshash operations during
 * transaction abort cleanup, at a point where the current ResourceOwner has
 * already set its `releasing` flag.
 *
 * Reference: https://github.com/timescale/pg_textsearch/issues/247
 *
 * NOTE: Each "bug" test uses a fresh pg.Client connection because the
 * ResourceOwnerEnlarge error leaves the PostgreSQL connection in a
 * permanently broken state (stuck in aborted transaction).
 */

import { getConnections } from 'pgsql-test';

// Use require() for pg since it's a transitive dependency (available at
// runtime via pgsql-client/pgsql-test but not declared in test-module)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

let teardown: () => Promise<void>;
let connConfig: Record<string, any>;

beforeAll(async () => {
  // Use getConnections() to provision a fresh database with test_schema deployed
  const conns = await getConnections();
  teardown = conns.teardown;

  // Extract the connection config so we can create raw pg.Client connections
  // for each test (needed because the bug corrupts the connection)
  const cfg = (conns.pg as any).config;
  connConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.superuser || cfg.user,
    password: cfg.password
  };
});

afterAll(async () => {
  await teardown();
});

/**
 * Helper: create a fresh raw pg.Client connection.
 * Each reproduction test needs its own connection because the
 * ResourceOwnerEnlarge error permanently corrupts the connection.
 */
async function freshClient(): Promise<any> {
  const client = new Client(connConfig);
  await client.connect();
  return client;
}

describe('pg_textsearch ResourceOwnerEnlarge bug reproduction', () => {
  /**
   * MINIMAL REPRODUCTION: CREATE TABLE + division by zero + ROLLBACK
   *
   * This is the simplest possible trigger. Any DDL that creates a database
   * object, followed by any error, followed by ROLLBACK.
   */
  it('minimal: CREATE TABLE + error + ROLLBACK triggers ResourceOwnerEnlarge', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE test_schema.repro_minimal (id serial PRIMARY KEY)');

      // Cause any error to put the transaction in aborted state
      try {
        await client.query('SELECT 1/0');
      } catch (e: any) {
        expect(e.message).toMatch(/division by zero/);
      }

      // ROLLBACK triggers the bug: pg_textsearch's hooks fire during abort
      // cleanup and attempt ResourceOwnerEnlarge after releasing has started
      let rollbackError: Error | null = null;
      try {
        await client.query('ROLLBACK');
      } catch (e: any) {
        rollbackError = e;
      }

      // When pg_textsearch is loaded, ROLLBACK fails with ResourceOwnerEnlarge
      // When pg_textsearch is NOT loaded (or bug is fixed), ROLLBACK succeeds
      if (rollbackError) {
        expect(rollbackError.message).toMatch(
          /ResourceOwnerEnlarge called after release started/
        );
      }
      // If no error, the bug is fixed — test passes either way
    } finally {
      await client.end().catch(() => {});
    }
  });

  /**
   * WITH BM25 INDEX: same pattern but creating a BM25 index inside the transaction.
   * This more closely matches real-world usage with pg_textsearch.
   */
  it('with BM25: CREATE TABLE + BM25 index + error + ROLLBACK', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TABLE test_schema.repro_bm25 (id serial PRIMARY KEY, title text NOT NULL)'
      );
      await client.query(
        `CREATE INDEX idx_repro_bm25 ON test_schema.repro_bm25 USING bm25 (title) WITH (text_config = 'english')`
      );

      try {
        await client.query('SELECT 1/0');
      } catch (e: any) {
        expect(e.message).toMatch(/division by zero/);
      }

      let rollbackError: Error | null = null;
      try {
        await client.query('ROLLBACK');
      } catch (e: any) {
        rollbackError = e;
      }

      if (rollbackError) {
        expect(rollbackError.message).toMatch(
          /ResourceOwnerEnlarge called after release started/
        );
      }
    } finally {
      await client.end().catch(() => {});
    }
  });

  /**
   * DDL ERROR PATTERN: CREATE TABLE + failing DDL (FK to nonexistent table) + ROLLBACK
   * This matches patterns where DDL trigger chains can fail mid-transaction.
   */
  it('DDL chain: CREATE TABLE + failing ALTER TABLE + ROLLBACK', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TABLE test_schema.repro_ddl (id serial PRIMARY KEY, name text)'
      );

      // This ALTER TABLE fails because nonexistent_table doesn't exist
      try {
        await client.query(
          'ALTER TABLE test_schema.repro_ddl ADD COLUMN bad_ref uuid REFERENCES nonexistent_table(id)'
        );
      } catch (e: any) {
        expect(e.message).toMatch(/nonexistent_table/);
      }

      let rollbackError: Error | null = null;
      try {
        await client.query('ROLLBACK');
      } catch (e: any) {
        rollbackError = e;
      }

      if (rollbackError) {
        expect(rollbackError.message).toMatch(
          /ResourceOwnerEnlarge called after release started/
        );
      }
    } finally {
      await client.end().catch(() => {});
    }
  });

  /**
   * SAVEPOINT PATTERN: matches pgsql-test's beforeEach/afterEach flow.
   * BEGIN + SAVEPOINT + DDL + error + ROLLBACK TO SAVEPOINT
   */
  it('savepoint: DDL + error + ROLLBACK TO SAVEPOINT', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');
      await client.query('SAVEPOINT test_sp');
      await client.query(
        'CREATE TABLE test_schema.repro_savepoint (id serial PRIMARY KEY, title text)'
      );

      try {
        await client.query('SELECT 1/0');
      } catch (e: any) {
        expect(e.message).toMatch(/division by zero/);
      }

      let rollbackError: Error | null = null;
      try {
        await client.query('ROLLBACK TO SAVEPOINT test_sp');
      } catch (e: any) {
        rollbackError = e;
      }

      if (rollbackError) {
        expect(rollbackError.message).toMatch(
          /ResourceOwnerEnlarge called after release started/
        );
      } else {
        // Clean up if savepoint rollback succeeded
        await client.query('ROLLBACK');
      }
    } finally {
      await client.end().catch(() => {});
    }
  });
});

describe('pg_textsearch ResourceOwnerEnlarge controls (should always pass)', () => {
  /**
   * CONTROL 1: Error WITHOUT prior DDL does NOT trigger the bug.
   * No objects are created, so no OAT_DROP events fire during abort.
   */
  it('control: error without DDL does NOT trigger ResourceOwnerEnlarge', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');

      // No DDL — just an error
      try {
        await client.query('SELECT 1/0');
      } catch (e: any) {
        expect(e.message).toMatch(/division by zero/);
      }

      // ROLLBACK should succeed because no objects were created
      await client.query('ROLLBACK');
    } finally {
      await client.end().catch(() => {});
    }
  });

  /**
   * CONTROL 2: DDL without error does NOT trigger the bug.
   * Clean ROLLBACK after successful DDL works fine.
   */
  it('control: DDL without error does NOT trigger ResourceOwnerEnlarge', async () => {
    const client = await freshClient();

    try {
      await client.query('BEGIN');
      await client.query(
        'CREATE TABLE test_schema.repro_clean (id serial PRIMARY KEY, title text)'
      );
      await client.query(
        `CREATE INDEX idx_repro_clean ON test_schema.repro_clean USING bm25 (title) WITH (text_config = 'english')`
      );

      // Clean ROLLBACK (no prior error) should always succeed
      await client.query('ROLLBACK');
    } finally {
      await client.end().catch(() => {});
    }
  });

  /**
   * CONTROL 3: Error in a different transaction than DDL.
   * DDL committed in one transaction, error + rollback in another.
   */
  it('control: DDL committed separately, then error + ROLLBACK in new tx', async () => {
    const client = await freshClient();

    try {
      // Transaction 1: create and commit
      await client.query('BEGIN');
      await client.query(
        'CREATE TABLE test_schema.repro_separate (id serial PRIMARY KEY, title text)'
      );
      await client.query('COMMIT');

      // Transaction 2: error + rollback (no DDL in this transaction)
      await client.query('BEGIN');
      try {
        await client.query('SELECT 1/0');
      } catch (e: any) {
        expect(e.message).toMatch(/division by zero/);
      }
      await client.query('ROLLBACK');

      // Cleanup
      await client.query('DROP TABLE IF EXISTS test_schema.repro_separate');
    } finally {
      await client.end().catch(() => {});
    }
  });
});
