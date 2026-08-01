module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :current_user, :current_workspace

    def connect
      membership = find_membership
      self.current_user = membership&.user || find_user || reject_unauthorized_connection
      # A connection outlives every request, so the room it belongs to is
      # settled once, here, and re-entered around each lookup that needs it.
      self.current_workspace = membership&.workspace || current_user.workspaces.first
    end

    private

    def token
      request.params[:token].presence ||
        request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence
    end

    def find_membership = token && WorkspaceMembership.find_by(api_token: token)

    # The token a client was holding before #134. Removed with the column.
    def find_user = token && User.find_by(api_token: token)
  end
end
