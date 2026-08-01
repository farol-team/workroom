class Activity < ApplicationRecord
  include BelongsToWorkspace

  belongs_to :actor,   polymorphic: true
  belongs_to :subject, polymorphic: true, optional: true

  validates :action, presence: true

  before_validation { self.created_at ||= Time.current }

  # Append-only: обновление и удаление запрещены на уровне модели.
  def readonly? = persisted?

  def self.log(actor:, action:, subject: nil, **metadata)
    create!(actor:, action:, subject:, metadata:)
  end
end
