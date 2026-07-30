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

    def channel!
      @channel ||= Channel.find_by!(slug: params[:channel_slug] || params[:slug])
    end

    def authorize_channel!
      return if @channel.visibility == "open" || current_user.member_of?(@channel)
      render_error("not a member of this channel", :forbidden)
    end

    def render_error(message, status) = render(json: { error: message }, status:)

    rescue_from ActiveRecord::RecordNotFound do
      render_error("not found", :not_found)
    end

    rescue_from ActiveRecord::RecordInvalid do |e|
      render_error(e.record.errors.full_messages.join(", "), :unprocessable_entity)
    end
  end
end
