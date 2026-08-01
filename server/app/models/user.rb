class User < ApplicationRecord
  has_many :memberships, dependent: :destroy
  has_many :channels, through: :memberships
  # Identity is global and membership is not: one person, one row, in as many
  # rooms as they belong to.
  has_many :workspace_memberships, dependent: :destroy
  has_many :workspaces, through: :workspace_memberships
  has_many :agent_sessions, dependent: :destroy
  has_many :messages, as: :author

  validates :email, :provider, :uid, presence: true
  validates :email, uniqueness: true

  def member_of?(channel) = memberships.exists?(channel: channel)
end
