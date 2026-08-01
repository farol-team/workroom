class TheDatabaseKeepsTheBoundary < ActiveRecord::Migration[8.1]
  # The policies themselves live in Workspace::Boundary, applied from one
  # idempotent place — because `db:migrate` on an empty database loads the
  # schema and records this as run without running it, and `schema.rb` cannot
  # describe a policy. A database built that way would say the boundary is
  # there and have none.
  def up = Workspace::Boundary.apply(connection)

  def down
    Workspace::Boundary::ROOMS.each do |table|
      execute "DROP POLICY IF EXISTS workspace_isolation ON #{table}"
      execute "ALTER TABLE #{table} NO FORCE ROW LEVEL SECURITY"
      execute "ALTER TABLE #{table} DISABLE ROW LEVEL SECURITY"
    end
  end
end
