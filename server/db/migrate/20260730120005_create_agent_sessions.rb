class CreateAgentSessions < ActiveRecord::Migration[8.1]
  def change
    create_table :agent_sessions do |t|
      t.references :user,    null: false, foreign_key: true
      t.references :channel, null: false, foreign_key: true

      t.string   :agent_kind, null: false, default: "claude_code"
      t.string   :external_id                    # the ACP session id
      t.string   :status,     null: false, default: "idle"  # idle|running|dead
      t.datetime :started_at
      t.datetime :ended_at
      t.timestamps
    end
    # One session per (user, agent, channel) — from which the memory scope of a
    # session naturally coincides with the channel's.
    add_index :agent_sessions, [ :user_id, :channel_id ]
  end
end
