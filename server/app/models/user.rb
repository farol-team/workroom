class User < ApplicationRecord
  has_many :memberships, dependent: :destroy
  has_many :channels, through: :memberships
  # Identity is global and membership is not: one person, one row, in as many
  # rooms as they belong to.
  has_many :workspace_memberships, dependent: :destroy
  has_many :workspaces, through: :workspace_memberships
  has_many :agent_sessions, dependent: :destroy
  has_many :messages, as: :author

  validates :email, :provider, :uid, :handle, presence: true
  validates :email, uniqueness: true
  validates :handle, uniqueness: true

  # What somebody types after an `@`. A name is what a colleague reads and an
  # email is what a provider knows; neither is this.
  before_validation :take_a_handle, on: :create

  def member_of?(channel) = memberships.exists?(channel: channel)

  private

  # From the address, because that is the name people already answer to — with a
  # number after it when somebody else got there first.
  def take_a_handle
    return if handle.present?

    base = email.to_s.split("@").first.to_s.downcase.gsub(/[^a-z0-9._-]/, "")
    base = "person" if base.blank?

    # Counting what looks like it would collide is not the same as finding one
    # that does not, and the difference is a unique index raising in somebody's
    # face while they sign in.
    self.handle = base
    suffix = 1
    self.handle = "#{base}#{suffix += 1}" while User.exists?(handle: handle)
  end
end
