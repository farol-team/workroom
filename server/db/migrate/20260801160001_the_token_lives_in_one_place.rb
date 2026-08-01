class TheTokenLivesInOnePlace < ActiveRecord::Migration[8.1]
  # #134 moved it to the membership and kept this readable so a deploy would not
  # sign the room out. The backfill copied every existing token across, so a
  # client holding one issued before any of this still authenticates — through
  # the membership, with the same string. Nobody is signed out by the removal.
  def up
    remove_column :users, :api_token
  end

  def down
    add_column :users, :api_token, :string
    add_index :users, :api_token, unique: true
  end
end
