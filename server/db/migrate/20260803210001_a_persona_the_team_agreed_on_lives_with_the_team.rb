class APersonaTheTeamAgreedOnLivesWithTheTeam < ActiveRecord::Migration[8.1]
  # The workspace owns the description — a name, a runtime, an instruction, a
  # model — and only the description (#233). There is no credential column by
  # construction: the process, the key and the bill stay on each member's
  # machine (Article P2).
  def change
    create_table :agent_definitions do |t|
      t.bigint :workspace_id, null: false
      t.string :name, null: false
      t.string :command, null: false
      t.jsonb :args, null: false, default: []
      t.text :instruction
      t.string :model
      t.timestamps
    end
    add_index :agent_definitions, %i[workspace_id name], unique: true
    add_foreign_key :agent_definitions, :workspaces
  end
end
