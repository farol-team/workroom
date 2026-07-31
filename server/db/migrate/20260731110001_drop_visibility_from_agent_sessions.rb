class DropVisibilityFromAgentSessions < ActiveRecord::Migration[8.1]
  # Working in a channel is already the decision to share. A level asks the user
  # to make it twice.
  def change
    remove_column :agent_sessions, :visibility, :string, null: false, default: "outcomes"
  end
end
