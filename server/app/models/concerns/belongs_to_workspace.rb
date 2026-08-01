module BelongsToWorkspace
  extend ActiveSupport::Concern

  # Every table holding a room's content carries its workspace, including where
  # it could be reached through a parent. Denormalised on purpose: a row-level
  # security policy has to be checkable without a join, and one written as a
  # subquery is both slower and able to be wrong.
  #
  # Nothing in the application sets it by hand. A record inherits it from the
  # parent it belongs to, or from the room the request is in — and a record that
  # can find neither is refused here rather than discovered later, in a row
  # nobody can read back.
  included do
    belongs_to :workspace

    before_validation :inherit_workspace, on: :create
  end

  class_methods do
    # Where this record's workspace comes from when the request does not say —
    # a message takes its channel's, a run takes its session's.
    def workspace_through(association) = @workspace_through = association

    def workspace_source = @workspace_source ||= @workspace_through
  end

  private

  def inherit_workspace
    return if workspace_id.present?

    parent = self.class.workspace_source
    self.workspace_id = (parent && public_send(parent)&.workspace_id) || Current.workspace&.id
  end
end
