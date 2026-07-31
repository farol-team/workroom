class AddVisibilityToAgentSessions < ActiveRecord::Migration[8.1]
  def change
    # How much of this session's process the room sees. The owner's stance
    # towards a channel, not a property of one turn — so it lives on the session.
    add_column :agent_sessions, :visibility, :string, null: false, default: "outcomes"
  end
end
