class MemoryEntry < ApplicationRecord
  TRUST = %w[human agent].freeze

  belongs_to :channel
  belongs_to :author, polymorphic: true, optional: true
  belongs_to :source, polymorphic: true, optional: true

  validates :uri, :title, presence: true
  validates :uri, uniqueness: true
  validates :trust, inclusion: { in: TRUST }

  scope :current, -> { where(superseded_at: nil) }
  # A person's assertion outranks an agent's inference at retrieval time.
  scope :by_trust, -> { order(Arel.sql("case trust when 'human' then 0 else 1 end"), created_at: :desc) }

  def supersede!(at: Time.current) = update!(superseded_at: at)

  # Provenance as every store can express it. A row can point at a User; a
  # context database holds a name in the record it wrote.
  def author_name = author&.name
end
