class AgentSession < ApplicationRecord
  STATUSES = %w[idle running dead].freeze


  belongs_to :user
  belongs_to :channel
  has_many :agent_runs, dependent: :destroy

  validates :agent_kind, presence: true
  validates :status, inclusion: { in: STATUSES }

  # One live session per (user, agent, channel). A session id belongs to the
  # process that issued it, so an agent must never be handed another's.
  scope :live_for, ->(user, channel, agent_kind) {
    where(user:, channel:, agent_kind:).where.not(status: "dead").order(created_at: :desc)
  }
end
