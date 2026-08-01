class Artifact < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  belongs_to :channel
  belongs_to :agent_run, optional: true

  has_one_attached :file

  validates :name, presence: true

  scope :transcripts, -> { where(kind: "transcript") }
end
