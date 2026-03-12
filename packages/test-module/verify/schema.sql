-- Verify: schema

SELECT id, slug, title, done, owner_id, created_at FROM test_schema.todos WHERE false;
