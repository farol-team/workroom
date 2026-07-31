module Api
  class BaseController < ActionController::API
    before_action :authenticate!

    attr_reader :current_user

    private

    def authenticate!
      token = request.headers["Authorization"].to_s.delete_prefix("Bearer ").presence
      @current_user = User.find_by(api_token: token) if token
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
  end
end
