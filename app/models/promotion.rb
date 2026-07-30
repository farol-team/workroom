class Promotion < ApplicationRecord
  STATES = %w[proposed approved rejected applied].freeze

  belongs_to :source, polymorphic: true          # Message | AgentRun | Artifact
  belongs_to :channel
  belongs_to :proposed_by, class_name: "User", optional: true
  belongs_to :approved_by, class_name: "User", optional: true

  validates :state, inclusion: { in: STATES }

  scope :pending, -> { where(state: "proposed") }

  # Продвижение — явное действие. Дистилляция только предлагает;
  # запись в OpenViking происходит после подтверждения человеком.
  def approve!(user)
    update!(state: "approved", approved_by: user)
    ApplyPromotionJob.perform_later(id)
  end

  def reject!(user) = update!(state: "rejected", approved_by: user)
end
