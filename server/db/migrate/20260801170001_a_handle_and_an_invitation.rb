class AHandleAndAnInvitation < ActiveRecord::Migration[8.1]
  # A name is what a colleague reads and an email is what a provider knows.
  # Neither is what somebody types after an `@`.
  def up
    add_column :users, :handle, :string
    add_index :users, :handle, unique: true

    say_with_time "giving everybody something to be mentioned by" do
      execute <<~SQL
        UPDATE users SET handle = base.handle || CASE WHEN base.n = 1 THEN '' ELSE base.n::text END
        FROM (
          SELECT id,
                 regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g') AS handle,
                 row_number() OVER (
                   PARTITION BY regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g')
                   ORDER BY id) AS n
          FROM users
        ) base
        WHERE users.id = base.id
      SQL
    end
    change_column_null :users, :handle, false

    # Not a workspace table: an invitation is how somebody reaches a room they
    # are not yet in, so it cannot live behind that room's boundary.
    create_table :invitations do |t|
      t.references :workspace, null: false, foreign_key: true
      t.references :invited_by, null: false, foreign_key: { to_table: :users }
      t.string     :code, null: false
      t.string     :email
      t.string     :role, null: false, default: "member"
      t.datetime   :expires_at, null: false
      t.datetime   :accepted_at
      t.references :accepted_by, foreign_key: { to_table: :users }
      t.timestamps
    end
    add_index :invitations, :code, unique: true
  end

  def down
    drop_table :invitations
    remove_column :users, :handle
  end
end
