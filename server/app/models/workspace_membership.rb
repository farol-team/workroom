class WorkspaceMembership < ApplicationRecord
  # A person's place in one room, and the token they reach it with. The two are
  # deliberately the same record: a token that names a workspace makes
  # authenticating and scoping one act, so there is no way to do the first and
  # forget the second.
  belongs_to :user
  belongs_to :workspace

  validates :role, inclusion: { in: Workspace::ROLES }
  validates :user_id, uniqueness: { scope: :workspace_id }

  has_secure_token :api_token
end
