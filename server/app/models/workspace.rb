class Workspace < ApplicationRecord
  ROLES = %w[owner admin member].freeze

  has_many :workspace_memberships, dependent: :destroy
  has_many :users, through: :workspace_memberships

  validates :slug, :name, presence: true
  validates :slug, uniqueness: true
end
