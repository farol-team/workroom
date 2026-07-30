class CreateMemberships < ActiveRecord::Migration[8.1]
  def change
    create_table :memberships do |t|
      t.references :user,    null: false, foreign_key: true
      t.references :channel, null: false, foreign_key: true
      t.string     :role,    null: false, default: "member"  # member | owner
      t.timestamps
    end
    add_index :memberships, [ :user_id, :channel_id ], unique: true
  end
end
