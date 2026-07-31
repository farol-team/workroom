class AgentSession < ApplicationRecord
  STATUSES = %w[idle running dead].freeze

  # The room shares outcomes, not process — and the person doing the work
  # decides how much of the process to share.
  VISIBILITIES = %w[full outcomes private].freeze

  belongs_to :user
  belongs_to :channel
  has_many :agent_runs, dependent: :destroy

  validates :agent_kind, presence: true
  validates :status, inclusion: { in: STATUSES }
  validates :visibility, inclusion: { in: VISIBILITIES }

  def shares_process?  = visibility == "full"
  def shares_outcomes? = visibility != "private"

  # Одна живая сессия на пару (пользователь, канал).
  scope :live_for, ->(user, channel) {
    where(user:, channel:).where.not(status: "dead").order(created_at: :desc)
  }
end
