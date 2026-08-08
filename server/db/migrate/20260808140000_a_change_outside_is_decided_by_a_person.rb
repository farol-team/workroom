class AChangeOutsideIsDecidedByAPerson < ActiveRecord::Migration[8.1]
  # A capability that changes something outside this room, waiting for somebody to
  # say yes.
  #
  # `arguments` is the proposal's own copy of what the agent asked for. The call is
  # made from here on approval and never from what the approver sent, so approving
  # cannot become a way to run something else.
  #
  # `supersedes_id` rather than editing a row: a corrected proposal leaves the first
  # one readable, which is the discipline memory already has (Article P6) and for the
  # same reason — what was first asked for is part of what happened.
  def change
    create_table :decisions do |t|
      t.bigint :workspace_id, null: false
      t.bigint :channel_id, null: false
      t.bigint :agent_run_id
      t.bigint :bound_capability_id, null: false
      t.jsonb :arguments, null: false, default: {}
      t.string :state, null: false, default: "pending"
      t.bigint :decided_by_id
      t.datetime :decided_at
      t.text :reason
      t.text :result
      t.bigint :supersedes_id
      t.timestamps
    end
    add_index :decisions, %i[channel_id state]
    add_foreign_key :decisions, :workspaces
    add_foreign_key :decisions, :channels
    add_foreign_key :decisions, :bound_capabilities
  end
end
