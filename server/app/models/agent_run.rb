class AgentRun < ApplicationRecord
  STATUSES = %w[queued running succeeded failed interrupted].freeze

  belongs_to :agent_session
  belongs_to :trigger_message, class_name: "Message", optional: true

  has_many :run_steps, -> { order(:created_at) }, dependent: :destroy
  has_many :messages, as: :author, dependent: :nullify
  has_many :artifacts, dependent: :nullify
  has_many :promotions, as: :source, dependent: :destroy

  validates :status, inclusion: { in: STATUSES }

  delegate :channel, :user, to: :agent_session

  def total_tokens = (input_tokens.to_i + output_tokens.to_i)
  def duration     = (ended_at && started_at) ? ended_at - started_at : nil
end
