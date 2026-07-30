class CreateAgentSessions < ActiveRecord::Migration[8.1]
  def change
    create_table :agent_sessions do |t|
      t.references :user,    null: false, foreign_key: true
      t.references :channel, null: false, foreign_key: true

      t.string   :agent_kind, null: false, default: "claude_code"
      t.string   :external_id                    # id ACP-сессии
      t.string   :status,     null: false, default: "idle"  # idle|running|dead
      t.datetime :started_at
      t.datetime :ended_at
      t.timestamps
    end
    # Одна сессия на пару (пользователь, канал) — из этого следует,
    # что память канала естественно совпадает с областью сессии.
    add_index :agent_sessions, [ :user_id, :channel_id ]
  end
end
