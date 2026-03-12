import { getConnections, PgTestClient } from 'pgsql-test';

let db: PgTestClient;
let pg: PgTestClient;
let teardown: () => Promise<void>;

beforeAll(async () => {
  ({ pg, db, teardown } = await getConnections());
});

afterAll(async () => {
  await teardown();
});

beforeEach(async () => {
  await db.beforeEach();
});

afterEach(async () => {
  await db.afterEach();
});

describe('todos', () => {
  it('should insert and retrieve a todo', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['buy-milk', 'buy milk', '00000000-0000-0000-0000-000000000001']
    );

    const result = await pg.query(
      `SELECT title, done FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000001']
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('buy milk');
    expect(result.rows[0].done).toBe(false);
  });

  it('should fail when inserting a todo without a title', async () => {
    await expect(
      pg.query(
        `INSERT INTO test_schema.todos (slug, title) VALUES ($1, $2)`,
        ['no-title', null]
      )
    ).rejects.toThrow();
  });

  it('should default done to false', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['test-default', 'test default', '00000000-0000-0000-0000-000000000002']
    );
    const result = await pg.query(
      `SELECT done FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000002']
    );
    expect(result.rows[0].done).toBe(false);
  });

  it('should set created_at automatically', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['timestamped', 'timestamped', '00000000-0000-0000-0000-000000000003']
    );
    const result = await pg.query(
      `SELECT created_at FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000003']
    );
    expect(result.rows[0].created_at).toBeInstanceOf(Date);
  });

  it('should update done to true', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['finish-report', 'finish report', '00000000-0000-0000-0000-000000000004']
    );
    await pg.query(
      `UPDATE test_schema.todos SET done = true WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000004']
    );
    const result = await pg.query(
      `SELECT done FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000004']
    );
    expect(result.rows[0].done).toBe(true);
  });

  it('should delete a todo', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['to-delete', 'to be deleted', '00000000-0000-0000-0000-000000000005']
    );
    await pg.query(
      `DELETE FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000005']
    );
    const result = await pg.query(
      `SELECT * FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-000000000005']
    );
    expect(result.rows).toHaveLength(0);
  });

  it('should insert multiple todos for the same owner', async () => {
    const ownerId = '00000000-0000-0000-0000-000000000006';
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3), ($4, $5, $3), ($6, $7, $3)`,
      ['one', 'one', ownerId, 'two', 'two', 'three', 'three']
    );
    const result = await pg.query(
      `SELECT * FROM test_schema.todos WHERE owner_id = $1 ORDER BY id`,
      [ownerId]
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.map((r: any) => r.title)).toEqual(['one', 'two', 'three']);
  });

  it('should return empty rows when no todos exist', async () => {
    const result = await pg.query(
      `SELECT * FROM test_schema.todos WHERE owner_id = $1`,
      ['00000000-0000-0000-0000-ffffffffffff']
    );
    expect(result.rows).toHaveLength(0);
  });

  it('should auto-increment the id', async () => {
    const r1 = await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3) RETURNING id`,
      ['first', 'first', '00000000-0000-0000-0000-000000000007']
    );
    const r2 = await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3) RETURNING id`,
      ['second', 'second', '00000000-0000-0000-0000-000000000007']
    );
    expect(r2.rows[0].id).toBeGreaterThan(r1.rows[0].id);
  });
});

