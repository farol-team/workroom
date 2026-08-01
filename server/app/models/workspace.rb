class Workspace < ApplicationRecord
  ROLES = %w[owner admin member].freeze

  has_many :workspace_memberships, dependent: :destroy
  has_many :users, through: :workspace_memberships

  validates :slug, :name, presence: true
  validates :slug, uniqueness: true

  # Where somebody signing in ends up. With one room that is the room; with
  # several it is the wrong question, and the answer becomes an invitation —
  # which is a later step of #118 and not something to guess at here.
  def self.default = order(:id).first

  # A person's place in a room, made once. Signing in twice is not joining
  # twice, and after #134 a person without a membership cannot reach anything.
  def self.admit(user)
    return unless (room = default)

    WorkspaceMembership.find_or_create_by!(user:, workspace: room)
    room
  end
end
