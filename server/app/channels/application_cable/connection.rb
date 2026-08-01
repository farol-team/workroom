module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :current_user, :current_workspace

    def connect
      membership = find_membership || reject_unauthorized_connection
      self.current_user = membership.user
      # A connection outlives every request, so the room it belongs to is
      # settled once, here, and re-entered around each lookup that needs it.
      self.current_workspace = membership.workspace
    end

    private

    def token
      request.params[:token].presence ||
        request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence
    end

    def find_membership = token && WorkspaceMembership.find_by(api_token: token)
  end
end
