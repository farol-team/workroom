class WorkspaceIdEverywhere < ActiveRecord::Migration[8.1]
  # Denormalised on purpose, including where it could be reached through a
  # parent: a row-level security policy has to be checkable without a join, and
  # one written as a subquery is both slower and able to be wrong.
  ROOMS = %i[channels memberships messages memory_entries artifacts
             agent_sessions agent_runs run_steps activities].freeze

  # Where each table can learn its workspace from, once channels know theirs.
  THROUGH = {
    memberships: "channels.id = memberships.channel_id",
    messages: "channels.id = messages.channel_id",
    memory_entries: "channels.id = memory_entries.channel_id",
    artifacts: "channels.id = artifacts.channel_id",
    agent_sessions: "channels.id = agent_sessions.channel_id"
  }.freeze

  def up
    ROOMS.each { |table| add_reference table, :workspace, foreign_key: true }

    say_with_time "giving what already exists to the room it was always in" do
      # A database with rows in it has the workspace 20260801120001 made. One
      # without — a fresh install, a test database that was emptied — has none,
      # and the backfill then has nothing to move but still needs somewhere for
      # the NOT NULL below to point at.
      execute(<<~SQL)
        INSERT INTO workspaces (slug, name, created_at, updated_at)
        SELECT 'workroom', 'WorkRoom', NOW(), NOW()
        WHERE NOT EXISTS (SELECT 1 FROM workspaces)
      SQL
      first = execute("SELECT id FROM workspaces ORDER BY id LIMIT 1").first

      execute("UPDATE channels SET workspace_id = #{first['id']}")
      THROUGH.each do |table, on|
        execute("UPDATE #{table} SET workspace_id = channels.workspace_id FROM channels WHERE #{on}")
      end
      execute(<<~SQL)
        UPDATE agent_runs SET workspace_id = agent_sessions.workspace_id
        FROM agent_sessions WHERE agent_sessions.id = agent_runs.agent_session_id
      SQL
      execute(<<~SQL)
        UPDATE run_steps SET workspace_id = agent_runs.workspace_id
        FROM agent_runs WHERE agent_runs.id = run_steps.agent_run_id
      SQL
      # Polymorphic and older than channels: what cannot be traced belongs to
      # the room that was the only one there was.
      execute("UPDATE activities SET workspace_id = #{first['id']} WHERE workspace_id IS NULL")
    end

    ROOMS.each { |table| change_column_null table, :workspace_id, false }

    # Two customers both want #general, and a uri gains a workspace segment in
    # step 4 — until then the pair is what is actually unique.
    remove_index :channels, :slug
    add_index :channels, %i[workspace_id slug], unique: true
    remove_index :memory_entries, :uri
    add_index :memory_entries, %i[workspace_id uri], unique: true

    # A child of one workspace cannot reference a parent of another. Not by
    # convention — the database refuses it.
    add_index :channels, %i[id workspace_id], unique: true
    add_index :agent_sessions, %i[id workspace_id], unique: true
    add_index :agent_runs, %i[id workspace_id], unique: true

    THROUGH.each_key do |table|
      add_foreign_key table, :channels, column: %i[channel_id workspace_id],
                                        primary_key: %i[id workspace_id]
    end
    add_foreign_key :agent_runs, :agent_sessions,
                    column: %i[agent_session_id workspace_id], primary_key: %i[id workspace_id]
    add_foreign_key :run_steps, :agent_runs,
                    column: %i[agent_run_id workspace_id], primary_key: %i[id workspace_id]
  end

  def down
    add_index :channels, :slug, unique: true
    add_index :memory_entries, :uri, unique: true
    ROOMS.each { |table| remove_reference table, :workspace }
  end
end
