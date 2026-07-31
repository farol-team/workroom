class AgentSession < ApplicationRecord
  STATUSES = %w[idle running dead].freeze


  belongs_to :user
  belongs_to :channel
  has_many :agent_runs, dependent: :destroy

  validates :agent_kind, presence: true
  validates :status, inclusion: { in: STATUSES }

  # Одна живая сессия на пару (пользователь, канал).
  scope :live_for, ->(user, channel) {
    where(user:, channel:).where.not(status: "dead").order(created_at: :desc)
  }
end
