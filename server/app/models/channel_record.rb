class ChannelRecord < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  belongs_to :channel
  belongs_to :subject, polymorphic: true, optional: true

  # Append-only, the same way an Activity is: what a record of what happened is
  # worth depends entirely on nobody being able to go back and adjust it. The
  # chain would notice an edit, but only if somebody checked — this refuses it.
  def readonly? = persisted?
end
