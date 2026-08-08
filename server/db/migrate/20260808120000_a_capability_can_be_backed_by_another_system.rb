class ACapabilityCanBeBackedByAnotherSystem < ActiveRecord::Migration[8.1]
  # What the rail may reach outside WorkRoom, and with what.
  #
  # The credential is a column here for the same reason the workspace's context
  # store key is one: it belongs to a system the workspace operates, not to the
  # model answering a turn, so Article P2 is untouched by it living server-side.
  # Encryption at rest is a decision about every secret this application holds and
  # not a detail of this one.
  #
  # `read_only` defaults to false, so a capability nobody has judged is a
  # capability nobody is offered.
  def change
    create_table :bound_capabilities do |t|
      t.bigint :workspace_id, null: false
      t.string :key, null: false
      t.string :title, null: false
      t.text :summary
      t.string :endpoint, null: false
      t.string :tool, null: false
      t.string :credential
      t.boolean :read_only, null: false, default: false
      t.timestamps
    end
    add_index :bound_capabilities, %i[workspace_id key], unique: true
    add_foreign_key :bound_capabilities, :workspaces
  end
end
