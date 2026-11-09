-- Postgres's own record of every query shape and its time (the Health page's
-- "Slowest SQL"). It only gathers once Postgres is started with
-- shared_preload_libraries=pg_stat_statements (infra/docker-compose.yml).
-- Never fails a deploy: a database where it cannot be created goes on without it.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_stat_statements not created: %', SQLERRM;
END $$;
