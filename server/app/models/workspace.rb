class Workspace < ApplicationRecord
  ROLES = %w[owner admin member].freeze

  has_many :workspace_memberships, dependent: :destroy
  has_many :users, through: :workspace_memberships

  validates :slug, :name, presence: true
  validates :slug, uniqueness: true

  # The role the policies actually apply to. A superuser bypasses row-level
  # security even where it is FORCEd, and a local or CI PostgreSQL hands you a
  # superuser — so the boundary is only real from inside this role, and taking
  # it is part of entering a room rather than something deployment arranges.
  APP_ROLE = "workroom_app".freeze

  # Both settings last exactly as long as the transaction. The connection is
  # pooled per transaction (port 6432 is the pooler), so anything session-scoped
  # would work under no load and lie under load.
  def self.confine(connection, workspace)
    connection.execute("SET LOCAL ROLE #{APP_ROLE}")
    connection.execute(
      "SET LOCAL app.workspace_id = #{workspace ? workspace.id.to_i : "''"}"
    )
  end

  # Everything inside the block sees this room and no other, because the
  # database is what refuses rather than a `WHERE` somebody has to remember.
  #
  # A transaction, and `SET LOCAL` inside it, because the connection is pooled
  # per transaction — see the migration. Nothing set means nothing visible, so a
  # caller that forgets gets an empty world rather than everybody's.
  def self.entered(workspace)
    ActiveRecord::Base.transaction do
      Workspace.confine(ActiveRecord::Base.connection, workspace)
      Current.workspace = workspace
      yield
    end
  end

  # Where somebody signing in ends up. With one room that is the room; with
  # several it is the wrong question, and the answer becomes an invitation —
  # which is a later step of #118 and not something to guess at here.
  def self.default = order(:id).first

  # A person's place in a room, made once. Signing in twice is not joining
  # twice, and after #134 a person without a membership cannot reach anything.
  def self.admit(user)
    WorkspaceMembership.find_or_create_by!(user:, workspace: default)
  end
end
