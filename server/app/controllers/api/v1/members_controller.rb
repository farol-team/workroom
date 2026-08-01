module Api
  module V1
    # Who is in the room. For recognising a colleague, not for collecting them —
    # so a name and a role, and nothing that identifies anyone elsewhere.
    class MembersController < BaseController
      before_action :require_channel_access!

      def index
        render json: channel!.memberships.includes(:user).order("users.name").map { |m|
          { id: m.user_id, name: m.user.name, handle: m.user.handle, role: m.role }
        }
      end

      # Adding a colleague to a room inside a workspace they are already in.
      # Anybody in the channel may: a room inside a room somebody already
      # belongs to is not a boundary worth defending, and it is Slack's answer.
      #
      # Somebody outside the workspace is not "not found" by accident — they are
      # refused, because whether a stranger exists is not this room's to say.
      def create
        person = current_workspace.users.find_by(handle: params.require(:handle).to_s.downcase)
        return render_error("nobody here is @#{params[:handle]}", :not_found) unless person

        membership = channel!.memberships.find_or_create_by!(user: person)
        Activity.log(actor: current_user, action: "channel.joined", subject: person)
        render json: { id: person.id, name: person.name, handle: person.handle,
                       role: membership.role }, status: :created
      end
    end
  end
end
