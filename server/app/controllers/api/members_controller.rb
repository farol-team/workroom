module Api
  # Who is in the room. For recognising a colleague, not for collecting them —
  # so a name and a role, and nothing that identifies anyone elsewhere.
  class MembersController < BaseController
    before_action :require_channel_access!

    def index
      render json: channel!.memberships.includes(:user).order("users.name").map { |m|
        { id: m.user_id, name: m.user.name, role: m.role }
      }
    end
  end
end
