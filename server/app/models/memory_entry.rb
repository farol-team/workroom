# Memory::Local's storage — one backend's table, not the system's memory.
# Everything reads it through Memory::Store.current (Article S1), and when a
# workspace runs an OpenViking context database instead, these rows are inert:
# a number read straight off the table there is not stale, it is structurally
# zero and stays zero, which is what the ambiguity cost once (#99). The table
# stays in Workspace::Boundary::ROOMS all the same — row-level security is
# per-table, not per-backend, and the boundary must hold whichever store
# answers.
class MemoryEntry < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  TRUST = %w[human agent].freeze

  belongs_to :channel
  belongs_to :author, polymorphic: true, optional: true
  belongs_to :source, polymorphic: true, optional: true

  validates :uri, :title, presence: true
  # The uri gains a workspace segment in step 4 of #118. Until it does, the pair
  # is what is actually unique.
  validates :uri, uniqueness: { scope: :workspace_id }
  validates :trust, inclusion: { in: TRUST }

  scope :current, -> { where(superseded_at: nil) }
  # A person's assertion outranks an agent's inference at retrieval time.
  scope :by_trust, -> { order(Arel.sql("case trust when 'human' then 0 else 1 end"), created_at: :desc) }

  def supersede!(at: Time.current) = update!(superseded_at: at)

  # Provenance as every store can express it. A row can point at a User; a
  # context database holds a name in the record it wrote.
  def author_name = author&.name
end
