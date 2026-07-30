class User < ApplicationRecord
  has_many :memberships, dependent: :destroy
  has_many :channels, through: :memberships
  has_many :agent_sessions, dependent: :destroy
  has_many :messages, as: :author

  validates :email, :provider, :uid, presence: true
  validates :email, uniqueness: true

  def member_of?(channel) = memberships.exists?(channel: channel)
end
