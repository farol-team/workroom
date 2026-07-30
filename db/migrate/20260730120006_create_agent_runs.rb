class CreateAgentRuns < ActiveRecord::Migration[8.1]
  def change
    create_table :agent_runs do |t|
      t.references :agent_session,   null: false, foreign_key: true
      t.references :trigger_message, null: true, foreign_key: { to_table: :messages }

      t.string   :status, null: false, default: "queued"
      # queued | running | succeeded | failed | interrupted

      t.integer  :input_tokens
      t.integer  :output_tokens
      t.datetime :started_at
      t.datetime :ended_at
      t.timestamps
    end
    add_index :agent_runs, [ :agent_session_id, :created_at ]
  end
end
