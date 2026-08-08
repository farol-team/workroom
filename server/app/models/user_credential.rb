# What pays for one person's turns.
#
# Article P2 permits the server to hold this only under three conditions, and each is
# a mechanism here rather than a promise: it belongs to exactly one person (a column
# that cannot be null and a unique index), it is encrypted at rest, and nothing hands
# it back.
#
# Deliberately not `belongs_to :workspace`. Everything else in this database is a
# room's and carries its workspace so row-level security can find it; this is a
# person's, and a person is in more than one room. Making it a workspace's would be
# the first step towards a workspace-wide key, which is the thing the article forbids.
class UserCredential < ApplicationRecord
  belongs_to :user

  encrypts :secret

  PROVIDERS = %w[anthropic].freeze

  validates :provider, inclusion: { in: PROVIDERS }
  validates :secret, presence: true
  validates :user, presence: { message: "must be one person — a shared key is what Article P2 forbids" }
  validates :user_id, uniqueness: { scope: :provider }

  # Replacing rather than accumulating. A person who pastes a new key means the old
  # one is finished, and a table of a person's old keys is a table of secrets nobody
  # is watching.
  def self.remember(user:, provider:, secret:)
    record = find_or_initialize_by(user:, provider:)
    record.update!(secret:)
    record
  end

  # What a person is shown about their own key: that there is one, from when, and
  # enough of its shape to recognise which one. Never the key.
  def describe = { provider:, set_at: updated_at }
end
