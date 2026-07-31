class RecordWhenARunKeptSomething < ActiveRecord::Migration[8.1]
  # Every turn asks the agent what the room should keep. A run that kept
  # something carries the moment it did; a run that kept nothing carries
  # nothing, which is a legitimate answer rather than a gap.
  def change
    add_column :agent_runs, :distilled_at, :datetime
  end
end
