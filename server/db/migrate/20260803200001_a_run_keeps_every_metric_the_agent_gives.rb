class ARunKeepsEveryMetricTheAgentGives < ActiveRecord::Migration[8.1]
  # Reporting, never billing — the model credential stays on the person's
  # machine, and these columns record what the agent already said on the wire
  # (#97). Every column is nullable on purpose: a zero and an unknown are
  # different numbers, and an agent that reported nothing reported nothing.
  def change
    change_table :agent_runs, bulk: true do |t|
      # The protocol's Cost is { amount, currency: ISO 4217 }. The amount has
      # lived in `cost` since #96; a number with no currency means different
      # things in different rooms, which is what this card was filed about.
      t.string :cost_currency
      # end_turn | max_tokens | max_turn_requests | refusal | cancelled — a turn
      # that ran out of tokens was recorded exactly like one that finished.
      t.string :stop_reason
      t.bigint :input_tokens
      t.bigint :output_tokens
      t.bigint :cached_read_tokens
      t.bigint :cached_write_tokens
      t.bigint :thought_tokens
      t.bigint :total_tokens
      # A vendor's extras, kept without inventing a schema for each: claude's
      # `_claude/origin`, codex's `quota`.
      t.jsonb :metrics
    end
  end
end
