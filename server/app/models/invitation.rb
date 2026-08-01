class Invitation < ApplicationRecord
  # Deliberately not a workspace table. An invitation is how somebody reaches a
  # room they are not yet in, so it cannot live behind that room's boundary —
  # and redeeming one is the third and last way to hold a token for a workspace
  # (#154 named the other two: signing in, and making the room).
  #
  # Safe for the same reason those are: it needs a code that travelled out of
  # band *and* somebody signed in as themselves. An agent holding one
  # workspace's token has neither.
  LIFETIME = 7.days

  belongs_to :workspace
  belongs_to :invited_by, class_name: "User"
  belongs_to :accepted_by, class_name: "User", optional: true

  validates :role, inclusion: { in: Workspace::ROLES }
  validates :code, presence: true, uniqueness: true

  scope :open, -> { where(accepted_at: nil).where(expires_at: Time.current..) }

  before_validation on: :create do
    self.code ||= SecureRandom.urlsafe_base64(24)
    self.expires_at ||= LIFETIME.from_now
  end

  def spent? = accepted_at.present?
  def expired? = expires_at.past?

  # Redeemed once, by one person. A second attempt is not an error to hide: the
  # link works or it does not, and "already used" is a different sentence from
  # "never existed".
  def redeem!(user)
    raise Spent if spent?
    raise Expired if expired?

    membership = nil
    transaction do
      membership = WorkspaceMembership.find_or_create_by!(user:, workspace:) do |m|
        m.role = role
      end
      update!(accepted_at: Time.current, accepted_by: user)
    end
    membership
  end

  Spent = Class.new(StandardError)
  Expired = Class.new(StandardError)
end
