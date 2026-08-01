class Message < ApplicationRecord
  include BelongsToWorkspace
  workspace_through :channel

  belongs_to :channel
  belongs_to :author, polymorphic: true          # User | AgentRun
  belongs_to :parent, class_name: "Message", optional: true

  has_many :replies, class_name: "Message", foreign_key: :parent_id, dependent: :destroy

  validates :body, presence: true
  validate  :single_level_threading

  scope :roots, -> { where(parent_id: nil) }

  def from_agent? = author.is_a?(AgentRun)

  private

  # Треды на один уровень: ответ на ответ запрещён.
  def single_level_threading
    errors.add(:parent, "вложенность больше одного уровня") if parent&.parent_id.present?
  end
end
