# A capability the rail can find and run, answered by a system outside WorkRoom.
#
# Configuration rather than record: the row says what may be reached, where, and
# with what. The rail asks it; nothing writes to it in the course of a turn.
#
# `read_only` defaults to false in the schema, so a capability nobody has judged is
# a capability nobody is offered. What is not read-only cannot run at all yet — a
# side effect needs a person's decision, and that step does not exist here.
class BoundCapability < ApplicationRecord
  PREFIX = "workroom://systems/".freeze

  belongs_to :workspace

  validates :key, :title, :endpoint, :tool, presence: true
  validates :key, uniqueness: { scope: :workspace_id }

  # What the operator judged safe to run without anybody watching.
  scope :offered, -> { where(read_only: true) }

  def uri = "#{PREFIX}#{key}"

  # The row an agent's uri names, or nil. Nil rather than an exception: a uri from
  # a search a day old, or from another workspace, is a thing to refuse and not a
  # thing to crash on. Row-level security is what makes the second case nil here
  # rather than found — the query cannot see another workspace's rows at all.
  def self.find_by_uri(uri)
    return nil unless uri.to_s.start_with?(PREFIX)

    find_by(key: uri.to_s.delete_prefix(PREFIX))
  end
end
