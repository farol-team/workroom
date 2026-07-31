class CreateMemoryEntries < ActiveRecord::Migration[8.1]
  def change
    # Local implementation of the context store. Same shape as the external
    # context database so the adapter can be swapped without touching callers.
    create_table :memory_entries do |t|
      t.references :channel, null: false, foreign_key: true
      t.references :author,  null: true, polymorphic: true   # User | AgentRun
      t.references :source,  null: true, polymorphic: true   # Message | AgentRun

      t.string :uri,   null: false            # viking://resources/channels/<slug>/<key>
      t.string :title, null: false
      t.text   :abstract                      # L0 — discovery
      t.text   :overview                      # L1 — orientation, pushed at session start
      t.text   :detail                        # L2 — full content, pulled on demand
      t.string :trust, null: false, default: "agent"   # human | agent
      t.datetime :superseded_at
      t.timestamps
    end
    add_index :memory_entries, :uri, unique: true
    add_index :memory_entries, [ :channel_id, :superseded_at ]
  end
end
