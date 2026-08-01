class Membership < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  ROLES = %w[member owner].freeze

  belongs_to :user
  belongs_to :channel

  validates :role, inclusion: { in: ROLES }
  validates :user_id, uniqueness: { scope: :channel_id }
end
