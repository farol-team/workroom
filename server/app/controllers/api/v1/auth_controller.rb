module Api
  module V1
    # Development sign-in. Replaced by OmniAuth; the shape of what it returns
    # (a bearer token identifying a User) does not change.
    class AuthController < BaseController
      skip_before_action :authenticate!, only: %i[create methods_available]

      # How this workspace lets people in. The client cannot guess, and guessing
      # wrong means offering a box that takes any address to a workspace that has
      # a provider.
      def methods_available
        render json: { development: Rails.configuration.x.dev_signin,
                       provider: ENV["OIDC_ISSUER"].present?,
                       # So a client can say plainly that it has drifted from the
                       # workspace, rather than presenting a feature that will not
                       # work as though it were broken.
                       version: Workroom::VERSION }
      end

      # Who the token in hand belongs to. A client that signed in through the
      # browser holds a token and has never been told whose it is.
      def me
        render json: { user: current_user.slice(:id, :email, :name) }
      end

      def create
        return head :not_found unless Rails.configuration.x.dev_signin

        email = params.require(:email).to_s.downcase
        user = User.find_or_create_by!(email:, provider: "dev", uid: email) do |u|
          u.name = params[:name].presence || email.split("@").first.titleize
        end
        membership = Workspace.admit(user)
        render json: { token: membership.api_token, user: user.slice(:id, :email, :name) }
      end
    end
  end
end
