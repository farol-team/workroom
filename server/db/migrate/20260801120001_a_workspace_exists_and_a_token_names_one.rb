class AWorkspaceExistsAndATokenNamesOne < ActiveRecord::Migration[8.1]
  # Identity stays global — one person, one row, membership in as many rooms as
  # they belong to. What moves is the token: a global one cannot name a
  # workspace, and one that does makes authenticating and scoping a single
  # lookup rather than two things somebody has to remember to do in order.
  def up
    create_table :workspaces do |t|
      t.string :slug, null: false
      t.string :name, null: false
      t.timestamps
    end
    add_index :workspaces, :slug, unique: true

    create_table :workspace_memberships do |t|
      t.references :user,      null: false, foreign_key: true
      t.references :workspace, null: false, foreign_key: true
      t.string     :role,      null: false, default: "member"
      t.string     :api_token
      t.timestamps
    end
    add_index :workspace_memberships, %i[user_id workspace_id], unique: true
    add_index :workspace_memberships, :api_token, unique: true

    # The room that already exists. Its people keep the tokens they hold, so a
    # client open during the deploy does not find itself signed out.
    say_with_time "moving the existing room into a workspace" do
      workspace = execute(<<~SQL).first
        INSERT INTO workspaces (slug, name, created_at, updated_at)
        VALUES ('workroom', 'WorkRoom', NOW(), NOW())
        RETURNING id
      SQL

      execute(<<~SQL)
        INSERT INTO workspace_memberships
          (user_id, workspace_id, role, api_token, created_at, updated_at)
        SELECT id, #{workspace["id"]}, 'owner', api_token, NOW(), NOW() FROM users
      SQL
    end
  end

  def down
    drop_table :workspace_memberships
    drop_table :workspaces
  end
end
