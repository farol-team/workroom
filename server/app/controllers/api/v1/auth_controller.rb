module Api
  module V1
    # Development sign-in. Replaced by OmniAuth; the shape of what it returns
    # (a bearer token identifying a User) does not change.
    class AuthController < BaseController
      # Only here. The API is `ActionController::API` and has no cookie jar, which
      # is a property worth keeping: an endpoint that cannot be driven by a cookie
      # cannot be driven by another site's page, so there is no CSRF surface to
      # defend across the rest of the API. This one action needs to read one
      # cookie, so this one controller gets a jar.
      include ActionController::Cookies
      skip_before_action :authenticate!, only: %i[create methods_available session destroy_session]

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

      # What a page in a browser holds. It cannot read its own cookie — that is the
      # point of the cookie — so it asks, and keeps the answer in a variable that
      # dies with the tab.
      #
      # The cookie is looked up exactly the way the bearer header is: same column,
      # same lookup, no shortcut. A cookie the browser sends is not evidence of
      # anything the header would not also have to prove, and treating it as more
      # trustworthy for being a cookie is how a forged one becomes a session.
      def session
        membership = WorkspaceMembership.find_by(api_token: cookies[SessionsController::COOKIE].to_s.presence)
        return render_error("no session", :unauthorized) unless membership

        render json: { token: membership.api_token }.merge(membership.user.slice(:id, :email, :name))
      end

      # The cookie is the whole credential, so this is the whole sign-out. A page
      # that only dropped its variable would be signed back in by a reload.
      def destroy_session
        cookies.delete(SessionsController::COOKIE, path: "/")
        head :no_content
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
