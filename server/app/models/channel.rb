class Channel < ApplicationRecord
  VISIBILITIES = %w[open private].freeze

  has_many :memberships, dependent: :destroy
  has_many :users, through: :memberships
  has_many :messages, dependent: :destroy
  has_many :agent_sessions, dependent: :destroy
  has_many :artifacts, dependent: :destroy
  has_many :memory_entries, dependent: :destroy

  validates :slug, :name, :memory_uri, presence: true
  validates :slug, uniqueness: true
  validates :visibility, inclusion: { in: VISIBILITIES }

  before_validation :default_memory_uri

  # Права на skills и память выводятся из пути, а не из таблицы грантов.
  # viking://channels/<slug>/ виден участникам, viking://org/ — всем.
  def skills_uri  = "#{memory_uri}skills/"
  def memory_root = memory_uri

  private

  def default_memory_uri
    self.memory_uri ||= "viking://channels/#{slug}/" if slug.present?
  end
end
