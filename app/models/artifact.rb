class Artifact < ApplicationRecord
  belongs_to :channel
  belongs_to :agent_run, optional: true

  has_one_attached :file
  has_many :promotions, as: :source, dependent: :destroy

  validates :name, presence: true
end
