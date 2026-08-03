module Api
  module V1
    # How somebody reaches a workspace they did not make.
    #
    # #154 named the two ways to hold a token — signing in, and making the room
    # — and said an endpoint that hands one over for another room would hand it
    # to an agent too. This is the third way, and it is safe for the same
    # reason: it needs a code that travelled out of band *and* somebody signed
    # in as themselves. An agent holding one workspace's token has neither.
    class InvitationsController < BaseController
      # Only making one is an admin's. Redeeming happens from outside the room
      # being joined — the room the request is authenticated for is not the room
      # it is about — so it is guarded by the code instead.
      before_action :require_workspace_admin, only: %i[create index]

      def create
        invitation = Invitation.create!(workspace: current_workspace, invited_by: current_user,
                                        email: params[:email].presence,
                                        role: params[:role].presence || "member")
        render json: serialize(invitation), status: :created
      end

      def index
        render json: Invitation.open.where(workspace: current_workspace)
                               .order(created_at: :desc).map { |i| serialize(i) }
      end

      def accept
        invitation = Invitation.find_by(code: params.require(:code))
        return render_error("that invitation does not exist", :not_found) unless invitation

        membership = invitation.redeem!(current_user)
        # The token comes back because this is the moment somebody is given a
        # way into this room, and there is no other endpoint that would.
        render json: { workspace: membership.workspace.slice(:id, :slug, :name),
                       role: membership.role, token: membership.api_token }
      rescue Invitation::Spent
        render_error("that invitation has already been used", :gone)
      end

      private

      # The code is the invitation. Listing carries it because only an admin of
      # this room can list, and they are the person who has to send it.
      def serialize(invitation)
        invitation.slice(:id, :email, :role)
                  .merge(code: invitation.code, invited_by: invitation.invited_by.name)
      end
    end
  end
end
