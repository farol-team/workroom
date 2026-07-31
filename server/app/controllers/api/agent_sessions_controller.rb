module Api
  # Only the owner of a session may change how much of it the room sees.
  class AgentSessionsController < BaseController
    def update
      session = AgentSession.where(user: current_user).find(params[:id])
      session.update!(visibility: params.require(:visibility))
      Activity.log(actor: current_user, action: "session.visibility_changed",
                   subject: session, visibility: session.visibility)
      render json: { id: session.id, visibility: session.visibility }
    end
  end
end
