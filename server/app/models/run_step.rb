class RunStep < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :agent_run

  KINDS = %w[tool_use tool_result thinking plan].freeze

  belongs_to :agent_run

  validates :kind, inclusion: { in: KINDS }

  # created_at is set by hand: the table is append-only, so there is no
  # updated_at for Rails to keep beside it.
  before_validation { self.created_at ||= Time.current }
end
