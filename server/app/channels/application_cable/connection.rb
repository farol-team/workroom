module ApplicationCable
  class Connection < ActionCable::Connection::Base
    identified_by :current_user

    def connect
      self.current_user = find_user || reject_unauthorized_connection
    end

    private

    def find_user
      token = request.params[:token].presence ||
              request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence
      User.find_by(api_token: token) if token
    end
  end
end
