class AddModelToAgentRuns < ActiveRecord::Migration[8.1]
  # Memory distilled from a run inherits its provenance. Knowing a conclusion
  # came from a small free model is part of knowing what it is worth.
  def change
    add_column :agent_runs, :model, :string
  end
end
