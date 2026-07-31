class AgentRun < ApplicationRecord
  STATUSES = %w[queued running succeeded failed interrupted].freeze

  belongs_to :agent_session
  belongs_to :trigger_message, class_name: "Message", optional: true

  has_many :run_steps, -> { order(:created_at) }, dependent: :destroy
  has_many :messages, as: :author, dependent: :nullify
  has_many :artifacts, dependent: :nullify

  validates :status, inclusion: { in: STATUSES }

  delegate :channel, :user, to: :agent_session

  # A finished run is a candidate for the room's memory — a candidate only.
  after_update_commit :distil, if: -> { saved_change_to_status? && status == "succeeded" }

  # How full the agent says its context is. Derived rather than stored: a ratio
  # kept beside its two operands is a third thing to keep consistent.
  def context_fraction
    return nil if context_used.nil? || context_size.to_i.zero?

    context_used.to_f / context_size
  end

  def distil = DistillRunJob.perform_later(id)
  def duration     = (ended_at && started_at) ? ended_at - started_at : nil
end