describe('bm25 search', () => {
  const ownerId = '00000000-0000-0000-0000-000000000010';
  let testNum = 0;

  const seedBm25Data = async () => {
    testNum++;
    const p = `bm25-${testNum}`;
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES
        ('${p}-buy-groceries', 'buy groceries at the store', $1),
        ('${p}-finish-report', 'finish the quarterly report', $1),
        ('${p}-buy-shoes', 'buy new running shoes', $1),
        ('${p}-dentist', 'schedule dentist appointment', $1),
        ('${p}-read-docs', 'read the postgresql documentation', $1)`,
      [ownerId]
    );
  };

  it('should return results ordered by bm25 relevance', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'buy' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'buy'
       LIMIT 5`,
      [ownerId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(result.rows[0].title).toMatch(/buy/);
    expect(result.rows[1].title).toMatch(/buy/);
  });

  it('should return negative scores for matching documents', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'report' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'report'
       LIMIT 1`,
      [ownerId]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toMatch(/report/);
    expect(parseFloat(result.rows[0].score)).toBeLessThan(0);
  });

  it('should rank more specific matches higher', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'postgresql documentation' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'postgresql documentation'
       LIMIT 5`,
      [ownerId]
    );
    expect(result.rows[0].title).toMatch(/postgresql/);
  });

  it('should return results for partial term matches', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'grocery' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'grocery'
       LIMIT 3`,
      [ownerId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].title).toMatch(/groceries/);
  });

  it('should handle queries with no strong matches gracefully', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'astrophysics' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'astrophysics'
       LIMIT 5`,
      [ownerId]
    );
    expect(result.rows).toBeDefined();
  });

  it('should work with multi-word queries', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'running shoes' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'running shoes'
       LIMIT 1`,
      [ownerId]
    );
    expect(result.rows[0].title).toMatch(/running shoes/);
  });

  it('should filter by score threshold', async () => {
    await seedBm25Data();
    const result = await pg.query(
      `SELECT title, title <@> 'dentist' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
         AND title <@> 'dentist' < -0.1
       ORDER BY title <@> 'dentist'`,
      [ownerId]
    );
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    result.rows.forEach((row: any) => {
      expect(parseFloat(row.score)).toBeLessThan(-0.1);
    });
  });
});

describe('bm25 + ON CONFLICT DO NOTHING', () => {
  const ownerId = '00000000-0000-0000-0000-000000000020';

  it('should handle ON CONFLICT DO NOTHING on unique slug with bm25 index present', async () => {
    // First insert
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['conflict-test', 'original title', ownerId]
    );

    // Same slug — should conflict and do nothing
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      ['conflict-test', 'duplicate title', ownerId]
    );

    const result = await pg.query(
      `SELECT title FROM test_schema.todos WHERE slug = $1`,
      ['conflict-test']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('original title');
  });

  it('should handle ON CONFLICT DO UPDATE with bm25 index present', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['upsert-test', 'initial title', ownerId]
    );

    // Upsert — should update the title
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title`,
      ['upsert-test', 'updated title', ownerId]
    );

    const result = await pg.query(
      `SELECT title FROM test_schema.todos WHERE slug = $1`,
      ['upsert-test']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('updated title');
  });

  it('should handle repeated ON CONFLICT DO NOTHING in a loop', async () => {
    // Insert the initial row
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['loop-test', 'loop title', ownerId]
    );

    // Repeatedly try to insert the same slug
    for (let i = 0; i < 5; i++) {
      await pg.query(
        `INSERT INTO test_schema.todos (slug, title, owner_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (slug) DO NOTHING`,
        ['loop-test', `attempt ${i}`, ownerId]
      );
    }

    const result = await pg.query(
      `SELECT * FROM test_schema.todos WHERE slug = $1`,
      ['loop-test']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('loop title');
  });

  it('should handle ON CONFLICT on primary key (id) with bm25 index present', async () => {
    const inserted = await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id)
       VALUES ($1, $2, $3) RETURNING id`,
      ['pk-conflict', 'pk conflict test', ownerId]
    );
    const id = inserted.rows[0].id;

    // Conflict on PK
    await pg.query(
      `INSERT INTO test_schema.todos (id, slug, title, owner_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, 'pk-conflict-dup', 'should not appear', ownerId]
    );

    const result = await pg.query(
      `SELECT title FROM test_schema.todos WHERE id = $1`,
      [id]
    );
    expect(result.rows[0].title).toBe('pk conflict test');
  });

  it('should search with bm25 after ON CONFLICT DO NOTHING', async () => {
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['search-after-conflict', 'searchable document about databases', ownerId]
    );

    // Trigger a conflict
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      ['search-after-conflict', 'different text', ownerId]
    );

    // Now do a bm25 search — this is the critical path that triggers
    // ResourceOwnerEnlarge in the original bug
    const result = await pg.query(
      `SELECT title, title <@> 'databases' AS score
       FROM test_schema.todos
       WHERE owner_id = $1
       ORDER BY title <@> 'databases'
       LIMIT 1`,
      [ownerId]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toMatch(/databases/);
  });

  it('should handle bulk upsert with bm25 index present', async () => {
    // Insert initial rows
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES
        ('bulk-1', 'first bulk item', $1),
        ('bulk-2', 'second bulk item', $1),
        ('bulk-3', 'third bulk item', $1)`,
      [ownerId]
    );

    // Bulk upsert — some conflict, some new
    await pg.query(
      `INSERT INTO test_schema.todos (slug, title, owner_id) VALUES
        ('bulk-1', 'updated first', $1),
        ('bulk-2', 'updated second', $1),
        ('bulk-4', 'fourth bulk item', $1)
       ON CONFLICT (slug) DO NOTHING`,
      [ownerId]
    );

    const result = await pg.query(
      `SELECT slug, title FROM test_schema.todos
       WHERE owner_id = $1 AND slug LIKE 'bulk-%'
       ORDER BY slug`,
      [ownerId]
    );
    expect(result.rows).toHaveLength(4);
    // originals should be unchanged
    expect(result.rows[0].title).toBe('first bulk item');
    expect(result.rows[1].title).toBe('second bulk item');
    expect(result.rows[2].title).toBe('third bulk item');
    // new row should be inserted
    expect(result.rows[3].title).toBe('fourth bulk item');
  });
});

describe('bm25 + table rename', () => {
  const ownerId = '00000000-0000-0000-0000-000000000030';

  it('should handle ON CONFLICT DO NOTHING after table rename', async () => {
    // Create a fresh table with a BM25 index
    await pg.query(`CREATE TABLE test_schema.items (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      title text NOT NULL,
      owner_id uuid
    )`);
    await pg.query(`CREATE INDEX idx_items_bm25 ON test_schema.items
      USING bm25 (title) WITH (text_config = 'english')`);

    // Insert a row before rename
    await pg.query(
      `INSERT INTO test_schema.items (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['pre-rename', 'item before rename', ownerId]
    );

    // Rename the table
    await pg.query(`ALTER TABLE test_schema.items RENAME TO items_renamed`);

    // ON CONFLICT DO NOTHING on the renamed table
    await pg.query(
      `INSERT INTO test_schema.items_renamed (slug, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      ['pre-rename', 'should not replace', ownerId]
    );

    const result = await pg.query(
      `SELECT title FROM test_schema.items_renamed WHERE slug = $1`,
      ['pre-rename']
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].title).toBe('item before rename');
  });

  it('should handle insert after table rename with bm25 index', async () => {
    await pg.query(`CREATE TABLE test_schema.docs (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      body text NOT NULL,
      owner_id uuid
    )`);
    await pg.query(`CREATE INDEX idx_docs_bm25 ON test_schema.docs
      USING bm25 (body) WITH (text_config = 'english')`);

    await pg.query(
      `INSERT INTO test_schema.docs (slug, body, owner_id) VALUES ($1, $2, $3)`,
      ['doc-1', 'postgresql full text search documentation', ownerId]
    );

    // Rename
    await pg.query(`ALTER TABLE test_schema.docs RENAME TO documents`);

    // Insert into renamed table
    await pg.query(
      `INSERT INTO test_schema.documents (slug, body, owner_id) VALUES ($1, $2, $3)`,
      ['doc-2', 'another document about databases', ownerId]
    );

    // BM25 search on the renamed table
    const result = await pg.query(
      `SELECT body, body <@> 'postgresql' AS score
       FROM test_schema.documents
       WHERE owner_id = $1
       ORDER BY body <@> 'postgresql'
       LIMIT 1`,
      [ownerId]
    );
    expect(result.rows[0].body).toMatch(/postgresql/);
  });

  it('should handle ON CONFLICT DO UPDATE after table rename with bm25 index', async () => {
    await pg.query(`CREATE TABLE test_schema.articles (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      content text NOT NULL,
      owner_id uuid
    )`);
    await pg.query(`CREATE INDEX idx_articles_bm25 ON test_schema.articles
      USING bm25 (content) WITH (text_config = 'english')`);

    await pg.query(
      `INSERT INTO test_schema.articles (slug, content, owner_id) VALUES ($1, $2, $3)`,
      ['article-1', 'original content', ownerId]
    );

    // Rename
    await pg.query(`ALTER TABLE test_schema.articles RENAME TO posts`);

    // Upsert on renamed table — this should update the bm25-indexed column
    await pg.query(
      `INSERT INTO test_schema.posts (slug, content, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET content = EXCLUDED.content`,
      ['article-1', 'updated content after rename', ownerId]
    );

    const result = await pg.query(
      `SELECT content FROM test_schema.posts WHERE slug = $1`,
      ['article-1']
    );
    expect(result.rows[0].content).toBe('updated content after rename');
  });

  it('should handle bm25 search after table rename and ON CONFLICT', async () => {
    await pg.query(`CREATE TABLE test_schema.notes (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      body text NOT NULL,
      owner_id uuid
    )`);
    await pg.query(`CREATE INDEX idx_notes_bm25 ON test_schema.notes
      USING bm25 (body) WITH (text_config = 'english')`);

    // Seed data
    await pg.query(
      `INSERT INTO test_schema.notes (slug, body, owner_id) VALUES
        ($1, $2, $7), ($3, $4, $7), ($5, $6, $7)`,
      [
        'note-1', 'learning about machine learning algorithms',
        'note-2', 'cooking recipes for italian pasta',
        'note-3', 'database indexing strategies and performance',
        ownerId
      ]
    );

    // Rename
    await pg.query(`ALTER TABLE test_schema.notes RENAME TO memos`);

    // Trigger a conflict on the renamed table
    await pg.query(
      `INSERT INTO test_schema.memos (slug, body, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      ['note-1', 'replacement text', ownerId]
    );

    // Now search with BM25 on the renamed table
    const result = await pg.query(
      `SELECT body, body <@> 'database indexing' AS score
       FROM test_schema.memos
       WHERE owner_id = $1
       ORDER BY body <@> 'database indexing'
       LIMIT 1`,
      [ownerId]
    );
    expect(result.rows[0].body).toMatch(/database/);
  });

  it('should handle repeated renames with bm25 index', async () => {
    await pg.query(`CREATE TABLE test_schema.t1 (
      id serial PRIMARY KEY,
      slug text NOT NULL UNIQUE,
      title text NOT NULL,
      owner_id uuid
    )`);
    await pg.query(`CREATE INDEX idx_t1_bm25 ON test_schema.t1
      USING bm25 (title) WITH (text_config = 'english')`);

    await pg.query(
      `INSERT INTO test_schema.t1 (slug, title, owner_id) VALUES ($1, $2, $3)`,
      ['row-1', 'first version of the table', ownerId]
    );

    // Rename twice
    await pg.query(`ALTER TABLE test_schema.t1 RENAME TO t2`);
    await pg.query(`ALTER TABLE test_schema.t2 RENAME TO t3`);

    // ON CONFLICT on the twice-renamed table
    await pg.query(
      `INSERT INTO test_schema.t3 (slug, title, owner_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO NOTHING`,
      ['row-1', 'should not appear', ownerId]
    );

    // BM25 search
    const result = await pg.query(
      `SELECT title, title <@> 'table' AS score
       FROM test_schema.t3
       ORDER BY title <@> 'table'
       LIMIT 1`
    );
    expect(result.rows[0].title).toBe('first version of the table');
  });
});

