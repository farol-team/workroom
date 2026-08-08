# Article P2, amended (#304): a server may hold an agent credential when it belongs
# to exactly one person. `user_id` is therefore `null: false` and unique with the
# provider — the article's central clause written where the database enforces it,
# not where a callback might.
class WhereATurnRunsIsThePersonsChoice < ActiveRecord::Migration[8.1]
  def change
    add_column :users, :execution_mode, :string, null: false, default: "own"

    create_table :user_credentials do |t|
      t.references :user, null: false, foreign_key: true
      t.string :provider, null: false
      # Encrypted by Active Record, so the column holds the envelope rather than
      # the key. Text, not string: the envelope is longer than what went into it.
      t.text :secret, null: false
      t.timestamps
    end

    add_index :user_credentials, %i[user_id provider], unique: true
  end
end
