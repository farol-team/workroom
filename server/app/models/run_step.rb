class RunStep < ApplicationRecord
  KINDS = %w[tool_use tool_result thinking plan].freeze

  belongs_to :agent_run

  validates :kind, inclusion: { in: KINDS }

  # created_at выставляется вручную: таблица append-only, updated_at не нужен.
  before_validation { self.created_at ||= Time.current }
end