describe('issue #344 repro: trigger-driven DDL + table rename + bm25', () => {
  it('field creation fails after trigger-driven table rename', async () => {
    // Register a managed table (trigger creates nothing yet — table must exist)
    await pg.query(`CREATE TABLE test_schema.testtable (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    )`);

    const mt = await pg.query(
      `INSERT INTO test_schema.managed_tables (schema_name, table_name, current_name)
       VALUES ('test_schema', 'testtable', 'testtable') RETURNING id`
    );
    const mtId = mt.rows[0].id;

    // Add a field via trigger (ALTER TABLE ADD COLUMN)
    await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'fielda', 'text')`,
      [mtId]
    );

    // Add a BM25 index on that field via trigger
    await pg.query(
      `INSERT INTO test_schema.managed_indexes (managed_table_id, index_name, index_type, field_name)
       VALUES ($1, 'idx_testtable_bm25', 'bm25', 'fielda')`,
      [mtId]
    );

    // Rename table via trigger (UPDATE current_name fires ALTER TABLE RENAME)
    await pg.query(
      `UPDATE test_schema.managed_tables SET current_name = 'testtablerenamed' WHERE id = $1`,
      [mtId]
    );

    // Now try to add another field — trigger will use the NEW name
    await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'fieldb', 'text')`,
      [mtId]
    );

    // Verify the column exists on the renamed table
    const result = await pg.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'test_schema' AND table_name = 'testtablerenamed'
       ORDER BY ordinal_position`
    );
    const cols = result.rows.map((r: any) => r.column_name);
    expect(cols).toContain('fielda');
    expect(cols).toContain('fieldb');
  });

  it('ON CONFLICT after trigger-driven rename with bm25 index', async () => {
    await pg.query(`CREATE TABLE test_schema.items2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slug text UNIQUE NOT NULL
    )`);

    const mt = await pg.query(
      `INSERT INTO test_schema.managed_tables (schema_name, table_name, current_name)
       VALUES ('test_schema', 'items2', 'items2') RETURNING id`
    );
    const mtId = mt.rows[0].id;

    // Add a text field + bm25 index via triggers
    await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'title', 'text')`,
      [mtId]
    );
    await pg.query(
      `INSERT INTO test_schema.managed_indexes (managed_table_id, index_name, index_type, field_name)
       VALUES ($1, 'idx_items2_bm25', 'bm25', 'title')`,
      [mtId]
    );

    // Insert a row
    await pg.query(
      `INSERT INTO test_schema.items2 (slug, title) VALUES ('item-1', 'searchable content')`
    );

    // Rename table via trigger
    await pg.query(
      `UPDATE test_schema.managed_tables SET current_name = 'items2_renamed' WHERE id = $1`,
      [mtId]
    );

    // ON CONFLICT on the renamed table
    await pg.query(
      `INSERT INTO test_schema.items2_renamed (slug, title)
       VALUES ('item-1', 'replacement')
       ON CONFLICT (slug) DO NOTHING`
    );

    // BM25 search on the renamed table
    const result = await pg.query(
      `SELECT title, title <@> 'searchable' AS score
       FROM test_schema.items2_renamed
       ORDER BY title <@> 'searchable'
       LIMIT 1`
    );
    expect(result.rows[0].title).toBe('searchable content');
  });

  it('field deletion after trigger-driven rename with bm25 index', async () => {
    await pg.query(`CREATE TABLE test_schema.docs2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    )`);

    const mt = await pg.query(
      `INSERT INTO test_schema.managed_tables (schema_name, table_name, current_name)
       VALUES ('test_schema', 'docs2', 'docs2') RETURNING id`
    );
    const mtId = mt.rows[0].id;

    // Add two fields
    const f1 = await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'body', 'text') RETURNING id`,
      [mtId]
    );
    await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'summary', 'text')`,
      [mtId]
    );

    // Add BM25 index on body
    await pg.query(
      `INSERT INTO test_schema.managed_indexes (managed_table_id, index_name, index_type, field_name)
       VALUES ($1, 'idx_docs2_bm25', 'bm25', 'body')`,
      [mtId]
    );

    // Rename table via trigger
    await pg.query(
      `UPDATE test_schema.managed_tables SET current_name = 'docs2_renamed' WHERE id = $1`,
      [mtId]
    );

    // Delete a field via trigger (DROP COLUMN on renamed table)
    await pg.query(
      `DELETE FROM test_schema.managed_fields WHERE id = $1`,
      [f1.rows[0].id]
    );

    // Verify the column is gone
    const result = await pg.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'test_schema' AND table_name = 'docs2_renamed'
       ORDER BY ordinal_position`
    );
    const cols = result.rows.map((r: any) => r.column_name);
    expect(cols).not.toContain('body');
    expect(cols).toContain('summary');
  });

  it('bm25 index creation after trigger-driven rename', async () => {
    await pg.query(`CREATE TABLE test_schema.posts2 (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid()
    )`);

    const mt = await pg.query(
      `INSERT INTO test_schema.managed_tables (schema_name, table_name, current_name)
       VALUES ('test_schema', 'posts2', 'posts2') RETURNING id`
    );
    const mtId = mt.rows[0].id;

    // Add a text field
    await pg.query(
      `INSERT INTO test_schema.managed_fields (managed_table_id, field_name, field_type)
       VALUES ($1, 'content', 'text')`,
      [mtId]
    );

    // Rename table BEFORE creating the bm25 index
    await pg.query(
      `UPDATE test_schema.managed_tables SET current_name = 'posts2_renamed' WHERE id = $1`,
      [mtId]
    );

    // Now create bm25 index via trigger — uses current_name (the renamed name)
    await pg.query(
      `INSERT INTO test_schema.managed_indexes (managed_table_id, index_name, index_type, field_name)
       VALUES ($1, 'idx_posts2_bm25', 'bm25', 'content')`,
      [mtId]
    );

    // Insert and search
    await pg.query(
      `INSERT INTO test_schema.posts2_renamed (content) VALUES ('full text search with bm25 ranking')`
    );

    const result = await pg.query(
      `SELECT content, content <@> 'bm25' AS score
       FROM test_schema.posts2_renamed
       ORDER BY content <@> 'bm25'
       LIMIT 1`
    );
    expect(result.rows[0].content).toMatch(/bm25/);
  });
});
