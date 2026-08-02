class Channel < ApplicationRecord
  include BelongsToWorkspace

  VISIBILITIES = %w[open private].freeze

  has_many :memberships, dependent: :destroy
  has_many :users, through: :memberships
  has_many :messages, dependent: :destroy
  has_many :agent_sessions, dependent: :destroy
  has_many :artifacts, dependent: :destroy
  has_many :memory_entries, dependent: :destroy
  # This is the cascade — the foreign keys are integrity guards and refuse the
  # delete rather than following it. delete_all, not destroy: a journal entry
  # is append-only and refuses to be destroyed, so a callback would raise
  # halfway through what one statement does without asking any of them.
  has_many :channel_records, dependent: :delete_all

  validates :slug, :name, :memory_uri, presence: true
  # Two customers both want a room called general. Unique inside a workspace,
  # not across the server.
  validates :slug, uniqueness: { scope: :workspace_id }
  validates :visibility, inclusion: { in: VISIBILITIES }

  before_validation :default_memory_uri

  # Rights over skills and memory are derived from the path, not from a table
  # of grants. viking://resources/channels/<slug>/ is the room's own knowledge.
  def skills_uri  = "#{memory_uri}skills/"

  private

  def default_memory_uri
    # `resources` is not decoration: the context database accepts four scopes —
    # agent, resources, session, user — and shared knowledge that belongs to no
    # single person is a resource. A uri outside them is refused outright.
    self.memory_uri ||= "viking://resources/channels/#{slug}/" if slug.present?
  end
end
