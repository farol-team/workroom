module Api
  class BaseController < ActionController::API
    before_action :authenticate!

    attr_reader :current_user, :current_workspace

    private

    # One lookup answers both questions. A token that belongs to a membership
    # names the person *and* the room, so there is no way to authenticate and
    # then forget to scope — it is a single act rather than two in order.
    def authenticate!
      token = request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence
      return render_error("unauthorized", :unauthorized) unless token

      if (membership = WorkspaceMembership.find_by(api_token: token))
        @current_user = membership.user
        @current_workspace = membership.workspace
      else
        # The token somebody's client is already holding. Read for as long as
        # `users.api_token` exists, so a deploy does not sign the room out
        # mid-migration; #118 step 5 removes both this and the column.
        @current_user = User.find_by(api_token: token)
        @current_workspace = @current_user&.workspaces&.first
      end

      render_error("unauthorized", :unauthorized) unless @current_user
    end

    # A filter, so a refusal halts the action. The previous shape rendered and
    # returned, which left every action to remember `return if performed?` —
    # and #4 proved it would not be remembered.
    def require_channel_access!
      @channel = Channel.find_by!(slug: params[:channel_slug] || params[:slug])
      return if @channel.visibility == "open" || current_user.member_of?(@channel)

      render_error("not a member of this channel", :forbidden)
    end

    def channel! = @channel

    def render_error(message, status) = render(json: { error: message }, status:)

    rescue_from ActiveRecord::RecordNotFound do
      render_error("not found", :not_found)
    end

    rescue_from ActiveRecord::RecordInvalid do |e|
      render_error(e.record.errors.full_messages.join(", "), :unprocessable_entity)
    end

    rescue_from ActionController::ParameterMissing do |e|
      render_error("#{e.param} is required", :unprocessable_entity)
    end
  end
end
