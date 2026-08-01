class Workspace
  # The boundary between workspaces, as the database keeps it.
  #
  # Not only a migration. `db:migrate` on an empty database loads `schema.rb`
  # and marks every migration up without running one, and `schema.rb` cannot
  # describe a policy — so a database built that way would record that this ran
  # and have no boundary at all. Applied from one idempotent place instead, by
  # whoever built the database and however they built it.
  module Boundary
    ROOMS = %w[channels memberships messages memory_entries artifacts
               agent_sessions agent_runs run_steps activities].freeze

    # Read from the transaction rather than the session: DATABASE_URL points at
    # the pooler, where session state does not survive between statements, so a
    # boundary set there works under no load and lies under load.
    MINE = "workspace_id = nullif(current_setting('app.workspace_id', true), '')::bigint".freeze

    def self.apply(connection)
      role(connection)
      ROOMS.each do |table|
        next unless connection.table_exists?(table)

        # FORCE is not optional. The owning role bypasses its own policies
        # without it, and the owning role is the one the application connects
        # as — the usual reason row-level security appears to do nothing.
        connection.execute "ALTER TABLE #{table} ENABLE ROW LEVEL SECURITY"
        connection.execute "ALTER TABLE #{table} FORCE  ROW LEVEL SECURITY"
        connection.execute "DROP POLICY IF EXISTS workspace_isolation ON #{table}"
        # WITH CHECK closes writing as well as reading: nothing can be put into
        # another workspace, even on purpose.
        connection.execute <<~SQL
          CREATE POLICY workspace_isolation ON #{table}
            USING (#{MINE}) WITH CHECK (#{MINE})
        SQL
      end
    end

    # A superuser bypasses row-level security even where it is FORCEd, and a
    # local or CI PostgreSQL hands you a superuser. Without a role that cannot
    # bypass it, every policy above is decoration and no test could go red.
    def self.role(connection)
      connection.execute <<~SQL
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '#{APP_ROLE}') THEN
            CREATE ROLE #{APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$;
      SQL
      [
        "GRANT USAGE ON SCHEMA public TO #{APP_ROLE}",
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO #{APP_ROLE}",
        "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO #{APP_ROLE}",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public " \
          "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO #{APP_ROLE}",
        "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO #{APP_ROLE}",
        # So the connecting user can become it for the length of a transaction.
        "GRANT #{APP_ROLE} TO CURRENT_USER"
      ].each { |sql| connection.execute(sql) }
    end
  end
end
