class Artifact < ApplicationRecord
  belongs_to :channel
  belongs_to :agent_run, optional: true

  has_one_attached :file

  validates :name, presence: true
end
