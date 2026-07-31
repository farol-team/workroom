class ReplaceRunTokensWithUsage < ActiveRecord::Migration[8.1]
  # The client volunteered token counts and nothing filled them reliably. The
  # agent reports what it actually knows: how full the context is, and what the
  # session has cost. The input/output split lives in the transcript, where it
  # is richer.
  def change
    remove_column :agent_runs, :input_tokens, :integer
    remove_column :agent_runs, :output_tokens, :integer

    add_column :agent_runs, :context_used, :integer
    add_column :agent_runs, :context_size, :integer
    add_column :agent_runs, :cost, :decimal, precision: 12, scale: 6
  end
end
